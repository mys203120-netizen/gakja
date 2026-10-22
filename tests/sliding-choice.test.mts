import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';

const module={exports:{} as any};
vm.runInNewContext(ts.transpileModule(readFileSync('apps/web/src/components/sliding-choice.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require(name:string){
 if(name==='react/jsx-runtime')return jsx;
 if(name==='./owned-class-name')return {ownedClassName:(value:string)=>value};
 if(name.endsWith('.module.css'))return {default:new Proxy({},{get:(_,key)=>String(key)})};
 throw Error(name);
}});

test('a common motion switch keeps a stable accessible label and emits the requested boolean state',()=>{
 const changed:boolean[]=[];
 for(const checked of [false,true]){
  const button=module.exports.MotionSwitch({label:'카메라 함께 사용',checked,disabled:false,onChange:(value:boolean)=>changed.push(value)});
  assert.equal(button.type,'button');assert.equal(button.props.type,'button');assert.equal(button.props.role,'switch');
  assert.equal(button.props['aria-label'],'카메라 함께 사용');assert.equal(button.props['aria-checked'],checked);
  button.props.onClick();
 }
 assert.deepEqual(changed,[true,false]);
 assert.equal(module.exports.MotionSwitch({label:'AI와 함께 정리',checked:true,disabled:true,onChange(){}}).props.disabled,true);
});

test('segmented choices select the clicked side and keep keyboard selection and focus together',()=>{
 const changed:string[]=[],focused:number[]=[];
 const group=module.exports.SlidingChoice({label:'대화 목록',value:'active',options:[{value:'active',label:'대화'},{value:'archived',label:'보관함'}],onChange:(value:string)=>changed.push(value)});
 assert.equal(group.props['aria-label'],'대화 목록');const buttons=group.props.children[1];
 assert.equal(buttons[0].props['aria-pressed'],true);assert.equal(buttons[1].props['aria-pressed'],false);
 buttons[0].props.onClick();buttons[1].props.onClick();assert.deepEqual(changed,['active','archived'],'clicking an already selected option never toggles the other side');
 const key=(index:number,key:string)=>buttons[index].props.onKeyDown({key,preventDefault(){},currentTarget:{parentElement:{querySelectorAll:()=>[0,1].map(index=>({focus:()=>focused.push(index)}))}}});
 key(0,'ArrowRight');key(1,'Home');key(0,'End');
 assert.deepEqual(changed.slice(2),['archived','active','archived']);assert.deepEqual(focused,[1,0,1]);
});
