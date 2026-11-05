/** Offline source extraction contracts. No semantic classification is performed
 * by this module: it binds IDs/ranges and preserves independently sourced data. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { studentAnalysisCodecV2Schema, STUDENT_ANALYSIS_CODEC_VERSION, decodeStudentAnalysisV2, verifyStudentAnalysisSourceQuote, type AcademicRecord, type AnalysisProof, type FullRecordSource, type FullStudentAnalysis, type StudentAnalysisCodecV2 } from './full-student-analysis';

const ref = z.object({ kind: z.literal('proof_ref'), quoteId: z.number().int().positive() }).strict();
const refs = z.array(ref).max(20);
const span = studentAnalysisCodecV2Schema.shape.academicRecords.element.shape.literalValues.element.shape.valueSpan;
const rowBase = studentAnalysisCodecV2Schema.shape.academicRecords.element;
export const deepAcademicRowSchema = rowBase.omit({ literalValues: true }).extend({
  rowIndex: z.number().int().nonnegative().nullable(), rowLabel: span.nullable(),
  metadataProofRefs: z.object({ grade: refs, semester: refs, subject: refs, gradingSystem: refs }).strict(),
  cells: z.array(z.object({ kind: z.literal('academic_literal'), value: z.string().min(1).max(50), valueSpan: span, columnIndex: z.number().int().nonnegative().nullable(), columnLabel: span.nullable() }).strict()).max(8),
}).strict();

export const studentDeepBatchSchema = z.object({
  schemaVersion: z.literal('student-source-deep-batch-v1'),
  quoteDictionary: z.array(studentAnalysisCodecV2Schema.shape.quoteDictionary.element).max(300),
  activities: z.array(studentAnalysisCodecV2Schema.shape.activities.element).max(65),
  academicRecords: z.array(deepAcademicRowSchema).max(90),
  sourceReviews: z.array(z.object({
    sourceKey: z.string(), status: z.enum(['analyzed', 'administrative_excluded', 'identity_excluded', 'needs_review']),
    reason: z.string().min(5).max(150),
    units: z.array(z.object({ title: z.string().min(2).max(100), kind: z.enum(['activity', 'academic_table', 'career_context', 'teacher_observation', 'administrative', 'continuation']),
      proofRefs: refs, entityLocalIds: z.array(z.string()).max(30), disposition: z.enum(['structured', 'excluded', 'needs_review']), reason: z.string().min(3).max(180),
    }).strict()).max(40),
  }).strict()).max(20),
}).strict();
export type StudentDeepBatch = z.infer<typeof studentDeepBatchSchema>;
export function verifyDeepBatchQuotes(source: FullRecordSource, input: unknown, expectedSourceKeys: string[]) {
  const batch = studentDeepBatchSchema.parse(input);
  if (new Set(batch.quoteDictionary.map(row => row.id)).size !== batch.quoteDictionary.length) throw new Error('DEEP_BATCH_QUOTE_ID_DUPLICATE');
  for (const row of batch.quoteDictionary) {
    if (!expectedSourceKeys.includes(row.sourceKey)) throw new Error('DEEP_BATCH_QUOTE_OUTSIDE_SOURCE');
    try { verifyStudentAnalysisSourceQuote(source, { sourceKey: row.sourceKey, quote: row.quote }); }
    catch (error) { throw new Error(`DEEP_QUOTE_BINDING_FAILED:${row.id}:${row.sourceKey}:${error instanceof Error ? error.message : 'unknown'}:${row.quote}`); }
  }
  return batch;
}
export function applyReviewedDeepQuoteCorrections(input: unknown, reviewInput: unknown, source: FullRecordSource, responseFileSha256: string, phase: string) {
  const review = z.object({ schemaVersion:z.literal('bounded-deep-source-quote-review-v1'), phase:z.string(), sourcePdfSha256:z.string(), sourceContentSha256:z.string(), responseFileSha256:z.string(), corrections:z.array(z.object({ quoteId:z.number().int().positive(), sourceKey:z.string(), previousQuote:z.string(), previousQuoteSha256:z.string(), replacementQuote:z.string().min(2).max(420), replacementQuoteSha256:z.string(), replacementProof:z.object({sourceRefId:z.string(),page:z.number(),pageStart:z.number(),pageEnd:z.number(),quote:z.string(),sourceTextSha256:z.string()}).strict() }).passthrough()).min(1).max(10) }).passthrough().parse(reviewInput);
  if (review.phase!==phase||review.sourcePdfSha256!==source.pdfSha256||review.sourceContentSha256!==source.contentSha256||review.responseFileSha256!==responseFileSha256) throw new Error('DEEP_QUOTE_REVIEW_CONTEXT_MISMATCH');
  const result=studentDeepBatchSchema.parse(input), textSha=(text:string)=>createHash('sha256').update(text).digest('hex');
  if (new Set(review.corrections.map(row=>row.quoteId)).size!==review.corrections.length) throw new Error('DEEP_QUOTE_REVIEW_DUPLICATE');
  for(const correction of review.corrections){
    const quote=result.quoteDictionary.find(row=>row.id===correction.quoteId);
    if(!quote||quote.sourceKey!==correction.sourceKey||quote.quote!==correction.previousQuote||textSha(quote.quote)!==correction.previousQuoteSha256||textSha(correction.replacementQuote)!==correction.replacementQuoteSha256)throw new Error('DEEP_QUOTE_REVIEW_STALE');
    const proof=verifyStudentAnalysisSourceQuote(source,{sourceKey:correction.sourceKey,quote:correction.replacementQuote});
    if(JSON.stringify(proof)!==JSON.stringify(correction.replacementProof))throw new Error('DEEP_QUOTE_REVIEW_RANGE_MISMATCH');
    quote.quote=correction.replacementQuote;
  }
  return result;
}

const entityGroup = z.object({ canonicalLocalId: z.string(), memberLocalIds: z.array(z.string()).min(1).max(30), reason: z.string().min(5).max(240) }).strict();
export const studentDeepSynthesisSchema = z.object({
  schemaVersion: z.literal('student-source-deep-synthesis-v1'),
  activityGroups: z.array(entityGroup.extend({ title: z.string().min(3).max(90), grade: z.number().int().min(1).max(3).nullable(), area: z.string().max(60) }).strict()).max(200),
  academicGroups: z.array(entityGroup).max(150),
  trajectories: studentAnalysisCodecV2Schema.shape.trajectories,
  activityPriorities: studentAnalysisCodecV2Schema.shape.activityPriorities,
  objectives: studentAnalysisCodecV2Schema.shape.objectives,
  wholeRecordAxes: z.array(z.object({ axis: z.enum(['interest_start', 'recurring_topic', 'deepening', 'cross_subject', 'grade_year_change', 'career_change', 'inquiry_method', 'community_behavior', 'strength_evidence', 'record_gap', 'fact_check']),
    interpretation: z.string().min(3).max(700), basisProofRefs: refs, unknowns: z.array(z.string().max(180)).max(10), status: z.literal('source_bound_interpretation_not_causal_fact'),
  }).strict()).min(11).max(11),
}).strict();
export type StudentDeepSynthesis = z.infer<typeof studentDeepSynthesisSchema>;
type Activity = StudentAnalysisCodecV2['activities'][number];
type Academic = StudentAnalysisCodecV2['academicRecords'][number];
type Dictionary = StudentAnalysisCodecV2['quoteDictionary'];
export interface DeepCommonParts { quoteDictionary: Dictionary; activities: Activity[]; academicRecords: Academic[]; preservedTrajectories: StudentAnalysisCodecV2['trajectories']; sourceReviews: StudentDeepBatch['sourceReviews']; seedActivityIds: string[]; seedAcademicIds: string[] }
const fields = ['recordedContext', 'studentActions', 'teamActions', 'choiceReasons', 'outcomes', 'teacherObservations'] as const;
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unique = <T>(rows: T[]) => [...new Map(rows.map(row => [JSON.stringify(row), row])).values()];

/** Synthesis needs the actual values and their source IDs, not the repeated
 * row/column provenance tree already verified by the extraction codec. */
export function deepSynthesisProjection(parts: DeepCommonParts) {
  const academicLimits=[...new Set(parts.academicRecords.map(row=>row.interpretationLimit))];
  return { quoteDictionary: parts.quoteDictionary, seedActivityIds: parts.seedActivityIds, seedAcademicIds: parts.seedAcademicIds,preservedTrajectories:parts.preservedTrajectories,
    activities: parts.activities.map(row => ({ localId: row.localId, title: row.title, grade: row.grade, area: row.area,
      factQuoteIds: Object.fromEntries(fields.map(field => [field, row.factProofRefs[field].map(proof => proof.quoteId)])), unknowns: row.unknowns })),
    academicLimits,
    academicRecords: parts.academicRecords.map(row => ({ localId: row.localId, grade: row.grade, semester: row.semester, subject: row.subject, gradingSystem: row.gradingSystem,
      literalValues: row.literalValues.map(cell => ({ value: cell.value, column:cell.provenance.columnLabel?.literal??null,columnIndex:cell.provenance.columnIndex,quoteId:cell.valueSpan.proofRef.quoteId })), proofQuoteIds: row.proofRefs.map(ref=>ref.quoteId), tableStructure: row.tableStructure.status, interpretationLimitIndex:academicLimits.indexOf(row.interpretationLimit) })),
    sourceReviews: parts.sourceReviews.map(row => ({ sourceKey: row.sourceKey, status: row.status, reason: row.reason, units: row.units.map(unit => ({ title: unit.title, kind: unit.kind, proofQuoteIds: unit.proofRefs.map(ref=>ref.quoteId), entityLocalIds: unit.entityLocalIds, disposition: unit.disposition })) })),
  };
}

/** A table-reader catalog is data, not permission to inherit a model's review.
 * Every literal/header quote is rebound; model row aliases require the same
 * grade/term/subject and a common actual physical row range. */
export function mergeSourceReviewedAcademicCatalog(parts: DeepCommonParts, input: unknown, source: FullRecordSource, parentCommonContentSha256: string) {
  const schema = z.object({ schemaVersion: z.literal('reviewed-complete-academic-catalog-v1'), status: z.literal('requires_independent_review'), sourcePdfSha256: z.string(), sourceContentSha256: z.string(), parentCommonContentSha256: z.string(),
    quoteDictionary: studentAnalysisCodecV2Schema.shape.quoteDictionary, academicRecords: studentAnalysisCodecV2Schema.shape.academicRecords,
    catalog: z.array(z.object({ localId: z.string(), rowProof: z.object({ sourceRefId: z.string(), page: z.number(), pageStart: z.number(), pageEnd: z.number(), quote: z.string(), sourceTextSha256: z.string() }).strict() }).passthrough()),
  }).passthrough();
  const catalog = schema.parse(input);
  const explicitAliases=z.array(z.object({previousLocalId:z.string(),currentLocalId:z.string(),previousMetadata:z.object({grade:z.number().nullable(),semester:z.number().nullable(),subject:z.string().nullable(),gradingSystem:z.string(),structureStatus:z.string()}).strict(),previousProofs:z.array(z.object({sourceRefId:z.string(),page:z.number(),pageStart:z.number(),pageEnd:z.number(),quote:z.string(),sourceTextSha256:z.string()}).strict())}).passthrough()).parse(catalog.modelAliases??[]);
  if(new Set(explicitAliases.map(row=>row.previousLocalId)).size!==explicitAliases.length)throw new Error('DEEP_CATALOG_EXPLICIT_ALIAS_DUPLICATE');
  if (catalog.sourcePdfSha256 !== source.pdfSha256 || catalog.sourceContentSha256 !== source.contentSha256 || catalog.parentCommonContentSha256 !== parentCommonContentSha256) throw new Error('DEEP_ACADEMIC_CATALOG_CONTEXT_MISMATCH');
  const result = structuredClone(parts), mapping = new Map<number,number>();
  for (const quote of catalog.quoteDictionary) {
    if (mapping.has(quote.id)) throw new Error('DEEP_CATALOG_QUOTE_ID_DUPLICATE');
    verifyStudentAnalysisSourceQuote(source,{sourceKey:quote.sourceKey,quote:quote.quote});
    let existing = result.quoteDictionary.find(row => row.sourceKey === quote.sourceKey && row.quote === quote.quote);
    if (!existing) { existing = {...quote,id:result.quoteDictionary.length+1}; result.quoteDictionary.push(existing); }
    mapping.set(quote.id,existing.id);
  }
  const records = remap(catalog.academicRecords,mapping);
  if (new Set(records.map(row => row.localId)).size !== records.length || catalog.catalog.length !== records.length || new Set(catalog.catalog.map(row => row.localId)).size !== records.length || records.some(row => !catalog.catalog.some(item => item.localId === row.localId))) throw new Error('DEEP_CATALOG_ROW_ID_INVALID');
  for (const item of catalog.catalog) {
    const p=item.rowProof, block=source.blocks.find(row => row.id === p.sourceRefId), page=source.pages.find(row => row.page===p.page);
    if (!block || !page || block.page!==p.page || p.pageStart<block.startOffset || p.pageEnd>block.endOffset || p.pageEnd<=p.pageStart || page.text.slice(p.pageStart,p.pageEnd)!==p.quote || p.sourceTextSha256!==block.textSha256) throw new Error('DEEP_CATALOG_PHYSICAL_ROW_INVALID');
  }
  const aliases = new Map<string,string>();
  const normalized = (text:string|null) => (text??'').normalize('NFC').replace(/\s/gu,'');
  for (const previous of result.academicRecords) {
    const direct=records.find(row=>row.localId===previous.localId);
    if (parts.seedAcademicIds.includes(previous.localId)) {
      const preservedFields=['localId','grade','semester','subject','gradingSystem','proofRefs','literalValues','tableStructure','interpretationLimit'] as const;
      if (!direct || !isDeepStrictEqual(preservedFields.map(field=>direct[field]),preservedFields.map(field=>previous[field]))) throw new Error('DEEP_CATALOG_CHANGED_PRESERVED_ROW:'+previous.localId);
      aliases.set(previous.localId,previous.localId);continue;
    }
    const bound=previous.proofRefs.map(ref=>{const q=result.quoteDictionary.find(row=>row.id===ref.quoteId);if(!q)throw new Error('DEEP_CATALOG_MODEL_PROOF_MISSING');return verifyStudentAnalysisSourceQuote(source,{sourceKey:q.sourceKey,quote:q.quote});});
    const matches=records.filter(row=>row.grade===previous.grade&&row.semester===previous.semester&&normalized(row.subject)===normalized(previous.subject)).filter(row=>{
      const p=catalog.catalog.find(item=>item.localId===row.localId)!.rowProof;
      return bound.some(b=>b.sourceRefId===p.sourceRefId&&(b.pageStart<=p.pageStart&&b.pageEnd>=p.pageEnd||p.pageStart<=b.pageStart&&p.pageEnd>=b.pageEnd));
    });
    let selected=matches.length===1?matches[0]:null;
    if(!selected){
      const review=explicitAliases.find(row=>row.previousLocalId===previous.localId),target=review?records.find(row=>row.localId===review.currentLocalId):null;
      const previousMetadata={grade:previous.grade,semester:previous.semester,subject:previous.subject,gradingSystem:previous.gradingSystem,structureStatus:previous.tableStructure.status};
      const physical=target?catalog.catalog.find(row=>row.localId===target.localId)?.rowProof:null;
      if(!review||!target||!physical||!isDeepStrictEqual(review.previousMetadata,previousMetadata)||!isDeepStrictEqual(review.previousProofs,bound)||previous.grade!==null&&previous.grade!==target.grade||previous.semester!==null&&previous.semester!==target.semester||previous.subject!==null&&normalized(previous.subject)!==normalized(target.subject)||!bound.some(b=>b.sourceRefId===physical.sourceRefId&&b.pageStart<=physical.pageStart&&b.pageEnd>=physical.pageEnd))throw new Error('DEEP_CATALOG_MODEL_ROW_PHYSICAL_MATCH_REQUIRED:'+previous.localId);
      selected=target;
    }
    aliases.set(previous.localId,selected.localId);
  }
  for (const review of result.sourceReviews) for (const unit of review.units) {
    unit.entityLocalIds=unique(unit.entityLocalIds.map(id=>aliases.get(id)??id));
    if(unit.kind==='academic_table'){
      const blockIndex=Number(review.sourceKey.slice(1))-1,block=source.blocks[blockIndex];
      const tableRows=catalog.catalog.filter(item=>item.rowProof.sourceRefId===block?.id).flatMap(item=>records.find(row=>row.localId===item.localId)??[]);
      unit.entityLocalIds=unique([...unit.entityLocalIds,...tableRows.map(row=>row.localId)]);
      unit.proofRefs=unique([...unit.proofRefs,...tableRows.map(row=>row.proofRefs[0])]);
      if(unit.entityLocalIds.length>30||unit.proofRefs.length>20)throw new Error('DEEP_CATALOG_UNIT_BINDING_BOUND_EXCEEDED');
    }
  }
  result.academicRecords=records;result.seedAcademicIds=records.map(row=>row.localId);
  return {parts:result,aliases:[...aliases].map(([previousLocalId,currentLocalId])=>({previousLocalId,currentLocalId})),verifiedCatalogRows:records.length};
}

/** A fresh wire quote needs enough original context to bind uniquely. Never
 * serialize a bare repeated grade digit as if it were a unique source quote. */
export function encodePreservedAnalysis(common: FullStudentAnalysis, source: FullRecordSource): DeepCommonParts {
  const quoteDictionary: Dictionary = [];
  const bind = (proof: AnalysisProof) => {
    const index = source.blocks.findIndex(block => block.id === proof.sourceRefId), block = source.blocks[index];
    if (!block || block.page !== proof.page || block.textSha256 !== proof.sourceTextSha256 || source.pages.find(page => page.page === proof.page)?.text.slice(proof.pageStart, proof.pageEnd) !== proof.quote) throw new Error('DEEP_SEED_PROOF_INVALID');
    let start = proof.pageStart - block.startOffset, end = proof.pageEnd - block.startOffset;
    let quote = block.text.slice(start, end);
    const canonical = (text: string) => text.replace(/\s/gu, '');
    const blockText = canonical(block.text);
    while (quote.length <= 400 && (blockText.indexOf(canonical(quote)) !== blockText.lastIndexOf(canonical(quote)))) {
      start = Math.max(0, start - 20); end = Math.min(block.text.length, end + 20); quote = block.text.slice(start, end);
    }
    if (quote.length > 420 || !quote.trim() || blockText.indexOf(canonical(quote)) !== blockText.lastIndexOf(canonical(quote))) throw new Error('DEEP_SEED_QUOTE_NOT_UNIQUE');
    const key = `B${index + 1}`;
    let entry = quoteDictionary.find(row => row.sourceKey === key && row.quote === quote);
    if (!entry) { entry = { id: quoteDictionary.length + 1, sourceKey: key, quote }; quoteDictionary.push(entry); }
    return { proofRef: { kind: 'proof_ref' as const, quoteId: entry.id }, binding: 'offsets' as const, start: proof.pageStart - block.startOffset - start, end: proof.pageEnd - block.startOffset - start, literal: proof.quote };
  };
  const proofRef = (proof: AnalysisProof) => bind(proof).proofRef;
  const interpretation = (rows: NonNullable<FullStudentAnalysis['activities'][number]['interpretations']>) => rows.map(row => ({ field: row.field as Activity['interpretations'][number]['field'], text: row.text, basisProofRefs: row.basisProofs.map(proofRef) }));
  const activities: Activity[] = common.activities.map(row => ({ localId: row.localId, title: row.title, grade: row.grade, area: row.area, factProofRefs: Object.fromEntries(fields.map(field => [field, row.facts[field].map(proofRef)])) as Activity['factProofRefs'], interpretations: interpretation(row.interpretations ?? []), unknowns: row.unknowns }));
  const academicRecords: Academic[] = common.academicRecords.filter(row => row.tableStructure?.status === 'resolved').map(row => ({ localId: row.localId, grade: row.grade, semester: row.semester, subject: row.subject, gradingSystem: row.gradingSystem, proofRefs: row.proofs.map(proofRef), interpretationLimit: row.interpretationLimit, tableStructure: row.tableStructure!, interpretations: interpretation(row.interpretations ?? []), literalValues: (row.literalValues ?? []).map(cell => ({ kind: 'academic_literal', value: cell.value, valueSpan: bind(cell.valueProof), provenance: { rowIndex: cell.provenance.rowIndex, columnIndex: cell.provenance.columnIndex, rowLabel: cell.provenance.rowLabel ? bind(cell.provenance.rowLabel) : null, columnLabel: cell.provenance.columnLabel ? bind(cell.provenance.columnLabel) : null, grade: row.grade, semester: row.semester, subject: row.subject, gradingSystem: row.gradingSystem, structureStatus: 'resolved', gradeProofRefs: cell.provenance.gradeProofs.map(proofRef), semesterProofRefs: cell.provenance.semesterProofs.map(proofRef), subjectProofRefs: cell.provenance.subjectProofs.map(proofRef), gradingSystemProofRefs: cell.provenance.gradingSystemProofs.map(proofRef) } })) }));
  const entityIds=new Map([...common.activities,...common.academicRecords].map(row=>[row.id,row.localId]));
  const preservedTrajectories=(common.trajectories??[]).map(row=>{
    const fromLocalId=entityIds.get(row.fromEntityId),toLocalId=entityIds.get(row.toEntityId);
    if(!fromLocalId||!toLocalId||![...activities,...academicRecords].some(item=>item.localId===fromLocalId)||![...activities,...academicRecords].some(item=>item.localId===toLocalId))throw new Error('DEEP_SEED_TRAJECTORY_ENTITY_NOT_PRESERVED');
    return {fromLocalId,toLocalId,relationship:row.relationship as StudentAnalysisCodecV2['trajectories'][number]['relationship'],rationale:row.rationale,proofRefs:row.proofs.map(proofRef)};
  });
  return { quoteDictionary, activities, academicRecords,preservedTrajectories, sourceReviews: [], seedActivityIds: activities.map(row => row.localId), seedAcademicIds: academicRecords.map(row => row.localId) };
}

export function expandDeepAcademicRow(row: z.infer<typeof deepAcademicRowSchema>): Academic {
  const { rowIndex, rowLabel, metadataProofRefs, cells, ...body } = row;
  return { ...body, literalValues: cells.map(cell => ({ kind: cell.kind, value: cell.value, valueSpan: cell.valueSpan, provenance: { rowIndex, columnIndex: cell.columnIndex, rowLabel, columnLabel: cell.columnLabel, grade: row.grade, semester: row.semester, subject: row.subject, gradingSystem: row.gradingSystem, structureStatus: row.tableStructure.status, gradeProofRefs: metadataProofRefs.grade, semesterProofRefs: metadataProofRefs.semester, subjectProofRefs: metadataProofRefs.subject, gradingSystemProofRefs: metadataProofRefs.gradingSystem } })) };
}
function remap<T>(value: T, mapping: Map<number, number>): T {
  if (Array.isArray(value)) return value.map(item => remap(item, mapping)) as T;
  if (!value || typeof value !== 'object') return value;
  const row = value as Record<string, unknown>;
  if (row.kind === 'proof_ref') { const id = mapping.get(row.quoteId as number); if (!id) throw new Error('DEEP_QUOTE_ID_MISSING'); return { kind: 'proof_ref', quoteId: id } as T; }
  return Object.fromEntries(Object.entries(row).map(([key, child]) => [key, remap(child, mapping)])) as T;
}
/** The LLM supplies the content and source dispositions. This function only
 * checks source ownership, typed references, ID namespaces and preservation. */
export function combineDeepBatches(seed: DeepCommonParts, batches: Array<{ sourceKeys: string[]; namespace: string; output: unknown }>, source: FullRecordSource, options: { allowPartialSources?: boolean } = {}): DeepCommonParts {
  const result = structuredClone(seed);
  for (const batch of batches) {
    const parsed = studentDeepBatchSchema.parse(batch.output);
    if (parsed.sourceReviews.length !== batch.sourceKeys.length || new Set(parsed.sourceReviews.map(row => row.sourceKey)).size !== batch.sourceKeys.length || batch.sourceKeys.some(key => !parsed.sourceReviews.some(row => row.sourceKey === key))) throw new Error('DEEP_BATCH_SOURCE_COVERAGE_INVALID');
    const map = new Map<number, number>();
    for (const row of parsed.quoteDictionary) {
      if (!batch.sourceKeys.includes(row.sourceKey) || map.has(row.id)) throw new Error('DEEP_BATCH_SOURCE_OR_QUOTE_NAMESPACE_INVALID');
      let entry = result.quoteDictionary.find(item => item.sourceKey === row.sourceKey && item.quote === row.quote);
      if (!entry) { entry = { ...row, id: result.quoteDictionary.length + 1 }; result.quoteDictionary.push(entry); }
      map.set(row.id, entry.id);
    }
    const local = remap({ activities: parsed.activities, academicRecords: parsed.academicRecords.map(expandDeepAcademicRow), sourceReviews: parsed.sourceReviews }, map);
    for (const activity of local.activities) {
      if (!seed.seedActivityIds.includes(activity.localId) && !activity.localId.startsWith(batch.namespace)) throw new Error('DEEP_ACTIVITY_NAMESPACE_INVALID');
      const previous = result.activities.find(row => row.localId === activity.localId);
      if (previous) {
        for (const field of fields) previous.factProofRefs[field] = unique([...previous.factProofRefs[field], ...activity.factProofRefs[field]]);
        previous.interpretations = unique([...previous.interpretations, ...activity.interpretations]); previous.unknowns = unique([...previous.unknowns, ...activity.unknowns]);
      } else result.activities.push(activity);
    }
    for (const record of local.academicRecords) {
      if (!seed.seedAcademicIds.includes(record.localId) && !record.localId.startsWith(batch.namespace)) throw new Error('DEEP_ACADEMIC_NAMESPACE_INVALID');
      const previous = result.academicRecords.find(row => row.localId === record.localId);
      if (previous) {
        if (JSON.stringify([previous.grade, previous.semester, previous.subject, previous.gradingSystem]) !== JSON.stringify([record.grade, record.semester, record.subject, record.gradingSystem])) throw new Error('DEEP_PRESERVED_ACADEMIC_METADATA_CHANGED');
        // A reviewed seed row remains the authoritative literal/provenance row.
        previous.interpretations = unique([...previous.interpretations, ...record.interpretations]);
      } else result.academicRecords.push(record);
    }
    result.sourceReviews.push(...local.sourceReviews);
  }
  const expectedSourceCount = options.allowPartialSources ? new Set(batches.flatMap(row => row.sourceKeys)).size : source.blocks.length;
  if (new Set(result.sourceReviews.map(row => row.sourceKey)).size !== expectedSourceCount || result.sourceReviews.length !== expectedSourceCount) throw new Error('DEEP_SOURCE_INVENTORY_INCOMPLETE');
  const dictionaryIds = new Set(result.quoteDictionary.map(row => row.id));
  const entities = new Set([...result.activities, ...result.academicRecords].map(row => row.localId));
  for (const row of result.sourceReviews) {
    if (!row.units.length) throw new Error('DEEP_SOURCE_REVIEW_WITHOUT_UNITS');
    if (row.units.some(unit => unit.entityLocalIds.some(id => !entities.has(id)) || unit.proofRefs.some(proof => !dictionaryIds.has(proof.quoteId)))) throw new Error('DEEP_SOURCE_REVIEW_BINDING_INVALID');
    if (row.status === 'analyzed' && row.units.some(unit => unit.disposition === 'needs_review')) throw new Error('DEEP_UNRESOLVED_UNIT_MARKED_ANALYZED');
  }
  return result;
}

export function materializeDeepWire(parts: DeepCommonParts, input: unknown, source: FullRecordSource): StudentAnalysisCodecV2 {
  const synthesis = studentDeepSynthesisSchema.parse(input);
  const activityIndex = new Map(parts.activities.map(row => [row.localId, row])), academicIndex = new Map(parts.academicRecords.map(row => [row.localId, row]));
  const validateGroups = (groups: z.infer<typeof entityGroup>[], ids: string[], seeds: string[]) => {
    const members = groups.flatMap(row => row.memberLocalIds);
    if (members.length !== ids.length || new Set(members).size !== ids.length || ids.some(id => !members.includes(id)) || groups.some(row => !row.memberLocalIds.includes(row.canonicalLocalId)) || seeds.some(id => !groups.some(group => group.canonicalLocalId === id))) throw new Error('DEEP_ENTITY_GROUP_COVERAGE_OR_PRESERVATION_INVALID');
  };
  validateGroups(synthesis.activityGroups, [...activityIndex.keys()], parts.seedActivityIds);
  validateGroups(synthesis.academicGroups, [...academicIndex.keys()], parts.seedAcademicIds);
  const orderedGroups = [...synthesis.activityGroups].sort((a,b) => {
    const ai = parts.seedActivityIds.indexOf(a.canonicalLocalId), bi = parts.seedActivityIds.indexOf(b.canonicalLocalId);
    return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi);
  });
  const activities = orderedGroups.map(group => {
    const members = group.memberLocalIds.map(id => activityIndex.get(id)!);
    return { localId: group.canonicalLocalId, title: group.title, grade: group.grade, area: group.area, factProofRefs: Object.fromEntries(fields.map(field => [field, unique(members.flatMap(row => row.factProofRefs[field]))])) as Activity['factProofRefs'], interpretations: unique(members.flatMap(row => row.interpretations)), unknowns: unique(members.flatMap(row => row.unknowns)) };
  });
  const academicRecords = synthesis.academicGroups.map(group => academicIndex.get(group.canonicalLocalId)!);
  if (synthesis.activityPriorities.length !== activities.length || new Set(synthesis.activityPriorities.map(row => row.activityLocalId)).size !== activities.length || activities.some(row => !synthesis.activityPriorities.some(priority => priority.activityLocalId === row.localId))) throw new Error('DEEP_PRIORITY_ENTITY_COVERAGE_INVALID');
  const axes = synthesis.wholeRecordAxes.map(row => row.axis);
  if (new Set(axes).size !== 11) throw new Error('DEEP_WHOLE_RECORD_AXES_INCOMPLETE');
  const knownIds = new Set(parts.quoteDictionary.map(row => row.id));
  if (synthesis.wholeRecordAxes.some(row => row.basisProofRefs.some(proof => !knownIds.has(proof.quoteId)))) throw new Error('DEEP_SYNTHESIS_PROOF_MISSING');
  const trajectories=[...parts.preservedTrajectories,...synthesis.trajectories.filter(row=>!parts.preservedTrajectories.some(saved=>saved.fromLocalId===row.fromLocalId&&saved.toLocalId===row.toLocalId))];
  const wire = studentAnalysisCodecV2Schema.parse({ schemaVersion: 'student-analysis-wire-v2', codecVersion: STUDENT_ANALYSIS_CODEC_VERSION, quoteDictionary: parts.quoteDictionary, activities, academicRecords, trajectories, sourceDispositions: parts.sourceReviews.map(({ sourceKey, status, reason }) => ({ sourceKey, status, reason })), activityPriorities: synthesis.activityPriorities, objectives: synthesis.objectives });
  decodeStudentAnalysisV2(source, wire);
  return wire;
}

export function preservedAcademicRowSignature(record: AcademicRecord) {
  return sha({ localId: record.localId, grade: record.grade, semester: record.semester, subject: record.subject, gradingSystem: record.gradingSystem, literalValues: record.literalValues });
}
