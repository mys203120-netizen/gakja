/** Read-only catalog + fixed publisher audit. No student writes or AI requests. */
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { NEWS_FEEDS,NEWS_TOPIC_REVISION,majorNewsConnection,filterNewsTopic,type NewsTopic } from '../apps/web/src/lib/department-news-model.ts';
registerHooks({resolve(specifier,context,nextResolve){return specifier==='server-only'?{url:new URL('../node_modules/next/dist/compiled/server-only/empty.js',import.meta.url).href,shortCircuit:true}:nextResolve(specifier,context);}});
const {collectPublisherNews}=await import('../apps/web/src/lib/department-news.ts');
const directory=JSON.parse(await readFile(new URL('../apps/web/src/data/school-directory.json',import.meta.url),'utf8'));
const checkedAt=new Date();
const feeds=await collectPublisherNews({now:checkedAt});
const departments=directory.schools.flatMap((school:any)=>school.departments.map((department:any)=>({school:school.university,schoolId:school.id,...department})));
const topics=new Map<string,NewsTopic>();
const rows=departments.map((department:any)=>{
  const match=majorNewsConnection(department.name,{category:department.category,field:department.field});
  if(match.topic)topics.set(match.topic.key,match.topic);
  return {school:department.school,schoolId:department.schoolId,departmentId:department.id,name:department.name,category:department.category,field:department.field,topic:match.topic?.key||null,basis:match.connection?.basis||null,label:match.connection?.label||null};
});
const topicRows=[...topics.values()].map(topic=>{
  const matched=filterNewsTopic(feeds.flatMap(feed=>feed.articles),topic);
  const seen=new Set<string>(),titles=new Set<string>();
  const articles=matched.sort((a,b)=>b.publishedAt.localeCompare(a.publishedAt)).filter(article=>{
    const title=article.title.replace(/[\s\p{P}]/gu,'').toLocaleLowerCase('ko-KR');
    if(seen.has(article.url)||titles.has(title))return false;seen.add(article.url);titles.add(title);return true;
  });
  const successfulFeeds=feeds.filter(feed=>topic.feeds.includes(feed.key)&&feed.status==='ok').length;
  return {...topic,departmentCount:rows.filter((row:any)=>row.topic===topic.key).length,status:articles.length?'recent_articles':successfulFeeds===topic.feeds.length?'empty':'unavailable',successfulFeeds,failedFeeds:feeds.filter(feed=>topic.feeds.includes(feed.key)&&feed.status==='failed').map(feed=>feed.key),recentEligibleArticles:articles.length,displayedArticles:Math.min(20,articles.length),newest:articles.slice(0,3).map(({title,url,publisher,publishedAt,keywords})=>({title,url,publisher,publishedAt,keywords}))};
});
const resultRows=rows.map((row:any)=>({...row,recentArticles:topicRows.find(topic=>topic.key===row.topic)?.displayedArticles||0,liveStatus:topicRows.find(topic=>topic.key===row.topic)?.status||'unmapped'}));
const byBasis:Record<string,number>={};for(const row of resultRows)byBasis[row.basis||'unmapped']=(byBasis[row.basis||'unmapped']||0)+1;
const summary={schools:directory.schools.length,departments:departments.length,uniqueDepartmentNames:new Set(departments.map((row:any)=>row.name)).size,topics:topicRows.length,byBasis,unmapped:resultRows.filter((row:any)=>!row.topic).length,keywordFallback:resultRows.filter((row:any)=>row.basis==='keyword').length,departmentsWithRecentTopicArticles:resultRows.filter((row:any)=>row.recentArticles>0).length,departmentsWithoutRecentTopicArticles:resultRows.filter((row:any)=>row.recentArticles===0).length,topicsWithRecentArticles:topicRows.filter(topic=>topic.displayedArticles>0).length,emptyTopics:topicRows.filter(topic=>topic.status==='empty').map(topic=>topic.key),unavailableTopics:topicRows.filter(topic=>topic.status==='unavailable').map(topic=>topic.key),publishersSucceeded:feeds.filter(feed=>feed.status==='ok').length,publishersTotal:feeds.length};
const output={checkedAt:checkedAt.toISOString(),topicRevision:NEWS_TOPIC_REVISION,catalogSource:directory.departmentSource,method:'학과명 주제 매핑 → 공식 학과 분류/계열 → 광역 공통 시사. 지정 언론사 RSS의 최근 30일 제목 키워드 일치. 각 학과별 전문 기사가 매일 존재한다는 의미가 아님.',summary,publishers:feeds.map(feed=>({key:feed.key,name:NEWS_FEEDS[feed.key].name,url:NEWS_FEEDS[feed.key].url,status:feed.status,recentHeadlines:feed.articles.length})),topicCoverage:topicRows,departmentCoverage:resultRows,gaps:resultRows.filter((row:any)=>!row.recentArticles)};
await mkdir('.local',{recursive:true});
const evidence='.local/department-news-coverage-2026-10-12.json';
await writeFile(evidence,JSON.stringify(output,null,2));
console.log(JSON.stringify({checkedAt:output.checkedAt,...summary,topics:topicRows.map(({key,label,departmentCount,displayedArticles,recentEligibleArticles,status})=>({key,label,departmentCount,displayedArticles,recentEligibleArticles,status})),evidence},null,2));
if(summary.unmapped||summary.keywordFallback||!summary.publishersSucceeded)process.exitCode=1;
