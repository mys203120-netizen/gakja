export type LogoBounds={left:number;top:number;right:number;bottom:number};

/** Ignore empty/near-white canvas, while retaining pale coloured university marks. */
export function schoolLogoBounds(pixels:ArrayLike<number>,width:number,height:number):LogoBounds|null {
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||pixels.length<width*height*4)return null;
  let left=width,top=height,right=-1,bottom=-1,count=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=(y*width+x)*4,r=pixels[i],g=pixels[i+1],b=pixels[i+2];
    if(pixels[i+3]<40||Math.min(r,g,b)>232&&Math.max(r,g,b)-Math.min(r,g,b)<24)continue;
    left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);count++;
  }
  if(count<Math.max(3,width*height*.0008))return null;
  return {left:Math.max(0,left-1)/width,top:Math.max(0,top-1)/height,right:Math.min(width,right+2)/width,bottom:Math.min(height,bottom+2)/height};
}

export function schoolLogoFit(bounds:LogoBounds|null,naturalWidth:number,naturalHeight:number,width:number,height:number){
  if(!bounds||![naturalWidth,naturalHeight,width,height].every(v=>Number.isFinite(v)&&v>0))return null;
  const contentWidth=(bounds.right-bounds.left)*naturalWidth,contentHeight=(bounds.bottom-bounds.top)*naturalHeight;
  if(contentWidth<=0||contentHeight<=0)return null;
  const base=Math.min(width/naturalWidth,height/naturalHeight);
  const scale=Math.min(width*.94/contentWidth,height*.94/contentHeight,base*5);
  // Already full-size marks retain their original size.
  if(scale<base*1.08)return null;
  return {width:naturalWidth*scale,height:naturalHeight*scale,left:width/2-(bounds.left+bounds.right)*naturalWidth*scale/2,top:height/2-(bounds.top+bounds.bottom)*naturalHeight*scale/2};
}
