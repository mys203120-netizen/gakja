import test from 'node:test';
import assert from 'node:assert/strict';
import {sendOnEnter,resetEnterSequence} from '../apps/web/src/lib/client/enter-send';

const field=(value='내 답변')=>({value,selectionStart:value.length,selectionEnd:value.length});
function press(input:ReturnType<typeof field>,enabled:boolean,send:()=>void,key='Enter',modifiers:Record<string,any>={},options:Record<string,any>={}){
 let prevented=false;
 const handled=sendOnEnter({key,currentTarget:input,...modifiers,preventDefault(){prevented=true;}},enabled,send,options);
 if(!prevented&&key==='Enter'&&!modifiers.nativeEvent?.isComposing){const {selectionStart:a,selectionEnd:b}=input;input.value=input.value.slice(0,a)+'\n'+input.value.slice(b);input.selectionStart=input.selectionEnd=a+1;}
 return handled;
}
test('on sends immediately, Shift+Enter remains a newline',()=>{
 const input=field();let count=0;
 assert.equal(press(input,true,()=>count++),true);assert.equal(count,1);
 assert.equal(press(input,true,()=>count++,'Enter',{shiftKey:true}),false);assert.equal(input.value,'내 답변\n');assert.equal(count,1);
});
test('off sends only on the second consecutive Enter in the same unchanged field',()=>{
 const input=field();let count=0;
 assert.equal(press(input,false,()=>count++),false);assert.equal(input.value,'내 답변\n');assert.equal(count,0);
 assert.equal(press(input,false,()=>count++),true);assert.equal(input.value,'내 답변\n');assert.equal(count,1);
});
test('typing, moving the caret, focus loss, another field and IME confirmation break the sequence',()=>{
 for(const interrupt of ['typing','caret','blur','ime','shift']){
  const input=field();let count=0;press(input,false,()=>count++);
  if(interrupt==='typing')press(input,false,()=>count++,'a');
  if(interrupt==='caret')input.selectionStart=input.selectionEnd=0;
  if(interrupt==='blur')resetEnterSequence(input);
  if(interrupt==='ime')press(input,false,()=>count++,'Enter',{nativeEvent:{isComposing:true,keyCode:229}});
  if(interrupt==='shift')press(input,false,()=>count++,'Enter',{shiftKey:true});
  assert.equal(press(input,false,()=>count++),false,interrupt);assert.equal(count,0,interrupt);
 }
 const first=field(),second=field();let count=0;press(first,false,()=>count++);press(second,false,()=>count++);assert.equal(count,0);
});
test('repeated keys, unavailable submission, empty input and audio notes never submit',()=>{
 for(const option of [{blocked:true},{keyboardDisabled:true}]){
  const input=field();let count=0;press(input,false,()=>count++,'Enter',{},option);press(input,false,()=>count++,'Enter',{},option);assert.equal(count,0);
 }
 const empty=field('');let count=0;press(empty,false,()=>count++);press(empty,false,()=>count++);assert.equal(count,0);
 const input=field();press(input,false,()=>count++);press(input,false,()=>count++,'Enter',{repeat:true});press(input,false,()=>count++);assert.equal(count,0);
});
