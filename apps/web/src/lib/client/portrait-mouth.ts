import type {InterviewerAvatarFrame} from './interviewer-avatar';

export type PortraitMouth={left:number;right:number;leftY:number;rightY:number;curve:number;maxGap:number};
/** Measured lip seams in the five existing square portraits. No generated/replacement face is used. */
export const PORTRAIT_MOUTHS:Readonly<Record<string,PortraitMouth>>={
  'clay-a':{left:566/1254,right:733/1254,leftY:644/1254,rightY:623/1254,curve:23/1254,maxGap:30/1254},
  'clay-b':{left:547/1254,right:719/1254,leftY:615/1254,rightY:605/1254,curve:13/1254,maxGap:29/1254},
  'clay-c':{left:560/1254,right:718/1254,leftY:666/1254,rightY:651/1254,curve:17/1254,maxGap:29/1254},
  'clay-d':{left:550/1254,right:720/1254,leftY:614/1254,rightY:606/1254,curve:11/1254,maxGap:29/1254},
  'clay-e':{left:578/1254,right:731/1254,leftY:672/1254,rightY:651/1254,curve:14/1254,maxGap:29/1254},
};
export function portraitMouthBounds(mouth:PortraitMouth){
  const x=mouth.left-14/1254,y=Math.min(mouth.leftY,mouth.rightY)-36/1254;
  return{x,y,width:mouth.right-mouth.left+28/1254,height:Math.max(mouth.leftY,mouth.rightY)+mouth.curve+62/1254-y};
}
export function portraitMouthOpening(frame:InterviewerAvatarFrame,personId:string){return frame.speakerId===personId&&frame.state==='speaking'&&Number.isFinite(frame.mouthOpen)?Math.max(0,Math.min(1,frame.mouthOpen)):0;}
type Pixels={width:number;height:number;data:Uint8ClampedArray};

/** Only the local lip/jaw patch is warped. Neutral/silent pixels remain exactly the original asset. */
export function warpPortraitMouth(source:Pixels,mouth:PortraitMouth,amount:number,scale:number):Pixels{
  const open=Number.isFinite(amount)?Math.max(0,Math.min(1,amount)):0;if(open<=.025)return source;
  const bounds=portraitMouthBounds(mouth),left=(mouth.left-bounds.x)*scale,right=(mouth.right-bounds.x)*scale;
  const result=new Uint8ClampedArray(source.data),{width,height}=source;
  for(let x=Math.max(0,Math.floor(left));x<Math.min(width,Math.ceil(right));x++){
    const t=(x+.5-left)/(right-left);if(t<=0||t>=1)continue;
    const weight=Math.pow(Math.sin(Math.PI*t),.85),gap=mouth.maxGap*scale*open*weight;
    if(gap<.2)continue;
    const seam=((mouth.leftY+(mouth.rightY-mouth.leftY)*t+4*t*(1-t)*mouth.curve)-bounds.y)*scale;
    const upper=seam-gap*.34,lower=seam+gap*.66;
    for(let y=0;y<height;y++){
      const index=(y*width+x)*4;
      if(y>upper&&y<lower){
        const depth=(y-upper)/gap,edge=Math.min(1,(y-upper)*1.5,(lower-y)*1.5),sample=Math.max(0,Math.min(height-1,Math.round(seam)));
        const original=(sample*width+x)*4;
        // A restrained inner-mouth shade, upper tooth edge and lower warm reflected light.
        const tooth=open>.24&&depth>.11&&depth<.3&&t>.16&&t<.84;
        const tongue=Math.max(0,(depth-.62)/.38)*Math.sin(Math.PI*t);
        const color=tooth?[225,211,195]:[52+tongue*48,25+tongue*22,29+tongue*22];
        for(let channel=0;channel<3;channel++)result[index+channel]=source.data[original+channel]*(1-edge)+color[channel]*edge;
        result[index+3]=source.data[original+3];continue;
      }
      const mapped=y<=upper?y*seam/Math.max(1,upper):seam+(y-lower)*(height-1-seam)/Math.max(1,height-1-lower);
      const row=Math.max(0,Math.min(height-1,mapped)),a=Math.floor(row),b=Math.min(height-1,a+1),blend=row-a;
      for(let channel=0;channel<4;channel++)result[index+channel]=source.data[(a*width+x)*4+channel]*(1-blend)+source.data[(b*width+x)*4+channel]*blend;
    }
  }
  return{width,height,data:result};
}

export class PortraitMouthRenderer{
  private context:CanvasRenderingContext2D;private source:ImageData;private amount=-1;
  constructor(private canvas:HTMLCanvasElement,image:HTMLImageElement,private mouth:PortraitMouth){
    const bounds=portraitMouthBounds(mouth),scale=image.naturalWidth;
    canvas.width=Math.max(1,Math.round(bounds.width*scale));canvas.height=Math.max(1,Math.round(bounds.height*scale));
    const context=canvas.getContext('2d',{willReadFrequently:true});if(!context)throw Error('Portrait canvas unavailable');this.context=context;
    context.drawImage(image,bounds.x*scale,bounds.y*scale,canvas.width,canvas.height,0,0,canvas.width,canvas.height);this.source=context.getImageData(0,0,canvas.width,canvas.height);this.scale=scale;
  }
  private scale:number;
  frame(frame:InterviewerAvatarFrame,personId:string){
    const opening=portraitMouthOpening(frame,personId),amount=Math.round(opening*40)/40;
    this.canvas.dataset.mouthOpen=String(amount);if(amount===this.amount)return;this.amount=amount;
    if(amount<=.025){this.canvas.hidden=true;return;}
    const warped=warpPortraitMouth(this.source,this.mouth,amount,this.scale);
    this.context.putImageData(new ImageData(warped.data as Uint8ClampedArray<ArrayBuffer>,warped.width,warped.height),0,0);this.canvas.hidden=false;
  }
  dispose(){this.canvas.hidden=true;this.canvas.dataset.mouthOpen='0';}
}
