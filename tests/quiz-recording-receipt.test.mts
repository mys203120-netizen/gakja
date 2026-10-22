import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

const require=createRequire(import.meta.url);
const studentId='00000000-0000-4000-8000-000000000001',sessionId='00000000-0000-4000-8000-000000000002';
class ApiError extends Error{constructor(public status:number,message:string){super(message);}}
function harness(policyVersion?:string){
  const recordings:any[]=[],requests:string[]=[];
  const form=()=>{const value=new FormData();value.set('recording',new Blob(['RIFF0000WAVEprivate-fixture'],{type:'audio/wav'}),'private.wav');value.set('sessionId',sessionId);value.set('itemIndex','3');value.set('durationMs','1500');value.set('consent','true');if(policyVersion)value.set('policyVersion',policyVersion);return value;};
  const db={query:async(sql:string,args:any[])=>{
    if(sql.startsWith('select * from quiz_sessions'))return {rows:args[0]===sessionId&&args[1]===studentId?[{id:sessionId,state:'active',current_index:3,mode:'oral'}]:[]};
    if(sql.includes('from quiz_recordings')&&sql.includes("metadata->>'digest'")){const row=recordings.find(item=>item.session_id===args[0]&&item.item_index===args[1]&&item.digest===args[2]);const fields=sql.slice('select '.length,sql.indexOf(' from ')).split(',').map(field=>field.trim());return {rows:row?[Object.fromEntries(fields.map(field=>[field,row[field]]))]:[]};}
    if(sql.startsWith('insert into quiz_recordings')){const metadata=JSON.parse(args[7]);const row={id:args[0],session_id:args[1],student_id:args[2],item_index:args[3],mime:args[5],duration_ms:args[6],digest:metadata.digest,metadata};recordings.push(row);return {rows:[{id:row.id,item_index:row.item_index,mime:row.mime,duration_ms:row.duration_ms}]};}
    throw Error('Unexpected SQL '+sql);
  }};
  const module={exports:{} as {POST:(request:Request)=>Promise<Response>}};
  const mocks:Record<string,unknown>={
    '@/lib/auth':{checkOrigin(){},requireUser:async()=>({id:studentId,role:'student'})},
    '@/lib/privacy-policy':{PRIVACY_POLICY_VERSION:'2026-10-22'},
    '@/lib/db':{ApiError,transaction:async(work:(db:unknown)=>Promise<unknown>)=>work(db),errorResponse:(error:any)=>Response.json({error:error.message},{status:error.status||500})},
    '@/lib/recording-upload':{recordingForm:async(request:Request,id:string,kind:string)=>{assert.equal(id,studentId);assert.equal(kind,'quiz');const storage=request.headers.get('x-recording-upload')==='complete';requests.push(storage?'storage':'multipart');return {form:storage?form():await request.formData(),files:storage?[{field:'recording',bucket:'student-media',path:`${studentId}/uploads/owned/recording`}]:[]};}},
    '@/lib/speech-analysis':{analyzeSpeech:()=>({timing:null,transcript:null})},
  };
  const code=ts.transpileModule(readFileSync(new URL('../apps/web/src/app/api/quiz/route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(code,{module,exports:module.exports,Buffer,File,Blob,FormData,Request,Response,URL,URLSearchParams,require:(name:string)=>name in mocks?mocks[name]:name.startsWith('@/')?{}:require(name)});
  return {recordings,requests,request:(transport:'multipart'|'storage')=>new Request('http://localhost/api/quiz',{method:'POST',...(transport==='storage'?{headers:{'Content-Type':'application/json','x-recording-upload':'complete'},body:JSON.stringify({uploadId:'owned-upload'})}:{body:form()})}),post:module.exports.POST};
}

for(const transport of ['multipart','storage'] as const)for(const version of [undefined,'2026-10-22'])test(`${transport} recording retry retains its consent revision (${version||'legacy'}) and returns the same complete receipt needed for transcript editing`,async()=>{
  const h=harness(version);const first=await h.post(h.request(transport));assert.equal(first.status,200);const saved=await first.json();
  // Simulate a committed upload whose response was lost. Only the retry reaches the view.
  const retry=await h.post(h.request(transport));assert.equal(retry.status,200);const recovered=await retry.json();
  assert.equal(h.recordings.length,1);assert.deepEqual(recovered.recording,saved.recording);assert.equal(recovered.recording.item_index,3);assert.equal(recovered.recording.duration_ms,1500);assert.equal(recovered.recording.mime,'audio/wav');assert.equal(recovered.recording.url,`/api/quiz?recordingId=${saved.recording.id}`);assert.deepEqual(h.requests,[transport,transport]);
  assert.equal(h.recordings[0].metadata.consentPolicyVersion,version);assert.ok(!Number.isNaN(Date.parse(h.recordings[0].metadata.consentAt)));
});
