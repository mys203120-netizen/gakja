import 'server-only';
import { createHash } from 'node:crypto';
import { canonicalJson, hashLearningData, parseLearningHtml, validateGuidebook, validatePair, type LearningData } from '@gakja/content-contracts';
import { ApiError } from './db';
import { materialQuestionPracticeItems } from './material-learning-flow';

export const FINAL_GUIDEBOOK_CONTRACT = 'final-guidebook-v1';
export type PublicationVersion = { id: string; package_id: string; version: number; student_id: string; data: LearningData; learning_hash: string; production_job_ref: string; review: Record<string, any>; status: string };
export type PublicationDocument = { id: string; kind: string; data: any; html: string; file_hash: string };

/** Imported analysis must never replace a student's registered school identity. */
export function assertRegisteredTargets(learning: LearningData, targets: { id: string; data: Record<string, any> }[]) {
  for (const target of learning.support_targets) {
    const registered = targets.find(item => item.id === target.id);
    if (!registered) throw new ApiError(409, '교재의 지원처가 학생 계정에 등록되어 있지 않아요.');
    for (const key of ['university', 'campus', 'department', 'admission_type', 'admission_year'] as const) {
      if (String(target[key]).trim() !== String(registered.data[key] ?? '').trim()) throw new ApiError(409, `교재의 ${target.university} 지원 정보(${key})가 계정과 달라요. 지원 정보와 교재를 확인해 주세요.`);
    }
  }
}

export function learningLinkSummary(learning: LearningData) {
  const approved = new Set(['verified', 'approved', 'confirmed', 'synthetic_reviewed', 'confirmed_from_record', 'confirmed_by_student']);
  return learning.questions.map(question => ({
    question_id: question.id, activity_ids: question.activity_ids, support_target_ids: question.support_target_ids,
    interview_available: approved.has(question.verification_status),
    memory_item_ids: materialQuestionPracticeItems(question, learning.memory_items).map(item => item.id),
  }));
}

/** Preview and publish must refer to the same original file and structured data. */
export function validatePublication(version: PublicationVersion, documents: PublicationDocument[]) {
  if (hashLearningData(version.data) !== version.learning_hash) throw new ApiError(409, '등록된 학습 데이터가 변경되었어요. 새 버전으로 등록해 주세요.');
  const parsed = documents.map(document => {
    try {
      const parsed = parseLearningHtml(document.html);
      if (parsed.fileHash !== document.file_hash || parsed.pack.document.kind !== document.kind || canonicalJson(parsed.pack.document) !== canonicalJson(document.data)) throw new Error('원본과 저장된 교재가 다릅니다.');
      return parsed;
    } catch { throw new ApiError(409, '등록된 교재 원본을 확인할 수 없어요. 새 버전으로 등록해 주세요.'); }
  });
  const context = { studentId: version.student_id, productionJobRef: version.production_job_ref, registeredTargetIds: version.data.support_targets.map(target => target.id) };
  try {
    const content = version.review?.import_contract === FINAL_GUIDEBOOK_CONTRACT
      ? parsed.length === 1 ? validateGuidebook(parsed[0].pack, context) : null
      : validatePair(parsed.map(item => item.pack), context);
    if (!content || content.packageId !== version.package_id || content.contentVersion !== version.version || content.learningHash !== version.learning_hash || canonicalJson(content.learning) !== canonicalJson(version.data)) throw new Error('버전과 교재 데이터가 다릅니다.');
  } catch { throw new ApiError(409, '교재와 학습 데이터의 연결을 다시 확인해 주세요.'); }
  return parsed;
}

export function publicationDigest(version: PublicationVersion, documents: PublicationDocument[]) {
  return createHash('sha256').update(canonicalJson({
    id: version.id, package: version.package_id, version: version.version,
    learning_hash: version.learning_hash, production_job_ref: version.production_job_ref,
    documents: documents.map(document => ({ kind: document.kind, file_hash: document.file_hash, data: document.data })).sort((a, b) => a.kind.localeCompare(b.kind)),
  })).digest('hex');
}
