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
function harness(today,settings=initial,props={}){
 const remote={registeredAt:today+'T01:00:00.000Z',startDate:today,availability:settings?{...settings,version:settings.version||1,revision:1,savedAt:today+'T01:00:00.000Z',startDate:today}:null};
 const state=[today,settings?library.availabilityInput(remote.availability,today):undefined,remote,false,false,'',false,0,'','',120];if(!settings)delete state[1];let index=0;const writes=[],destinations=[];
 const module={exports:{}};
 vm.runInNewContext(source,{module,exports:module.exports,Date,Intl,Set,AbortController,console,require(name){if(name==='./owned-class-name'||name==='@/components/owned-class-name')return {ownedClassName:(value)=>value};
  if(name==='react')return {...React,useEffect(){},useId:()=>':availability:',useRef:initial=>({current:initial}),useState(initial){const slot=index++;if(!(slot in state))state[slot]=typeof initial==='function'?initial():initial;return [state[slot],value=>{state[slot]=typeof value==='function'?value(state[slot]):value;}];}};
  if(name==='react/jsx-runtime')return jsx;if(name==='lucide-react')return icons;
  if(name==='next/link')return {default:({children,href,...props})=>React.createElement('a',{href,...props},children)};
  if(name==='next/navigation')return {useRouter:()=>({push(path){destinations.push(path);}})};
  if(name==='./app-shell')return {useApp:()=>({refresh:async()=>{}})};
  if(name==='@/lib/training-availability')return library;
  if(name==='./minute-wheel')return {MinuteWheel:({label,value,disabled})=>React.createElement('div',{role:'spinbutton','aria-label':label,'aria-valuenow':value,'aria-disabled':disabled||undefined,'data-minute-wheel':true})};
  if(name.endsWith('.module.css'))return {default:new Proxy({},{get:(_,key)=>String(key)})};
  if(name==='./shared')return {InfoTip:({label})=>React.createElement('button',{type:'button','aria-label':label},'정보'),api:async()=>remote,post:async(path,body)=>{writes.push({path,body});return {availability:{...body.availability,version:2,startDate:today,revision:2,savedAt:today+'T01:00:00.000Z'}};},Spinner:()=>null,Alert:({children})=>React.createElement('p',null,children),ActionButton:({pending,pendingLabel,children,...props})=>React.createElement('button',props,children)};
  throw Error(name);
 }});
 return {state,writes,destinations,render(){index=0;return module.exports.TrainingAvailability(props);},markup(){return renderToStaticMarkup(this.render());}};
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
 assert.deepEqual(fields.map(node=>Boolean(node.props.inlineLabel)),[true,true,false],'weekday and weekend share inline labels on desktop and mobile; date overrides retain their own layout');
 const markup=h.markup();
 assert.ok(markup.includes('class="minuteField inlineMinuteField"'),'the day label belongs to the same inline field as its value');
 assert.ok(markup.includes('aria-label="평일"')&&markup.includes('aria-label="주말"'),'native inputs and mobile wheels retain their accessible day labels');
 assert.ok(!markup.includes('학습하지 못하는 날')&&!markup.includes('저장하고 오늘 훈련 시작'));
 assert.ok(markup.includes('<span class="sr-only">쉬는 날짜</span>'),'the visually removed date caption keeps an accessible input name');
}
{
 const h=harness('2026-11-19',{weekdayMinutes:120,weekendMinutes:180,version:2,blockedDates:['2026-11-20'],overrides:{'2026-11-21':90}}),markup=h.markup();
 assert.ok(!markup.includes('수능'));assert.ok(markup.includes('쉬는 날')&&markup.includes('1시간 30분'),'unavailable days and individual-date time remain visible in the live preview');
}
{
 const h=harness('2026-10-20',null,{onboarding:true});
 assert.ok(h.markup().includes('저장하기'),'onboarding uses the concise save action');
 const dates=nodes(h.render()).filter(node=>node.type==='input'&&node.props.type==='date');
 dates[0].props.onChange({target:{value:'2026-10-22'}});
 const add=nodes(h.render()).find(node=>node.type==='button'&&Array.isArray(node.props.children)&&node.props.children.includes('날짜 추가'));
 add.props.onClick();assert.deepEqual(Array.from(h.state[1].blockedDates),['2026-10-22'],'date exclusion remains usable without the redundant caption');
 assert.equal(h.writes.length,0,'editing the proposal never saves automatically');
 await nodes(h.render()).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});
 assert.deepEqual(h.destinations,['/my'],'saving the onboarding plan still opens today training');
 assert.deepEqual(Array.from(h.writes[0].body.availability.blockedDates),['2026-10-22']);
}
console.log('Availability screens passed: inline day labels, concise save, accessible date exclusion, mobile wheel, editable defaults and unchanged onboarding destination.');
