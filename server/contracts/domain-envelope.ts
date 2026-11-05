import { createHash } from 'node:crypto';
import { z } from 'zod';
import { analysisDomainSchemas } from './analysis-domain-codecs';
import { decodeAnalysisWireV2PreservingOrder, decodeFullAnalysisPreservingOrder, decodeTargetAnalysisPreservingOrder } from './analysis-domain-adapters';
import { approvedQuestionContractSchema, preparedMainCandidateSchema, studentObjectiveCandidateSchema,
  decodeApprovedQuestionContract, decodePreparedMainCandidate, decodeStudentObjectiveCandidate } from './question-domain-codecs';
import type { FullRecordSource } from '../data/full-student-analysis';
import type { QuestionDraft } from '../protocol';

export const domainSchemas = { ...analysisDomainSchemas, 'student-objective-candidate': studentObjectiveCandidateSchema,
  'prepared-main-candidate': preparedMainCandidateSchema, 'approved-question-contract': approvedQuestionContractSchema };
export type DomainKind = keyof typeof domainSchemas;
const pin = z.string().min(1).nullable();
export const domainScopeSchema = z.object({ ownerId: pin, studentId: pin, supportTargetId: pin, sourceRevision: pin,
  recordRevision: pin, sourceContentSha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  analysisRevision: pin, profileRevision: pin, bankKey: pin }).strict();
export type DomainScope = z.infer<typeof domainScopeSchema>;
export const domainEnvelopeSchema = z.object({ envelopeVersion: z.literal('existing-domain-envelope-v1'),
  kind: z.enum(Object.keys(domainSchemas) as [DomainKind, ...DomainKind[]]), payloadVersion: z.string().min(1),
  scope: domainScopeSchema, payloadJson: z.string().min(1), payloadSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  authority: z.literal('transport_only_not_approval_or_authentication') }).strict();
export type DomainEnvelope = z.infer<typeof domainEnvelopeSchema>;
export const emptyDomainScope = (): DomainScope => ({ ownerId: null, studentId: null, supportTargetId: null, sourceRevision: null,
  recordRevision: null, sourceContentSha256: null, analysisRevision: null, profileRevision: null, bankKey: null });
export const transportDigest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const wellFormed = (value: string) => !/[\uD800-\uDFFF]/u.test(value);

/** Reject ambiguous JSON transport; domain files are not rewritten. A Python
 * consumer forwards payloadJson exactly, never reserializes legacy hash bodies. */
export function parseTransportJson(raw: string): unknown {
  const value: unknown = JSON.parse(raw);
  const frames: (Set<string> | null)[] = [];
  const tokens = raw.match(/"(?:[^"\\]|\\[\s\S])*"|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/gu) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '{') frames.push(new Set()); else if (token === '[') frames.push(null);
    else if (token === '}' || token === ']') frames.pop();
    else if (token.startsWith('"') && tokens[i + 1] === ':') {
      const key = JSON.parse(token) as string, keys = frames.at(-1);
      if (!keys || keys.has(key)) throw new Error('DOMAIN_TRANSPORT_DUPLICATE_KEY'); keys.add(key);
    }
  }
  const visit = (item: unknown): void => {
    if (typeof item === 'string' && !wellFormed(item)) throw new Error('DOMAIN_TRANSPORT_UNPAIRED_SURROGATE');
    if (typeof item === 'number' && (!Number.isFinite(item) || Number.isInteger(item) && !Number.isSafeInteger(item))) throw new Error('DOMAIN_TRANSPORT_NUMBER_RANGE');
    if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) { visit(key); visit(child); }
  };
  visit(value); return value;
}
export function domainPayloadVersion(kind: DomainKind, value: unknown): string {
  const row = value as Record<string, unknown>;
  if (kind === 'full-student-analysis' || kind === 'target-student-analysis') return String(row.schemaVersion);
  if (kind === 'approved-question-contract') return String(row.version);
  return kind === 'student-analysis-codec-v2' ? kind : 'unversioned';
}
export function assertDomainScope(kind: DomainKind, value: unknown, scope: DomainScope): void {
  const row = value as Record<string, unknown>;
  for (const key of ['studentId', 'supportTargetId', 'recordRevision', 'sourceContentSha256', 'profileRevision'] as const) {
    if (typeof row[key] === 'string' && scope[key] !== row[key]) throw new Error('DOMAIN_SCOPE_MISMATCH:' + key);
  }
  const revision = kind === 'full-student-analysis' ? row.revision : row.analysisRevision;
  if (typeof revision === 'string' && scope.analysisRevision !== revision) throw new Error('DOMAIN_SCOPE_MISMATCH:analysisRevision');
  // Existing common-module target pins are sometimes nested, never inferred
  // from a ROLE label or copied into an evaluation authorization.
  const visit = (item: unknown): void => {
    if (!item || typeof item !== 'object') return;
    if (Array.isArray(item)) { item.forEach(visit); return; }
    const record = item as Record<string, unknown>;
    if (typeof record.supportTargetId === 'string' && record.supportTargetId !== scope.supportTargetId) throw new Error('DOMAIN_SCOPE_MISMATCH:supportTargetId');
    Object.values(record).forEach(visit);
  };
  visit(value);
}
/** Shared TS/Python validation: shape, Unicode string limits, byte integrity and
 * carried scope. This does not authenticate the caller or approve content. */
export function inspectDomainEnvelope(input: unknown, expectedScope: Partial<DomainScope> = {}): { envelope: DomainEnvelope; payload: unknown } {
  domainEnvelopeSchema.parse(input); const envelope = structuredClone(input) as DomainEnvelope;
  parseTransportJson(JSON.stringify(envelope.scope));
  for (const [key, value] of Object.entries(expectedScope)) if (envelope.scope[key as keyof DomainScope] !== value) throw new Error('DOMAIN_EXPECTED_SCOPE_MISMATCH:' + key);
  if (transportDigest(envelope.payloadJson) !== envelope.payloadSha256) throw new Error('DOMAIN_TRANSPORT_HASH_CHANGED');
  const payload = parseTransportJson(envelope.payloadJson);
  domainSchemas[envelope.kind].parse(payload);
  if (domainPayloadVersion(envelope.kind, payload) !== envelope.payloadVersion) throw new Error('DOMAIN_PAYLOAD_VERSION_MISMATCH');
  assertDomainScope(envelope.kind, payload, envelope.scope);
  return { envelope, payload };
}
export interface DomainDecodeContext { source?: FullRecordSource; draft?: QuestionDraft }
function sourcePins(context: DomainDecodeContext): Partial<DomainScope> {
  const source = context.source;
  return source ? { studentId: source.studentId, sourceRevision: source.revision, recordRevision: source.recordRevision, sourceContentSha256: source.contentSha256 } : {};
}
function decodeDomain(kind: DomainKind, value: unknown, context: DomainDecodeContext): unknown {
  switch (kind) {
    case 'student-analysis-codec-v2':
      if (!context.source) throw new Error('DOMAIN_SOURCE_CONTEXT_REQUIRED');
      return decodeAnalysisWireV2PreservingOrder(context.source, value);
    case 'full-student-analysis': return decodeFullAnalysisPreservingOrder(value);
    case 'target-student-analysis': return decodeTargetAnalysisPreservingOrder(value);
    case 'student-objective-candidate': return decodeStudentObjectiveCandidate(value);
    case 'prepared-main-candidate': return decodePreparedMainCandidate(value);
    case 'approved-question-contract': return decodeApprovedQuestionContract(value, context);
  }
}
/** Existing version stays existing: no v1->v2 relabel, new IDs or approval. */
export function createDomainEnvelope(kind: DomainKind, value: unknown, scope: DomainScope, context: DomainDecodeContext = {}): DomainEnvelope {
  const decoded = decodeDomain(kind, value, context), payloadJson = JSON.stringify(decoded);
  const envelope: DomainEnvelope = { envelopeVersion: 'existing-domain-envelope-v1', kind, payloadVersion: domainPayloadVersion(kind, decoded),
    scope: structuredClone(scope), payloadJson, payloadSha256: transportDigest(payloadJson), authority: 'transport_only_not_approval_or_authentication' };
  inspectDomainEnvelope(envelope, sourcePins(context)); return envelope;
}
export function decodeDomainEnvelope(input: unknown, context: DomainDecodeContext = {}): unknown {
  const { envelope, payload } = inspectDomainEnvelope(input, sourcePins(context)); return decodeDomain(envelope.kind, payload, context);
}

/** Canonical source coordinate helper, not an assertion of source authority. */
export function verifyUtf16Span(source: string, start: number, end: number, quote: string): boolean {
  return wellFormed(source) && wellFormed(quote) && Number.isSafeInteger(start) && Number.isSafeInteger(end) &&
    start >= 0 && end > start && end <= source.length && wellFormed(source.slice(start, end)) && source.slice(start, end) === quote;
}
