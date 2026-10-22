import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

function nodes(tree:any):any[]{return Array.isArray(tree)?tree.flatMap(nodes):tree&&typeof tree==='object'?[tree,...nodes(tree.props?.children)]:[];}
function text(tree:any):string{return Array.isArray(tree)?tree.map(text).join(''):tree&&typeof tree==='object'?text(tree.props?.children):tree==null?'':String(tree);}
function harness(component='Assistant',extra:any={},stored=new Map<string,string>()){
  const slots:any[]=[],deps:any[]=[],effects:Function[]=[],cleanup:Function[]=[],calls:any[]=[];let index=0;
  const faults={getPending:null as Promise<void>|null,userId:'student',preparePending:null as Promise<void>|null,postError:null as Error|null,result:{threadId:'thread',userMessage:{id:'u',role:'user',content:'질문'},message:{id:'a',role:'assistant',status:'completed',content:'활동의 실제 역할을 먼저 말해 보세요.'}} as any,pending:null as Promise<void>|null,prepareError:null as Error|null,prepare:false};
  const parent={draft:'아직 제출하지 않은 학생의 활동 초안',question:'현재 꼬리질문',closed:0,assisted:0};
  const props:any={scope:'student:original-target:session:turn:q:personal:6',questionId:'root-question',targetId:'original-target',sourceVersion:6,questionPrompt:parent.question,answerDraft:parent.draft,interviewSessionId:'session',interviewTurnId:'turn',beforeOpen:async()=>{calls.push({prepare:true});await faults.preparePending;if(faults.prepareError)throw faults.prepareError;return faults.prepare;},onClose:()=>parent.closed++,onAssisted:()=>parent.assisted++,...extra};
  const react={useState(initial:any){const n=index++;if(!(n in slots))slots[n]=typeof initial==='function'?initial():initial;return [slots[n],(next:any)=>slots[n]=typeof next==='function'?next(slots[n]):next];},useRef(initial:any){const n=index++;return slots[n]??(slots[n]={current:initial});},useCallback(fn:Function){index++;return fn;},useEffect(fn:Function,next:any[]){const n=index++;if(!deps[n]||next?.some((value,i)=>value!==deps[n][i])){deps[n]=next;effects.push(()=>{cleanup[n]?.();cleanup[n]=fn();});}}};
  const mod={exports:{} as any};
  const source=readFileSync('apps/web/src/components/learning-help.tsx','utf8')+'\nexport {Assistant};';
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{module:mod,exports:mod.exports,crypto:{randomUUID},URLSearchParams,Promise,JSON,Number,Set,
    sessionStorage:{getItem:(key:string)=>stored.get(key)||null,setItem:(key:string,value:string)=>stored.set(key,value)},
    document:{activeElement:null,body:{style:{overflow:''}},addEventListener(){},removeEventListener(){}},
    require(name:string){
      if(name==='react')return react;
      if(name==='react/jsx-runtime')return {jsx:(type:any,props:any)=>({type,props}),jsxs:(type:any,props:any)=>({type,props}),Fragment:'Fragment'};
      if(name==='./owned-class-name')return {ownedClassName:(value:any)=>value};
      if(name==='./app-shell')return {useApp:()=>({data:{user:{id:faults.userId},preferences:{enterToSend:false}},targetId:'different-global-target',openResource:(resource:any)=>calls.push({resource})})};
      if(name==='./shared')return {Alert:'Alert',api:async(url:string)=>{calls.push({get:url});await faults.getPending;return {messages:[faults.result.message],learning:{questions:[]},documents:[]};},post:async(url:string,body:any)=>{calls.push({url,body});await faults.pending;if(faults.postError)throw faults.postError;return faults.result;}};
      if(name.endsWith('.module.css'))return {__esModule:true,default:{}};
      return new Proxy({},{get:(_,key)=>String(key)});
    }});
  const render=()=>{index=0;const tree=mod.exports[component](props);while(effects.length)effects.shift()!();return tree;};
  return {render,parent,props,faults,calls,stored,cleanup:()=>cleanup.forEach(fn=>fn?.()),flush:()=>new Promise(resolve=>setImmediate(resolve))};
}

test('AI help sends the frozen interview attempt and preserves the question and unsubmitted answer',async()=>{
  const h=harness();try{h.render();let tree=h.render();let composer=nodes(tree).find(node=>node.type==='ChatComposer');assert.equal(composer.props.enterToSend,false);
    composer.props.onChange('이 활동의 어떤 점을 먼저 말하면 될까요?');tree=h.render();await nodes(tree).find(node=>node.type==='ChatComposer').props.onSend();tree=h.render();
    const request=h.calls.find(call=>call.url==='/api/chat').body;
    assert.equal(request.interviewSessionId,'session');assert.equal(request.interviewTurnId,'turn');assert.equal(request.targetId,undefined);assert.equal(request.sourceVersion,undefined);assert.equal(request.questionId,undefined);
    assert.match(request.message,/현재 꼬리질문/);assert.match(request.message,/아직 제출하지 않은 학생의 활동 초안/);assert.equal(h.parent.assisted,1);
    assert.equal(h.calls.some(call=>call.body?.action==='answer'||call.body?.action==='finish'),false);assert.equal(h.parent.draft,'아직 제출하지 않은 학생의 활동 초안');
    nodes(tree).find(node=>node.type==='button'&&text(node)==='같은 질문으로 돌아가기').props.onClick();assert.equal(h.parent.closed,1);assert.equal(h.parent.question,'현재 꼬리질문');
  }finally{h.cleanup();}
});

test('help failure retains its message and draft, and retry reuses the same submission identity',async()=>{
  const h=harness();try{h.render();let tree=h.render();nodes(tree).find(node=>node.type==='ChatComposer').props.onChange('내 역할을 정리하고 싶어요.');h.faults.postError=Error('연결이 끊겼어요.');tree=h.render();await nodes(tree).find(node=>node.type==='ChatComposer').props.onSend();tree=h.render();
    assert.equal(nodes(tree).find(node=>node.type==='ChatComposer').props.value,'내 역할을 정리하고 싶어요.');assert.equal(h.parent.assisted,0);assert.match(text(tree),/연결이 끊겼어요/);
    const failed=h.calls.find(call=>call.url==='/api/chat').body;h.faults.postError=null;await nodes(tree).find(node=>node.type==='ChatComposer').props.onSend();
    const retried=h.calls.filter(call=>call.url==='/api/chat')[1].body;assert.equal(failed.requestId,retried.requestId);assert.equal(h.parent.assisted,1);assert.equal(h.parent.draft,'아직 제출하지 않은 학생의 활동 초안');
  }finally{h.cleanup();}
});

test('pending AI output cannot finish the training or allow a resume before its help receipt settles',async()=>{
  const h=harness();try{h.render();nodes(h.render()).find(node=>node.type==='ChatComposer').props.onChange('도움받기');let release!:()=>void;h.faults.pending=new Promise(resolve=>release=resolve);
    const sending=nodes(h.render()).find(node=>node.type==='ChatComposer').props.onSend();const busy=h.render();
    assert.ok(nodes(busy).filter(node=>node.type==='button'&&['AI 도움 닫기','도움 닫기'].includes(node.props['aria-label'])).every(node=>node.props.disabled));assert.equal(nodes(busy).find(node=>node.type==='button'&&text(node)==='같은 질문으로 돌아가기').props.disabled,true);
    assert.equal(h.parent.assisted,0);release();await sending;assert.equal(h.parent.assisted,1);assert.equal(h.calls.some(call=>call.body?.action==='finish'||call.body?.action==='answer'),false);
  }finally{h.cleanup();}
});

test('opening the sheet waits for draft preservation and failed preparation cannot open a sheet',async()=>{
  const h=harness('LearningHelp');try{let tree=h.render();nodes(tree).find(node=>node.type==='button'&&text(node)==='AI 비서 도움받기').props.onClick();await h.flush();tree=h.render();assert.equal(nodes(tree).some(node=>typeof node.type==='function'),false);
    h.faults.prepare=true;h.faults.prepareError=Error('초안을 저장하지 못했어요.');nodes(tree).find(node=>node.type==='button'&&text(node)==='AI 비서 도움받기').props.onClick();await h.flush();tree=h.render();assert.match(text(tree),/초안을 저장하지 못했어요/);assert.equal(nodes(tree).some(node=>typeof node.type==='function'),false);
    h.faults.prepareError=null;nodes(tree).find(node=>node.type==='button'&&text(node)==='AI 비서 도움받기').props.onClick();await h.flush();tree=h.render();const sheet=nodes(tree).find(node=>typeof node.type==='function');assert.ok(sheet);assert.equal(sheet.props.interviewTurnId,'turn');assert.equal(h.parent.draft,'아직 제출하지 않은 학생의 활동 초안');
  }finally{h.cleanup();}
});

test('quiz evidence is fetched using its saved item scope, not the globally selected school or newest version',async()=>{
  const h=harness('LearningHelp',{interviewSessionId:undefined,interviewTurnId:undefined,quizSessionId:'saved-quiz',itemIndex:2});try{h.faults.prepare=true;const tree=h.render();nodes(tree).find(node=>node.type==='button'&&text(node)==='질문과 근거').props.onClick();await h.flush();
    const call=h.calls.find(call=>call.get);assert.match(call.get,/quizSessionId=saved-quiz&quizItemIndex=2/);assert.equal(call.get.includes('targetId='),false);assert.equal(h.parent.assisted,1);assert.ok(h.calls.some(call=>call.body?.action==='assist'&&call.body.itemIndex===2));
  }finally{h.cleanup();}
});


test('a help request with a lost response retains its idempotency identity after closing and reopening the sheet',async()=>{
  const h=harness();h.render();let tree=h.render();nodes(tree).find(node=>node.type==='ChatComposer').props.onChange('서버에서 처리됐는지 확인할 도움 요청');h.faults.postError=Error('response lost');tree=h.render();await nodes(tree).find(node=>node.type==='ChatComposer').props.onSend();h.render();
  const request=h.calls.find(call=>call.url==='/api/chat').body;h.cleanup();
  const reopened=harness('Assistant',{},h.stored);try{reopened.render();tree=reopened.render();assert.equal(nodes(tree).find(node=>node.type==='ChatComposer').props.value,'서버에서 처리됐는지 확인할 도움 요청');await nodes(tree).find(node=>node.type==='ChatComposer').props.onSend();
    const retried=reopened.calls.find(call=>call.url==='/api/chat').body;assert.equal(retried.requestId,request.requestId,'the server can recover its original thread instead of creating a second paid request');assert.equal(retried.message,request.message);assert.equal(reopened.parent.assisted,1);
  }finally{reopened.cleanup();}
});

test('a late saved-draft preparation cannot open AI help for another question or account',async()=>{
  const h=harness('LearningHelp');try{h.faults.prepare=true;let release!:()=>void;h.faults.preparePending=new Promise(resolve=>release=resolve);let tree=h.render();nodes(tree).find(node=>node.type==='button'&&text(node)==='AI 비서 도움받기').props.onClick();h.render();
    h.props.interviewTurnId='next-turn';h.props.questionId='next-question';h.faults.userId='other-student';h.render();release();await h.flush();tree=h.render();assert.equal(nodes(tree).some(node=>typeof node.type==='function'),false,'a previous attempt cannot open the new help sheet');assert.equal(h.calls.some(call=>call.url==='/api/chat'),false);
  }finally{h.cleanup();}
});


test('retrying a previously pending help request replaces its existing message with the completed reply once',async()=>{
  const h=harness();try{h.render();nodes(h.render()).find(node=>node.type==='ChatComposer').props.onChange('중단된 도움 응답 확인');h.faults.result.message={id:'same-reply',role:'assistant',status:'pending',content:''};await nodes(h.render()).find(node=>node.type==='ChatComposer').props.onSend();let tree=h.render();assert.match(text(tree),/응답을 작성 중/);
    h.faults.result.message={id:'same-reply',role:'assistant',status:'completed',content:'완료된 도움 답변을 확인했습니다.'};await nodes(tree).find(node=>node.type==='ChatComposer').props.onSend();tree=h.render();const response=nodes(tree).find(node=>node.type==='MarkdownMessage');assert.ok(response,'a same-ID pending message must become the visible completed answer');assert.equal(response.props.content,'완료된 도움 답변을 확인했습니다.');assert.equal(nodes(tree).filter(node=>node.type==='article'&&node.props.className==='assistant').length,1);assert.equal(h.parent.assisted,1);
  }finally{h.cleanup();}
});


test('persisted help receipts remain separated by account, attempt, item and source-version scopes',async()=>{
  const h=harness();h.render();nodes(h.render()).find(node=>node.type==='ChatComposer').props.onChange('이 시도에만 남길 도움 요청');h.faults.postError=Error('response lost');await nodes(h.render()).find(node=>node.type==='ChatComposer').props.onSend();h.render();const original=h.calls.find(call=>call.url==='/api/chat').body;h.cleanup();
  for(const scope of ['other-student:original-target:session:turn:q:personal:6','student:other-target:session:turn:q:personal:6','student:original-target:other-session:turn:q:personal:6','student:original-target:session:other-item:q:personal:6','student:original-target:session:turn:q:personal:7']){
    const other=harness('Assistant',{scope},h.stored);try{other.render();let tree=other.render();assert.equal(nodes(tree).find(node=>node.type==='ChatComposer').props.value,'');assert.equal(nodes(tree).some(node=>node.type==='article'),false);
      nodes(tree).find(node=>node.type==='ChatComposer').props.onChange('현재 시도의 새 질문');tree=other.render();await nodes(tree).find(node=>node.type==='ChatComposer').props.onSend();assert.notEqual(other.calls.find(call=>call.url==='/api/chat').body.requestId,original.requestId);
    }finally{other.cleanup();}
  }
});


test('a late AI send after the help sheet unmounts cannot invoke the old attempt assistance callback',async()=>{
  const h=harness();h.render();nodes(h.render()).find(node=>node.type==='ChatComposer').props.onChange('늦게 끝날 도움 요청');let release!:()=>void;h.faults.pending=new Promise(resolve=>release=resolve);const sending=nodes(h.render()).find(node=>node.type==='ChatComposer').props.onSend();h.cleanup();release();await sending;assert.equal(h.parent.assisted,0,'an unmounted old attempt must not refresh or relabel a new account');
});

test('a late help reload after unmount cannot invoke the old attempt assistance callback',async()=>{
  const h=harness();h.render();nodes(h.render()).find(node=>node.type==='ChatComposer').props.onChange('pending 응답을 다시 확인');h.faults.result.message={id:'reply',role:'assistant',status:'pending',content:''};await nodes(h.render()).find(node=>node.type==='ChatComposer').props.onSend();let tree=h.render();let release!:()=>void;h.faults.getPending=new Promise(resolve=>release=resolve);h.faults.result.message={id:'reply',role:'assistant',status:'completed',content:'이전 시도의 늦은 도움 답변'};
  nodes(tree).find(node=>node.type==='button'&&text(node)==='대화 다시 불러오기').props.onClick();h.cleanup();release();await h.flush();assert.equal(h.parent.assisted,0,'reloading a previous thread cannot trigger assistance effects after leaving');
});

test('a late send from the previous visit is ignored even after returning to the same help scope',async()=>{
  const h=harness();try{h.render();nodes(h.render()).find(node=>node.type==='ChatComposer').props.onChange('이전 방문의 지연 요청');let release!:()=>void;h.faults.pending=new Promise(resolve=>release=resolve);const sending=nodes(h.render()).find(node=>node.type==='ChatComposer').props.onSend();const scope=h.props.scope;
    h.props.scope='new-account-and-attempt';h.render();h.render();h.props.scope=scope;h.render();h.render();release();await sending;assert.equal(h.parent.assisted,0,'the same string scope still has a fresh visit identity');
  }finally{h.cleanup();}
});
