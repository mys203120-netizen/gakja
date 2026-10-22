import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {tsImport} from 'tsx/esm/api';

const targetScope=await tsImport('../apps/web/src/lib/learning-target-scope.ts',import.meta.url);

// Render the actual components, then invoke their real filter handlers.
// No server, private student data, paid model, or synthetic browser is involved.
const states=[];let stateIndex=0,path='/materials',query=new URLSearchParams();
const app={data:{documents:[{kind:'guidebook'},{kind:'handbook'}],learning:{activities:[],source_refs:[]}},openResource(){}};
function load(file,extra='') {
  const source=fs.readFileSync(new URL('../apps/web/src/components/'+file,import.meta.url),'utf8')+extra;
  const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
  const module={exports:{}};
  vm.runInNewContext(output,{module,exports:module.exports,URLSearchParams,Intl,require(name){if(name==='@/lib/client/device-storage'||name==='./client/device-storage')return {setDeviceItem:(storage,key,value)=>storage.setItem(key,value),openDeviceDocumentScope:()=>({ready:Promise.resolve(),close(){}})};if(name==='./owned-class-name'||name==='@/components/owned-class-name')return {ownedClassName:(value)=>value};
    if(name==='react')return {Suspense:'Suspense',useState(initial){const index=stateIndex++;if(!(index in states))states[index]=initial;return [states[index],value=>{states[index]=typeof value==='function'?value(states[index]):value;}];},useEffect(){},useRef:initial=>({current:initial})};
    if(name==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props}),Fragment:'Fragment'};
    if(name==='next/link')return {__esModule:true,default:'Link'};
    if(name==='next/navigation')return {useSearchParams:()=>query,usePathname:()=>path};
    if(name==='lucide-react')return new Proxy({},{get:(_,key)=>String(key)});
    if(name==='./app-shell')return {useApp:()=>app};
    if(name.endsWith('.module.css'))return {__esModule:true,default:new Proxy({},{get:(_,key)=>String(key)})};
    if(name==='./shared')return {PageTitle:'PageTitle',Empty:'Empty',Spinner:'Spinner',Breadcrumb:'Breadcrumb',Alert:'Alert',Modal:'Modal'};
    if(name==='./learning-help')return {LearningHelp:'LearningHelp'};
    if(name==='@/lib/knowledge-bites-catalog')return {KNOWLEDGE_FOCUS:{science:'과학·환경',society:'공동체·사회'}};
    if(name==='@/lib/knowledge-flow-model')return {knowledgeTargetKey:()=>'',knowledgeCheckPrompt:()=>''};
    if(name==='@/lib/material-learning-flow')return {publishedMaterialBooks:documents=>documents};
    if(name==='@/lib/learning-target-scope')return targetScope;
    throw new Error('Unexpected import '+name);
  }});
  return module.exports;
}
function nodes(value){if(Array.isArray(value))return value.flatMap(nodes);if(!value||typeof value!=='object')return [];return [value,...nodes(value.props?.children)];}
function text(value){if(Array.isArray(value))return value.map(text).join(' ');if(value&&typeof value==='object')return text(value.props?.children);return value==null?'':String(value);}
let checks=0;function check(value,message){assert.ok(value,message);checks++;}
const {KnowledgeList,VideoThumbnail}=load('knowledge-bites.tsx','\nexport {KnowledgeList,VideoThumbnail};');
const {MaterialNavigation}=load('material-navigation.tsx');
const video=(id,origin,extra={})=>({id,label:'자료 '+id,title:id,topic:'수질',stretch:'연결 이유 '+id,channel:'공식 채널',current:true,focus:'science',activities:[],contexts:[],originLabels:[origin],progress:null,...extra});
const content={videos:[video('school','학교 연결'),video('record','내 기록',{activities:[{id:'a1',title:'하천 조사'}]}),video('major','학과 연결',{focus:'society'}),video('question','내 기록',{relatedQuestions:[{id:'q1'}]}),video('extra','학과 연결'),video('old','내 기록',{current:false,progress:{saved:true,completed_at:'2026-10-01'}}),video('saved','학교 연결',{progress:{saved:true,completed_at:null}}),...Array.from({length:13},(_,index)=>video('published-'+index,'학과 연결'))],selectedTarget:{id:'target',university:'선택 대학',department:'환경공학과'},contextQuestion:{id:'q1',prompt:'본인 역할은?'},activities:[{id:'a1',title:'하천 조사'}],searches:[{activityId:'a1',activityTitle:'하천 조사',topic:'물의 순환',url:'https://www.youtube.com/results?search_query=water'}],stats:{available:19,saved:2,completed:1}};
function render(reset=false){if(reset)states.length=0;stateIndex=0;return KnowledgeList({content});}
function rows(tree){return nodes(tree).filter(node=>node.type==='article'&&node.props.className.includes('knowledge-row'));}
let tree=render(true);
check(rows(tree).length===19,'all nineteen published recommendations appear on the first render');
check(!text(rows(tree)).includes('자료 old'),'recommendations keep unrequested historical records out of the current list');
check(!nodes(tree).some(node=>node.type==='button'&&text(node).includes('추천 자료 더 보기')),'the full list needs no reveal or more-materials button');
check(text(rows(tree)[0]).includes('자료 question'),'a current-question connection precedes a general school link');
check(text(rows(tree)[1]).includes('자료 school'),'the remaining recommendations retain the server’s diverse published order');
const primary=nodes(tree).find(node=>node.type==='nav'&&node.props['aria-label']==='자료 보기');
check(nodes(primary).filter(node=>node.type==='button').length===2,'only recommendation and saved are primary tabs');
const filterGroup=nodes(tree).find(node=>node.props?.role==='group'&&node.props['aria-label']==='자료 찾기');
check(filterGroup&&filterGroup.type==='div'&&!nodes(tree).some(node=>node.type==='details'),'search, filters, and additional topic links are available without disclosure controls');
check(nodes(tree).some(node=>node.type==='input'&&node.props.type==='search'&&node.props['aria-label']==='자료·활동 검색'),'a labelled search field is visible above the full list');
check(nodes(filterGroup).some(node=>node.type==='select'&&node.props['aria-label']==='연결 활동'),'activity filter remains available');
check(nodes(filterGroup).some(node=>node.type==='select'&&node.props['aria-label']==='주제 분야'),'topic filter remains available');
check(nodes(tree).some(node=>node.type==='a'&&node.props.href===content.searches[0].url),'related topics keep their external search escape route');
nodes(tree).find(node=>node.type==='select'&&node.props['aria-label']==='학습 연결').props.onChange({target:{value:'학교 연결'}});tree=render();
check(rows(tree).length===2&&text(rows(tree)).includes('자료 school')&&text(rows(tree)).includes('자료 saved'),'school connection filter shows only the selected origin');
nodes(tree).find(node=>node.type==='button'&&text(node)==='조건 초기화').props.onClick();tree=render();
nodes(tree).find(node=>node.type==='select'&&node.props['aria-label']==='주제 분야').props.onChange({target:{value:'society'}});tree=render();
check(rows(tree).length===1&&text(rows(tree)).includes('자료 major'),'topic selection narrows the full list');
nodes(tree).find(node=>node.type==='button'&&text(node)==='조건 초기화').props.onClick();tree=render();
nodes(tree).find(node=>node.type==='select'&&node.props['aria-label']==='연결 활동').props.onChange({target:{value:'a1'}});tree=render();
check(rows(tree).length===1&&text(rows(tree)).includes('자료 record'),'activity selection retains only connected material');
nodes(tree).find(node=>node.type==='button'&&text(node)==='조건 초기화').props.onClick();tree=render();
nodes(tree).find(node=>node.type==='button'&&text(node).trim().startsWith('저장')).props.onClick();tree=render();
check(rows(tree).length===2&&text(rows(tree)).includes('자료 old'),'saved view keeps historical saved items accessible');
nodes(tree).find(node=>node.type==='input'&&node.props.type==='checkbox').props.onChange({target:{checked:true}});tree=render();
check(rows(tree).length===1&&text(rows(tree)).includes('자료 old'),'viewed-only can narrow saved history without deleting it');
tree=render(true);nodes(tree).find(node=>node.type==='input'&&node.props['aria-label']==='자료·활동 검색').props.onChange({target:{value:'존재하지않는자료'}});tree=render();
check(rows(tree).length===0&&nodes(tree).some(node=>node.type==='Empty'&&node.props.title==='조건에 맞는 자료가 없어요'),'no matching conditions produce an explicit empty state');
nodes(tree).find(node=>node.type==='button'&&text(node)==='조건 초기화').props.onClick();tree=render();
check(rows(tree).length===19,'reset restores all published recommendations without a second click');
query=new URLSearchParams('targetId=target&flow=today&sessionId=00000000-0000-4000-8000-000000000000');tree=render(true);
const detail=nodes(rows(tree)[0]).find(node=>node.type==='Link'&&node.props.className==='knowledge-thumbnail');
check(['questionId=q1','targetId=target','flow=today','sessionId='].every(part=>detail.props.href.includes(part)),'recommendation keeps question, selected target, and learning-session links');
states.length=0;stateIndex=0;
const thumbnail=VideoThumbnail({video:video('thumb','내 기록',{thumbnail:'https://i.ytimg.com/vi/test/hqdefault.jpg'})});
check(thumbnail.type==='img'&&thumbnail.props.loading==='lazy','showing the complete list keeps below-fold thumbnails lazy');
for(const route of ['/materials','/materials/activities','/materials/questions/q1','/materials/answers/q1','/materials/guidebook','/materials/handbook']) {
  path=route;tree=MaterialNavigation();const group=nodes(tree).find(node=>node.type==='nav'&&node.props['aria-label']==='내 교재 구성');
  const links=nodes(group).filter(node=>node.type==='Link');
  check(links.length===5,'five material children remain directly available at '+route);
  check(links.filter(node=>node.props['aria-current']==='page').length===(route==='/materials'?0:1),'only the exact child is selected at '+route);
  check(links.some(node=>text(node)==='답변 초안'),'prepared answers are clearly named drafts at '+route);
  check(!links.some(node=>['/knowledge','/materials','/materials/briefings'].includes(node.props.href)),'child tabs never duplicate the global material sections at '+route);
}
for(const route of ['/materials/briefings','/materials/briefings/news/a1','/knowledge','/schools']){
  path=route;check(MaterialNavigation()===null,'material children do not appear outside personal materials at '+route);
}
app.data.documents=[];path='/materials/activities';tree=MaterialNavigation();
check(nodes(tree).filter(node=>node.type==='Link').length===3,'unpublished books are not offered as empty child pages');
console.log(`Learning surface render and navigation: ${checks} checks passed; external calls: 0.`);
