import assert from 'node:assert/strict';
import test from 'node:test';
import {parse} from 'parse5';
import {readableReportArticle,readableReportHeader,readableReportSection} from '../apps/web/src/lib/account-readable-report.ts';

function elements(node:any,name:string):any[]{return [node,...(node.childNodes||[]).flatMap((child:any)=>elements(child,name))].filter((item:any)=>item.tagName===name);}
test('readable report escapes untrusted profile, titles and nested answer HTML without executable elements',()=>{
  const injection='<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const html=readableReportHeader({name:injection,email:'<test@example.com>'},'2026-10-22T15:00:00Z')+readableReportSection('user_answers')+readableReportArticle('user_answers',{id:'secret-id',title:injection,script:injection,data:{feedback:injection},created_at:'2026-10-22T15:00:00Z'})+'</section></body></html>';
  const document=parse(html);assert.equal(elements(document,'script').length,0);assert.equal(elements(document,'img').length,0);
  assert.match(html,/&lt;script&gt;/);assert.match(html,/&lt;test@example.com&gt;/);assert.doesNotMatch(html,/secret-id/);
  assert.match(html,/휴지통과 미디어 원본/);assert.match(html,/2026년 10월 23일/,'dates use Korea calendar days');
});
test('readable report keeps human content and meaningful labels while omitting technical inventories and private references',()=>{
  const experience=readableReportArticle('experience_cards',{id:'abc',student_id:'def',revision:7,data:{title:'협업',situation:'의견 충돌',action:'함께 논의함',result:'합의',sourceNote:'직접 기록',pinned:true},created_at:'2026-10-22T00:00:00Z'});
  assert.match(experience,/상황: 의견 충돌/);assert.match(experience,/내 행동: 함께 논의함/);assert.match(experience,/결과·배운 점: 합의/);
  assert.doesNotMatch(experience,/student_id|revision|pinned|abc|def/);
  assert.equal(readableReportArticle('recording_uploads',{files:[{path:'private-storage'}]}),'');
  const chat=readableReportArticle('chat_messages',{role:'user',content:'내 답변'});assert.match(chat,/말한 사람: 나/);assert.match(chat,/내용: 내 답변/);
});
test('long readable text is visibly identified and the standalone report has exactly four font sizes',()=>{
  const article=readableReportArticle('user_answers',{script:'가'.repeat(200001)});assert.match(article,/긴 글의 나머지는 전체 JSON 백업/);
  const header=readableReportHeader({name:'학생',email:'student@example.com'},'2026-10-22T00:00:00Z');
  const sizes=new Set([...header.matchAll(/(?:font-size:|font:)(\d+)px/g)].map(match=>Number(match[1])));assert.deepEqual([...sizes].sort((a,b)=>a-b),[14,16,20,28]);
});
