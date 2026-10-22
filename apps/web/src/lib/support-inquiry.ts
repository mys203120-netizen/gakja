import { PRIVACY_POLICY_VERSION } from './privacy-policy';

export const INQUIRY_TYPES = { service: '서비스 이용', account: '계정·로그인', technical: '오류 신고', privacy: '개인정보·삭제 요청' } as const;
export type InquiryType = keyof typeof INQUIRY_TYPES;
export type InquiryInput = { email: string; type: InquiryType; content: string; consent: true; policyVersion: string; requestId: string };
export class InquiryValidationError extends Error {}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validateInquiry(input: unknown): InquiryInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InquiryValidationError('문의 내용을 확인해 주세요.');
  const value = input as Record<string, unknown>;
  const email = typeof value.email === 'string' ? value.email.trim().toLowerCase() : '';
  const content = typeof value.content === 'string' ? value.content.trim() : '';
  if (email.length > 254 || !/^[^\s@\x00-\x1f]+@[^\s@\x00-\x1f]+\.[^\s@\x00-\x1f]+$/.test(email)) throw new InquiryValidationError('답변받을 이메일을 확인해 주세요.');
  if (typeof value.type !== 'string' || !Object.hasOwn(INQUIRY_TYPES, value.type)) throw new InquiryValidationError('문의 유형을 선택해 주세요.');
  if (!content || content.length > 5000 || /\x00/.test(content)) throw new InquiryValidationError('문의 내용을 1~5,000자로 입력해 주세요.');
  if (value.consent !== true || value.policyVersion !== PRIVACY_POLICY_VERSION) throw new InquiryValidationError('현재 개인정보 수집·이용 안내를 확인하고 동의해 주세요.');
  if (typeof value.requestId !== 'string' || !uuid.test(value.requestId)) throw new InquiryValidationError('문의 양식을 새로 열어 주세요.');
  if (value.website) throw new InquiryValidationError('문의 내용을 확인해 주세요.');
  return { email, type: value.type as InquiryType, content, consent: true, policyVersion: PRIVACY_POLICY_VERSION, requestId: value.requestId };
}

/** Bound actual streamed bytes, including requests without Content-Length. */
export async function readInquiryBody(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new InquiryValidationError('JSON 형식으로 문의를 보내 주세요.');
  const reader = request.body?.getReader();
  if (!reader) throw new InquiryValidationError('문의 내용을 확인해 주세요.');
  let size = 0;
  const parts: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 24000) { await reader.cancel(); throw new InquiryValidationError('문의 내용이 너무 길어요.'); }
      parts.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof InquiryValidationError) throw error;
    throw new InquiryValidationError('문의 내용을 확인해 주세요.');
  } finally { reader.releaseLock(); }
}
