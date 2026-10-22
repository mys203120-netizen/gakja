'use client';
import {ownedClassName} from './owned-class-name';

import {useState,type SyntheticEvent} from 'react';
import {schoolLogoBounds,schoolLogoFit,type LogoBounds} from '@/lib/school-logo-fit';
const measurements=new Map<string,{bounds:LogoBounds|null;width:number;height:number}>();
export function SchoolLogo({school,size=40,loading}:{school:{logoUrl?:string|null;school_logo_url?:string|null;university?:string;canonicalName?:string};size?:number;loading?:'lazy'|'eager'}) {
  const name=school.canonicalName||school.university||'',unist=/UNIST|유니스트|울산과학기술원/i.test(name),ajou=name==='아주대학교';
  const src=unist?'/school-logos/6cc29bbe9eca.png':school.school_logo_url||school.logoUrl;
  const [failed,setFailed]=useState<string|null>(null),[measured,setMeasured]=useState<{src:string;bounds:LogoBounds|null;width:number;height:number}|null>(null);
  const width=unist?Math.round(size*1.65):size;
  const measurement=measured?.src===src?measured:src?measurements.get(src):null;
  // UNIST uses white artwork recoloured blue; analyse other marks before recolouring.
  const fit=!unist&&measurement?schoolLogoFit(measurement.bounds,measurement.width,measurement.height,width,size):null;
  function loaded(event:SyntheticEvent<HTMLImageElement>){
    const image=event.currentTarget;if(!src||unist||!image.naturalWidth||!image.naturalHeight)return;
    let found=measurements.get(src);
    if(!found){
      let bounds:LogoBounds|null=null;
      try{
        const scale=Math.min(1,160/Math.max(image.naturalWidth,image.naturalHeight));
        const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
        const context=canvas.getContext('2d',{willReadFrequently:true});
        if(context){context.drawImage(image,0,0,canvas.width,canvas.height);bounds=schoolLogoBounds(context.getImageData(0,0,canvas.width,canvas.height).data,canvas.width,canvas.height);}
      }catch{/* Remote/CORS or unavailable canvas keeps the original mark usable. */}
      found={bounds,width:image.naturalWidth,height:image.naturalHeight};measurements.set(src,found);
    }
    setMeasured({src,...found});
  }
  return src&&failed!==src?<span className={ownedClassName("school-logo",true)} data-school-logo={unist?'unist':ajou?'ajou':undefined} aria-hidden="true" style={{position:'relative',display:'inline-flex',alignItems:'center',justifyContent:'center',width,height:size,flexShrink:0,overflow:'hidden',background:'transparent',mixBlendMode:'multiply'}}><img src={src} width={width} height={size} loading={loading} alt="" onLoad={loaded} onError={()=>setFailed(src)} style={{...(fit?{position:'absolute',width:fit.width,height:fit.height,left:fit.left,top:fit.top,maxWidth:'none',maxHeight:'none'}:{width:'100%',height:'100%'}),objectFit:fit?'fill':ajou?'cover':'contain',objectPosition:ajou?'37% 50%':'center',transform:!fit&&ajou?'scale(1.22)':undefined,filter:unist?'brightness(0) saturate(100%) invert(23%) sepia(90%) saturate(1100%) hue-rotate(172deg) brightness(80%) contrast(105%)':undefined,mixBlendMode:'multiply',background:'transparent',flexShrink:0}} className={ownedClassName(undefined,true)}/></span>:<span className={ownedClassName("school-logo-fallback",true)} aria-hidden="true" style={{width:size,height:size,display:'inline-flex',alignItems:'center',justifyContent:'center',flexShrink:0,whiteSpace:'nowrap',fontSize:'var(--font-size-caption)',lineHeight:1,borderRadius:'50%',background:'#f1f4f1',color:'#617064'}}>{(name||'대학').slice(0,2)}</span>;
}
