/** Public videos verified against their publisher and YouTube oEmbed on 2026-10-12/13.
 * Student-record text never leaves the server. Matching uses an explicit topic dictionary.
 */
export const KNOWLEDGE_FOCUS = { science: '과학·환경', data: '수학·자료', community: '공동체·사회', humanities: '인문·예술', technology: '기술·진로', learning: '학습·사고' } as const;
export type KnowledgeFocus = keyof typeof KNOWLEDGE_FOCUS;
const TOPIC_LENSES: Record<string, { focus: KnowledgeFocus; stretch: string }> = {
  '미세플라스틱': { focus: 'science', stretch: '분리 실험에서 인체 유입 경로까지' },
  '플라스틱': { focus: 'science', stretch: '재질 비교에서 폐기 이후의 경로까지' },
  '수질과 정수': { focus: 'science', stretch: '수질 측정에서 물을 다시 쓰는 과정까지' },
  '녹지와 기후': { focus: 'science', stretch: '도시 온도 자료에서 녹지의 작용까지' },
  '탄소 순환': { focus: 'science', stretch: '탄소 감축 논의에서 탄소의 이동까지' },
  '항생제 내성': { focus: 'science', stretch: '항생제의 작용에서 내성이 생기는 과정까지' },
  '생물다양성': { focus: 'science', stretch: '개별 생물에서 생태계의 연결까지' },
  '효소': { focus: 'science', stretch: '반응 조건에서 효소의 작용까지' },
  '삼투': { focus: 'science', stretch: '농도 비교에서 물이 이동하는 원리까지' },
  '유전자 발현': { focus: 'science', stretch: '유전 정보에서 단백질이 만들어지는 과정까지' },
  '자료 해석': { focus: 'data', stretch: '측정값 비교에서 그래프의 축과 표현까지' },
  '근거 검토': { focus: 'learning', stretch: '내 결론에서 전제와 다른 관점까지' },
  '연습과 학습': { focus: 'learning', stretch: '반복 학습에서 집중과 연습 설계까지' },
  '경청과 협업': { focus: 'community', stretch: '역할 조율에서 상대의 말을 듣는 방법까지' },
  '공동 자원': { focus: 'community', stretch: '환경 실천에서 공동 자원의 선택과 규칙까지' },
  '정보와 미디어': { focus: 'community', stretch: '자료 조사에서 사실과 의견을 가리는 방법까지' },
  '관찰과 발견': { focus: 'science', stretch: '실험 설계에서 간단한 관찰로 질문을 만드는 방법까지' },
  '알고리즘': { focus: 'technology', stretch: '문제 해결 과정에서 절차와 효율까지' },
  '윤리와 선택': { focus: 'humanities', stretch: '가치 판단에서 선택의 결과와 책임까지' },
  '음악 읽기': { focus: 'humanities', stretch: '연주 경험에서 음높이와 리듬을 읽는 원리까지' },
  '시장과 기대': { focus: 'community', stretch: '가격 변화에서 사람들의 기대와 시장까지' },
};
export type KnowledgeVideo = {
  id: string; title: string; label: string; channel: string; topic: string;
  keywords: string[]; source: string; durationSeconds?: number;
  url: string; thumbnail: string; verifiedAt: string; focus: KnowledgeFocus; stretch: string;
  kind?: 'video' | 'reading'; summary?: string; originLabels?: string[];
  targetId?: string | null; targetSnapshot?: Record<string, unknown> | null;
  sourceSnapshot?: Record<string, unknown>; relatedQuestionIds?: string[];
};
type CatalogInput = Omit<KnowledgeVideo, 'url' | 'thumbnail' | 'verifiedAt' | 'focus' | 'stretch'> & { verifiedAt?: string };
const video = (item: CatalogInput): KnowledgeVideo => ({ ...item, ...TOPIC_LENSES[item.topic], url: `https://www.youtube.com/watch?v=${item.id}`, thumbnail: `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`, verifiedAt: item.verifiedAt || '2026-10-12' });
const ted = (slug: string) => `https://ed.ted.com/lessons/${slug}`;
export const KNOWLEDGE_CATALOG: readonly KnowledgeVideo[] = [
  video({ id: 'lQRsqMiBTsI', title: '3 surprising ways microplastics can enter your body', label: '미세플라스틱과 우리 몸', channel: 'TED-Ed', topic: '미세플라스틱', keywords: ['미세플라스틱', '마이크로플라스틱', '나노플라스틱', 'microplastic'], source: 'https://www.ted.com/talks/ted_ed_3_surprising_ways_microplastics_can_enter_your_body' }),
  video({ id: '_6xlNyWPpB8', title: 'What really happens to the plastic you throw away - Emma Bryce', label: '버린 플라스틱의 다음 행선지', channel: 'TED-Ed', topic: '플라스틱', keywords: ['미세플라스틱', '플라스틱', 'plastic'], source: ted('what-really-happens-to-the-plastic-you-throw-away-emma-bryce'), durationSeconds: 247 }),
  video({ id: 'SYia4zqcE4g', title: 'How the water you flush becomes the water you drink - Francis de los Reyes', label: '폐수가 다시 물이 되는 과정', channel: 'TED-Ed', topic: '수질과 정수', keywords: ['수질', '하천', '정수', '폐수', '오폐수', '수처리', 'wastewater'], source: ted('how-the-water-you-flush-becomes-the-water-you-drink-francis-de-los-reyes'), durationSeconds: 323 }),
  video({ id: 'bbxmH_Kj7fk', title: 'Does planting trees actually cool the planet? - Carolyn Beans', label: '나무를 심으면 시원해질까?', channel: 'TED-Ed', topic: '녹지와 기후', keywords: ['열섬', '녹지', '도시숲', '나무심기', '산림복원', 'urbanheatisland'], source: ted('does-planting-trees-actually-fight-climate-change-carolyn-beans'), durationSeconds: 341 }),
  video({ id: 'A4cPmHGegKI', title: 'The carbon cycle - Nathaniel Manning', label: '탄소는 어떻게 순환할까?', channel: 'TED-Ed', topic: '탄소 순환', keywords: ['탄소감축', '탄소순환', '탄소중립', '탄소배출', '탄소정책', 'carboncycle'], source: ted('the-carbon-cycle-nathaniel-manning'), durationSeconds: 235 }),
  video({ id: 'znnp-Ivj2ek', title: 'What causes antibiotic resistance? - Kevin Wu', label: '항생제 내성의 원리', channel: 'TED-Ed', topic: '항생제 내성', keywords: ['항생제', '항균제', 'antibiotic'], source: ted('how-antibiotics-become-resistant-over-time-kevin-wu'), durationSeconds: 275 }),
  video({ id: 'GK_vRtHJZu4', title: 'Why is biodiversity so important? - Kim Preshoff', label: '생물다양성이 중요한 이유', channel: 'TED-Ed', topic: '생물다양성', keywords: ['생물다양성', '생태다양성', '생태계', 'biodiversity'], source: ted('why-is-biodiversity-so-important-kim-preshoff'), durationSeconds: 259 }),
  video({ id: 'qgVFkRn8f10', title: 'Enzymes (Updated)', label: '효소와 반응 조건', channel: 'Amoeba Sisters', topic: '효소', keywords: ['효소', '생체촉매', 'enzyme'], source: 'https://www.youtube.com/watch?v=qgVFkRn8f10' }),
  video({ id: 'L-osEc07vMs', title: 'Osmosis and Water Potential (Updated)', label: '삼투와 물의 이동', channel: 'Amoeba Sisters', topic: '삼투', keywords: ['삼투', '수분퍼텐셜', '수분포텐셜', 'osmosis'], source: 'https://www.youtube.com/watch?v=L-osEc07vMs' }),
  video({ id: 'oefAI2x2CQM', title: 'Protein Synthesis: Transcription and Translation (Updated)', label: 'DNA에서 단백질까지', channel: 'Amoeba Sisters', topic: '유전자 발현', keywords: ['유전자발현', '단백질합성', '전사와번역', 'dna', 'rna'], source: 'https://www.youtube.com/watch?v=oefAI2x2CQM' }),
  video({ id: 'E91bGT9BjYk', title: 'How to spot a misleading graph - Lea Gaslowitz', label: '그래프를 읽을 때 놓치기 쉬운 것', channel: 'TED-Ed', topic: '자료 해석', keywords: ['통계', '그래프', '자료분석', '자료해석', '수치비교', '관측조건', '상관관계', '단위확인', '데이터시각화', 'statistics'], source: ted('how-to-spot-a-misleading-graph-lea-gaslowitz'), verifiedAt: '2026-10-13' }),
  video({ id: 'dItUGF8GdTw', title: '5 tips to improve your critical thinking - Samantha Agoos', label: '내 결론을 한 번 더 점검하기', channel: 'TED-Ed', topic: '근거 검토', keywords: ['근거검토', '측정한계', '실험오차', '변인통제', '대조조건', '비판적사고', '가치판단', '논거', 'criticalthinking'], source: ted('5-tips-to-improve-your-critical-thinking-samantha-agoos'), verifiedAt: '2026-10-13' }),
  video({ id: 'f2O6mQkFiiw', title: 'How to practice effectively...for just about anything - Annie Bosler and Don Greene', label: '반복보다 중요한 연습의 방법', channel: 'TED-Ed', topic: '연습과 학습', keywords: ['오답', '오류분석', '자기주도학습', '학습계획', '반복학습', '연습방법', '연주연습', '훈련계획'], source: ted('how-to-practice-effectively-for-just-about-anything-annie-bosler-and-don-greene'), verifiedAt: '2026-10-13' }),
  video({ id: '-BdbiZcNBXg', title: 'Being A Good Listener', label: '잘 듣는다는 건 어떤 일일까?', channel: 'The School of Life', topic: '경청과 협업', keywords: ['경청', '의사소통', '역할조율', '의견조율', '갈등조정', '팀원', '상대의상황', 'listening'], source: 'https://ed.ted.com/best_of_web/foptnjVE', verifiedAt: '2026-10-13' }),
  video({ id: 'CxC161GvMPc', title: 'What is the tragedy of the commons? - Nicholas Amendolare', label: '함께 쓰는 자원은 어떻게 지킬까?', channel: 'TED-Ed', topic: '공동 자원', keywords: ['공유지', '공동자원', '자원배분', '잔반', '소량배식', '과잉소비', '공공재', '환경실천', 'tragedyofthecommons'], source: ted('what-is-the-tragedy-of-the-commons-nicholas-amendolare'), verifiedAt: '2026-10-13' }),
  video({ id: 'q-Y-z6HmRgI', title: 'How to choose your news - Damon Brown', label: '사실과 의견을 나눠 읽기', channel: 'TED-Ed', topic: '정보와 미디어', keywords: ['미디어', '기사분석', '가짜뉴스', '출처확인', '정보검증', '사실과가치', '사실과의견', '언론', 'medialiteracy'], source: ted('how-to-choose-your-news-damon-brown'), verifiedAt: '2026-10-13' }),
  video({ id: 'F8UFGu2M2gM', title: 'How simple ideas lead to scientific discoveries', label: '작은 관찰이 탐구가 되기까지', channel: 'TED-Ed', topic: '관찰과 발견', keywords: ['측정도구', '반복측정', '실험설계', '측정방법', '가설검증', '관찰실험', '과학적방법', 'scientificmethod'], source: ted('how-simple-ideas-lead-to-scientific-discoveries'), verifiedAt: '2026-10-13' }),
  video({ id: '6hfOvs8pY1k', title: "What's an algorithm? - David J. Malan", label: '문제를 풀어가는 절차', channel: 'TED-Ed', topic: '알고리즘', keywords: ['알고리즘', '코딩', '프로그래밍', '소프트웨어', '컴퓨터과학', 'algorithm', 'programming'], source: ted('your-brain-can-solve-algorithms-david-j-malan'), verifiedAt: '2026-10-13' }),
  video({ id: 'yg16u_bzjPE', title: 'Would you sacrifice one person to save five? - Eleanor Nelsen', label: '선택의 결과와 책임', channel: 'TED-Ed', topic: '윤리와 선택', keywords: ['공리주의', '의무론', '윤리', '도덕적딜레마', '트롤리', '생명윤리', '형평성', 'trolley'], source: ted('would-you-sacrifice-one-person-to-save-five-eleanor-nelsen'), verifiedAt: '2026-10-13' }),
  video({ id: 'ZN41d7Txcq0', title: 'How to read music - Tim Hansen', label: '악보 안의 음높이와 리듬', channel: 'TED-Ed', topic: '음악 읽기', keywords: ['악보', '합주', '합창', '음악동아리', '리듬', '작곡', '음악이론'], source: ted('how-to-read-music-tim-hansen'), verifiedAt: '2026-10-13' }),
  video({ id: 'I5ZR0jMlxX0', title: 'What causes economic bubbles? - Prateek Singh', label: '가격에 기대가 더해질 때', channel: 'TED-Ed', topic: '시장과 기대', keywords: ['경제버블', '자산가격', '수요공급', '시장경제', '가격변동', '투자심리', '경제동아리'], source: ted('what-causes-economic-bubbles-prateek-singh'), verifiedAt: '2026-10-13' }),
];
export type KnowledgeActivity = { id: string; title: string; grade?: number; area?: string };
export type KnowledgeContext = { id: string; kind: 'activity' | 'goal' | 'plan' | 'career' | 'record' | 'major' | 'school' | 'question'; title: string; sourceRefIds: string[]; area?: string; url?: string; targetId?: string };
export type KnowledgeQuestion = { id: string; prompt: string; activityIds: string[]; needsReview?: boolean; sourceKind?: 'personal' | 'common'; sourceType?: string; commonRevision?: number; sourceSnapshot?: Record<string, unknown>; targetId?: string | null; targetSnapshot?: Record<string, unknown> | null };
export type KnowledgeLearning = { questionId?: string; prompt?: string; checkPrompt?: string; selfCheck?: 'explained' | 'needs_review' | 'not_yet'; explanation?: string; explanationSavedAt?: string; contentVersion?: number | null; assisted?: boolean; sourceKind?: 'personal' | 'common'; sourceType?: string; commonRevision?: number; sourceSnapshot?: Record<string, unknown>; targetId?: string | null; targetSnapshot?: Record<string, unknown> | null };
export type KnowledgeProgress = { id: string; saved: boolean; completed_at: string | null; reflection: string; revision: number; snapshot?: { learning?: KnowledgeLearning; [key: string]: unknown } };
export type KnowledgeMatch = KnowledgeVideo & { activities: KnowledgeActivity[]; contexts?: KnowledgeContext[]; current: boolean; progress: KnowledgeProgress | null; relatedQuestions?: KnowledgeQuestion[]; recommendedReason?: string };
export type KnowledgeSearch = { activityId: string; activityTitle: string; topic: string; url: string; kind?: 'record' | 'major' | 'school'; targetId?: string; sourceUrl?: string };
export type KnowledgeTarget = { id: string; university: string; department: string; departmentCatalogId: string | null; departmentField: string | null; departmentCategory: string | null; campus: string | null; sourceUrl?: string; snapshot: Record<string, unknown> };
type LearningRecord = { activities?: Record<string, unknown>[]; source_refs?: Record<string, unknown>[]; student_context?: Record<string, unknown> };
function plain(value: unknown): string { return typeof value === 'string' ? value : ''; }
const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
function topicMatch(text: string, keyword: string): boolean {
  const needle = normalize(keyword);
  // Short English tokens must be complete words; e.g. "banana" is not "RNA".
  if (/^[a-z]{1,4}$/.test(needle)) return new RegExp(`(^|[^a-z])${needle}([^a-z]|$)`, 'i').test(text);
  return normalize(text).includes(needle);
}
const confirmed = new Set(['verified', 'approved', 'confirmed', 'synthetic_reviewed', 'confirmed_from_record', 'confirmed_by_student']);
function recordAnchors(learning: LearningRecord) {
  const activities = Array.isArray(learning.activities) ? learning.activities : [];
  const sources = Array.isArray(learning.source_refs) ? learning.source_refs : [];
  const sourceIds = new Set(sources.map(source => plain(source.id)).filter(Boolean));
  const refs = (item: Record<string, unknown>) => (Array.isArray(item.source_ref_ids) ? item.source_ref_ids : []).filter((id): id is string => typeof id === 'string' && sourceIds.has(id));
  const anchors: { context: KnowledgeContext; text: string; activity?: KnowledgeActivity }[] = activities.filter(activity => plain(activity.id) && plain(activity.title)).map(activity => {
    const sourceRefIds = refs(activity);
    const relatedQuotes = sources.filter(source => sourceRefIds.includes(plain(source.id))).map(source => plain(source.quote));
    const actual = { id: plain(activity.id), title: plain(activity.title), ...(typeof activity.grade === 'number' ? { grade: activity.grade } : {}), ...(typeof activity.area === 'string' ? { area: activity.area } : {}) };
    return { context: { id: actual.id, kind: 'activity', title: actual.title, sourceRefIds, area: actual.area }, activity: actual,
      text: [activity.title, activity.activity_summary, activity.motivation, activity.role, activity.process, activity.result, activity.lessons, activity.reading_title, activity.book_title, ...(Array.isArray(activity.keywords) ? activity.keywords : []), ...relatedQuotes].map(plain).join(' ').normalize('NFKC').toLowerCase() };
  });
  const context = learning.student_context || {};
  const studentSourceIds = new Set(sources.filter(source => ['student_record', 'student_confirmation'].includes(plain(source.type))).map(source => plain(source.id)));
  for (const [field, kind] of [['confirmed_goals', 'goal'], ['confirmed_plans', 'plan'], ['career_academic_flow', 'career']] as const) {
    const values = context[field];
    if (!Array.isArray(values)) continue;
    values.forEach((value, index) => {
      if (!value || typeof value !== 'object') return;
      const item = value as Record<string, unknown>, title = plain(kind === 'career' ? item.focus : item.text), sourceRefIds = refs(item).filter(id => studentSourceIds.has(id));
      if (!title || !sourceRefIds.length || kind !== 'career' && !confirmed.has(plain(item.verification_status))) return;
      anchors.push({ context: { id: `${kind}:${index}`, kind, title, sourceRefIds }, text: title.normalize('NFKC').toLowerCase() });
    });
  }
  // Published student-record passages can stand on their own. Institution profiles and
  // model answers are never treated as the student's experience or interests.
  const attached = new Set(anchors.flatMap(anchor => anchor.context.sourceRefIds));
  for (const source of sources) {
    const id = plain(source.id), quote = plain(source.quote), area = plain(source.area);
    if (!id || !quote || source.type !== 'student_record' || attached.has(id)) continue;
    anchors.push({ context: { id: `record:${id}`, kind: 'record', title: area ? `${area} 기록` : '학생부 기록', sourceRefIds: [id], ...(area ? { area } : {}) }, text: quote.normalize('NFKC').toLowerCase() });
  }
  return anchors;
}
/** Public major metadata supplies a learning lens, never a claim about the student's past. */
export function majorKnowledgeTopics(target: KnowledgeTarget): string[] {
  if (!target.departmentCatalogId) return ['근거 검토', '자료 해석'];
  const category = target.departmentCategory || '';
  const topics: Record<string, string[]> = {
    '인문학': ['근거 검토', '윤리와 선택', '정보와 미디어'], '언어・문학': ['정보와 미디어', '근거 검토', '경청과 협업'],
    '경영・경제': ['시장과 기대', '자료 해석', '윤리와 선택'], '사회과학': ['정보와 미디어', '공동 자원', '자료 해석'],
    '법학': ['윤리와 선택', '근거 검토', '공동 자원'], '교육': ['연습과 학습', '경청과 협업', '근거 검토'],
    '간호': ['항생제 내성', '경청과 협업', '윤리와 선택'], '보건': ['항생제 내성', '자료 해석', '윤리와 선택'],
    '의료': ['항생제 내성', '유전자 발현', '윤리와 선택'], '의료예과': ['항생제 내성', '효소', '윤리와 선택'],
    '약학': ['효소', '항생제 내성', '유전자 발현'], '화학・생명과학・환경': ['효소', '생물다양성', '수질과 정수', '자료 해석'],
    '화공・고분자・에너지': ['플라스틱', '탄소 순환', '관찰과 발견'], '수학・물리・천문・지구': ['자료 해석', '관찰과 발견', '근거 검토'],
    '농림・수산': ['생물다양성', '녹지와 기후', '공동 자원'], '건설': ['녹지와 기후', '공동 자원', '자료 해석'],
    '전기・전자・컴퓨터': ['알고리즘', '자료 해석', '윤리와 선택'], '재료': ['플라스틱', '관찰과 발견', '자료 해석'],
    '기계': ['관찰과 발견', '알고리즘', '자료 해석'], '산업・안전': ['자료 해석', '윤리와 선택', '알고리즘'],
    '교통・수송': ['자료 해석', '공동 자원', '알고리즘'], '생활과학': ['공동 자원', '자료 해석', '경청과 협업'],
    '음악': ['음악 읽기', '연습과 학습', '경청과 협업'], '미술': ['관찰과 발견', '정보와 미디어', '근거 검토'],
    '연극・영화': ['정보와 미디어', '경청과 협업', '윤리와 선택'], '응용예술': ['관찰과 발견', '정보와 미디어', '알고리즘'],
    '무용・체육': ['연습과 학습', '경청과 협업', '자료 해석'],
  };
  return topics[category] || (target.departmentField === '예체능계열' ? ['연습과 학습', '경청과 협업'] : ['근거 검토', '자료 해석', '윤리와 선택']);
}
export function matchKnowledgeVideos(learning: LearningRecord, target?: KnowledgeTarget | null): KnowledgeMatch[] {
  const anchors = recordAnchors(learning);
  const majorTopics = target ? new Set(majorKnowledgeTopics(target)) : new Set<string>();
  return KNOWLEDGE_CATALOG.flatMap(item => {
    const related = anchors.filter(anchor => item.keywords.some(keyword => topicMatch(anchor.text, keyword)));
    const major = target && majorTopics.has(item.topic) ? [{ id: `major:${target.id}`, kind: 'major' as const, title: target.department, sourceRefIds: [], targetId: target.id, url: target.sourceUrl }] : [];
    return related.length || major.length ? [{ ...item, kind:'video' as const, originLabels:[...(related.length?['내 기록']:[]), ...(major.length?['학과 연결']:[])], targetId:target?.id || null, targetSnapshot:target?.snapshot || null, activities: related.flatMap(anchor => anchor.activity ? [anchor.activity] : []), contexts: [...related.map(anchor => anchor.context), ...major], current: true, progress: null }] : [];
  });
}
export function knowledgeTargetSearches(target: KnowledgeTarget): KnowledgeSearch[] {
  return majorKnowledgeTopics(target).map(topic => ({ activityId:`major:${target.id}:${topic}`, activityTitle:target.department, topic:`${target.department} · ${topic}`, kind:'major', targetId:target.id, sourceUrl:target.sourceUrl, url:`https://www.youtube.com/results?search_query=${encodeURIComponent(`${target.department} ${topic}`)}` }));
}
export function knowledgeSearches(learning: LearningRecord, matches: KnowledgeMatch[]): KnowledgeSearch[] {
  const matched = new Set(matches.flatMap(item => item.activities.map(activity => activity.id)));
  return (Array.isArray(learning.activities) ? learning.activities : []).filter(activity => plain(activity.id) && plain(activity.title) && (!matched.has(plain(activity.id)) || plain(activity.reading_title) || plain(activity.book_title))).map(activity => {
    // Search links are explicitly labeled as searches. No generated thumbnail or invented video.
    const terms = Array.isArray(activity.keywords) ? activity.keywords.filter(value => typeof value === 'string').slice(0, 2) as string[] : [];
    const topic = plain(activity.reading_title) || plain(activity.book_title) || terms.join(' ') || plain(activity.title);
    return { activityId: plain(activity.id), activityTitle: plain(activity.title), topic, url: `https://www.youtube.com/results?search_query=${encodeURIComponent(topic.slice(0, 100))}` };
  });
}
