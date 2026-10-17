import gsap from 'gsap';

type Carry = { ghost: HTMLElement; target?: HTMLElement; raf: number; timer: number; born: number };
let carry: Carry | undefined;
const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
const reduce = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
function stopCarry() {
  if (!carry) return;
  cancelAnimationFrame(carry.raf);clearTimeout(carry.timer);gsap.killTweensOf(carry.ghost);
  if(carry.target){gsap.killTweensOf(carry.target);gsap.set(carry.target,{clearProps:'opacity'});}
  carry.ghost.remove();carry=undefined;
}

/** A question crosses screens only when both ends have the same identity AND text. */
export function attachQuestionCarry() {
  const click=(event:MouseEvent)=>{
    if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||reduce())return;
    const anchor=(event.target as Element)?.closest<HTMLAnchorElement>('a[href]');
    if(!anchor||anchor.target==='_blank'||anchor.hasAttribute('download'))return;
    const href=new URL(anchor.href,location.href),id=href.searchParams.get('questionId');
    if(href.origin!==location.origin||!/^\/interview\/(new|chat|live)$/.test(href.pathname)||!id)return;
    const source=Array.from(document.querySelectorAll<HTMLElement>('[data-question-key]')).find(element=>element.dataset.questionKey===id&&element.getBoundingClientRect().height>0);
    if(!source)return;
    const rect=source.getBoundingClientRect(),style=getComputedStyle(source),prompt=normalize(source.textContent||'');
    if(!prompt||rect.bottom<0||rect.top>innerHeight)return;
    stopCarry();const ghost=document.createElement('div');ghost.className='question-carry';ghost.textContent=source.textContent;ghost.setAttribute('aria-hidden','true');
    Object.assign(ghost.style,{left:`${rect.left}px`,top:`${rect.top}px`,width:`${rect.width}px`,fontFamily:style.fontFamily,fontSize:style.fontSize,fontWeight:style.fontWeight,lineHeight:style.lineHeight,letterSpacing:style.letterSpacing,color:style.color});
    document.body.append(ghost);carry={ghost,raf:0,timer:0,born:performance.now()};
    const state=carry;
    const seek=()=>{
      if(carry!==state)return;
      if(performance.now()-state.born>3500){gsap.to(ghost,{opacity:0,duration:.15,onComplete:stopCarry});return;}
      const destination=location.pathname===href.pathname&&new URLSearchParams(location.search).get('questionId')===id
        ?Array.from(document.querySelectorAll<HTMLElement>('[data-question-key]')).find(element=>element.dataset.questionKey===id&&normalize(element.textContent||'')===prompt&&element!==source):undefined;
      if(!destination){state.raf=requestAnimationFrame(seek);return;}
      const end=destination.getBoundingClientRect();if(!end.height||end.top>innerHeight||end.bottom<0){stopCarry();return;}
      const endStyle=getComputedStyle(destination);state.target=destination;
      gsap.set(destination,{opacity:0});gsap.to(ghost,{left:end.left,top:end.top,width:end.width,fontSize:endStyle.fontSize,lineHeight:endStyle.lineHeight,letterSpacing:endStyle.letterSpacing,opacity:1,duration:.34,ease:'power3.out',onComplete:()=>{if(carry!==state)return;gsap.to(destination,{opacity:1,duration:.12,clearProps:'opacity'});gsap.to(ghost,{opacity:0,duration:.12,onComplete:stopCarry});}});
    };
    // Cover only the source text while the destination loads; normal navigation is never delayed.
    gsap.fromTo(ghost,{opacity:.35},{opacity:.75,duration:.12});state.raf=requestAnimationFrame(seek);
  };
  document.addEventListener('click',click,true);
  return()=>{document.removeEventListener('click',click,true);stopCarry();};
}

/** A saved receipt moves toward Reports. It runs only after a successful write. */
export function animateStudyReceipt(origin?: DOMRect) {
  if(reduce())return;
  const destination=Array.from(document.querySelectorAll<HTMLElement>('.main-nav a[href="/records"],.mobile-nav a[href="/records"]')).find(element=>{const rect=element.getBoundingClientRect();return rect.height>0&&rect.top>=0&&rect.bottom<=innerHeight;});
  if(!destination)return;
  const end=(destination.querySelector('svg')||destination).getBoundingClientRect(),start=origin||{left:innerWidth/2,top:innerHeight/2,width:0,height:0};
  const dot=document.createElement('span');dot.className='study-receipt-dot';dot.setAttribute('aria-hidden','true');document.body.append(dot);
  const x=start.left+start.width/2,y=start.top+start.height/2;
  gsap.set(dot,{x,y,scale:.6});gsap.timeline({onComplete:()=>dot.remove()})
    .to(dot,{scale:1,duration:.1})
    .to(dot,{x:end.left+end.width/2,y:end.top+end.height/2,duration:.38,ease:'power3.inOut'})
    .to(dot,{scale:1.8,opacity:0,duration:.16});
  gsap.fromTo(destination,{filter:'brightness(1)'},{filter:'brightness(.85)',duration:.15,repeat:1,yoyo:true,clearProps:'filter',delay:.45});
  window.setTimeout(()=>{gsap.killTweensOf(dot);dot.remove();},1000);
}
