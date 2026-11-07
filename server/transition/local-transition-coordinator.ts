import { createHash } from 'node:crypto';
import type { AuthenticatedRequestContext, RequestIdentityBoundary } from '../auth/request-identity';
import { assertTransitionOperatorCapability, createTransitionCommand } from './postgres-transition';
import type { TransitionOperatorCapability, TransitionRepository, TransitionScope } from './transition-ports';
import { installLocalWriterFence, registerLocalSource, restoreLocalSourceAfterEmptyRollback, sealLocalSource } from './local-writer-fence';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
/** Explicit approved local source registration. No .env discovery, owner
 * inference, legacy session conversion or writable fallback is performed. */
export function createLocalTransitionCoordinator(input: {
  root: string; scope: TransitionScope; identity: RequestIdentityBoundary;
  context: AuthenticatedRequestContext; repository: TransitionRepository; operator: TransitionOperatorCapability;
  verifyStoppedParticipants(): Promise<{ complete: boolean; unparticipatingProcesses: number; proofSha256: string }>;
}) {
  if (!input.context.scope || input.scope.ownerId !== input.context.account.ownerId || input.scope.studentId !== input.context.scope.studentId ||
      input.scope.applicationTargetId !== input.context.scope.applicationTargetId || input.scope.supportTargetId !== input.context.scope.supportTargetId ||
      Object.hasOwn(input.scope,'sourceRevision') !== Object.hasOwn(input.context.scope,'sourceRevision') || input.scope.sourceRevision !== input.context.scope.sourceRevision)
    throw new Error('TRANSITION_LOCAL_SOURCE_SCOPE_MISMATCH');
  async function authorize(action: 'prepare'|'activate'|'rollback-empty'|'recover') {
    const fresh = await input.identity.revalidate(input.context);
    if (fresh.mode !== 'authenticated') throw new Error('TRANSITION_OPERATOR_REQUIRED');
    await assertTransitionOperatorCapability(input.operator, fresh, action);
    // Recheck the actual finite DB grant before filesystem mutation. This is
    // read/authorization only; final SQL commands still take their own lock.
    await input.repository.authorizeOperator(fresh, action, input.operator);
  }
  const source = registerLocalSource({ root: input.root, scope: input.scope, authorize });
  return {
    install: () => installLocalWriterFence(source),
    async activate(options: { key: string; expectedGeneration: string; expiresAt: string;
      verifyCheckpoint(checkpointJson: string): Promise<boolean> }) {
      const stopped = await input.verifyStoppedParticipants();
      if (!stopped.complete || stopped.unparticipatingProcesses !== 0 || !/^[a-f0-9]{64}$/u.test(stopped.proofSha256))
        throw new Error('TRANSITION_UNPARTICIPATING_WRITER_UNCONFIRMED');
      return sealLocalSource(source, { generation: options.expectedGeneration, stoppedParticipantProofSha256: stopped.proofSha256,
        async activate(evidence) {
          // Deterministic keys/inputs survive a lost response. Existing receipt
          // lookup happens in SQL before generation/state checks.
          const prepare = createTransitionCommand({ key: options.key + ':prepare', action: 'prepare', expectedGeneration: options.expectedGeneration,
            payloadJson: JSON.stringify({ ...evidence, expiresAt: options.expiresAt }) });
          const prepared = await input.repository.command(input.context, prepare, input.operator);
          const first = JSON.parse(prepared.resultJson) as { generation: string };
          if (!await options.verifyCheckpoint(evidence.checkpointJson)) throw new Error('TRANSITION_CHECKPOINT_NOT_VERIFIED');
          const verificationJson = JSON.stringify({ verified: true, localEvidenceSha256: evidence.localEvidenceSha256, checkpointSha256: evidence.checkpointSha256 });
          const verified = await input.repository.command(input.context, createTransitionCommand({ key: options.key + ':verify', action: 'verify', expectedGeneration: first.generation,
            payloadJson: JSON.stringify({ verificationJson, verificationSha256: sha(verificationJson) }) }), input.operator);
          const second = JSON.parse(verified.resultJson) as { generation: string };
          return input.repository.command(input.context, createTransitionCommand({ key: options.key + ':activate', action: 'activate', expectedGeneration: second.generation, payloadJson: '{}' }), input.operator);
        } });
    },
    /** SQL rollback must commit and prove zero durable new writes. A network
     * error leaves the barrier in place until the same receipt is confirmed. */
    async rollbackEmpty(options: { key: string; expectedGeneration: string }) {
      const stopped=await input.verifyStoppedParticipants();
      if(!stopped.complete||stopped.unparticipatingProcesses!==0)throw new Error('TRANSITION_UNPARTICIPATING_WRITER_UNCONFIRMED');
      return restoreLocalSourceAfterEmptyRollback(source, async () => {
        const command = createTransitionCommand({ key: options.key, action: 'rollback-empty', expectedGeneration: options.expectedGeneration, payloadJson: '{}' });
        await input.repository.command(input.context, command, input.operator);
        const confirmed = await input.repository.receipt(input.context, command.key, command.inputSha256, input.operator);
        if (!confirmed || confirmed.action !== 'rollback-empty') throw new Error('TRANSITION_EMPTY_ROLLBACK_UNCONFIRMED');
        const state = await input.repository.read(input.context);
        if (!state || state.state !== 'local-primary' || state.writeFacts !== 0) throw new Error('TRANSITION_EMPTY_ROLLBACK_UNCONFIRMED');
      });
    },
  };
}
