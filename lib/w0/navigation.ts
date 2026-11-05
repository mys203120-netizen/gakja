export const primaryNavigation = [
  { label: '생기부', path: '/w0/record', area: 'record' },
  { label: '면접 연습실', path: '/w0/interviews', area: 'interviews' },
  { label: '내 답변', path: '/w0/answers', area: 'answers' },
  { label: '암기 훈련실', path: '/w0/memory', area: 'memory' },
] as const;

export const guideChapters = [
  ['G01', '나의 면접 전략'], ['G02', '학생부 분석'], ['G03', '대학·학과 분석'],
  ['G04', '예상 질문·답변'], ['G05', '실전 훈련'], ['G06', '부록'],
] as const;

export const profileLinks = [
  ['U01', '지원처 관리'], ['U02', '내 요금제'], ['U03', '면접 이용권'],
  ['U04', '결제 내역'], ['U05', '계정 설정'], ['U07', '고객센터'],
] as const;

// These are isolated W0 guidance routes, not approved public service URLs.
export const detailPages: Record<string, { title: string; description: string; area: string }> = {
  P01: { title: '각자의답', description: '학생부를 바탕으로 나만의 면접 답변을 준비하는 공간이에요.', area: 'home' },
  P02: { title: '서비스 이용 방법', description: '학생부 제출, 가이드북, 면접 연습, 기록과 학습으로 이어져요.', area: 'home' },
  P03: { title: '요금제', description: '상품별 이용 범위와 승인된 조건은 서비스 준비 후 안내할 예정이에요.', area: 'home' },
  P04: { title: '자주 묻는 질문', description: '이용 중 궁금한 점을 확인하는 공간이에요.', area: 'home' },
  P05: { title: '약관·정책', description: '승인된 약관과 개인정보처리방침을 안내할 공간이에요.', area: 'home' },
  P06: { title: '로그인·회원가입', description: '계정 기능을 준비하고 있어요. 아직 정보를 입력하거나 가입할 수 없어요.', area: 'home' },
  O01: { title: '계정·필수 동의', description: '계정과 필수 동의를 확인하는 단계예요.', area: 'home' },
  O02: { title: '지원처 최초 등록', description: '대학·학과·전형을 확인한 뒤 지원처를 등록하는 단계예요.', area: 'home' },
  O03: { title: '요금제 선택·결제', description: '상품 조건과 결제 기능이 준비된 뒤 이용할 수 있어요.', area: 'home' },
  O04: { title: '학생부 등록', description: '학생부를 제출할 공간이에요. 제출 기능이 준비되면 안내할게요.', area: 'record' },
  O05: { title: '가이드북 제작·검수 상태', description: '실제 분석·확인·발행 상태를 확인할 공간이에요.', area: 'record' },
  O06: { title: '가이드북 발행', description: '검수가 끝나고 열람 가능한 자료가 발행되면 안내해요.', area: 'record' },
  G02: { title: '학생부 분석', description: '학생부 원문 순서 그대로 읽고, 관련 분석을 함께 확인하는 공간이에요.', area: 'record' },
  G03: { title: '대학·학과 분석', description: '확인된 대학·학과 정보와 나의 학생부를 함께 살펴보는 공간이에요.', area: 'record' },
  G04: { title: '예상 질문·답변', description: '질문과 학생부 근거를 함께 읽고 나만의 답변을 다듬는 공간이에요.', area: 'record' },
  G05: { title: '실전 훈련', description: '기억 구조화, 발화, 돌발 대응과 직전 점검을 읽으며 준비해요.', area: 'record' },
  G06: { title: '부록', description: '질문, 사실 확인과 학습 자료를 모아 살펴보는 공간이에요.', area: 'record' },
  G07: { title: '가이드북 사용법', description: '목차에서 읽을 장을 선택하고, 질문을 저장한 뒤 면접 연습실에서 연습해요.', area: 'record' },
  I01: { title: '연습 면접', description: '질문을 선택하고 채팅 또는 화상으로 연습을 준비해요.', area: 'interviews' },
  I02: { title: '연습 진행', description: '질문 묶음을 마친 뒤 피드백을 확인할 수 있어요.', area: 'interviews' },
  I03: { title: '연습 피드백', description: '실제로 관찰된 답변의 강점과 보완할 내용을 확인하는 공간이에요.', area: 'interviews' },
  I05: { title: '실전 모의면접', description: '지원처와 이용권을 확인하고 화상 면접을 준비해요.', area: 'interviews' },
  I06: { title: '입장 전 점검', description: '기존 면접 화면에서 카메라·마이크와 시작 조건을 확인해요.', area: 'interviews' },
  I07: { title: '실전 화상 면접', description: '기존 면접 화면으로 이동해 진행할 수 있어요. 이 공간의 지원처 선택은 면접에 전달되지 않아요.', area: 'interviews' },
  I08: { title: '종료·평가', description: '면접 종료 후 실제 평가 상태와 리포트를 확인할 공간이에요.', area: 'interviews' },
  I10: { title: '면접장 입장 준비', description: '실제 준비 상태가 연결되면 진행 상황을 안내해요.', area: 'interviews' },
  A01: { title: '답변 보관함', description: '연습 세션과 실전 회차별로 나의 답변을 모아 확인해요.', area: 'answers' },
  A02: { title: '답변 상세', description: '질문과 실제 답변 기록을 확인할 공간이에요.', area: 'answers' },
  A03: { title: '면접 리포트', description: '확정된 평가 결과와 회차별 기록을 확인하는 공간이에요.', area: 'answers' },
  A06: { title: '면접 직전 요약', description: '개인 확정 면접일을 기준으로 공개되는 요약이에요.', area: 'answers' },
  M01: { title: '퀴즈', description: '검수된 학습 자료를 바탕으로 개념을 다시 확인하는 공간이에요.', area: 'memory' },
  M02: { title: '퀴즈 문제·해설', description: '내 답을 확인하고 개념을 익히는 공간이에요.', area: 'memory' },
  M03: { title: '지식한입', description: '학생부와 연결된 신뢰할 수 있는 학습 자료를 읽는 공간이에요.', area: 'memory' },
  M04: { title: '이슈픽', description: '전공과 사회 이슈를 읽고 면접에서 생각해 볼 질문을 살펴봐요.', area: 'memory' },
  U01: { title: '지원처 관리', description: '등록한 지원처와 개인 면접일을 관리하는 공간이에요.', area: 'home' },
  U02: { title: '내 요금제', description: '현재 플랜과 이용 가능한 기능을 확인할 공간이에요.', area: 'home' },
  U03: { title: '면접 이용권', description: '실전 모의면접 이용권의 잔여·사용·복구 내역을 확인할 공간이에요.', area: 'home' },
  U04: { title: '결제 내역', description: '주문과 결제 상태, 영수증을 확인하는 공간이에요.', area: 'home' },
  U05: { title: '계정 설정', description: '내 정보와 알림, 계정 관련 설정을 관리할 공간이에요.', area: 'home' },
  U07: { title: '고객센터', description: '자주 묻는 질문과 문의를 확인할 공간이에요.', area: 'home' },
};

export function getW0Route(segments: string[] = []) {
  const preview = segments[0] === 'preview';
  const path = preview ? segments.slice(1) : segments;
  if (!path.length) return { preview, screen: 'home', id: null, area: 'home' };
  if (path.length === 1 && ['record', 'interviews', 'answers', 'memory'].includes(path[0])) {
    return { preview, screen: path[0], id: null, area: path[0] };
  }
  if (path.length === 2 && path[0] === 'view' && Object.hasOwn(detailPages, path[1])) {
    return { preview, screen: 'detail', id: path[1], area: detailPages[path[1]].area };
  }
  return null;
}
