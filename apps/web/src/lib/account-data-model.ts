export const ACCOUNT_DATA_TYPES = {
  experience: '내 경험', draft: '경험 초안', answer: '답변', thread: 'AI 대화',
  interview: '면접', report: '면접 리포트', media: '녹음·영상', attachment: '대화 첨부',
  document: '교재', quiz: '연습', quiz_recording: '연습 녹음', study: '학습 리포트',
  memory: '복습', thought: '생각 기록', news: '뉴스 생각', knowledge: '지식 기록',
  confirmation: '확인 요청', plan: '계획', assignment: '과제', school: '지원 학교',
} as const;
export type AccountDataType = keyof typeof ACCOUNT_DATA_TYPES;
export type AccountDataItem = {
  id: string; type: AccountDataType; title: string; createdAt: string;
  sourceId?: string; schoolId: string | null; schoolName: string;
  deletedAt?: string | null; detail?: string; href?: string; relatedCount?: number;
  restoreAvailable?: boolean;
};
export type AccountDataReceipt = {id: string; type: AccountDataType; sourceId: string};
export type AccountDeviceSession = {id: string; label: string; current: boolean; createdAt: string; lastSeenAt: string};
export type AccountDataRequest = {
  id: string; type: 'all_data' | 'account'; status: 'requested' | 'processing' | 'completed' | 'cancelled';
  createdAt: string; updatedAt: string; detail: string;
};
export type AccountDataPage = {
  items: AccountDataItem[]; page: {nextCursor: string | null; hasMore: boolean; limit: number};
  counts: {active: number; trash: number}; schools: {id: string; name: string}[];
  sessions: AccountDeviceSession[]; requests: AccountDataRequest[];
};
export const ACCOUNT_DATA_BULK_LIMIT = 50;
