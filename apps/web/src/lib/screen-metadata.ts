import { privateMetadata } from './public-site';

/** Only fixed screen names enter metadata, even when a route contains private IDs. */
export function screenMetadata(section: string, slug: string[] = []) {
  const [screen, detail] = slug;
  let title: string;
  switch (section) {
    case 'account':
      title = screen === 'settings' ? '계정 설정' : screen === 'data' ? '데이터 관리' : screen === 'confirmations' ? '확인 요청' : '내 계정';
      break;
    case 'chat': case 'on':
      title = screen === 'interviews' ? detail && detail !== 'new' ? '채팅 면접 연습' : '채팅 면접 시작' : '각자ON 대화';
      break;
    case 'interview':
      title = !screen ? '모의면접' : ['new', 'chat', 'live'].includes(screen) ? '모의면접 시작' : '면접 연습';
      break;
    case 'knowledge':
      title = screen ? '지식한입 자료' : '지식한입';
      break;
    case 'materials': {
      const titles: Record<string, string> = { guidebook: '면접 가이드북', handbook: '면접 핸드북', activities: '내 활동', questions: '면접 질문', answers: '내 답변', briefings: '시사 자료' };
      title = Object.hasOwn(titles, screen) ? titles[screen] : '내 교재';
      if (detail) title = screen === 'answers' ? '답변 작성' : `${title} 상세`;
      break;
    }
    case 'practice': case 'quiz':
      title = screen === 'assignments' ? detail ? '과제 풀기' : '내 과제'
        : screen === 'memory' ? detail ? '암기 연습' : '암기 훈련'
        : screen === 'video' ? detail && detail !== 'new' ? '화상 면접 연습' : '화상 면접 시작'
        : screen === 'session' ? '퀴즈 풀기' : '퀴즈 훈련';
      break;
    case 'records': case 'reports':
      title = screen === 'comparisons' ? '답변 비교' : screen === 'reports' ? '면접 결과'
        : screen === 'sessions' ? '학습 리포트' : screen === 'history' ? '연습 이력' : '내 기록';
      break;
    case 'schools':
      title = screen === 'new' ? '지원 학교 추가' : detail === 'edit' ? '지원 학교 수정' : screen ? '지원 학교 상세' : '지원 학교';
      break;
    case 'admin': {
      const titles: Record<string, string> = { assignments: '과제 관리', schools: '지원 학교 관리', schedules: '일정 관리', students: '학생 관리', imports: '자료 업로드', content: '콘텐츠 이력', reviews: '검토 관리', knowledge: '지식한입 관리', inquiries: '문의 관리', settings: '관리자 설정' };
      title = Object.hasOwn(titles, screen) ? titles[screen] : '관리자 현황';
      if (screen === 'students' && detail) title = '학생 상세';
      if (screen === 'imports' && detail) title = detail === 'new' ? '자료 업로드 시작' : '업로드 상세';
      if (screen === 'content' && detail) title = '콘텐츠 버전 상세';
      if (screen === 'reviews' && detail) title = '검토 상세';
      break;
    }
    default: title = '내 면접 준비';
  }
  return privateMetadata(title);
}
