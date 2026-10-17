/** Public publisher feeds only. No arbitrary feed or article URL is ever fetched. */
export const NEWS_FEEDS = {
  water: { name: '워터저널', url: 'https://www.waterjournal.co.kr/rss/allArticle.xml', articleHosts: ['www.waterjournal.co.kr', 'waterjournal.co.kr'] },
  environment: { name: '환경일보', url: 'https://www.hkbs.co.kr/rss/allArticle.xml', articleHosts: ['www.hkbs.co.kr', 'hkbs.co.kr'] },
  science: { name: '경향신문', url: 'https://www.khan.co.kr/rss/rssdata/science_news.xml', articleHosts: ['www.khan.co.kr', 'khan.co.kr'] },
  society: { name: '경향신문', url: 'https://www.khan.co.kr/rss/rssdata/society_news.xml', articleHosts: ['www.khan.co.kr', 'khan.co.kr'] },
  culture: { name: '경향신문', url: 'https://www.khan.co.kr/rss/rssdata/culture_news.xml', articleHosts: ['www.khan.co.kr', 'khan.co.kr'] },
  technology: { name: '전자신문', url: 'https://rss.etnews.com/Section901.xml', articleHosts: ['www.etnews.com', 'etnews.com'] },
  digital: { name: '아이뉴스24', url: 'https://rss.inews24.com/rss/news_all.xml', articleHosts: ['www.inews24.com', 'inews24.com'] },
  economy: { name: '매일경제', url: 'https://www.mk.co.kr/rss/30000001/', articleHosts: ['www.mk.co.kr', 'mk.co.kr'] },
} as const;
export type NewsFeedKey = keyof typeof NEWS_FEEDS;
export type NewsTopic = { key: string; label: string; keywords: string[]; feeds: NewsFeedKey[] };
export const NEWS_TOPIC_REVISION = 'v2';
export type NewsMajorMetadata = { category?: string; field?: string };
export type NewsConnection = { basis: 'major_topic' | 'related_field' | 'common' | 'keyword'; label: string; category?: string; field?: string };
export type NewsArticle = { id: string; title: string; url: string; publisher: string; snippet: string; publishedAt: string; fetchedAt: string; keywords: string[]; feedKey: NewsFeedKey };
export type NewsThought = { content: string; revision: number; updatedAt: string };
export type DepartmentNewsData = { major: string; targetId: string | null; topic: NewsTopic | null; connection: NewsConnection | null; status: 'fresh' | 'stale' | 'empty' | 'unavailable' | 'setup_required'; fetchedAt: string | null; checkedAt: string | null; articles: (NewsArticle & { thought: NewsThought | null; practiceBriefingId?: string | null })[]; message: string | null; sources: { name: string; url: string }[] };

const topics: { match: RegExp; topic: NewsTopic }[] = [
  // Explicit professional subjects take precedence over generic words such as
  // 환경, 정보, 생명 and language names (간호환경, 환경교육, 국어교육).
  { match: /교육|사범|유아|초등/, topic: { key: 'education', label: '교육', keywords: ['교육', '학교', '교사', '학습', '학생', '교과', '청소년', '유아', '입시'], feeds: ['society', 'digital', 'culture'] } },
  { match: /의학|의예|의과|간호|약학|약과|약물|제약|의약|보건|치의|치위생|한의|물리치료|작업치료|응급구조|임상병리|방사선|안경광학|의료|의공|의생명|신약|메디컬|메디칼/, topic: { key: 'health', label: '의료·보건', keywords: ['의료', '치료', '환자', '병원', '간호', '의약', '보건', '질병', '항암', '암 환자', '암 치료', '백신', '감염', '건강', '처방', '의사', '제약'], feeds: ['society', 'science', 'economy'] } },
  { match: /식품|식량|영양|조리|외식|푸드/, topic: { key: 'food', label: '식품·영양', keywords: ['식품', '영양', '식량', '먹거리', '식중독', '단백질', '식재료', '급식', '살모넬라', '농산물', '조리', '푸드'], feeds: ['science', 'society', 'environment'] } },
  { match: /농업|농학|농생명|농산업|동물|축산|산림|원예|식물|스마트팜|수산|어업|해양생물|조경/, topic: { key: 'agriculture', label: '농림·수산', keywords: ['농업', '농촌', '농산물', '축산', '동물', '산림', '원예', '식물', '스마트팜', '수산', '어업', '해양생물', '조경', '농어촌', '생태', '영농'], feeds: ['environment', 'science', 'society'] } },
  { match: /의류|의상|패션|섬유|뷰티|미용|향장|코스메틱|헤어|메이크업/, topic: { key: 'fashion', label: '패션·생활', keywords: ['패션', '의류', '의상', '섬유', '뷰티', '화장품', '미용', '코스메틱', '명품 브랜드', '명품브랜드', '명품 가방', '모델 보호', '생활과학'], feeds: ['culture', 'economy', 'digital'] } },
  { match: /법학|법무|법과|법경영|경찰|범죄/, topic: { key: 'law', label: '법·안전', keywords: ['법원', '법률', '법안', '판결', '헌법', '경찰', '범죄', '검찰', '수사', '인권', '기소', '피해자'], feeds: ['society', 'economy', 'digital'] } },
  { match: /체육|스포츠|운동|태권도|골프|레저/, topic: { key: 'sports', label: '체육·스포츠', keywords: ['스포츠', '체육', '운동량', '운동능력', '골프', '태권도', '올림픽', '체력', '축구', '야구', '경기장'], feeds: ['society', 'economy', 'culture'] } },
  { match: /관광|호텔|Hospitality|MICE/i, topic: { key: 'tourism', label: '관광·서비스', keywords: ['관광', '호텔', '여행', '축제', '관광객', '숙박', '항공사', '컨벤션', '외국인 관광', '외국인관광', '방한'], feeds: ['economy', 'society', 'culture'] } },
  { match: /신학|종교|불교|기독교|선교/, topic: { key: 'religion', label: '종교·인문', keywords: ['종교', '교회', '신앙', '불교', '기독교', '복음', '신학', '사찰', '철학', '성당'], feeds: ['culture', 'society', 'economy'] } },
  { match: /심리|상담/, topic: { key: 'psychology', label: '심리·상담', keywords: ['심리', '정신건강', '정신병원', '상담', '우울', '인지능력', '인지과학', '행동치료', '행동장애', '뇌과학', '청소년', '자살', '게임중독', '인터넷중독', '도박', '알코올', '약물중독'], feeds: ['society', 'science', 'culture'] } },
  { match: /디자인|미술|예술|음악|연극|영화|무용|연기|연출|뮤지컬|기악|성악|작곡|피아노|공예|회화|서양화|한국화|조소|도예|영상|만화|애니메이션|아트|Art\s*&\s*Design/i, topic: { key: 'arts', label: '예술·문화', keywords: ['예술', '디자인', '미술', '음악', '영화', '문화', '갤러리', '미술전', '전시관', '공연', '만화', '애니메이션', '작가', '앨범'], feeds: ['culture', 'digital', 'society'] } },
  { match: /언론|미디어|방송|광고|홍보|커뮤니케이션|콘텐츠|엔터테인먼트|게임/, topic: { key: 'media', label: '미디어·콘텐츠', keywords: ['미디어', '언론', '방송', '콘텐츠', '광고', '플랫폼', '저작권', '문화', 'SNS', '게임'], feeds: ['digital', 'culture', 'society'] } },
  { match: /환경|수질|수자원|기후|지구시스템/, topic: { key: 'environment', label: '환경·수질', keywords: ['미세플라스틱', '수질', '수처리', '하수', '정수', '탄소', '기후', '폐기물', '재활용', '생물다양성', '환경오염', '대기오염', '수자원'], feeds: ['water', 'environment', 'science'] } },
  { match: /컴퓨터|소프트웨어|인공지능|정보통신|정보보호|정보보안|사이버|데이터|정보융합|정보기술|사물인터넷|임베디드|네트워크|컴퓨팅|ICT|\bIT\b|\bAI\b|AI(?=[가-힣])|\bSW\b|Computing|Software/i, topic: { key: 'computing', label: '컴퓨터·정보', keywords: ['인공지능', 'AI', '소프트웨어', '반도체', '보안', '데이터', '알고리즘', '컴퓨팅', '로봇', '디지털'], feeds: ['technology', 'digital', 'science'] } },
  { match: /전기|전자|반도체|기계|자동차|로봇|항공|우주|모빌리티|메카트로닉스|기전|디스플레이|조선|금형|광공학|통신/, topic: { key: 'engineering', label: '전기·기계', keywords: ['전력', '전기차', '배터리', '반도체', '로봇', '항공', '우주', '자율주행', '모빌리티', '에너지', '제조', '디스플레이', '위성'], feeds: ['technology', 'science', 'economy'] } },
  { match: /(?<!문)화학|화공|신소재|재료|에너지|고분자|소재|이차전지|원자력|탄소중립/, topic: { key: 'chemistry', label: '화학·소재', keywords: ['화학', '신소재', '배터리', '전해액', '촉매', '수소', '고분자', '탄소', '에너지', '소재', '원자력'], feeds: ['science', 'technology', 'environment'] } },
  { match: /생명|바이오|생물/, topic: { key: 'biology', label: '생명·생물', keywords: ['생명', '바이오', '생물', '유전자', '세포', '단백질', '생태', '미생물', '효모'], feeds: ['science', 'environment', 'society'] } },
  { match: /경영|경제|금융|회계|무역|통상|경상|비즈니스|커머스|물류|부동산|Business|Trade/i, topic: { key: 'economics', label: '경제·경영', keywords: ['경제', '금융', '금리', '기업', '산업', '무역', '투자', '고용', '경영', '시장', '환율', '물류', '부동산'], feeds: ['economy', 'digital', 'society'] } },
  { match: /건축|건설|토목|도시|교통|한옥|스마트시티|공간정보|인프라/, topic: { key: 'built_environment', label: '건축·도시', keywords: ['건축', '건설', '도시', '주택', '교통', '인프라', '정비사업', '재난', '도시공간', '공간정보', '스마트시티', '건물'], feeds: ['economy', 'environment', 'society'] } },
  { match: /산업공학|산업시스템|안전|제조|생산기술|산업과학/, topic: { key: 'industry', label: '산업·안전', keywords: ['산업', '제조', '생산', '안전', '제조공정', '공정 기술', '공정기술', '공정 개선', '공정개선', '생산공정', '공장', '자동화', '로봇', '재난', '노동'], feeds: ['technology', 'economy', 'society'] } },
  { match: /사회|행정|정치|국제|복지|공공|소비자|아동|가족|지역|지리|문헌정보|리더|안보/, topic: { key: 'social_science', label: '사회·정책', keywords: ['정책', '사회', '복지', '행정', '법원', '법률', '인권', '노동', '국제', '청년', '지역', '아동', '가족'], feeds: ['society', 'economy', 'culture'] } },
  { match: /국어|영어|문학|문예|철학|사학|역사|어문|언어|인문|일본|중국|독일|프랑스|러시아|스페인|아랍|고고|문화재|문화유산|문화|한국학|미학|Language/i, topic: { key: 'humanities', label: '언어·인문', keywords: ['문학', '역사', '철학', '언어', '책', '출판', '인문', '문화', '박물관', '한글', '유산'], feeds: ['culture', 'society', 'science'] } },
  { match: /수학|통계|물리|천문|지질|지구과학|자연과학|해양학|해양과학|대기과학|이학/, topic: { key: 'natural_science', label: '기초과학', keywords: ['수학', '통계', '물리', '천문', '우주', '지질', '양자', '과학', '천체', '분자', '해양', '온난화', '기온 상승'], feeds: ['science', 'technology', 'environment'] } },
];
const commonTopic: NewsTopic = { key: 'common', label: '공통 시사', keywords: ['정책', '사회', '경제', '교육', '기후', '인공지능', 'AI', '청년', '노동', '인권', '복지'], feeds: ['society', 'economy', 'science'] };
const categoryTopics: Record<string, string> = { '인문학':'humanities', '언어・문학':'humanities', '경영・경제':'economics', '간호':'health', '사회과학':'social_science', '생활과학':'fashion', '음악':'arts', '미술':'arts', '건설':'built_environment', '교육':'education', '기계':'engineering', '농림・수산':'agriculture', '연극・영화':'arts', '수학・물리・천문・지구':'natural_science', '산업・안전':'industry', '화학・생명과학・환경':'biology', '화공・고분자・에너지':'chemistry', '의료예과':'health', '응용예술':'arts', '재료':'chemistry', '전기・전자・컴퓨터':'engineering', '무용・체육':'sports', '약학':'health', '보건':'health', '법학':'law', '교통・수송':'engineering', '의료':'health' };
function topicByKey(key: string) { return topics.find(row=>row.topic.key===key)?.topic || null; }
/** The category/field must come from the server-resolved official department. */
export function majorNewsConnection(major: string, metadata: NewsMajorMetadata = {}): { topic: NewsTopic | null; connection: NewsConnection | null } {
  const clean = major.trim().replace(/\s+/g, ' ');
  if (!clean || /^(미정|선택|미선택|없음)$/.test(clean)) return {topic:null,connection:null};
  const related = (topic:NewsTopic,basis:NewsConnection['basis']) => ({topic,connection:{basis,label:topic.label,...metadata}});
  const broad = /자유전공|자율전공|무전공|자율학부|광역|통합모집|기타모집단위|새내기|전공자유|열린전공|도전탐색|학부대학|스크랜튼|인터칼리지|혁신칼리지|아너스|진리자유|기초학부/.test(clean);
  const matched = topics.find(item => item.match.test(clean)&&!(item.topic.key==='computing'&&/로봇|모빌리티|반도체|전기|전자/.test(clean)));
  if (matched) return related(matched.topic,broad?'related_field':'major_topic');
  const categoryTopic=topicByKey(categoryTopics[metadata.category||'']);
  if(categoryTopic)return related(categoryTopic,'related_field');
  const fieldTopic=topicByKey(({공학계열:'engineering',자연과학계열:'natural_science',인문사회계열:'social_science',예체능계열:'arts',의학계열:'health',교육계열:'education'} as Record<string,string>)[metadata.field||'']);
  if(fieldTopic)return related(fieldTopic,'related_field');
  if(broad||metadata.field==='광역계열'||/^(융합|첨단|미래|글로벌).*(학부|계열|전공)$/.test(clean))return related(commonTopic,'common');
  const keyword = clean.replace(/(학과|학부|전공|계열|공학과|과)$/g, '').trim();
  return keyword.length >= 2 ? related({ key: `major:${keyword}`, label: clean, keywords: [keyword], feeds: ['society', 'science', 'economy'] },'keyword') : {topic:null,connection:null};
}
export function majorNewsTopic(major: string, metadata: NewsMajorMetadata = {}): NewsTopic | null { return majorNewsConnection(major,metadata).topic; }

export function cleanNewsText(value: string, max = 220): string {
  let text = value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  // A feed may entity-encode HTML twice; never return markup from it.
  for (let i = 0; i < 3; i++) text = text.replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (_, hex, dec) => {
    const code = parseInt(hex || dec, hex ? 16 : 10); return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
  }).replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, entity: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[entity.toLowerCase()] || '');
  return text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function tag(item: string, name: string): string {
  const safeName = name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  return item.match(new RegExp(`<${safeName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${safeName}>`, 'i'))?.[1] || '';
}
export function feedArticleURL(value: string, key: NewsFeedKey): string | null {
  try {
    const url = new URL(cleanNewsText(value, 4096));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || !NEWS_FEEDS[key].articleHosts.some(host => url.hostname === host)) return null;
    url.hash = ''; for (const name of Array.from(url.searchParams.keys())) if (/^utm_|^(fbclid|gclid)$/.test(name)) url.searchParams.delete(name);
    return url.href;
  } catch { return null; }
}
export function newsPublishedAt(value: string): string | null {
  const clean = cleanNewsText(value, 100);
  // These Korean publisher RSS feeds omit an offset; their displayed times are KST.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(clean) ? clean.replace(' ', 'T') + '+09:00' : clean;
  const stamp = new Date(normalized).getTime(); return Number.isFinite(stamp) ? new Date(stamp).toISOString() : null;
}
/** Parse a publisher once, then reuse its bounded recent headlines across subjects. */
export function parsePublisherFeed(xml: string, key: NewsFeedKey, now = new Date()): Omit<NewsArticle, 'id'>[] {
  if (xml.length > 2_000_000 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('허용되지 않은 뉴스 피드 형식');
  if (!/<rss[\s>]/i.test(xml) || !/<channel[\s>]/i.test(xml)) throw new Error('뉴스 피드 형식을 확인할 수 없음');
  const found = new Map<string, Omit<NewsArticle, 'id'>>();
  for (const block of xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi)?.slice(0, 250) || []) {
    const title = cleanNewsText(tag(block, 'title'), 300), snippet = cleanNewsText(tag(block, 'description'), 180);
    const url = feedArticleURL(tag(block, 'link'), key);
    const publishedAt = newsPublishedAt(tag(block, 'pubDate') || tag(block, 'dc:date'));
    if (!title || !url || !publishedAt) continue;
    const age = now.getTime() - new Date(publishedAt).getTime();
    // Missing or future timestamps are discarded, never replaced by collection time.
    if (age < 0 || age > 30 * 86_400_000) continue;
    if (/^\[(社告|사고|부고|인사|포토)\]/.test(title)) continue;
    found.set(url, { title, url, publisher: NEWS_FEEDS[key].name, snippet, publishedAt, fetchedAt: now.toISOString(), keywords:[], feedKey: key });
  }
  return [...found.values()].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}
export function matchingNewsKeywords(title: string, topic: NewsTopic): string[] {
  const headline=title.toLocaleLowerCase('ko-KR');
  return topic.keywords.filter(keyword=>{
    if(!keyword.trim())return false;
    const clean=keyword.toLocaleLowerCase('ko-KR');
    if(clean==='책')return /(?:^|[^가-힣])책(?:$|[\s\p{P}]|(?:은|이|을|에|의|도|으로|과|에서|부터)(?=$|[\s\p{P}]))/u.test(headline);
    if(clean==='영양')return headline.replace(/영양군/g,'').includes(clean);
    if(clean==='올림픽')return headline.replace(/올림픽공원/g,'').includes(clean);
    if(clean==='학교')return headline.replace(/취업사관학교/g,'').includes(clean);
    if(clean==='의사')return headline.replace(/의사결정|의사소통|의사표시/g,'').includes(clean);
    if(/^[a-z0-9]+$/i.test(clean))return new RegExp(`(?<![a-z0-9])${clean}(?![a-z0-9])`,'i').test(headline);
    return headline.includes(clean);
  });
}
export function filterNewsTopic(articles: Omit<NewsArticle,'id'>[],topic:NewsTopic): Omit<NewsArticle,'id'>[] {
  return articles.flatMap(article=>{
    const keywords=matchingNewsKeywords(article.title,topic);
    return topic.feeds.includes(article.feedKey)&&keywords.length?[{...article,keywords}]:[];
  });
}
export function parseNewsFeed(xml: string, key: NewsFeedKey, topic: NewsTopic, now = new Date()): Omit<NewsArticle, 'id'>[] {
  return filterNewsTopic(parsePublisherFeed(xml,key,now),topic);
}

export function newsPracticeQuestion(article: Pick<NewsArticle, 'title' | 'keywords'>, major: string): string {
  const concept = article.keywords.slice(0, 2).join('·');
  return `「${article.title}」 기사를 읽고, ${major}의 관점에서 ‘${concept || '이 문제'}’에 관해 중요하다고 생각한 점과 그 이유를 설명해 주세요. 기사에서 확인한 내용과 본인의 생각을 구분해 말해 주세요.`;
}
