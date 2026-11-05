import type { PreparedQuestionBank, QuestionBankPartial } from '../data/prepared-question-bank';
import type { ReadScope } from './analysis-read-ports';

/** Existing bank identities only. This is the local development-owner boundary,
 * not authenticated ownership or an alternative bank storage format. */
export interface QuestionBankScope extends ReadScope {
  bankKey: string; bankContentSha256: string | null; sourceFingerprint: string | null;
}
export type QuestionBankPurpose = 'current' | 'pinned' | 'preparation' | 'preparation-summary' | 'donor-reuse';
export interface QuestionBankRequest { scope: QuestionBankScope; purpose: QuestionBankPurpose }
export interface QuestionBankRepository {
  ownerId: string;
  readReady(request: QuestionBankRequest): Promise<PreparedQuestionBank | null>;
  readPartial(request: QuestionBankRequest): Promise<QuestionBankPartial | PreparedQuestionBank | null>;
  writePartial(request: QuestionBankRequest & { value: QuestionBankPartial }): Promise<void>;
  publishReady(request: QuestionBankRequest & { value: PreparedQuestionBank }): Promise<void>;
  removePartial(request: QuestionBankRequest): Promise<void>;
}
