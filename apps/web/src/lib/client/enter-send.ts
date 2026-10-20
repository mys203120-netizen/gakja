/** Shared by answer fields and chat composers; IME confirmation is never a send. */
type EnterInput={value:string;selectionStart:number|null;selectionEnd:number|null};
type EnterEvent={key:string;currentTarget?:EnterInput;shiftKey?:boolean;ctrlKey?:boolean;metaKey?:boolean;altKey?:boolean;repeat?:boolean;defaultPrevented?:boolean;nativeEvent?:{isComposing?:boolean;keyCode?:number};preventDefault():void};
const sequences=new WeakMap<EnterInput,{value:string;caret:number}>();
export function resetEnterSequence(input:EnterInput|null|undefined){if(input)sequences.delete(input);}

/** Off: the first Enter inserts a newline; only a second consecutive Enter in this field sends. */
export function sendOnEnter(event:EnterEvent,enabled:boolean,send:()=>void|Promise<void>,options:{composing?:boolean;blocked?:boolean;keyboardDisabled?:boolean}={}):boolean {
  const input=event.currentTarget;
  if(event.key!=='Enter'||event.shiftKey||event.ctrlKey||event.metaKey||event.altKey||event.repeat||event.defaultPrevented||event.nativeEvent?.isComposing||event.nativeEvent?.keyCode===229||options.composing||options.keyboardDisabled){resetEnterSequence(input);return false;}
  if(enabled){resetEnterSequence(input);event.preventDefault();if(!options.blocked)void send();return true;}
  if(!input)return false;
  const previous=sequences.get(input),start=input.selectionStart,end=input.selectionEnd;
  resetEnterSequence(input);
  if(previous&&previous.value===input.value&&previous.caret===start&&start===end){
    event.preventDefault();if(!options.blocked&&input.value.trim())void send();return true;
  }
  if(!options.blocked&&input.value.trim()&&start!==null&&end!==null){
    sequences.set(input,{value:input.value.slice(0,start)+'\n'+input.value.slice(end),caret:start+1});
  }
  return false;
}
