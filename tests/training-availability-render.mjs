import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import assert from 'node:assert/strict';
import React from 'react';
import * as jsx from 'react/jsx-runtime';
import * as icons from 'lucide-react';
import {renderToStaticMarkup} from 'react-dom/server';
import {tsImport} from 'tsx/esm/api';

const library=await tsImport('../apps/web/src/lib/training-availability.ts',import.meta.url);
const source=ts.transpileModule(fs.readFileSync(new URL('../apps/web/src/components/training-availability.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
const initial={weekdayMinutes:120,weekendMinutes:180,csatDate:'2026-11-19',beforeCsatWeekdayMinutes:30,beforeCsatWeekendMinutes:60,blockedDates:[],overrides:{}};
const nodes=value=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];
function harness(today,settings=initial){
 const remote={registeredAt:today+'T01:00:00.000Z',startDate:today,availability:settings?{...settings,version:settings.version||1,revision:1,savedAt:today+'T01:00:00.000Z',startDate:today}:null};
 const state=[today,settings?library.availabilityInput(remote.availability,today):undefined,remote,false,false,'',false,0,'','',120];if(!settings)delete state[1];let index=0;const writes=[];
 const module={exports:{}};
 vm.runInNewContext(source,{module,exports:module.exports,Date,Intl,Set,AbortController,console,require(name){
  if(name==='react')return {...React,useEffect(){},useId:()=>':availability:',useRef:initial=>({current:initial}),useState(initial){const slot=index++;if(!(slot in state))state[slot]=typeof initial==='function'?initial():initial;return [state[slot],value=>{state[slot]=typeof value==='function'?value(state[slot]):value;}];}};
  if(name==='react/jsx-runtime')return jsx;if(name==='lucide-react')return icons;
  if(name==='next/link')return {default:({children,href,...props})=>React.createElement('a',{href,...props},children)};
  if(name==='next/navigation')return {useRouter:()=>({push(){}})};
  if(name==='./app-shell')return {useApp:()=>({refresh:async()=>{}})};
  if(name==='@/lib/training-availability')return library;
  if(name==='./minute-wheel')return {MinuteWheel:({label,value,disabled})=>React.createElement('div',{role:'spinbutton','aria-label':label,'aria-valuenow':value,'aria-disabled':disabled||undefined,'data-minute-wheel':true})};
  if(name.endsWith('.module.css'))return {default:new Proxy({},{get:(_,key)=>String(key)})};
  if(name==='./shared')return {InfoTip:({label})=>React.createElement('button',{type:'button','aria-label':label},'정보'),api:async()=>remote,post:async(path,body)=>{writes.push({path,body});return {availability:{...body.availability,version:2,startDate:today,revision:2,savedAt:today+'T01:00:00.000Z'}};},Spinner:()=>null,Alert:({children})=>React.createElement('p',null,children),ActionButton:({pending,pendingLabel,children,...props})=>React.createElement('button',props,children)};
  throw Error(name);
 }});
 return {state,writes,render(){index=0;return module.exports.TrainingAvailability({});},markup(){return renderToStaticMarkup(this.render());}};
}


// Legacy values are loaded from the current period, but the screen has only one pair of day settings.
for(const [today,weekday,weekend] of [['2026-10-20',30,60],['2026-11-20',120,180]]){
 const h=harness(today),markup=h.markup(),fields=nodes(h.render()).filter(node=>node.type?.name==='MinuteField');
 assert.ok(!markup.includes('수능'));assert.deepEqual(fields.map(node=>[node.props.label,node.props.value]),[['평일',weekday],['주말',weekend],['가능한 시간',120]]);
 assert.equal((markup.match(/data-minute-wheel="true"/g)||[]).length,3);assert.equal((markup.match(/type="number"/g)||[]).length,3);
 fields[0].props.onChange(90);assert.equal(h.state[1].weekdayMinutes,90);
 await nodes(h.render()).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});
 assert.equal(h.writes[0].body.availability.weekdayMinutes,90);assert.ok(!('csatDate' in h.writes[0].body.availability));
}
{
 const h=harness('2026-10-20',null),fields=nodes(h.render()).filter(node=>node.type?.name==='MinuteField');
 assert.deepEqual(fields.slice(0,2).map(node=>node.props.value),[120,120],'new students get editable 120-minute weekday and weekend values');
}
{
 const h=harness('2026-11-19',{weekdayMinutes:120,weekendMinutes:180,version:2,blockedDates:['2026-11-20'],overrides:{'2026-11-21':90}}),markup=h.markup();
 assert.ok(!markup.includes('수능'));assert.ok(markup.includes('쉬는 날')&&markup.includes('1시간 30분'),'unavailable days and individual-date time remain visible in the live preview');
}
console.log('Availability screens passed: one daily setting, legacy current-period projection, editable defaults, mobile wheel, explicit save, blocked days and date overrides.');
