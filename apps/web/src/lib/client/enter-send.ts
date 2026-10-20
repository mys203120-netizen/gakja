/** Shared by answer fields and chat composers; IME confirmation is never a send. */
type EnterEvent={key:string;shiftKey?:boolean;ctrlKey?:boolean;metaKey?:boolean;altKey?:boolean;repeat?:boolean;defaultPrevented?:boolean;nativeEvent?:{isComposing?:boolean;keyCode?:number};preventDefault():void};
export function sendOnEnter(event:EnterEvent,enabled:boolean,send:()=>void|Promise<void>,options:{composing?:boolean;blocked?:boolean}={}):boolean {
  if(!enabled||event.key!=='Enter'||event.shiftKey||event.ctrlKey||event.metaKey||event.altKey||event.repeat||event.defaultPrevented||event.nativeEvent?.isComposing||event.nativeEvent?.keyCode===229||options.composing)return false;
  event.preventDefault();
  if(!options.blocked)void send();
  return true;
}
