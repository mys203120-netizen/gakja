import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

function harness(){
  const state={queries:0,sweeps:[] as string[],intervals:[] as any[],clears:0,unrefs:0,warning:0,pending:null as Promise<any>|null,queryFailure:false,studentFailure:false,env:{OPENAI_API_KEY:'synthetic'} as Record<string,string>};
  const module={exports:{} as any};vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../apps/web/src/lib/realtime-interview-maintenance.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,process:{env:state.env},console:{warn(){state.warning++;}},setInterval:(work:Function,delay:number)=>{const timer={work,delay,unref(){state.unrefs++;}};state.intervals.push(timer);return timer;},clearInterval(){state.clears++;},require(name:string){if(name==='server-only')return{};if(name==='./db')return{query:async(sql:string)=>{assert.ok(sql.includes("created_at<now()-interval '4 minutes'"));state.queries++;if(state.queryFailure)throw Error('secret failure');return state.pending||[{student_id:'owned-student'}];}};if(name==='./realtime-interview')return{expireInterviewRealtimeCalls:async(id:string)=>{state.sweeps.push(id);if(state.studentFailure)throw Error('secret failure');}};throw Error(name);}});
  return{state,api:module.exports};
}
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};

test('persistent server cleanup is a single unref timer with immediate and periodic owned-call sweeps',async()=>{
  const h=harness();h.api.startInterviewRealtimeMaintenance();h.api.startInterviewRealtimeMaintenance();await flush();assert.equal(h.state.intervals.length,1);assert.equal(h.state.intervals[0].delay,60000);assert.equal(h.state.unrefs,1);assert.deepEqual(h.state.sweeps,['owned-student']);h.state.intervals[0].work();await flush();assert.deepEqual(h.state.sweeps,['owned-student','owned-student']);h.api.stopInterviewRealtimeMaintenance();assert.equal(h.state.clears,1);h.api.stopInterviewRealtimeMaintenance();assert.equal(h.state.clears,1);
});

test('pending cleanup never overlaps, failures remain retryable, and missing credentials do no work',async()=>{
  const h=harness();let resolve!:Function;h.state.pending=new Promise(done=>resolve=done);h.api.startInterviewRealtimeMaintenance();h.state.intervals[0].work();assert.equal(h.state.queries,1);resolve([]);await flush();h.state.pending=null;h.state.queryFailure=true;h.state.intervals[0].work();await flush();assert.equal(h.state.warning,1);h.state.queryFailure=false;h.state.studentFailure=true;h.state.intervals[0].work();await flush();h.state.studentFailure=false;h.state.intervals[0].work();await flush();assert.equal(h.state.sweeps.length,2);
  const off=harness();delete off.state.env.OPENAI_API_KEY;off.api.startInterviewRealtimeMaintenance();assert.equal(off.state.intervals.length,0);assert.equal(off.state.queries,0);
});
