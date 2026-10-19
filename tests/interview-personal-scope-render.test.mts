import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as flow from '../apps/web/src/lib/interview-flow';
import * as scope from '../apps/web/src/lib/school-interview-scope';
import * as identity from '../apps/web/src/lib/learning-target-scope';

const target={id:'old-target',university:'고려대학교',department:'경영학과',admission_type:'고른기회',admission_year:2027};
const question={id:'own-question',prompt:'맡은 역할을 설명해 주세요.',grounding_types:['document_based']};
let params=new URLSearchParams(),values:any[]=[],hook=0,calls:any[]=[];
const app={data:{user:{id:'owner'},targets:[target],package:{active_version:2},learning:{questions:[question]},schoolProfiles:[{target_id:target.id,status:'official_confirmed',data:{format:'document',interviewer_count:{min:4,max:4}}}]},targetId:target.id,setTargetId(){},openResource(){}};
const mod={exports:{} as any};
vm.runInNewContext(ts.transpileModule(readFileSync('apps/web/src/components/interview-setup.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,{
  module:mod,exports:mod.exports,URLSearchParams,crypto:{randomUUID:()=> 'fixture-start-request'},
  require(name:string){
    if(name==='react')return {useState(initial:any){const index=hook++;return [index in values?values[index]:initial,(value:any)=>values[index]=value];},useEffect(){}};
    if(name==='react/jsx-runtime')return {jsx:(type:any,props:any)=>({type,props}),jsxs:(type:any,props:any)=>({type,props}),Fragment:'Fragment'};
    if(name==='next/link')return {__esModule:true,default:'Link'};
    if(name==='next/navigation')return {useSearchParams:()=>params,useRouter:()=>({replace:(href:string)=>calls.push({replace:href}),push:(href:string)=>calls.push({href})})};
    if(name==='lucide-react')return new Proxy({},{get:(_,key)=>String(key)});
    if(name==='./app-shell')return {useApp:()=>app};
    if(name==='./learning-help')return {LearningHelp:'LearningHelp'};
    if(name==='./question-experience-picker')return {QuestionExperiencePicker:'QuestionExperiencePicker'};
    if(name==='./shared')return {api:async(url:string,options:any)=>{calls.push({url,body:JSON.parse(options.body)});return {session:{id:'new-session'}};},ActionButton:'ActionButton',PageTitle:'PageTitle',Breadcrumb:'Breadcrumb',Alert:'Alert',targetName:(value:any)=>value.university};
    if(name==='@/lib/interview-flow')return flow;
    if(name==='@/lib/school-interview-scope')return scope;
    if(name==='@/lib/learning-target-scope')return identity;
    throw Error(name);
  },
});
function nodes(tree:any):any[]{return Array.isArray(tree)?tree.flatMap(nodes):tree&&typeof tree==='object'?[tree,...nodes(tree.props?.children)]:[];}
function render(preview:any,query=''){
  params=new URLSearchParams(query);values=[false,'',null,preview,'',false];hook=0;calls=[];
  return mod.exports.InterviewSetup({kind:'chat'});
}
const preview={question:null,questions:[question],sourceKind:'personal',contentVersion:2,practiceAllowed:true,practiceScope:'personal_record',practiceLabel:'일반 경험 면접',practiceNotice:'내 자료의 경험 연습이며 실제 전형 면접은 재현하지 않아요.'};
test('ordinary Chat entry enables personal record practice and suppresses school-profile settings',async()=>{
  const tree=render(preview,'details=1&mode=university');
  const action=nodes(tree).find(node=>node.type==='ActionButton');assert.equal(action.props.disabled,false);
  const university=nodes(tree).find(node=>node.type==='input'&&node.props.value==='university');assert.equal(university.props.disabled,true);
  assert.ok(JSON.stringify(tree).includes(preview.practiceNotice));
  await action.props.onClick();
  assert.equal(calls[0].body.mode,'basic');assert.equal(calls[0].body.panelistCount,2,'official four-person profile is not used for general practice');
  assert.equal(calls[0].body.targetId,target.id);assert.equal(calls[1].href,'/interview/new-session?kind=chat');
});
test('an exact old question CTA keeps its source version while blocked public practice stays disabled',async()=>{
  let tree=render({...preview,question,contentVersion:1},'questionId=own-question&sourceType=personal&sourceVersion=1');
  await nodes(tree).find(node=>node.type==='ActionButton').props.onClick();
  assert.equal(calls[0].body.questionId,question.id);assert.equal(calls[0].body.sourceType,'personal');assert.equal(calls[0].body.sourceVersion,1);
  tree=render({...preview,questions:[],sourceKind:'common',practiceAllowed:false,practiceScope:'blocked',practiceLabel:null,practiceNotice:'제시문 면접 제외'});
  assert.equal(nodes(tree).find(node=>node.type==='ActionButton').props.disabled,true);
  assert.ok(nodes(tree).some(node=>node.type==='Alert'));
});
test('an unsupported-target warning waits until the published question scope has loaded',()=>{
  render(null);values[5]=true;hook=0;
  const tree=mod.exports.InterviewSetup({kind:'chat'});
  assert.ok(!nodes(tree).some(node=>node.type==='Alert'));
  assert.equal(nodes(tree).find(node=>node.type==='ActionButton').props.disabled,true);
});
test('question experience selection preserves question, source version and school and applies only the selected revision',()=>{
  const tree=render({...preview,question,contentVersion:1},'questionId=own-question&sourceType=personal&sourceVersion=1&targetId=old-target');
  const picker=nodes(tree).find(node=>node.type==='QuestionExperiencePicker');assert.ok(picker);assert.equal(calls.length,0);
  picker.props.onSelect({id:'owned-experience',revision:4,data:{title:'내 경험'}});
  const selected=new URL(calls[0].replace,'http://fixture.test');assert.equal(selected.searchParams.get('questionId'),question.id);assert.equal(selected.searchParams.get('sourceVersion'),'1');assert.equal(selected.searchParams.get('sourceType'),'personal');assert.equal(selected.searchParams.get('targetId'),target.id);assert.equal(selected.searchParams.get('experienceCardId'),'owned-experience');assert.equal(selected.searchParams.get('experienceRevision'),'4');
  picker.props.onSelect(null);const cleared=new URL(calls[1].replace,'http://fixture.test');assert.equal(cleared.searchParams.has('experienceCardId'),false);assert.equal(cleared.searchParams.get('questionId'),question.id);
});
