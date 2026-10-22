import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { balanceNewsPublishers, cleanNewsText, feedArticleURL, majorNewsConnection, majorNewsTopic, matchingNewsKeywords, newsPracticeQuestion, newsPublishedAt, parseNewsFeed, parsePublisherFeed, filterNewsTopic, type NewsTopic } from '../apps/web/src/lib/department-news-model.ts';
import { readFileSync } from 'node:fs';
// Next resolves this marker internally. Standalone Node tests resolve its bundled
// empty implementation explicitly, without NODE_PATH or any product-code change.
registerHooks({ resolve(specifier, context, nextResolve) {
  return specifier === 'server-only'
    ? { url: new URL('../node_modules/next/dist/compiled/server-only/empty.js', import.meta.url).href, shortCircuit: true }
    : nextResolve(specifier, context);
} });
const now = new Date('2026-10-12T06:00:00Z'), topic = majorNewsTopic('환경공학과')!;
function item({ title = '수질과 미세플라스틱 연구', url = 'https://www.waterjournal.co.kr/news/articleView.html?idxno=123', date = '2026-10-12 09:30:00', snippet = '연구팀이 결과를 공개했다.' } = {}) { return `<item><title><![CDATA[${title}]]></title><link>${url}</link><pubDate>${date}</pubDate><description><![CDATA[${snippet}]]></description></item>`; }
const feed = (...items: string[]) => `<rss version="2.0"><channel>${items.join('')}</channel></rss>`;
test('department topics use real registered majors; no invented default for undecided', () => {
  assert.equal(majorNewsTopic('미정'), null); assert.equal(majorNewsTopic(''), null);
  assert.equal(topic.key, 'environment'); assert.ok(topic.keywords.includes('미세플라스틱'));
  assert.equal(majorNewsTopic('컴퓨터공학부')?.key, 'computing'); assert.equal(majorNewsTopic('경영학과')?.key, 'economics');
  assert.equal(majorNewsTopic('의예과')?.key, 'health'); assert.equal(majorNewsTopic('해양문화학과')?.key, 'humanities');
  assert.deepEqual(majorNewsTopic('희귀학제학과')?.keywords, ['희귀학제']);
});
test('ambiguous interdisciplinary names retain their professional subject',()=>{
  for(const [name,key] of [['환경교육과','education'],['국어교육과','education'],['간호환경학과','health'],['의공학과','health'],['의료정보학과','health'],['식품영양학과','food'],['농학과','agriculture'],['스마트팜과학과','agriculture'],['언어학과','humanities'],['해양문화학과','humanities'],['문화학과','humanities'],['사회복지학과','social_science'],['법학과','law'],['건축디자인학과','arts'],['건축공학과','built_environment'],['의류환경학과','fashion'],['AI모빌리티공학과','engineering'],['지능형로봇학과','engineering'],['전자공학과','engineering'],['신학과','religion'],['소프트웨어학과','computing'],['생명화학공학과','chemistry']]) assert.equal(majorNewsTopic(name)?.key,key,name);
});
test('official category fills unfamiliar department names, broad admissions do not invent a specialization',()=>{
  assert.equal(majorNewsConnection('IBE전공',{category:'경영・경제',field:'인문사회계열'}).topic?.key,'economics');
  assert.equal(majorNewsConnection('IBE전공',{category:'경영・경제'}).connection?.basis,'related_field');
  assert.equal(majorNewsConnection('자유전공학부',{category:'N.C.E',field:'광역계열'}).connection?.basis,'common');
  assert.equal(majorNewsConnection('공과대학자유전공학부',{category:'N.C.E',field:'공학계열'}).connection?.basis,'related_field');
  assert.equal(majorNewsConnection('미정',{category:'경영・경제'}).topic,null);
});
test('every official school department is assessed without single-keyword or unresolved catalog fallback',()=>{
  const directory=JSON.parse(readFileSync(new URL('../apps/web/src/data/school-directory.json',import.meta.url),'utf8'));
  const departments=directory.schools.flatMap((school:any)=>school.departments);
  assert.equal(directory.schools.length,88);assert.equal(departments.length,3934);
  for(const d of departments){const result=majorNewsConnection(d.name,d);assert.ok(result.topic&&result.connection,d.name);assert.notEqual(result.connection?.basis,'keyword',d.name);assert.ok(result.topic!.feeds.length&&result.topic!.keywords.length,d.name);}
});
test('Latin keyword boundaries and humanities book term do not match unrelated word fragments',()=>{
  assert.deepEqual(matchingNewsKeywords('Chair 기업의 책임과 대책 발표',majorNewsTopic('컴퓨터공학과')!),[]);
  assert.deepEqual(matchingNewsKeywords('기업 책임과 대책 발표',majorNewsTopic('국어국문학과')!),[]);
  assert.ok(matchingNewsKeywords('이 책은 우리 시대의 언어를 말한다',majorNewsTopic('언어학과')!).includes('책'));
  assert.ok(matchingNewsKeywords('AI 시대에 필요한 보안',majorNewsTopic('컴퓨터공학과')!).includes('AI'));
  assert.deepEqual(matchingNewsKeywords('영화는 상상력 펼치는 공간',majorNewsTopic('건축공학과')!),[]);
});
test('live-feed homonyms cannot turn food poisoning into psychology or weapons into fashion',()=>{
  for(const [title,major] of [['식중독 의심 신고 757명','심리학과'],['명품무기 K2 K9 부품 수출','의류환경학과'],['영양군 안전캠핑 성황','식품영양학과'],['외국인 코스피 순매도','관광학과'],['선관위 올림픽공원 투표용지 검증','스포츠학과'],['공정위 취업사관학교 전락','교육학과'],['공정위 브랜드 사용료 기준','산업공학과'],['기업 의사결정 개선','의학과']])assert.deepEqual(matchingNewsKeywords(title,majorNewsTopic(major)!),[],title);
  assert.ok(matchingNewsKeywords('청소년 게임중독 상담',majorNewsTopic('심리학과')!).includes('게임중독'));
  assert.ok(matchingNewsKeywords('영양군 어린이 영양 관리',majorNewsTopic('식품영양학과')!).includes('영양'));
});
test('publisher parsed once can serve several topics without leaking irrelevant headlines',()=>{
  const xml=feed(item({title:'수질과 미세플라스틱 연구'}),item({title:'영화와 문화 이야기',url:'https://www.waterjournal.co.kr/news/articleView.html?idxno=2'}));
  const rows=parsePublisherFeed(xml,'water',now);assert.equal(rows.length,2);
  assert.equal(filterNewsTopic(rows,topic).length,1);
  assert.equal(filterNewsTopic(rows,majorNewsTopic('영화학과')!).length,0); // not an arts publisher
});
test('server uses selected official school and department, never arbitrary category fields',async()=>{
  const {newsConnectionForTarget}=await import('../apps/web/src/lib/department-news.ts');
  const {schoolDirectory}=await import('../apps/web/src/lib/school-directory.ts');
  const directory=JSON.parse(readFileSync(new URL('../apps/web/src/data/school-directory.json',import.meta.url),'utf8'));
  const school=directory.schools.find((row:any)=>row.departments.some((d:any)=>d.name==='IBE전공'));
  const department=school.departments.find((d:any)=>d.name==='IBE전공');
  assert.equal(newsConnectionForTarget({school_reference_id:school.id,department_catalog_id:department.id,major:department.name}).topic?.key,'economics');
  assert.equal(newsConnectionForTarget({major:'IBE전공',department_category:'경영・경제',department_field:'인문사회계열'}).connection?.basis,'keyword');
  assert.equal(newsConnectionForTarget({school_reference_id:directory.schools[0].id,department_catalog_id:department.id,major:department.name}).connection?.basis,'keyword');
  // The immutable disclosure includes aggregate '기타모집단위' rows. These are
  // intentionally excluded from the app's selectable department catalogue.
  for(const selectedSchool of schoolDirectory)for(const selectedDepartment of selectedSchool.departments){
    const actual=newsConnectionForTarget({school_reference_id:selectedSchool.id,department_catalog_id:selectedDepartment.id,major:selectedDepartment.name});
    const expected=majorNewsConnection(selectedDepartment.name,selectedDepartment);
    assert.equal(actual.topic?.key,expected.topic?.key,`${selectedSchool.university} ${selectedDepartment.name}`);
    assert.equal(actual.connection?.basis,expected.connection?.basis,`${selectedSchool.university} ${selectedDepartment.name}`);
  }
});
test('HTML, CDATA and nested entities become safe readable text, never markup', () => {
  assert.equal(cleanNewsText('<![CDATA[<script>alert(1)</script><p>수질 &amp;quot;연구&amp;quot;</p>]]>'), '수질 "연구"');
  assert.equal(cleanNewsText('&lt;img src=x onerror=evil&gt;소식'), '소식');
  assert.equal(cleanNewsText('A&#x1f600; B&#55296; C&#1114112;'), 'A😀 B C');
  assert.equal(cleanNewsText('a'.repeat(400), 180).length, 180);
});
test('article URLs are fixed publisher hosts; tracking removed', () => {
  assert.equal(feedArticleURL('https://www.waterjournal.co.kr/news/articleView.html?idxno=1&amp;utm_source=x#top', 'water'), 'https://www.waterjournal.co.kr/news/articleView.html?idxno=1');
  for (const url of ['javascript:alert(1)', 'http://127.0.0.1/x', 'http://localhost/x', 'https://www.waterjournal.co.kr.evil.test/a', 'https://evil@www.waterjournal.co.kr/a', 'https://www.waterjournal.co.kr:999/a']) assert.equal(feedArticleURL(url, 'water'), null);
});
test('Korean offset-free publisher timestamps are KST, never collection time', () => {
  assert.equal(newsPublishedAt('2026-10-12 09:30:00'), '2026-10-12T00:30:00.000Z');
  assert.equal(newsPublishedAt('Mon, 12 Oct 2026 09:30:00 +0900'), '2026-10-12T00:30:00.000Z');
  assert.equal(newsPublishedAt(''), null); assert.equal(newsPublishedAt('not-a-date'), null);
});
test('eligible article carries real date, title, publisher and bounded RSS excerpt', () => {
  const rows = parseNewsFeed(feed(item({ snippet: 'a'.repeat(800) })), 'water', topic, now);
  assert.equal(rows.length, 1); assert.equal(rows[0].publisher, '워터저널'); assert.equal(rows[0].publishedAt, '2026-10-12T00:30:00.000Z');
  assert.equal(rows[0].snippet.length, 180); assert.deepEqual(rows[0].keywords, ['미세플라스틱', '수질']);
});
test('articles older than 30 days, future-dated, undated or irrelevant are excluded', () => {
  assert.equal(parseNewsFeed(feed(item({ date: '2026-09-01 09:00:00' }), item({ date: '2026-10-13 09:00:00' }), item({ date: '' }), item({ title: '연예인 결혼', snippet: '환경을 위한 기후와 수질 연구' })), 'water', topic, now).length, 0);
});
test('publisher announcement and foreign article domains are excluded', () => {
  assert.equal(parseNewsFeed(feed(item({ title: '[社告] 기후 행사 안내' }), item({ url: 'https://evil.test/a' })), 'water', topic, now).length, 0);
});
test('the same canonical link is deduplicated and newest items sort first', () => {
  const rows = parseNewsFeed(feed(item({ date: '2026-10-10 09:00:00' }), item({ date: '2026-10-11 09:00:00' }), item({ url: 'https://www.waterjournal.co.kr/news/articleView.html?idxno=2', date: '2026-10-12 09:00:00' })), 'water', topic, now);
  assert.equal(rows.length, 2); assert.ok(rows[0].url.endsWith('idxno=2'));
});
test('DOCTYPE, entities, excessive feed and non-RSS error pages rejected', () => {
  for (const xml of ['<!DOCTYPE rss><rss><channel/></rss>', '<!ENTITY test "abc"><rss><channel/></rss>', 'a'.repeat(2_000_001), '<html>Error</html>']) assert.throws(() => parseNewsFeed(xml, 'water', topic, now));
});
test('dc:date feeds supported without inventing publication timestamps', () => {
  const xml = '<rss><channel><item><title>기후와 탄소</title><link>https://www.khan.co.kr/article/1</link><dc:date>2026-10-11T10:00:00+09:00</dc:date></item></channel></rss>';
  assert.equal(parseNewsFeed(xml, 'science', topic, now)[0].publishedAt, '2026-10-11T01:00:00.000Z');
});
test('practice prompt cites the same headline and asks to distinguish facts and reflection', () => {
  const prompt = newsPracticeQuestion({ title: '미세플라스틱 필터 연구', keywords: ['미세플라스틱'] }, '환경공학과');
  assert.ok(prompt.includes('미세플라스틱 필터 연구')); assert.ok(prompt.includes('환경공학과')); assert.ok(prompt.includes('기사에서 확인한 내용과 본인의 생각을 구분'));
});
test('collector only fetches configured publishers, stops automatic redirects and deduplicates titles', async () => {
  const { collectDepartmentNews } = await import('../apps/web/src/lib/department-news.ts');
  const seen: { url: string; redirect: unknown }[] = [];
  const selected: NewsTopic = { ...topic, feeds: ['water', 'environment'] };
  const fetcher: typeof fetch = async (url, options) => {
    seen.push({ url: String(url), redirect: options?.redirect });
    const local = String(url).includes('waterjournal') ? 'https://www.waterjournal.co.kr/news/articleView.html?idxno=1' : 'https://www.hkbs.co.kr/news/articleView.html?idxno=1';
    return new Response(feed(item({ url: local })), { headers: { 'content-type': 'application/xml' } });
  };
  const result = await collectDepartmentNews(selected, { now, fetcher });
  assert.equal(result.articles.length, 1); assert.equal(result.successfulSources, 2); assert.deepEqual(result.failedSources, []);
  assert.equal(seen.length, 2); assert.ok(seen.every(row => row.redirect === 'error')); assert.ok(seen.every(row => row.url.endsWith('/rss/allArticle.xml')));
});
test('collector partial failures preserve successful results; total failure is explicit', async () => {
  const { collectDepartmentNews } = await import('../apps/web/src/lib/department-news.ts');
  const partial = await collectDepartmentNews({ ...topic, feeds: ['water', 'environment'] }, { now, fetcher: async url => { if (String(url).includes('hkbs')) throw new Error('offline'); return new Response(feed(item()), { headers: { 'content-type': 'application/xml' } }); } });
  assert.equal(partial.articles.length, 1); assert.equal(partial.successfulSources, 1); assert.deepEqual(partial.failedSources, ['environment']);
  const all = await collectDepartmentNews(topic, { now, fetcher: async () => { throw new Error('offline'); } });
  assert.equal(all.articles.length, 0); assert.equal(all.successfulSources, 0); assert.equal(all.failedSources.length, topic.feeds.length);
});
test('a finite news snapshot balances publishers instead of letting the newest desk occupy every slot',()=>{
 const articles=Array.from({length:25},(_,index)=>({title:`도시 교통 계획 ${index}`,url:`https://one.test/${index}`,publisher:'같은 신문',publishedAt:new Date(now.getTime()-index*1000).toISOString()}));
 articles.push({title:'다른 지역의 교통 대책',url:'https://two.test/1',publisher:'다른 신문',publishedAt:new Date(now.getTime()-29*1000).toISOString()});
 articles.push({title:'지속 가능한 도시 정책',url:'https://three.test/1',publisher:'세 번째 신문',publishedAt:new Date(now.getTime()-30*1000).toISOString()});
 const selected=balanceNewsPublishers(articles,20);
 assert.equal(selected.length,20);assert.deepEqual(selected.slice(0,3).map(item=>item.publisher),['같은 신문','다른 신문','세 번째 신문']);
 assert.equal(articles.length,27,'selection never mutates the source list');
});
test('syndicated breaking-news labels do not create duplicate headlines',()=>{
 const article={title:'도시 교통 정책 발표',url:'https://one.test/1',publisher:'신문 A',publishedAt:now.toISOString()};
 assert.equal(balanceNewsPublishers([article,{...article,title:'[속보] 도시 교통 정책 발표',url:'https://two.test/2',publisher:'신문 B'}]).length,1);
 assert.deepEqual(balanceNewsPublishers([article],0),[]);
});
test('even majors whose primary desks belong to one publisher have alternate general-news sources',()=>{
 for(const major of ['심리학과','사회학과','언어학과','경제학과']){
  const feeds=majorNewsTopic(major)!.feeds;
  assert.ok(feeds.includes('digital')&&feeds.includes('economy')&&feeds.includes('technology'),major);
 }
});
test('oversized responses and HTML are failures; no scraping follow-up request happens', async () => {
  const { collectDepartmentNews } = await import('../apps/web/src/lib/department-news.ts');
  for (const response of [new Response('<html>error</html>', { headers: { 'content-type': 'text/html' } }), new Response('x', { headers: { 'content-type': 'application/xml', 'content-length': '2000001' } }), new Response('a'.repeat(2_000_001), { headers: { 'content-type': 'application/xml' } })]) {
    let calls = 0;
    const result = await collectDepartmentNews({ ...topic, feeds: ['water'] }, { now, fetcher: async () => { calls++; return response; } });
    assert.equal(result.successfulSources, 0); assert.equal(calls, 1);
  }
});
