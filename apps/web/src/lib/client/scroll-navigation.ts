/** Keep mobile navigation visible and reserve its space until text entry begins. */
export function installScrollNavigation(nav:HTMLElement,doc:Document=document){
  const win=doc.defaultView;if(!win)return()=>{};
  let focusTimer:number|undefined;
  const editing=()=>Boolean(doc.activeElement?.matches?.('textarea,input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]),[contenteditable=true]'));
  const clearFocus=()=>{if(focusTimer!==undefined){win.clearTimeout(focusTimer);focusTimer=undefined;}};
  const sync=()=>{
    const inputActive=editing(),visible=win.innerWidth<=700&&!inputActive&&doc.visibilityState!=='hidden';
    nav.dataset.inputActive=inputActive?'true':'false';
    nav.dataset.scrollActive=visible?'true':'false';
    doc.documentElement?.style.setProperty('--mobile-navigation-space',visible?'calc(92px + env(safe-area-inset-bottom, 0px))':'0px');
  };
  const focus=()=>{clearFocus();sync();};
  // focusout can still see the departing input as activeElement. Recheck after
  // the browser completes focus transfer, including a blur onto the page body.
  const blur=()=>{clearFocus();focusTimer=win.setTimeout(()=>{focusTimer=undefined;sync();},0);};
  const key=(event:KeyboardEvent)=>{if(event.key==='Tab')sync();};
  sync();
  doc.addEventListener('focusin',focus);doc.addEventListener('focusout',blur);doc.addEventListener('keydown',key);doc.addEventListener('visibilitychange',sync);win.addEventListener('resize',sync);
  return()=>{
    clearFocus();doc.documentElement?.style.setProperty('--mobile-navigation-space','0px');
    doc.removeEventListener('focusin',focus);doc.removeEventListener('focusout',blur);doc.removeEventListener('keydown',key);doc.removeEventListener('visibilitychange',sync);win.removeEventListener('resize',sync);
    delete nav.dataset.scrollActive;delete nav.dataset.inputActive;
  };
}
