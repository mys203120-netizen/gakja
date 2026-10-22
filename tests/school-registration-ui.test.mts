import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source=ts.transpileModule(readFileSync('apps/web/src/components/school-registration.tsx','utf8')+'\nexport {loadSchoolDetails};',{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
const school={id:'school',university:'확인대학교',departments:[{id:'department',name:'환경공학부',campus:'본교',college:'공과대학'}]};
const nodes=(tree:any):any[]=>Array.isArray(tree)?tree.flatMap(nodes):tree&&typeof tree==='object'?[tree,...nodes(tree.props?.children)]:[];
const text=(tree:any):string=>Array.isArray(tree)?tree.map(text).join(''):tree&&typeof tree==='object'?text(tree.props?.children):tree==null?'':String(tree);

function harness(initialTarget?:any,catalog=[school]){
 const states:any[]=[],refs:any[]=[],effects:any[]=[],queue:any[]=[],calls:any[]=[],writes:any[]=[],metadataReplies:any[]=[],writeReplies:any[]=[];let stateIndex=0,refIndex=0,effectIndex=0;
 const actionButton=({pending,children,...props}:any)=>({type:'button',props:{...props,children,disabled:props.disabled||pending}});
 const jsx=(type:any,props:any)=>type===actionButton?actionButton(props):({type,props});
 const module={exports:{} as any};
 vm.runInNewContext(source,{module,exports:module.exports,JSON,AbortController,Number,encodeURIComponent,
  setTimeout(callback:any){callback();return 1;},clearTimeout(){},require(name:string){if(name==='./owned-class-name'||name==='@/components/owned-class-name')return {ownedClassName:(value:string|undefined)=>value};
   if(name==='react')return {useState(initial:any){const index=stateIndex++;if(!(index in states))states[index]=typeof initial==='function'?initial():initial;return [states[index],(value:any)=>{states[index]=typeof value==='function'?value(states[index]):value;}];},useRef(initial:any){return refs[refIndex++]??={current:initial};},useEffect(callback:any,deps:any[]){const index=effectIndex++,old=effects[index];if(!old||deps.some((value,index)=>!Object.is(value,old.deps[index]))){queue.push(()=>{old?.cleanup?.();effects[index]={deps,cleanup:callback()};});}}};
   if(name==='react/jsx-runtime')return {jsx,jsxs:jsx,Fragment:'Fragment'};
   if(name==='next/link')return {default:'Link'};
   if(name==='lucide-react')return new Proxy({},{get:(_,key)=>String(key)});
   if(name==='./school-picker')return {SchoolPicker:'SchoolPicker'};
   if(name==='./school-logo')return {SchoolLogo:'SchoolLogo'};
   if(name==='./training-availability')return {TrainingAvailability:'TrainingAvailability'};
   if(name==='@/lib/schedule')return {scheduleDateLabel:(value:any)=>value};
   if(name==='@/lib/calendar-source-presentation')return {visibleCalendarSourceText:(value:any)=>value||'',visibleCalendarSourceUrl:(value:any)=>value||'',visibleCalendarSourceLabel:()=> '입학처'};
   if(name.endsWith('.module.css'))return {default:new Proxy({},{get:(_,key)=>String(key)})};
   if(name==='./shared')return {ActionButton:actionButton,Breadcrumb:'Breadcrumb',Alert:'Alert',Spinner:'Spinner',Logo:'Logo',post:async(path:any,body:any)=>{writes.push({path,body});if(writeReplies.length){const reply=writeReplies.shift();if(reply instanceof Error)throw reply;return reply;}const targets=(body.registrations||[body]).map((input:any,index:number)=>({id:'saved-'+index,university:catalog.find(item=>item.id===input.referenceId)?.university||school.university,department:'환경공학부'}));return {target:targets.at(-1),targets};},api:async(path:any,options:any)=>{
    calls.push({path,options});if(path.startsWith('/api/schools/catalog'))return metadataReplies.length?metadataReplies.shift():{school:catalog.find(item=>item.id===new URL(path,'http://fixture.test').searchParams.get('schoolId'))||school};
    const input=JSON.parse(options.body),matched=[{id:'date',startDate:'2026-11-29',endDate:'2026-11-29',trackLabel:'학생부종합'}];
    const calendar={fingerprint:'a'.repeat(64),track:input.track,matched:input.track==='학생부종합'?matched:[],canReview:input.track==='학생부종합',tracks:['학생부종합'],status:'registered',statusLabel:'면접 일정 확인',note:'학교 공개 일정',references:[],unresolved:[],officialSources:[],checkedAt:'2026-10-20'};
    return {calendar,...(input.track==='미정'?{suggestedCalendar:{...calendar,track:'학생부종합',matched,canReview:true}}:{})};
   }};
   throw Error(name);
  }});
 const props={catalog,loading:false,error:'',onboarding:true,onSaved:async()=>{},initialTarget};let tree:any;
 function render(){stateIndex=0;refIndex=0;effectIndex=0;tree=module.exports.SchoolRegistration(props);return tree;}
 async function settle(){for(let index=0;index<8;index++){render();while(queue.length)queue.shift()();await new Promise(resolve=>setImmediate(resolve));}return tree;}
 return {calls,writes,render,settle,metadataReplies,writeReplies,props,loadSchoolDetails:module.exports.loadSchoolDetails,get tree(){return tree;}};
}

test('the school registration UI has one step heading, a fixed 2027 payload, and preserves evidence acknowledgement',async()=>{
 const h=harness();let tree=await h.settle();
 assert.ok(!text(tree).includes('각자ON 시작하기'));assert.ok(!text(tree).includes('지원 학교부터, 나의 면접까지.'));
 assert.ok(!text(tree).includes('학생부·제출서류 기반 면접을 준비할 수 있는 학교예요.'));
 assert.ok(!text(tree).includes('학교 전체가 아닌, 선택한 학과·전형의 면접 방식을 기준으로 준비해요.'));
 assert.ok(nodes(tree).some(node=>node.type==='h1'&&text(node)==='지원 학교 등록'));
 nodes(tree).find(node=>node.type==='button'&&node.props['data-selected']!==undefined).props.onClick();tree=await h.settle();
 await nodes(tree).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});tree=await h.settle();
 assert.ok(!nodes(tree).some(node=>node.type==='input'&&node.props.type==='number'));
 nodes(tree).find(node=>node.type==='SchoolPicker'&&node.props.label==='지원 학과·학부').props.onChange('department');tree=await h.settle();
 const next=nodes(tree).find(node=>node.type==='button'&&text(node)==='다음');assert.ok(next&&!next.props.disabled);
 assert.equal(h.calls.filter(call=>call.path==='/api/schools/onboarding-calendar').length,1,'a server-signed single track is selected without another calendar POST');
 assert.ok(h.calls.filter(call=>call.path==='/api/schools/onboarding-calendar').every(call=>JSON.parse(call.options.body).admissionYear===2027));
 await nodes(tree).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});tree=await h.settle();
 const acknowledgement=nodes(tree).find(node=>node.type==='input'&&node.props.type==='checkbox');assert.ok(acknowledgement);
 await nodes(tree).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});assert.equal(h.writes.length,0,'the next-step label does not bypass final evidence acknowledgement');
 acknowledgement.props.onChange({target:{checked:true}});tree=h.render();await nodes(tree).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});
 assert.equal(h.writes.length,1);assert.equal(h.writes[0].body.admissionYear,2027);assert.equal(h.writes[0].body.calendarReview.acknowledged,true);assert.equal(h.writes[0].body.calendarReview.fingerprint,'a'.repeat(64));
});

test('editing an old registration also previews the supported 2027 year without a year selector',async()=>{
 const h=harness({id:'old',school_reference_id:school.id,department_catalog_id:'department',university:school.university,department:'환경공학부',admission_year:2040,admission_type:'학생부종합'});
 const tree=await h.settle();assert.ok(!nodes(tree).some(node=>node.type==='input'&&node.props.type==='number'));
 const previews=h.calls.filter(call=>call.path==='/api/schools/onboarding-calendar');assert.ok(previews.length);assert.ok(previews.every(call=>JSON.parse(call.options.body).admissionYear===2027));
});
test('a forced department retry bypasses both the local metadata cache and shared API cache',async()=>{
 const h=harness();await h.loadSchoolDetails(school.id);await h.loadSchoolDetails(school.id);assert.equal(h.calls.length,1);
 await h.loadSchoolDetails(school.id,true);assert.equal(h.calls.length,2);assert.equal(h.calls[1].options.cache,'no-store');
});
test('a late old prefetch cannot replace the metadata returned by a forced retry',async()=>{
 const h=harness();let oldDone:any,newDone:any;h.metadataReplies.push(new Promise(resolve=>{oldDone=resolve;}),new Promise(resolve=>{newDone=resolve;}));
 const old=h.loadSchoolDetails(school.id),fresh=h.loadSchoolDetails(school.id,true);
 newDone({school:{...school,marker:'new'}});await fresh;oldDone({school:{...school,marker:'old'}});await old;
 assert.equal((await h.loadSchoolDetails(school.id)).school.marker,'new');assert.equal(h.calls.length,2);
});

test('multiple-school selection preserves each university draft and commits only after every review',async()=>{
 const second={...school,id:'school-two',university:'두번째대학교'},h=harness(undefined,[school,second]);let tree=await h.settle();
 for(const id of [school.id,second.id]){nodes(tree).find(node=>node.type==='button'&&node.props['aria-pressed']!==undefined&&nodes(node).some(child=>child.type==='SchoolLogo'&&child.props.school.id===id)).props.onClick();tree=await h.settle();}
 assert.equal(nodes(tree).filter(node=>node.type==='button'&&node.props['aria-pressed']===true).length,2);
 const submit=async()=>{await nodes(tree).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});tree=await h.settle();};
 const selectMajor=async()=>{nodes(tree).find(node=>node.type==='SchoolPicker'&&node.props.label==='지원 학과·학부').props.onChange('department');tree=await h.settle();};
 const acknowledge=()=>{nodes(tree).find(node=>node.type==='input'&&node.props.type==='checkbox').props.onChange({target:{checked:true}});tree=h.render();};
 await submit();await selectMajor();await submit();acknowledge();await submit();
 assert.equal(h.writes.length,0,'the first university review stays local until the full batch is confirmed');
 assert.equal(nodes(tree).find(node=>node.type==='SchoolPicker'&&node.props.label==='지원 학과·학부').props.value,'','the second university starts with its own fields');
 const schoolNavigation=nodes(tree).find(node=>node.type==='nav'&&node.props['aria-label']==='선택한 대학별 지원 정보');
 nodes(schoolNavigation).find(node=>node.type==='button'&&text(node).includes(school.university)).props.onClick();tree=await h.settle();
 assert.equal(nodes(tree).find(node=>node.type==='SchoolPicker'&&node.props.label==='지원 학과·학부').props.value,'department','going back retains the first university major');
 await submit();acknowledge();await submit();await selectMajor();await submit();acknowledge();
 const form=nodes(tree).find(node=>node.type==='form');await Promise.all([form.props.onSubmit({preventDefault(){}}),form.props.onSubmit({preventDefault(){}})]);tree=await h.settle();
 assert.equal(h.writes.length,1,'rapid final confirmation has one in-flight mutation');
 assert.deepEqual(JSON.parse(JSON.stringify(h.writes[0].body.registrations.map((input:any)=>input.referenceId))),[school.id,second.id]);
 assert.ok(h.writes[0].body.registrations.every((input:any)=>input.calendarReview.acknowledged&&input.departmentId==='department'));
 assert.equal(nodes(tree).find(node=>node.type==='TrainingAvailability').props.schoolLabel,'2개 지원 학교');
});

test('a failed batch retains all reviewed schools and retry sends the same complete batch',async()=>{
 const second={...school,id:'school-two',university:'두번째대학교'},h=harness(undefined,[school,second]);let tree=await h.settle();
 for(const button of nodes(tree).filter(node=>node.type==='button'&&node.props['aria-pressed']!==undefined))button.props.onClick();tree=await h.settle();
 const submit=async()=>{await nodes(tree).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});tree=await h.settle();};
 await submit();
 for(let index=0;index<2;index++){
  nodes(tree).find(node=>node.type==='SchoolPicker'&&node.props.label==='지원 학과·학부').props.onChange('department');tree=await h.settle();await submit();
  nodes(tree).find(node=>node.type==='input'&&node.props.type==='checkbox').props.onChange({target:{checked:true}});tree=h.render();
  if(index===1)h.writeReplies.push(Error('일시적인 저장 오류'));
  await submit();
 }
 assert.equal(h.writes.length,1);assert.match(text(tree),/일시적인 저장 오류/);
 nodes(tree).find(node=>node.type==='input'&&node.props.type==='checkbox').props.onChange({target:{checked:true}});tree=h.render();await submit();
 assert.equal(h.writes.length,2);assert.equal(JSON.stringify(h.writes[1].body),JSON.stringify(h.writes[0].body));
});
