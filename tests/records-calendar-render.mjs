import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise calendar navigation against synthetic records without a server or private data.
let states=[],cursor=0;
const module={exports:{}};
const source=fs.readFileSync(new URL('../apps/web/src/components/records-calendar.tsx',import.meta.url),'utf8');
vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,Date,Intl,Set,URLSearchParams,require(name){
  if(name==='react')return {useState(initial){const index=cursor++;if(!(index in states))states[index]=initial;return [states[index],value=>states[index]=value];}};
  if(name==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
  if(name==='next/link')return {default:'Link'};
  if(name==='./report-download')return {ReportDownload:'ReportDownload'};
  if(name==='lucide-react')return new Proxy({},{get:(_,key)=>key});
  if(name==='@/lib/planner-model')return {koreaToday:()=> '2026-10-23'};
  if(name.endsWith('.module.css'))return {default:new Proxy({},{get:(_,key)=>key})};
  throw Error('Unexpected import '+name);
}});
const records=[{id:'one',date:'2026-10-23',title:'오늘 면접',href:'/reports/reports/one',kind:'interview',completed:true},{id:'two',date:'2026-10-21',title:'지난 훈련',href:'/reports/sessions/two',kind:'study',completed:true},{id:'three',date:'2026-09-30',title:'지난달 훈련',href:'/reports/sessions/three',kind:'study',completed:false}];
const props={records,hasMore:true,loadingMore:false,onMore(){}};
function nodes(value){if(Array.isArray(value))return value.flatMap(nodes);return value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];}
function render(extra={}){cursor=0;return module.exports.RecordsCalendar({...props,...extra});}
const links=tree=>nodes(tree).filter(node=>node.type==='Link').map(node=>node.props.href);
let tree=render();
assert.deepEqual(links(tree),['/reports/reports/one?date=2026-10-23']);
assert.ok(nodes(tree).find(node=>node.props?.['aria-label']==='다음 달').props.disabled);
const day=nodes(tree).find(node=>node.type==='button'&&node.props['aria-label']?.startsWith('10월 21일'));
day.props.onClick();tree=render();assert.deepEqual(links(tree),['/reports/sessions/two?date=2026-10-21']);
nodes(tree).find(node=>node.props?.['aria-label']==='이전 달').props.onClick();tree=render();assert.deepEqual(links(tree),['/reports/sessions/three?date=2026-09-30']);
assert.equal(nodes(tree).filter(node=>node.type==='Check'&&node.props.className==='stamp').length,0,'active work does not receive a completion stamp');
nodes(tree).find(node=>node.props?.['aria-label']==='다음 달').props.onClick();tree=render();assert.deepEqual(links(tree),['/reports/reports/one?date=2026-10-23']);
const future=nodes(tree).find(node=>node.type==='button'&&node.props['aria-label']?.startsWith('10월 24일'));assert.equal(future.props.disabled,true);
states=[];tree=render({initialDate:'2026-10-21',currentAction:{date:'2026-10-23',finishing:false,onFinish(){}}});
assert.ok(!nodes(tree).some(node=>node.props?.children==='진행 중인 학습 마치기'),'a different date never shows today’s active session action');assert.deepEqual(links(tree),['/reports/sessions/two?date=2026-10-21'],'returning from a report restores its calendar date');
assert.equal(module.exports.recordDate('2026-10-22T16:00:00Z'),'2026-10-23','late UTC records stay on the Korean calendar date');
assert.equal(module.exports.recordDate('invalid'),'');
states=[];tree=render({initialDate:'2026-99-12'});assert.deepEqual(links(tree),['/reports/reports/one?date=2026-10-23'],'invalid date queries fall back to the latest valid date');
states=[];tree=render({records:[{...records[0],href:'/reports/reports/one?targetId=school&date=old#question-2'}]});
assert.deepEqual(links(tree),['/reports/reports/one?targetId=school&date=2026-10-23#question-2'],'calendar links preserve existing context and fragment while replacing the selected date');

const navigation={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../apps/web/src/lib/app-navigation.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:navigation,exports:navigation.exports});
const mobile={exports:{}};let mobilePath='/reports/reports/one',mobileQuery='date=2026-10-21';
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../apps/web/src/components/mobile-back.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,{module:mobile,exports:mobile.exports,Date,URLSearchParams,require(name){
  if(name==='next/navigation')return {usePathname:()=>mobilePath,useSearchParams:()=>new URLSearchParams(mobileQuery)};
  if(name==='next/link')return {default:'Link'};
  if(name==='react/jsx-runtime')return {jsx:(type,props)=>({type,props})};
  if(name==='lucide-react')return {ArrowLeft:'ArrowLeft'};
  if(name==='@/lib/app-navigation')return navigation.exports;
  if(name==='./owned-class-name')return {ownedClassName:value=>value};
  if(name.endsWith('.module.css'))return {default:{mobileBack:'mobileBack'}};
  throw Error('Unexpected mobile import '+name);
}});
assert.equal(mobile.exports.MobileBack().props.href,'/records?date=2026-10-21','visible mobile back restores the selected calendar date');
mobilePath='/records/sessions/one';assert.equal(mobile.exports.MobileBack().props.href,'/records?date=2026-10-21');
for(const date of ['','2026-02-30','2026-99-12','https://example.com','//example.com','2026-10-21&next=https://example.com']){
  mobileQuery=new URLSearchParams({date}).toString();assert.equal(mobile.exports.MobileBack().props.href,'/records','invalid or redirect-like dates retain the fixed in-app parent');
}
mobileQuery='date=2024-02-29';assert.equal(mobile.exports.MobileBack().props.href,'/records?date=2024-02-29','real leap dates are accepted');
mobilePath='/records';assert.equal(mobile.exports.MobileBack().props.href,'/preparation','calendar root keeps the dashboard parent');
mobilePath='/knowledge/article';assert.equal(mobile.exports.MobileBack().props.href,'/knowledge','date query cannot replace an unrelated parent');
console.log('Records calendar and mobile return: date selection, query preservation, exact date validation and in-app navigation regressions passed.');
