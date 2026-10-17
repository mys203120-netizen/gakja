'use client';
import { useState } from 'react';
export function SchoolLogo({school,size=40,loading}:{school:{logoUrl?:string|null;school_logo_url?:string|null;university?:string;canonicalName?:string};size?:number;loading?:'lazy'|'eager'}) {
  const src=school.school_logo_url||school.logoUrl;const [failed,setFailed]=useState<string|null>(null);
  return src&&failed!==src?<img className="school-logo" src={src} width={size} height={size} loading={loading} alt="" onError={()=>setFailed(src)} style={{objectFit:'contain',flexShrink:0}}/>:<span className="school-logo-fallback" aria-hidden="true" style={{width:size,height:size,display:'inline-flex',alignItems:'center',justifyContent:'center',flexShrink:0,whiteSpace:'nowrap',fontSize:Math.min(12,Math.max(10,size*.3)),lineHeight:1,borderRadius:'50%',background:'#f1f4f1',color:'#617064'}}>{(school.canonicalName||school.university||'대학').slice(0,2)}</span>;
}
