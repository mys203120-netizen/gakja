import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source=ts.transpileModule(readFileSync('apps/web/src/app/api/actions/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
class ApiError extends Error {constructor(public status:number,message:string){super(message);}}
function harness(){
  let userId='student-one';
  const saved=new Map<string,Record<string,unknown>>([['student-one',{answerLength:'normal',notificationsEnabled:false}]]),writes:any[]=[];
  const module={exports:{} as any};
  vm.runInNewContext(source,{module,exports:module.exports,Request,Response,URL,JSON,require(name:string){
    if(name==='node:crypto')return {randomUUID:()=>''};
    if(name==='@supabase/supabase-js')return {};
    if(name==='@/lib/auth')return {requireUser:async()=>({id:userId,role:'student'}),checkOrigin:(request:Request)=>{if(request.headers.get('origin')!=='http://fixture.test')throw new ApiError(403,'출처 확인');}};
    if(name==='@/lib/db')return {ApiError,errorResponse:(error:any)=>Response.json({error:error.message},{status:error.status||500}),query:async(sql:string,args:any[])=>{
      assert.match(sql,/insert into student_preferences/);assert.match(sql,/data=student_preferences.data\|\|excluded.data/);writes.push({sql,args});
      const preferences={...saved.get(args[0]),...JSON.parse(args[1])};saved.set(args[0],preferences);return [{data:preferences}];
    }};
    if(name.startsWith('@/lib/'))return {};
    throw Error(name);
  }});
  async function post(payload:any,origin='http://fixture.test'){
    const response=await module.exports.POST(new Request('http://fixture.test/api/actions',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({action:'preference',payload})}));
    return {status:response.status,body:await response.json()};
  }
  return {post,saved,writes,setUser:(id:string)=>{userId=id;}};
}

test('help, enter-send and recording preferences persist true and false per authenticated account while preserving unrelated settings',async()=>{
  const h=harness();
  for(const enabled of [false,true]){
    const result=await h.post({helpEnabled:enabled,enterToSend:enabled,liveRecordingConsent:enabled,liveCameraEnabled:enabled});assert.equal(result.status,200);
    for(const key of ['helpEnabled','enterToSend','liveRecordingConsent','liveCameraEnabled'])assert.equal(result.body.preferences[key],enabled);
    assert.equal(result.body.preferences.answerLength,'normal');assert.equal(result.body.preferences.notificationsEnabled,false);
  }
  h.setUser('student-two');assert.equal((await h.post({helpEnabled:false,enterToSend:false,student_id:'student-one'})).status,200);
  assert.equal(h.saved.get('student-one')?.helpEnabled,true);assert.equal(h.saved.get('student-two')?.helpEnabled,false);
  assert.equal(h.saved.get('student-one')?.enterToSend,true);assert.equal(h.saved.get('student-two')?.enterToSend,false);
  assert.equal(h.saved.get('student-two')?.student_id,undefined,'request cannot select another account');
});

test('help, enter-send and recording preferences reject truthy strings, numbers and null without a write',async()=>{
  const h=harness();
  for(const key of ['helpEnabled','enterToSend','liveRecordingConsent','liveCameraEnabled'])for(const value of ['false',1,null,{}])assert.equal((await h.post({[key]:value})).status,400);
  assert.equal(h.writes.length,0);
});

test('preference writes retain same-origin protection',async()=>{
  const h=harness();assert.equal((await h.post({helpEnabled:false},'https://other.invalid')).status,403);assert.equal(h.writes.length,0);
});
