import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import * as contract from '../apps/web/src/lib/recording-upload-contract';

const require = createRequire(import.meta.url);
const studentId='00000000-0000-4000-8000-000000000001', sessionId='00000000-0000-4000-8000-000000000002', turnId='00000000-0000-4000-8000-000000000003';
const fields={sessionId,itemIndex:'0',consent:'true',durationMs:'1000'};
const descriptor={field:'recording',size:6*1024*1024,mime:'audio/webm'};
class ApiError extends Error {constructor(public status:number,message:string){super(message);}}
function load(path:string,mocks:Record<string,unknown>,globals:Record<string,unknown>={}) {
  const module={exports:{} as any};
  const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(code,{module,exports:module.exports,require:(name:string)=>name==='@/lib/privacy-policy'?{PRIVACY_POLICY_VERSION:'2026-10-22'}:name in mocks?mocks[name]:require(name),Buffer,File,Blob,FormData,Request,Response,URL,console,...globals});
  return module.exports;
}
function harness() {
  const state={mode:'supabase',staff:true,intent:null as any,session:{state:'active',current_index:0,mode:'oral',data:{context:{},generation:1}},turn:{data:{}},info:{size:descriptor.size,contentType:descriptor.mime},blob:new Blob([new Uint8Array(descriptor.size)],{type:descriptor.mime}),downloads:0,locks:0,count:0,access:true,queries:[] as string[]};
  const query=async(sql:string,args:any[])=>{
    state.queries.push(sql);
    if(sql.includes('count(*)'))return [{count:state.count}];
    if(sql.startsWith('insert into recording_uploads')){state.intent={id:args[0],student_id:args[1],kind:args[2],fields:JSON.parse(args[3]),files:JSON.parse(args[4])};return [];}
    if(sql.startsWith('select * from recording_uploads'))return state.intent&&state.intent.id===args[0]&&state.intent.student_id===args[1]&&state.intent.kind===args[2]?[state.intent]:[];
    if(sql.includes('from quiz_sessions')||sql.includes('from interview_sessions'))return args[1]===studentId?[state.session]:[];
    if(sql.includes('from interview_turns'))return [state.turn];
    if(sql.includes('from production_links'))return [{id:'production'}];
    if(sql.startsWith('update recording_uploads'))state.locks++;
    return [];
  };
  const env={get AUTH_MODE(){return state.mode;}};
  const server=load('apps/web/src/lib/recording-upload.ts',{
    'server-only':{},'./db':{ApiError,query,transaction:async(fn:any)=>fn({query:async(sql:string,args:any[])=>({rows:await query(sql,args)})})},
    './auth':{requireStaff:async()=>{if(!state.staff)throw new ApiError(403,'staff permission required');return {id:studentId};},supabaseServer:async()=>({storage:{from:()=>({info:async()=>({data:state.info}),download:async()=>{state.downloads++;return {data:state.blob};},createSignedUrl:async(_path:string,ttl:number)=>{assert.equal(ttl,60);return {data:{signedUrl:'https://storage.example.test/signed'}};}})}})},
    './ai':{assertPublishedAccess:async()=>{if(!state.access)throw new ApiError(403,'unpublished');}},
    './recording-upload-contract':contract,
  },{process:{env}});
  return {state,server,complete:(id=state.intent?.id,owner=studentId,kind='quiz')=>server.recordingForm(new Request('http://local/api/quiz',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({uploadId:id})}),owner,kind)};
}
test('upload metadata enforces count, audio types, consent-independent size limits and no duplicate destinations',()=>{
  for(const files of [[],[descriptor,descriptor],[{...descriptor,size:10*1024*1024+1}],[{...descriptor,mime:'video/mp4'}],[{...descriptor,field:'analysisAudio'}]])assert.equal(contract.recordingUploadSchema.safeParse({kind:'quiz',fields,files}).success,false);
  assert.equal(contract.recordingUploadSchema.safeParse({kind:'interview',fields,files:[{...descriptor,size:20*1024*1024}]}).success,true);
  assert.equal(contract.recordingUploadSchema.safeParse({kind:'interview',fields,files:[{...descriptor,size:20*1024*1024+1}]}).success,false);
});
test('chat attachments and guidebooks enforce their own file limits, extensions and MIME contracts',()=>{
  const file={field:'file0',name:'guide.html',size:5*1024*1024,mime:'text/html'};
  assert.equal(contract.recordingUploadSchema.safeParse({kind:'guidebook',fields:{},files:[file]}).success,true);
  for(const files of [[{...file,size:file.size+1}],[{...file,name:'guide.exe'}],[file,{...file,field:'file1'}]])assert.equal(contract.recordingUploadSchema.safeParse({kind:'guidebook',fields:{},files}).success,false);
  const pdf={...file,name:'notes.pdf',size:15*1024*1024,mime:'application/pdf'};
  assert.equal(contract.recordingUploadSchema.safeParse({kind:'attachment',fields:{},files:[pdf,{...pdf,field:'file1'},{...pdf,field:'file2'}]}).success,true);
  for(const files of [[{...pdf,size:pdf.size+1}],[{...pdf,mime:'text/html'}],[{...pdf,field:'file1'}]])assert.equal(contract.recordingUploadSchema.safeParse({kind:'attachment',fields:{},files}).success,false);
});
test('guidebook completion rechecks staff assignment and cannot be exchanged for a chat attachment',async()=>{
  const {state,server,complete}=harness();
  const intent=await server.prepareRecordingUpload(studentId,{kind:'guidebook',fields:{studentId:sessionId,productionJobRef:'production'},files:[{field:'file0',name:'guide.html',size:8,mime:'application/octet-stream'}]});
  assert.equal(intent.files[0].bucket,'content-imports');assert.equal(intent.files[0].mime,'text/html');
  state.info={size:8,contentType:'text/html'};state.blob=new Blob(['<p>x</p>']);
  const result=await complete(intent.uploadId,studentId,'guidebook');assert.equal(result.form.get('files').name,'guide.html');
  await assert.rejects(complete(intent.uploadId,studentId,'attachment'),{status:404});
  state.staff=false;await assert.rejects(complete(intent.uploadId,studentId,'guidebook'),{status:403});
});
test('server issues only owned paths; 6MB recording bypasses app request body; completion can retry',async()=>{
  const {state,server,complete}=harness();
  const intent=await server.prepareRecordingUpload(studentId,{kind:'quiz',fields,files:[descriptor]});
  assert.equal(intent.transport,'storage');assert.ok(intent.files[0].path.startsWith(studentId+'/uploads/'));
  assert.equal(JSON.stringify(intent).includes('token'),false);
  const result=await complete();assert.equal(result.form.get('recording').size,descriptor.size);assert.equal(state.locks,1);
  assert.equal((await complete()).form.get('sessionId'),sessionId);assert.equal(state.downloads,2);
});
test('another student, a different purpose and unknown upload IDs cannot complete',async()=>{
  const {state,server,complete}=harness();await server.prepareRecordingUpload(studentId,{kind:'quiz',fields,files:[descriptor]});
  await assert.rejects(complete(state.intent.id,sessionId),{status:404});
  await assert.rejects(complete(state.intent.id,studentId,'interview'),{status:404});
  await assert.rejects(complete(turnId),{status:404});assert.equal(state.downloads,0);
});
test('stale quiz index, ended session, no consent and rate exhaustion fail before an upload is issued',async()=>{
  for(const variation of ['index','ended','consent','rate']){
    const {state,server}=harness();const input={kind:'quiz',fields:{...fields},files:[descriptor]};
    if(variation==='index')state.session.current_index=1;
    if(variation==='ended')state.session.state='completed';
    if(variation==='consent')input.fields.consent='false';
    if(variation==='rate')state.count=60;
    await assert.rejects(server.prepareRecordingUpload(studentId,input));assert.equal(state.intent,null);
  }
});
test('completion rechecks the current quiz after upload and refuses metadata/byte mismatches',async()=>{
  for(const variation of ['ended','size','mime','bytes']){
    const {state,server,complete}=harness();await server.prepareRecordingUpload(studentId,{kind:'quiz',fields,files:[descriptor]});
    if(variation==='ended')state.session.state='completed';
    if(variation==='size')state.info.size++;
    if(variation==='mime')state.info.contentType='video/mp4';
    if(variation==='bytes')state.blob=new Blob(['short']);
    await assert.rejects(complete());if(variation!=='bytes')assert.equal(state.downloads,0);
  }
});
test('interview preparation checks publication, generation and answered turns',async()=>{
  for(const variation of ['valid','unpublished','generation','answered']){
    const {state,server}=harness();
    state.access=variation!=='unpublished';if(variation==='answered')state.turn.data={answer:'saved'};
    const input={kind:'interview',fields:{sessionId,turnId,questionId:'q',generation:variation==='generation'?'0':'1',consent:'true'},files:[descriptor]};
    if(variation==='valid')assert.equal((await server.prepareRecordingUpload(studentId,input)).transport,'storage');
    else await assert.rejects(server.prepareRecordingUpload(studentId,input));
  }
});
test('Supabase mode refuses multipart, local mode keeps existing recordings, playback returns only a short redirect',async()=>{
  const {state,server}=harness();const form=new FormData();form.set('recording',new Blob(['test']));
  const request=()=>new Request('http://local/api/media',{method:'POST',body:form});
  await assert.rejects(server.recordingForm(request(),studentId,'interview'),{status:415});
  state.mode='local';assert.equal((await server.recordingForm(request(),studentId,'interview')).files.length,0);
  const response=await server.recordingRedirect('student-media','owned');assert.equal(response.status,307);assert.equal(await response.text(),'');assert.equal(response.headers.get('cache-control'),'private, no-store');
});
test('browser sends large bytes to Storage only, and metadata to completion; upload failure never completes',async()=>{
  for(const fail of [false,true]){
    const calls:{url:string,init:any}[]=[];let uploaded=0;
    const client=load('apps/web/src/lib/recording-upload-client.ts',{'@supabase/ssr':{createBrowserClient:()=>({storage:{from:()=>({upload:async(_path:string,blob:Blob,options:any)=>{uploaded++;assert.equal(blob.size,descriptor.size);assert.equal(options.upsert,false);return {error:fail?new Error('offline'):null};}})}})}},{process:{env:{}},fetch:async(url:string,init:any)=>{calls.push({url,init});return Response.json(url==='/api/uploads'?{transport:'storage',uploadId:turnId,files:[{...descriptor,bucket:'student-media',path:'owned'}]}:{recording:{id:'saved'}});}});
    const form=new FormData();form.set('recording',new Blob([new Uint8Array(descriptor.size)],{type:descriptor.mime}));form.set('sessionId',sessionId);
    if(fail)await assert.rejects(client.uploadRecording('/api/quiz',form));else assert.equal((await client.uploadRecording('/api/quiz',form)).recording.id,'saved');
    assert.equal(uploaded,1);assert.equal(calls.length,fail?1:2);assert.ok(calls.every(call=>typeof call.init.body==='string'&&call.init.body.length<1000));
  }
});
test('browser attachment batches and guidebook HTML also keep large files off the app API',async()=>{
  for(const endpoint of ['/api/chat/attachments','/api/imports']) {
    const count=endpoint==='/api/imports'?1:3, size=endpoint==='/api/imports'?5*1024*1024:6*1024*1024;
    const kind=endpoint==='/api/imports'?'guidebook':'attachment', mime=kind==='guidebook'?'text/html':'application/pdf';
    let stored=0;const calls:any[]=[];
    const client=load('apps/web/src/lib/recording-upload-client.ts',{'@supabase/ssr':{createBrowserClient:()=>({storage:{from:()=>({upload:async(_path:string,blob:Blob)=>{stored++;assert.equal(blob.size,size);assert.equal(blob.type,mime);return {error:null};}})}})}},{process:{env:{}},fetch:async(url:string,init:any)=>{
      assert.ok(typeof init.body==='string'&&init.body.length<2000);const input=JSON.parse(init.body);calls.push(input);
      if(url==='/api/uploads'){assert.equal(input.kind,kind);assert.equal(input.files.length,count);return Response.json({transport:'storage',uploadId:turnId,files:input.files.map((file:any)=>({...file,bucket:'private',path:file.field}))});}
      return Response.json({ok:true});
    }});
    const form=new FormData();for(let i=0;i<count;i++)form.append('files',new File([new Uint8Array(size)],kind==='guidebook'?'guide.html':`notes-${i}.pdf`,{type:mime}));
    assert.equal((await client.uploadPrivateFiles(endpoint,form)).ok,true);assert.equal(stored,count);assert.equal(calls.length,2);
  }
});
test('upload preparation route authenticates and denies student imports and staff student-media uploads',async()=>{
  for(const [role,kind] of [['student','guidebook'],['staff','quiz'],['admin','attachment'],['student','quiz'],['admin','guidebook']]) {
    let prepared=0;
    const body={kind,fields:{},files:kind==='guidebook'?[{field:'file0',name:'guide.html',size:8,mime:'text/html'}]:kind==='attachment'?[{field:'file0',name:'notes.pdf',size:8,mime:'application/pdf'}]:[descriptor]};
    const route=load('apps/web/src/app/api/uploads/route.ts',{
      '@/lib/auth':{checkOrigin(){},requireUser:async()=>({id:studentId,role})},
      '@/lib/recording-upload-contract':contract,
      '@/lib/recording-upload':{uploadJson:async()=>body,prepareRecordingUpload:async()=>{prepared++;return {transport:'storage'};}},
      '@/lib/db':{ApiError,errorResponse:(error:any)=>Response.json({error:error.message},{status:error.status||500})},
    });
    const allowed=role==='student'?kind!=='guidebook':kind==='guidebook';
    const response=await route.POST(new Request('http://local',{method:'POST'}));
    assert.equal(response.status,allowed?200:403);assert.equal(prepared,allowed?1:0);
  }
});
test('chunked completion metadata is bounded without Content-Length; malformed JSON is a client error',async()=>{
  const {server}=harness();let cancelled=false;
  const body=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(100_001));},cancel(){cancelled=true;}});
  await assert.rejects(server.uploadJson(new Request('http://local',{method:'POST',body,duplex:'half'} as any)),{status:413});
  assert.equal(cancelled,true);
  await assert.rejects(server.uploadJson(new Request('http://local',{method:'POST',body:'{'})),{status:400});
  await assert.rejects(server.recordingForm(new Request('http://local',{method:'POST',body:JSON.stringify({uploadId:'invalid'})}),studentId,'guidebook'),{status:400});
});
test('real media and quiz endpoints reject forged file signatures before persisting a recording',async()=>{
  for(const kind of ['media','quiz']){
    const form=new FormData();form.set('recording',new Blob(['not a webm'],{type:'audio/webm'}),'answer.webm');
    for(const [key,value] of Object.entries({...fields,turnId,questionId:'q',generation:'0',durationSeconds:'1'}))form.set(key,value);
    let writes=0;
    class FeatureError extends ApiError {constructor(status:number,message:string,public code:string){super(status,message);}}
    const query=async(sql:string)=>{
      if(sql.includes('from interview_sessions'))return [{id:sessionId,state:'active',data:{generation:0,context:{}}}];
      if(sql.includes('from interview_turns'))return [{id:turnId,data:{}}];
      writes++;return [];
    };
    const mocks=new Proxy<Record<string,any>>({
      '@/lib/auth':{checkOrigin(){},requireUser:async()=>({id:studentId,role:'student'})},
      '@/lib/recording-upload':{recordingForm:async()=>({form,files:[{...descriptor,path:'owned',bucket:'student-media'}]})},
      '@/lib/db':{ApiError,query,errorResponse:(error:any)=>Response.json({error:error.message},{status:error.status||500})},
      '@/lib/ai':{FeatureError,requireStudent(){},assertPublishedAccess:async()=>{},featureError:(error:any)=>({error:error.message,status:error.status||500})},
    },{has:(target,key)=>typeof key==='string'&&key.startsWith('@/lib/')||key in target,get:(target,key)=>target[key as string]||{}});
    const route=load(`apps/web/src/app/api/${kind}/route.ts`,mocks,{process:{env:{AUTH_MODE:'supabase'}}});
    const response=await route.POST(new Request('http://local/api/'+kind,{method:'POST',headers:{'Content-Type':'application/json','X-Recording-Upload':'complete'},body:JSON.stringify({uploadId:turnId})}));
    assert.equal(response.status,415);assert.equal(writes,0);
  }
});
test('media preservation-only upload stores the original without requiring transcription, while normal upload still transcribes',async()=>{
  for(const deferred of [true,false]){
    const bytes=Buffer.concat([Buffer.from([0x1a,0x45,0xdf,0xa3]),Buffer.alloc(128)]),form=new FormData();
    form.set('recording',new File([bytes],'answer.webm',{type:'audio/webm'}));
    for(const[key,value]of Object.entries({sessionId,turnId,questionId:'q',generation:'0',durationSeconds:'1',consent:'true'}))form.set(key,value);
    if(deferred){form.set('deferTranscription','true');form.set('policyVersion','2026-10-22');}
    let asset:any,transcriptions=0;
    class FeatureError extends ApiError{constructor(status:number,message:string,public code:string){super(status,message);}}
    const query=async(sql:string,args:any[]=[])=>{
      if(sql.startsWith('select s.state'))return [{state:'active',session_data:{generation:0},turn_data:{}}];
      if(sql.includes('from interview_sessions'))return [{id:sessionId,state:'active',data:{generation:0,context:{}}}];
      if(sql.includes('from interview_turns'))return [{id:turnId,data:{}}];
      if(sql.startsWith('insert into media_assets')){asset={id:args[0],bytes:args[3],metadata:JSON.parse(args[5])};return [];}
      if(sql.startsWith('select metadata'))return [{metadata:asset.metadata}];
      return [];
    };
    const route=load('apps/web/src/app/api/media/route.ts',{
      '@/lib/auth':{checkOrigin(){},requireUser:async()=>({id:studentId,role:'student'})},
      '@/lib/recording-upload':{recordingForm:async()=>({form,files:[]})},
      '@/lib/db':{query,transaction:async(fn:any)=>fn({query:async(sql:string,args:any[])=>({rows:await query(sql,args)})})},
      '@/lib/ai':{FeatureError,requireStudent(){},assertPublishedAccess:async()=>{},featureError:(error:any)=>({error:error.message,status:error.status||500})},
      '@/lib/speech-analysis':{analyzeSpeech:()=>({status:'unmeasured'})},
      '@/lib/interview-transcription':{transcribeOwnedInterviewRecording:async()=>{transcriptions++;return {transcriptionStatus:'completed'};}},
      '@/lib/recording-transcription':{withRecordingTranscriptionLock:async(_key:string,work:Function)=>work(),transcriptionResponse:(metadata:any)=>({transcriptionStatus:metadata.transcriptionStatus})},
    });
    const response=await route.POST(new Request('http://local/api/media',{method:'POST',body:form})),value=await response.json();
    assert.equal(response.status,200,JSON.stringify(value));assert.equal(Buffer.compare(asset.bytes,bytes),0);assert.equal(asset.metadata.transcriptionStatus,'pending');
    assert.equal(asset.metadata.consentPolicyVersion,deferred?'2026-10-22':undefined,'only an explicit current policy confirmation records its revision');
    assert.equal(transcriptions,deferred?0:1);assert.equal(value.transcriptionStatus,deferred?'pending':'completed');assert.ok(value.media.id);
  }
});
