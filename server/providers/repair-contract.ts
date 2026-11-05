import { createHash } from 'node:crypto';
import type { QuestionDraft } from '../protocol';

export type RepairContract = Readonly<{
  version: 'repair-contract-v1';
  originalText: string;
  target: string;
  primaryFunction: QuestionDraft['primaryFunction'];
  depth: QuestionDraft['depth'];
  action: 'FOLLOW_UP' | 'CLARIFICATION';
}>;

export type RepairDemandMatch = 'same' | 'changed' | 'uncertain';
export interface RepairCheck {
  version: 'repair-check-v1';
  contract: RepairContract;
  contractSha256: string;
  candidateQuestionSha256: string;
  verdict: 'same';
}

export class RepairContractError extends Error {
  constructor(code: 'REPAIR_MEANING_CHANGED' | 'REPAIR_MEANING_UNCERTAIN' | 'REPAIR_PROOF_INVALID') {
    super(code);
    this.name = 'RepairContractError';
  }
}

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** Reconstruct a flat, frozen object so field order and caller-owned references cannot change the binding. */
function canonicalContract(value: RepairContract): RepairContract {
  if (!value || value.version !== 'repair-contract-v1' || typeof value.originalText !== 'string' || !value.originalText.trim()
    || typeof value.target !== 'string' || !value.target.trim() || typeof value.primaryFunction !== 'string' || !value.primaryFunction
    || !['D1', 'D2', 'D3', 'D4'].includes(value.depth) || !['FOLLOW_UP', 'CLARIFICATION'].includes(value.action)) {
    throw new RepairContractError('REPAIR_PROOF_INVALID');
  }
  return Object.freeze({ version: value.version, originalText: value.originalText, target: value.target,
    primaryFunction: value.primaryFunction, depth: value.depth, action: value.action });
}

export function repairContractHash(contract: RepairContract): string {
  return sha(JSON.stringify(canonicalContract(contract)));
}

export function createRepairContract(draft: QuestionDraft): RepairContract {
  if (!['follow_up', 'clarification'].includes(draft.questionKind) || draft.targetEvidence.length !== 1) {
    throw new RepairContractError('REPAIR_PROOF_INVALID');
  }
  return canonicalContract({ version: 'repair-contract-v1', originalText: draft.questionText,
    target: draft.targetEvidence[0], primaryFunction: draft.primaryFunction, depth: draft.depth,
    action: draft.questionKind === 'follow_up' ? 'FOLLOW_UP' : 'CLARIFICATION' });
}

export function assertRepairContractMatchesDraft(contract: RepairContract, draft: QuestionDraft): void {
  const reference = canonicalContract(contract);
  if (draft.questionKind !== (reference.action === 'FOLLOW_UP' ? 'follow_up' : 'clarification')
    || draft.targetEvidence.length !== 1 || draft.targetEvidence[0] !== reference.target
    || draft.primaryFunction !== reference.primaryFunction || draft.depth !== reference.depth) {
    throw new RepairContractError('REPAIR_PROOF_INVALID');
  }
}

export function createRepairCheck(contract: RepairContract, draft: QuestionDraft, verdict: RepairDemandMatch): RepairCheck {
  if (verdict !== 'same') throw new RepairContractError(verdict === 'changed' ? 'REPAIR_MEANING_CHANGED' : 'REPAIR_MEANING_UNCERTAIN');
  assertRepairContractMatchesDraft(contract, draft);
  const reference = canonicalContract(contract);
  return Object.freeze({ version: 'repair-check-v1', contract: reference, contractSha256: repairContractHash(reference),
    candidateQuestionSha256: sha(draft.questionText), verdict });
}

/** Cached repair surfaces require this proof; ordinary and historical unrepaired drafts keep their existing shape. */
export function assertRepairProof(draft: QuestionDraft, expectedContract?: RepairContract, required = false): void {
  const proof = draft.premiseValidation?.repairCheck;
  if (!proof) {
    if (required || expectedContract) throw new RepairContractError('REPAIR_PROOF_INVALID');
    return;
  }
  if (proof.version !== 'repair-check-v1' || proof.verdict !== 'same'
    || proof.contractSha256 !== repairContractHash(proof.contract)
    || proof.candidateQuestionSha256 !== sha(draft.questionText)
    || expectedContract && proof.contractSha256 !== repairContractHash(expectedContract)) {
    throw new RepairContractError('REPAIR_PROOF_INVALID');
  }
  assertRepairContractMatchesDraft(proof.contract, draft);
}
