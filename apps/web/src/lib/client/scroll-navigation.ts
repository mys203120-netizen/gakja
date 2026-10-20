/** Directional decoration; keyboard and screen-reader links stay available. */
export function installScrollNavigation(nav:HTMLElement,doc:Document=document){
  const win=doc.defaultView;if(!win)return()=>{};
  let timer:number|undefined;
  const positions=new WeakMap<object,number>();
  const documentY=()=>Math.max(0,doc.scrollingElement?.scrollTop??win.scrollY??0);
  positions.set(doc,documentY());
  const hide=()=>{nav.dataset.scrollActive='false';};
  const clear=()=>{if(timer!==undefined){win.clearTimeout(timer);timer=undefined;}};
  const show=()=>{
    if(win.innerWidth>700)return;
    nav.dataset.scrollActive='true';clear();
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
  const visibility=()=>{if(doc.visibilityState==='hidden'){clear();hide();}};
  hide();doc.addEventListener('scroll',scroll,{capture:true,passive:true});doc.addEventListener('wheel',remember,{capture:true,passive:true});doc.addEventListener('touchstart',remember,{capture:true,passive:true});doc.addEventListener('keydown',key);doc.addEventListener('visibilitychange',visibility);
  return()=>{clear();doc.removeEventListener('scroll',scroll,true);doc.removeEventListener('wheel',remember,true);doc.removeEventListener('touchstart',remember,true);doc.removeEventListener('keydown',key);doc.removeEventListener('visibilitychange',visibility);delete nav.dataset.scrollActive;};
}
