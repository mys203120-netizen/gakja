/** Directional decoration; keyboard and screen-reader links stay available. */
export function installScrollNavigation(nav:HTMLElement,doc:Document=document){
  const win=doc.defaultView;if(!win)return()=>{};
  let timer:number|undefined,releaseTimer:number|undefined;
  const positions=new WeakMap<object,number>();
  const documentY=()=>Math.max(0,doc.scrollingElement?.scrollTop??win.scrollY??0);
  positions.set(doc,documentY());
  const reserve=(value:string)=>doc.documentElement?.style.setProperty('--mobile-navigation-space',value==='80px'?'calc(80px + env(safe-area-inset-bottom, 0px))':value);
  const release=()=>{if(releaseTimer!==undefined){win.clearTimeout(releaseTimer);releaseTimer=undefined;}};
  const editing=()=>Boolean(doc.activeElement?.matches?.('textarea,input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]),[contenteditable=true]'));
  const hide=(immediate=false)=>{release();if(!immediate&&doc.activeElement&&nav.contains?.(doc.activeElement)){reserve('80px');nav.dataset.scrollActive='true';return;}nav.dataset.scrollActive='false';if(immediate)reserve('0px');else releaseTimer=win.setTimeout(()=>{releaseTimer=undefined;reserve('0px');},800);};
  const clear=()=>{if(timer!==undefined){win.clearTimeout(timer);timer=undefined;}};
  const show=()=>{
    if(win.innerWidth>700||editing())return;
    release();reserve('80px');nav.dataset.scrollActive='true';clear();
    timer=win.setTimeout(()=>{timer=undefined;hide();},1400);
  };
  const scroll=(event:Event)=>{
    const target=event.target as HTMLElement|Document|null;
    const source=!target||target===doc||target===doc.scrollingElement?doc:target;
    const next=source===doc?documentY():Math.max(0,(source as HTMLElement).scrollTop||0);
    const previous=positions.get(source);if(previous===undefined){positions.set(source,next);return;}
    const delta=next-previous;if(Math.abs(delta)<3)return;
    positions.set(source,next);
    if(delta>0)show();else{clear();hide();}
  };
  const remember=(event:Event)=>{
    let element=event.target as HTMLElement|null;
    while(element&&element!==doc.scrollingElement){positions.set(element,Math.max(0,element.scrollTop||0));element=element.parentElement;}
  };
  const key=(event:KeyboardEvent)=>{if(event.key==='Tab')show();};
  const visibility=()=>{if(doc.visibilityState==='hidden'){clear();hide(true);}};
  const focus=()=>{nav.dataset.inputActive=editing()?'true':'false';clear();if(editing())hide(true);else if(doc.activeElement&&nav.contains?.(doc.activeElement)){release();reserve('80px');nav.dataset.scrollActive='true';}else hide();};
  hide(true);doc.addEventListener('scroll',scroll,{capture:true,passive:true});doc.addEventListener('wheel',remember,{capture:true,passive:true});doc.addEventListener('touchstart',remember,{capture:true,passive:true});doc.addEventListener('keydown',key);doc.addEventListener('visibilitychange',visibility);doc.addEventListener('focusin',focus);doc.addEventListener('focusout',focus);
  return()=>{clear();release();reserve('0px');doc.removeEventListener('scroll',scroll,true);doc.removeEventListener('wheel',remember,true);doc.removeEventListener('touchstart',remember,true);doc.removeEventListener('keydown',key);doc.removeEventListener('visibilitychange',visibility);doc.removeEventListener('focusin',focus);doc.removeEventListener('focusout',focus);delete nav.dataset.scrollActive;delete nav.dataset.inputActive;};
}
