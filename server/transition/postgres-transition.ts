import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { RequestAccessError,type AuthenticatedRequestContext,type RequestIdentityBoundary } from '../auth/request-identity';
import { TransitionError, type TransitionAccess, type TransitionCommand, type TransitionInstallerCapability, type TransitionOperatorAction,
  type TransitionOperatorCapability, type TransitionOperatorGrant, type TransitionReceipt, type TransitionRepository, type TransitionScope, type TransitionSnapshot } from './transition-ports';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const hex = /^[a-f0-9]{64}$/u, integer = /^\d+$/u;
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value === value.trim();
const actions: readonly TransitionOperatorAction[] = ['prepare','verify','activate','freeze','rollback-empty','recover','status','export','restore','register-input'];
const denied = () => new TransitionError(403, 'TRANSITION_OPERATOR_REQUIRED');
const invalid = () => new TransitionError(400, 'TRANSITION_INVALID');
interface FiniteAuthority extends TransitionScope { issuer: string; subject: string; expiresAt: number; checkCurrent(): Promise<boolean> }
export interface TransitionOperatorAuthority extends FiniteAuthority { actions: readonly TransitionOperatorAction[] }
export interface TransitionInstallerAuthority extends FiniteAuthority { key: string; inputSha256: string; sourceProofSha256: string }
const operators = new WeakMap<TransitionOperatorCapability, Readonly<TransitionOperatorAuthority>>();
const installers = new WeakMap<TransitionInstallerCapability, Readonly<TransitionInstallerAuthority>>();
function validAuthority(input: FiniteAuthority) {
  if (![input.ownerId,input.studentId,input.applicationTargetId,input.supportTargetId,input.issuer,input.subject].every(text) ||
    Object.hasOwn(input,'sourceRevision') && input.sourceRevision !== null && !text(input.sourceRevision) || !Number.isFinite(input.expiresAt) || input.expiresAt <= 0 || typeof input.checkCurrent !== 'function') throw denied();
}
export function createTransitionOperatorCapability(input: TransitionOperatorAuthority): TransitionOperatorCapability {
  validAuthority(input);
  if (!input.actions.length || input.actions.some(action => !actions.includes(action))) throw denied();
  const capability = Object.freeze({ kind: 'scoped-transition-operator-v1' as const });
  operators.set(capability, Object.freeze({ ...input, actions: Object.freeze([...new Set(input.actions)]), checkCurrent: input.checkCurrent.bind(input) })); return capability;
}
export function createTransitionInstallerCapability(input: TransitionInstallerAuthority): TransitionInstallerCapability {
  validAuthority(input); if (!text(input.key) || input.key.length > 160 || !hex.test(input.inputSha256) || !hex.test(input.sourceProofSha256)) throw denied();
  const capability = Object.freeze({ kind: 'scoped-transition-installer-v1' as const });
  installers.set(capability, Object.freeze({ ...input, checkCurrent: input.checkCurrent.bind(input) })); return capability;
}
export async function assertTransitionOperatorCapability(capability: TransitionOperatorCapability, context: AuthenticatedRequestContext, action: TransitionOperatorAction, now = Date.now) {
  const value = operators.get(capability);
  if (!value || !value.actions.includes(action) || now() >= value.expiresAt || value.issuer !== context.principal.issuer || value.subject !== context.principal.subject) throw denied();
  sameScope(value,context); let allowed = false; try { allowed = await value.checkCurrent(); } catch { /* fail closed */ }
  if (!allowed || now() >= value.expiresAt) throw denied();
}
export function createTransitionCommand(input: Omit<TransitionCommand,'version'|'inputJson'|'inputSha256'>): TransitionCommand {
  const inputJson = JSON.stringify({ action: input.action, expectedGeneration: input.expectedGeneration, payloadJson: input.payloadJson });
  return { version: 'scoped-transition-command-v1', ...input, inputJson, inputSha256: sha(inputJson) };
}
function sameScope(value: TransitionScope, context: AuthenticatedRequestContext) {
  if (!context.scope || value.ownerId !== context.account.ownerId || value.studentId !== context.scope.studentId || value.applicationTargetId !== context.scope.applicationTargetId ||
    value.supportTargetId !== context.scope.supportTargetId || Object.hasOwn(value,'sourceRevision') !== Object.hasOwn(context.scope,'sourceRevision') || value.sourceRevision !== context.scope.sourceRevision) throw denied();
}
function json(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 128 * 1024 * 1024) throw invalid();
  try { JSON.parse(value); } catch { throw invalid(); } return value;
}
function snapshot(value: unknown, context: AuthenticatedRequestContext): TransitionSnapshot | null {
  if (value === null) return null; const result = value as TransitionSnapshot;
  if (!result || result.version !== 'scoped-transition-state-v1' || !text(result.transitionId) || !integer.test(result.generation) || !integer.test(result.fence) || !Number.isFinite(Date.parse(result.serverNow))) throw invalid();
  sameScope(result.scope, context);
  for (const [bytes, checksum] of [[result.localEvidenceJson,result.localEvidenceSha256],[result.verificationJson,result.verificationSha256],[result.checkpointJson,result.checkpointSha256]])
    if (bytes !== null && (checksum === null || sha(json(bytes)) !== checksum)) throw invalid();
  return result;
}
function receipt(value: unknown): TransitionReceipt | null {
  if (value === null) return null; const result = value as TransitionReceipt;
  if (!result || result.version !== 'scoped-transition-receipt-v1' || !hex.test(result.inputSha256) || !hex.test(result.resultSha256) || sha(json(result.resultJson)) !== result.resultSha256 || typeof result.replay !== 'boolean') throw invalid();
  return result;
}
function sqlError(error: unknown, committing: boolean): Error {
  if (error instanceof TransitionError || error instanceof RequestAccessError) return error;
  const code = (error as { code?: string })?.code;
  const known: Record<string,[number,string]> = { P7301:[409,'TRANSITION_IDEMPOTENCY_CONFLICT'],P7302:[409,'TRANSITION_STATE_CONFLICT'],P7303:[409,'TRANSITION_GENERATION_CHANGED'],P7304:[409,'TRANSITION_EVIDENCE_REQUIRED'],
    '42501':[403,'TRANSITION_OPERATOR_REQUIRED'],'22023':[400,'TRANSITION_INVALID'],'22P02':[400,'TRANSITION_INVALID'],'23514':[409,'TRANSITION_INVARIANT_CONFLICT'],'23505':[409,'TRANSITION_IDEMPOTENCY_CONFLICT'],
    '57014':[503,'TRANSITION_DATABASE_TIMEOUT'],'55P03':[503,'TRANSITION_DATABASE_TIMEOUT'],'40P01':[409,'TRANSITION_CONCURRENT_CHANGE'] };
  return code && known[code] ? new TransitionError(...known[code]) : new TransitionError(503, committing ? 'TRANSITION_COMMIT_UNKNOWN' : 'TRANSITION_DATABASE_UNAVAILABLE');
}
const settings = ['issuer','subject','account_id','account_revision','owner_id','student_id','application_target_id','job_id','worker_subject','transition_mode','transition_id','transition_generation','transition_operation'];
export function createPostgresTransitionRepository(options: { identity: RequestIdentityBoundary; requestPool: Pool; mappingPool?: Pool; now?: () => number; statementTimeoutMs?: number }): TransitionRepository {
  if (options.identity.mode !== 'service') throw denied();
  const now = options.now ?? Date.now, timeout = options.statementTimeoutMs ?? 5000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30000) throw invalid();
  async function current(context: AuthenticatedRequestContext) {
    const selected = await options.identity.revalidate(context); if (selected.mode !== 'authenticated' || !selected.scope) throw denied(); return selected;
  }
  async function operator(context: AuthenticatedRequestContext, capability: TransitionOperatorCapability, action: TransitionOperatorAction) {
    await assertTransitionOperatorCapability(capability,context,action,now);
  }
  async function tx<T>(context: AuthenticatedRequestContext, role: 'gakja_request'|'gakja_mapping', sql: string, args: unknown[], validate: (value: unknown, context: AuthenticatedRequestContext) => T,
    permit?: { capability: TransitionOperatorCapability; action: TransitionOperatorAction }): Promise<T> {
    const selected = await current(context); if (permit) await operator(selected,permit.capability,permit.action);
    let client: PoolClient | undefined, begun = false, healthy = true, committing = false;
    try {
      const pool = role === 'gakja_request' ? options.requestPool : options.mappingPool;
      if (!pool) throw new TransitionError(503,'TRANSITION_MAPPING_DEPENDENCY_REQUIRED');
      client = await pool.connect();
      const r = (await client.query(`SELECT current_user::text current,session_user::text session,r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,
       EXISTS(SELECT 1 FROM pg_roles p WHERE (p.rolsuper OR p.rolbypassrls OR p.rolname='gakja_owner') AND pg_has_role(current_user,p.oid,'MEMBER')) elevated FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
      if (!r || r.current !== role || r.session !== role || r.rolsuper || r.rolbypassrls || r.rolcreaterole || r.rolcreatedb || r.elevated) throw denied();
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED'); begun = true;
      const values = [selected.principal.issuer,selected.principal.subject,selected.account.accountId,selected.account.revision,selected.account.ownerId,selected.scope!.studentId,selected.scope!.applicationTargetId,'','','','','',''];
      for (let i = 0; i < settings.length; i++) await client.query('SELECT set_config($1,$2,true)',['gakja.' + settings[i],values[i]]);
      await client.query("SELECT set_config('statement_timeout',$1,true)",[String(timeout)]);
      const result = validate((await client.query(sql,args)).rows[0]?.value ?? null,selected);
      await client.query('SELECT gakja.transition_read()'); // final current account/grant guard, no external await in transaction
      options.identity.selectScope(selected,{}); committing = true; await client.query('COMMIT'); begun = false; options.identity.selectScope(selected,{}); return result;
    } catch (error) { if (client && begun) try { await client.query('ROLLBACK'); } catch { healthy = false; } throw sqlError(error,committing); }
    finally {
      if (client) { try { await client.query('RESET ALL'); healthy = healthy && (await client.query(`SELECT ${settings.map((_,i) => `coalesce(current_setting($${i+1},true),'')=''`).join(' AND ')} clean`,settings.map(key => 'gakja.'+key))).rows[0]?.clean === true; } catch { healthy = false; } client.release(!healthy); }
    }
  }
  const repository: TransitionRepository = {
    kind: 'postgres-scoped-transition-v1' as const,
    read: context => tx(context,'gakja_request','SELECT gakja.transition_read() value',[],snapshot),
    authorizeOperator: (context,action,capability) => tx(context,'gakja_mapping','SELECT gakja.transition_authorize_operator($1) value',[action],(value,ctx) => {
      const result=snapshot(value,ctx);if(!result)throw denied();return result;
    },{capability,action}),
    access: (context,operation,input = {}) => tx(context,'gakja_request','SELECT gakja.transition_access($1,$2,$3) value',[operation,input.expectedGeneration ?? null,input.sessionId ?? null],(value,ctx) => {
      const result = value as TransitionAccess; if (!result || !integer.test(result.generation) || !integer.test(result.fence)) throw invalid(); sameScope(result.scope,ctx); return result;
    }),
    async installOperator(context,input,capability) {
      const selected = await current(context), value = installers.get(capability);
      if (!value || now() >= value.expiresAt || value.key !== input.key || value.inputSha256 !== input.inputSha256 || value.issuer !== selected.principal.issuer || value.subject !== selected.principal.subject) throw denied();
      sameScope(value,selected); let allowed = false; try { allowed = await value.checkCurrent(); } catch { /* fail closed */ } if (!allowed || now() >= value.expiresAt) throw denied();
      const grant: TransitionOperatorGrant = input.grant;
      const grantExpiresAt=Date.parse(grant.expiresAt);
      if (!text(grant.issuer) || !text(grant.subject) || !grant.actions.length || grant.actions.some(action => !actions.includes(action)) || !Number.isFinite(grantExpiresAt) || grantExpiresAt <= 0 || grantExpiresAt > value.expiresAt || grantExpiresAt <= now()) throw invalid();
      const result = await tx(selected,'gakja_mapping','SELECT gakja.transition_install_operator($1::jsonb) value',[JSON.stringify({ ...input, sourceProofSha256: value.sourceProofSha256 })],snapshot);
      if (!result) throw invalid(); return result;
    },
    command: (context,input,capability) => {
      if (input.version !== 'scoped-transition-command-v1' || !text(input.key) || input.key.length > 160 || !integer.test(input.expectedGeneration) || sha(json(input.inputJson)) !== input.inputSha256) throw invalid();
      json(input.payloadJson); return tx(context,'gakja_mapping','SELECT gakja.transition_command($1::jsonb) value',[JSON.stringify(input)],value => { const result = receipt(value); if (!result) throw invalid(); return result; },{ capability,action: input.action });
    },
    receipt: (context,key,inputSha256,capability) => tx(context,'gakja_mapping','SELECT gakja.transition_receipt($1,$2) value',[key,inputSha256],receipt,{ capability,action:'status' }),
    beginOperation: (context,input) => tx(context,'gakja_request','SELECT gakja.transition_begin_operation($1::jsonb) value',[JSON.stringify({ ...input,expiresAt:new Date(Math.min(Date.parse(input.expiresAt),context.principal.expiresAt)).toISOString() })],(value,ctx) => {
      const result = value as Awaited<ReturnType<TransitionRepository['beginOperation']>>; if (!result || !integer.test(result.generation) || result.operationId !== input.operationId || !Number.isFinite(Date.parse(result.expiresAt))) throw invalid(); sameScope(result.scope,ctx); return result;
    }),
    async finishOperation(context,input) { await tx(context,'gakja_request','SELECT gakja.transition_finish_operation($1::jsonb) value',[JSON.stringify(input)],() => undefined); },
    exportRecovery: (context,capability) => tx(context,'gakja_mapping','SELECT gakja.transition_export_recovery() value',[],value => { const metadataJson = json(value); return { metadataJson,metadataSha256:sha(metadataJson) }; },{ capability,action:'export' }),
    restoreRecovery: (context,capability,input) => {
      if (sha(json(input.metadataJson)) !== input.metadataSha256 || !hex.test(input.manifestSha256)) throw invalid();
      return tx(context,'gakja_mapping','SELECT gakja.transition_restore_recovery($1,$2,$3,$4::jsonb) value',[input.metadataJson,input.metadataSha256,input.manifestSha256,JSON.stringify(input.locations)],value => value,{ capability,action:'restore' });
    },
  }; return Object.freeze(repository);
}
