import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {INTERVIEWER_PORTRAITS,interviewerPortrait} from '../apps/web/src/lib/interviewer-portraits';
import {InterviewerAvatarSignal} from '../apps/web/src/lib/client/interviewer-avatar';

function render(props:Record<string,unknown>,root?:{dataset:Record<string,string>;style:{setProperty:(name:string,value:string)=>void}}){
  const source=readFileSync('apps/web/src/components/interviewer-character.tsx','utf8');
  const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const module={exports:{} as any};
  vm.runInNewContext(output,{module,exports:module.exports,process:{env:{}},require:(name:string)=>{
    if(name==='react')return {useRef:()=>({current:root||null}),useEffect:(effect:()=>void)=>{if(root)effect();}};
    if(name==='react/jsx-runtime')return {jsx:(type:any,props:any)=>({type,props}),jsxs:(type:any,props:any)=>({type,props})};
    if(name==='@/lib/interviewer-portraits')return {interviewerPortrait};
    if(name==='./live2d-interviewer')return {Live2DInterviewer:'Live2DInterviewer'};
    if(name==='./portrait-mouth')return {PortraitMouth:'PortraitMouth'};
    if(name==='./portrait-expression')return {PortraitExpression:'PortraitExpression'};
    if(name==='./owned-class-name')return {ownedClassName:(value:any)=>value};
    if(name.endsWith('.module.css'))return {__esModule:true,default:{avatar:'avatar',portrait:'portrait',identity:'identity'}};
    throw new Error(name);
  }});
  return module.exports.Interviewer(props);
}
function nodes(value:any):any[]{return Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];}
function image(tree:any){return nodes(tree).find(node=>node.type==='img');}

test('all five supported panelists retain their own fixed adult identity',()=>{
  assert.equal(INTERVIEWER_PORTRAITS.length,5);
  assert.equal(new Set(['A','B','C','D','E'].map(id=>interviewerPortrait(id).src)).size,5);
  assert.equal(interviewerPortrait('unusual-id',2).src,interviewerPortrait('C').src);
  assert.equal(interviewerPortrait('unusual-id',NaN).src,interviewerPortrait('unusual-id').src);
});

test('speaking, waiting, listening and historical reaction data preserve the same original identity asset',()=>{
  const person={id:'B',name:'면접관 B'};
  const variants=[{}, {speaking:true}, {listening:true}, {pending:true}, {reaction:{level:0,status:'evaluated',signal:'off_topic'}}, {compact:true}];
  const trees=variants.map(state=>render({person,...state}));
  assert.ok(trees.every(tree=>image(tree).props.src===interviewerPortrait('B').src));
  assert.ok(trees.every(tree=>image(tree).props.alt.includes('면접관 B')));
  assert.ok(trees.every(tree=>!nodes(tree).some(node=>node.type==='svg'||node.props?.['data-reaction-level']!==undefined)));
  assert.equal(image(trees[0]).props.width,image(trees[0]).props.height);
});

test('measured-output rooms add a local mouth renderer while static history has no animation source',()=>{
  const person={id:'B',name:'면접관 B'},signal={snapshot:{state:'speaking',speakerId:'B',mouthOpen:.7}};
  const active=render({person,avatarSignal:signal}),mouth=nodes(active).find(node=>node.type==='PortraitMouth');assert.ok(mouth);assert.equal(mouth.props.personId,'B');assert.equal(mouth.props.portraitId,'clay-b');assert.equal(mouth.props.src,interviewerPortrait('B').src);assert.equal(mouth.props.signal,signal);assert.ok(!nodes(render({person,speaking:true})).some(node=>node.type==='PortraitMouth'),'a speaking label alone cannot invent lip motion');
});

test('the five production assets are distinct transparent PNG files',()=>{
  const buffers=INTERVIEWER_PORTRAITS.map(portrait=>readFileSync('apps/web/public'+portrait.src));
  assert.ok(buffers.every(buffer=>buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))));
  assert.ok(buffers.every(buffer=>buffer[25]===6),'RGBA alpha remains intact');
  assert.equal(new Set(buffers.map(buffer=>buffer.toString('base64'))).size,5);
});

test('only measured output dims the other portraits; pauses and listening restore every interviewer',()=>{
  const signal=new InterviewerAvatarSignal(),roots=['A','B','C'].map(id=>{const root={dataset:{} as Record<string,string>,style:{setProperty(){}}};render({person:{id,name:id},avatarSignal:signal},root);return root;});
  signal.state('speaking','A');assert.ok(roots.every(root=>root.dataset.dimmed==='false'),'preparing speech without measured sound does not dim the panel');
  signal.mouth(.6);assert.deepEqual(roots.map(root=>root.dataset.dimmed),['false','true','true']);
  signal.silence();assert.ok(roots.every(root=>root.dataset.dimmed==='false'),'waveform silence restores the panel');
  signal.state('speaking','B');signal.mouth(.4);assert.deepEqual(roots.map(root=>root.dataset.dimmed),['true','false','true'],'the actual output speaker owns the spotlight');
  signal.state('listening','B');assert.ok(roots.every(root=>root.dataset.dimmed==='false'),'the student microphone never dims interviewers');
  signal.state('speaking','A');signal.mouth(.8);signal.reset();assert.ok(roots.every(root=>root.dataset.dimmed==='false'),'pause, exit and teardown remove the spotlight');
});

test('the Live stage gives every visible participant the shared measured-output signal',()=>{
  const module={exports:{} as any},signal=new InterviewerAvatarSignal();
  vm.runInNewContext(ts.transpileModule(readFileSync('apps/web/src/components/live-interviewer-stage.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{module,exports:module.exports,require(name:string){
    if(name==='react/jsx-runtime')return {jsx:(type:any,props:any)=>({type,props}),jsxs:(type:any,props:any)=>({type,props})};
    if(name==='./interviewer-character')return {Interviewer:'Interviewer'};
    if(name==='./owned-class-name')return {ownedClassName:(value:any)=>value};
    if(name==='lucide-react')return new Proxy({},{get:(_target,key)=>String(key)});
    if(name.endsWith('.module.css'))return {__esModule:true,default:new Proxy({},{get:(_target,key)=>String(key)})};
    throw Error(name);
  }});
  const tree=module.exports.LiveInterviewerStage({people:[{id:'A',name:'A'},{id:'B',name:'B'},{id:'C',name:'C'}],speakerId:'A',phase:'speaking',avatarSignal:signal});
  const participants=nodes(tree).filter(node=>node.type==='Interviewer');assert.equal(participants.length,5);assert.ok(participants.every(node=>node.props.avatarSignal===signal),'inactive thumbnails need the same output to dim and restore');
  for(const phase of ['idle','paused']){
    const typed=module.exports.LiveInterviewerStage({people:[],phase,answerMode:'text',question:'같은 질문'});
    assert.equal(nodes(typed).some(node=>['stageStatus','stageHint'].includes(node.props?.className)),false,'typing already has a labelled editor; idle copy does not repeat it');
    assert.ok(nodes(typed).some(node=>node.type==='h2'&&node.props.children==='같은 질문'));
  }
  const saving=module.exports.LiveInterviewerStage({people:[],phase:'saving',answerMode:'text'});
  assert.ok(nodes(saving).some(node=>node.props?.role==='status'),'actual saving remains announced');
});
