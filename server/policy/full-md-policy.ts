import { createHash } from 'node:crypto';
import { interviewConfig } from '../../interview.config';
import { compactInterviewerPolicyInstructions, type InterviewerPolicyPack } from './interviewer-policy';

export const FULL_MD_POLICY_VERSION = 'full-interviewer-md-originals-v1';
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
/** Explicit order keeps shared instruction prefixes stable across turns and sessions. */
export const fullMdPolicyRoles = [
  'glossary', 'brandGuidelines', 'guidebookGuidelines', 'prdGuidelines',
  'studentAnalysisGuidelines', 'schoolGuidelines', 'productionGuidelines',
  'operatingGuidelines', 'questionGuidelines', 'evaluationGuidelines',
  'termsDraft', 'studentUxGuidelines',
] as const;
export interface FullMdPolicyOriginals {
  version: typeof FULL_MD_POLICY_VERSION;
  contentSha256: string;
  documents: Array<{ role: typeof fullMdPolicyRoles[number]; path: string; sha256: string; text: string }>;
}
interface InputFile { role: string; path: string; sha256: string | null; bytes: Buffer | null }
interface PolicyContext {
  manifest: { files: Array<{ role: string; path: string; sha256: string | null }>; interviewerPolicy?: { contentSha256: string } | null };
  interviewerPolicy?: InterviewerPolicyPack | null;
  fullMdPolicyOriginals?: FullMdPolicyOriginals;
}
const bodyHash = (documents: FullMdPolicyOriginals['documents']) => sha(JSON.stringify({ version: FULL_MD_POLICY_VERSION, documents }));

/** Capture the exact UTF-8 originals that were already read and hashed by the context loader. */
export function captureFullMdPolicyOriginals(inputs: readonly InputFile[], policy: InterviewerPolicyPack): FullMdPolicyOriginals {
  const documents = fullMdPolicyRoles.map(role => {
    const path = interviewConfig.files[role];
    const input = inputs.find(file => file.role === role && file.path === path);
    const mapped = policy.sourceFiles.find(file => file.path === path);
    if (!input?.bytes?.length || !input.sha256 || !mapped || input.sha256 !== mapped.sha256 || sha(input.bytes) !== input.sha256) throw new Error('FULL_MD_POLICY_SOURCE_MISMATCH:' + role);
    const text = input.bytes.toString('utf8');
    if (sha(text) !== input.sha256) throw new Error('FULL_MD_POLICY_ENCODING_MISMATCH:' + role);
    return { role, path, sha256: input.sha256, text };
  });
  return { version: FULL_MD_POLICY_VERSION, documents, contentSha256: bodyHash(documents) };
}

/** No filesystem reread: restored sessions consume only their pinned, verified original snapshot. */
export function assertFullMdPolicyOriginals(context: PolicyContext): FullMdPolicyOriginals {
  const pack = context.fullMdPolicyOriginals;
  if (!pack || !context.interviewerPolicy) throw new Error('FULL_MD_POLICY_ORIGINALS_REQUIRED');
  if (pack.version !== FULL_MD_POLICY_VERSION || pack.documents.length !== fullMdPolicyRoles.length || bodyHash(pack.documents) !== pack.contentSha256 || context.manifest.interviewerPolicy?.contentSha256 !== context.interviewerPolicy.contentSha256) throw new Error('FULL_MD_POLICY_SNAPSHOT_INVALID');
  for (const [index, role] of fullMdPolicyRoles.entries()) {
    const doc = pack.documents[index], path = interviewConfig.files[role];
    const file = context.manifest.files.find(file => file.role === role && file.path === path);
    const mapped = context.interviewerPolicy.sourceFiles.find(file => file.path === path);
    if (doc.role !== role || doc.path !== path || !file?.sha256 || file.sha256 !== doc.sha256 || mapped?.sha256 !== doc.sha256 || sha(doc.text) !== doc.sha256) throw new Error('FULL_MD_POLICY_SNAPSHOT_SOURCE_MISMATCH:' + role);
  }
  return pack;
}

/** All twelve originals appear byte-for-byte. No student record or book corpus is added here. */
export function fullMdInterviewerPolicyInstructions(context: PolicyContext): string {
  // Unit fixtures without a compiled policy are deliberately not production policy contexts.
  // A real or restored policy-bearing session must never silently downgrade to compact rules.
  if (!context.interviewerPolicy && !context.fullMdPolicyOriginals) return compactInterviewerPolicyInstructions();
  const pack = assertFullMdPolicyOriginals(context);
  const preamble = `각자의답 최신 MD 정본 전체 원문이다. 문서를 생략하거나 요약한 대체 규칙이 아니다.
아래 1~12번 문서 전체를 읽고 현재 실시간 면접관의 질문·반응·진행 판단에 적용한다. 현재 단계는 실시간 면접이며 화면 설계·결제·가이드북 제작·사후 채점 지시는 해당 단계에서만 적용한다. 예시 학생·답안·수치는 현재 학생의 사실이 아니다. 현재 학생의 사실·실제 답변·공식 지원처는 별도 입력 데이터만 근거로 삼는다.
우선순위: 명시적 사용자 운영 예외 > 해당 단계의 구체 규칙(실시간 운영 8번·질문 9번, 학생 분석 5번, 사후 평가 10번) > 나머지 공통 정본. 문서 내 예제는 표현 참고이며 고정 발화·필수 주제·현재 학생 경험으로 복사하지 않는다.
문서 원문이 길다는 이유로 일부 문서의 존재나 규칙을 무시하지 않는다. 다만 출력은 현재 질문과 실제 답변에 필요한 단일 판단과 한 가지 확인 요구로 한정한다.
정본 묶음 버전: ${pack.version}; 원문 지문: ${pack.contentSha256}`;
  const originals = pack.documents.map((doc, index) => `\n===== MD ${index + 1}: ${doc.path} | SHA256 ${doc.sha256} =====\n${doc.text}\n===== END MD ${index + 1} =====`).join('\n');
  const overrides = context.interviewerPolicy!.userOverrides.map(rule => `${rule.id}: ${rule.instruction}`).join('\n');
  return `${preamble}\n${originals}\n\n명시적 사용자 운영 예외(충돌 시 우선):\n${overrides}`;
}

export function fullMdPolicyDiagnostics(pack: FullMdPolicyOriginals) {
  return { version: pack.version, contentSha256: pack.contentSha256, documentCount: pack.documents.length, originalUtf8Bytes: pack.documents.reduce((sum, document) => sum + Buffer.byteLength(document.text, 'utf8'), 0), originalCharacters: pack.documents.reduce((sum, document) => sum + document.text.length, 0) };
}
