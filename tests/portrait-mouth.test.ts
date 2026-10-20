import assert from 'node:assert/strict';
import test from 'node:test';
import {PORTRAIT_MOUTHS,portraitMouthBounds,portraitMouthOpening,warpPortraitMouth} from '../apps/web/src/lib/client/portrait-mouth';
import {InterviewerAvatarSignal} from '../apps/web/src/lib/client/interviewer-avatar';

function sourceFor(id:string){const mouth=PORTRAIT_MOUTHS[id],bounds=portraitMouthBounds(mouth),scale=1254,width=Math.ceil(bounds.width*scale),height=Math.ceil(bounds.height*scale),data=new Uint8ClampedArray(width*height*4);for(let y=0;y<height;y++)for(let x=0;x<width;x++){const at=(y*width+x)*4;data[at]=100+Math.round(y/2);data[at+1]=80+Math.round(y/3);data[at+2]=90+Math.round(y/4);data[at+3]=255;}return{mouth,bounds,scale,source:{width,height,data}};}

test('five measured mouth patches stay entirely within their existing portrait and keep a bounded opening',()=>{
  assert.equal(Object.keys(PORTRAIT_MOUTHS).length,5);for(const mouth of Object.values(PORTRAIT_MOUTHS)){const bounds=portraitMouthBounds(mouth);assert.ok(bounds.x>0&&bounds.y>0&&bounds.x+bounds.width<1&&bounds.y+bounds.height<1);assert.ok(mouth.maxGap>0&&mouth.maxGap<.03);assert.ok(mouth.left<mouth.right);}
});

test('only active interviewer output animates; microphone/listening, silence, invalid amplitude and reset close all mouths',()=>{
  const signal=new InterviewerAvatarSignal();signal.state('speaking','B');signal.mouth(.7);assert.equal(portraitMouthOpening(signal.snapshot,'B'),.7);assert.equal(portraitMouthOpening(signal.snapshot,'A'),0);signal.state('listening','B');signal.mouth(1);assert.equal(portraitMouthOpening(signal.snapshot,'B'),0);signal.state('speaking','B');signal.mouth(.9);signal.silence();assert.equal(portraitMouthOpening(signal.snapshot,'B'),0);signal.reset();assert.equal(portraitMouthOpening(signal.snapshot,'B'),0);assert.equal(portraitMouthOpening({state:'speaking',speakerId:'B',mouthOpen:NaN},'B'),0);
});

test('silent and invalid frames reuse exactly the original pixels while measured speech visibly changes the mouth',()=>{
  for(const id of Object.keys(PORTRAIT_MOUTHS)){const{mouth,scale,source}=sourceFor(id);for(const value of [0,-1,NaN,Infinity,.025])assert.equal(warpPortraitMouth(source,mouth,value,scale),source);const opened=warpPortraitMouth(source,mouth,.8,scale);let changed=0;for(let at=0;at<source.data.length;at++)if(source.data[at]!==opened.data[at])changed++;assert.ok(changed>1500,'actual mouth pixels change for '+id);assert.notEqual(opened.data,source.data);assert.deepEqual(warpPortraitMouth(source,mouth,1,scale).data,warpPortraitMouth(source,mouth,10,scale).data);}
});

test('speech warps only mouth columns, preserves transparency and joins the original top/bottom without a patch boundary',()=>{
  for(const id of Object.keys(PORTRAIT_MOUTHS)){const{mouth,bounds,scale,source}=sourceFor(id),opened=warpPortraitMouth(source,mouth,1,scale);const left=Math.floor((mouth.left-bounds.x)*scale),right=Math.ceil((mouth.right-bounds.x)*scale);for(let y=0;y<source.height;y++)for(let x=0;x<source.width;x++){const at=(y*source.width+x)*4;assert.equal(opened.data[at+3],source.data[at+3]);if(x<left||x>=right||y===0||y===source.height-1)assert.deepEqual(opened.data.subarray(at,at+4),source.data.subarray(at,at+4),'pixels outside the lip deformation remain original');}}
});

test('mouth opening follows changing amplitude rather than a timer or a canned loop',()=>{
  const{mouth,scale,source}=sourceFor('clay-b');const quarter=warpPortraitMouth(source,mouth,.25,scale),full=warpPortraitMouth(source,mouth,1,scale);const dark=(data:Uint8ClampedArray)=>{let total=0;for(let i=0;i<data.length;i+=4)if(data[i]<95&&data[i+1]<60)total++;return total;};assert.ok(dark(full.data)>dark(quarter.data)*1.8);assert.equal(dark(source.data),0);assert.equal(warpPortraitMouth(source,mouth,0,scale),source);
});
