import { inflateSync } from 'node:zlib';

export type PrivateMediaType = 'audio/wav' | 'audio/mpeg' | 'image/png' | 'image/jpeg';
export class MediaFormatError extends Error {
  constructor(readonly code: 'MEDIA_FORMAT_INVALID' | 'MEDIA_FORMAT_UNSUPPORTED' | 'MEDIA_LIMIT') { super(code);this.name='MediaFormatError'; }
}
const invalid=():never=>{throw new MediaFormatError('MEDIA_FORMAT_INVALID');};
const unsupported=():never=>{throw new MediaFormatError('MEDIA_FORMAT_UNSUPPORTED');};
const limit=():never=>{throw new MediaFormatError('MEDIA_LIMIT');};
const maxBytes=16*1024*1024;
const bounded=(b:Buffer)=>{if(!Buffer.isBuffer(b)||!b.length)invalid();if(b.length>maxBytes)limit();};

/** Structural subset, not an audio decoder. Every LayerIII frame must have a
 * legal header and complete calculated extent; ID3 alone is never audio.
 * Free-format/APE/trailing junk and stream format switches are unsupported. */
export function inspectMp3(bytes:Buffer) {
  bounded(bytes);let start=0,end=bytes.length;
  if(bytes.subarray(0,3).toString('ascii')==='ID3') {
    if(bytes.length<10||![2,3,4].includes(bytes[3])||bytes[4]===255||bytes.subarray(6,10).some(v=>v>127))invalid();
    const tagSize=bytes[6]*2097152+bytes[7]*16384+bytes[8]*128+bytes[9];
    if(tagSize>256*1024)limit();start=10+tagSize+(bytes[3]===4&&(bytes[5]&16)!==0?10:0);if(start>=end)invalid();
  }
  if(end-start>=128&&bytes.toString('ascii',end-128,end-125)==='TAG')end-=128;
  let frames=0,samples=0,rate=0,version=0,channels=0;
  const bitrates1=[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320];
  const bitrates2=[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160];
  for(let pos=start;pos<end;) {
    if(pos+4>end)invalid();const h=bytes.readUInt32BE(pos);
    if((h>>>21)!==2047)invalid();const v=(h>>>19)&3,layer=(h>>>17)&3,bi=(h>>>12)&15,si=(h>>>10)&3;
    if(v===1||layer!==1||bi===15||si===3||(h&3)===2)invalid();if(bi===0)unsupported();
    const sampleRate=[44100,48000,32000][si]/(v===3?1:v===2?2:4),channelCount=((h>>>6)&3)===3?1:2;
    if(frames&&(sampleRate!==rate||v!==version||channelCount!==channels))unsupported();
    const bitrate=(v===3?bitrates1:bitrates2)[bi]*1000;
    const length=Math.floor((v===3?144:72)*bitrate/sampleRate)+((h>>>9)&1);
    const sideInfo=v===3?(channelCount===1?17:32):(channelCount===1?9:17),crc=((h>>>16)&1)===0?2:0;
    if(length<4+crc+sideInfo||pos+length>end)invalid();
    frames++;samples+=v===3?1152:576;rate=sampleRate;version=v;channels=channelCount;pos+=length;
  }
  if(frames<2)invalid();
  return {mediaType:'audio/mpeg' as const,frames,sampleRate:rate,channels,durationSeconds:samples/rate,validation:'contiguous-mpeg-layer3-frame-structure' as const};
}

export function inspectWav(bytes:Buffer) {
  bounded(bytes);
  if(bytes.length<44||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE'||bytes.readUInt32LE(4)+8!==bytes.length)invalid();
  let fmt=false,data=false,sampleRate=0,channels=0,alignment=0,dataBytes=0;
  for(let pos=12;pos<bytes.length;) {
    if(pos+8>bytes.length)invalid();const name=bytes.toString('ascii',pos,pos+4),size=bytes.readUInt32LE(pos+4),begin=pos+8;
    if(begin+size>bytes.length)invalid();
    if(name==='fmt ') {
      if(fmt||size<16)invalid();const format=bytes.readUInt16LE(begin),bits=bytes.readUInt16LE(begin+14);
      channels=bytes.readUInt16LE(begin+2);sampleRate=bytes.readUInt32LE(begin+4);alignment=bytes.readUInt16LE(begin+12);
      if(![1,3].includes(format)||![1,2].includes(channels)||sampleRate<8000||sampleRate>192000||
        !(format===1?[8,16,24,32]:[32,64]).includes(bits))unsupported();
      if(alignment!==channels*bits/8||bytes.readUInt32LE(begin+8)!==sampleRate*alignment)invalid();fmt=true;
    }
    if(name==='data'){if(data||!size)invalid();data=true;dataBytes=size;}
    pos=begin+size+(size&1);if(pos>bytes.length)invalid();
  }
  if(!fmt||!data||dataBytes%alignment)invalid();return {mediaType:'audio/wav' as const,sampleRate,channels,durationSeconds:dataBytes/alignment/sampleRate,validation:'riff-pcm-container-structure' as const};
}
export function inspectAudioFormat(bytes:Buffer) {return bytes.subarray(0,4).toString('ascii')==='RIFF'?inspectWav(bytes):inspectMp3(bytes);}

const crcTable=Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function crc32(bytes:Buffer) {let c=0xffffffff;for(const v of bytes)c=crcTable[(c^v)&255]^(c>>>8);return(c^0xffffffff)>>>0;}
const pngSignature=Buffer.from([137,80,78,71,13,10,26,10]);
/** Bounded format checks. PNG validates chunks/CRC and non-interlaced scanline
 * structure; JPEG validates segment extents/SOF/SOS/EOI, not entropy decoding. */
export function inspectImageFormat(bytes:Buffer) {
  bounded(bytes);
  if(bytes.subarray(0,8).equals(pngSignature)) {
    let width=0,height=0,bitDepth=0,color=0,interlace=0,seenData=false,ended=false,paletteEntries=0,dataEnded=false;const idat:Buffer[]=[];
    for(let pos=8;pos<bytes.length;) {
      if(pos+12>bytes.length)invalid();const size=bytes.readUInt32BE(pos),name=bytes.toString('ascii',pos+4,pos+8),begin=pos+8;
      if(size>maxBytes||begin+size+4>bytes.length||!/^[A-Za-z]{4}$/u.test(name)||crc32(bytes.subarray(pos+4,begin+size))!==bytes.readUInt32BE(begin+size))invalid();
      if(pos===8&&name!=='IHDR')invalid();
      if(name==='IHDR') {
        if(width||size!==13)invalid();width=bytes.readUInt32BE(begin);height=bytes.readUInt32BE(begin+4);bitDepth=bytes[begin+8];color=bytes[begin+9];interlace=bytes[begin+12];
        if(!width||!height||width>16384||height>16384||width*height>16777216)limit();
        if(bytes[begin+10]!==0||bytes[begin+11]!==0||![0,1].includes(interlace))invalid();
        const legal:Record<number,number[]>={0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
        if(!legal[color]?.includes(bitDepth))invalid();
      } else if(name==='PLTE') {
        if(paletteEntries||seenData||color===0||color===4||size<3||size>768||size%3||color===3&&size/3>2**bitDepth)invalid();
        paletteEntries=size/3;
      } else if(name==='IDAT') {
        if(dataEnded||color===3&&!paletteEntries)invalid();seenData=true;idat.push(bytes.subarray(begin,begin+size));
      } else if(name==='IEND'){if(size||!seenData||begin+4!==bytes.length)invalid();ended=true;}
      else {if(name[0]===name[0].toUpperCase())unsupported();if(seenData)dataEnded=true;}
      pos=begin+size+4;if(ended)break;
    }
    if(!ended||!width)invalid();
    if(interlace===0) {
      const channels:Record<number,number>={0:1,2:3,3:1,4:2,6:4},row=Math.ceil(width*channels[color]*bitDepth/8)+1,total=row*height;
      if(total>128*1024*1024)limit();let pixels:Buffer;try{pixels=inflateSync(Buffer.concat(idat),{maxOutputLength:total});}catch{invalid();}
      if(pixels!.length!==total)invalid();for(let r=0;r<height;r++)if(pixels![r*row]>4)invalid();
    } else {
      // Adam7 decoding is intentionally unsupported instead of a signature-only success.
      unsupported();
    }
    return {mediaType:'image/png' as const,width,height,validation:'png-chunks-crc-and-scanlines' as const};
  }
  if(bytes.length<4||bytes[0]!==255||bytes[1]!==216)invalid();
  let pos=2,width=0,height=0,scan=false,ended=false,frameType=0;const components=new Set<number>();
  while(pos<bytes.length) {
    if(bytes[pos++]!==255)invalid();while(bytes[pos]===255)pos++;if(pos>=bytes.length)invalid();const marker=bytes[pos++];
    if(marker===217){ended=true;if(pos!==bytes.length)invalid();break;}
    if(marker===0||marker===216||marker>=208&&marker<=215)invalid();
    if(pos+2>bytes.length)invalid();const size=bytes.readUInt16BE(pos);if(size<2||pos+size>bytes.length)invalid();
    if([192,193,194].includes(marker)) {
      if(width||size<8)invalid();height=bytes.readUInt16BE(pos+3);width=bytes.readUInt16BE(pos+5);
      if(bytes[pos+2]!==8||![1,3,4].includes(bytes[pos+7]))unsupported();
      if(!width||!height||width>16384||height>16384||width*height>16777216)limit();
      if(size!==8+3*bytes[pos+7])invalid();
      frameType=marker;
      for(let n=0;n<bytes[pos+7];n++) {
        const offset=pos+8+3*n,component=bytes[offset],sampling=bytes[offset+1];
        if(components.has(component)||!(sampling>>4)||!(sampling&15)||(sampling>>4)>4||(sampling&15)>4||bytes[offset+2]>3)invalid();
        components.add(component);
      }
    } else if(marker>=192&&marker<=207&&![196,200,204].includes(marker))unsupported();
    if(marker===218) {
      if(!width||size<8)invalid();const count=bytes[pos+2],selected=new Set<number>();
      if(!count||count>components.size||size!==6+2*count)invalid();
      for(let n=0;n<count;n++) {
        const component=bytes[pos+3+2*n],tables=bytes[pos+4+2*n];
        if(!components.has(component)||selected.has(component)||(tables>>4)>3||(tables&15)>3)invalid();selected.add(component);
      }
      const start=bytes[pos+3+2*count],end=bytes[pos+4+2*count],approximation=bytes[pos+5+2*count];
      if(start>end||end>63||(approximation>>4)>13||(approximation&15)>13||
        (frameType!==194&&(start!==0||end!==63||approximation!==0))||
        (frameType===194&&(start===0&&end!==0||start>0&&count!==1)))invalid();
    }
    pos+=size;
    if(marker===218) {
      scan=true;const scanStart=pos;
      while(pos<bytes.length) {
        if(bytes[pos]!==255){pos++;continue;}
        const next=bytes[pos+1];if(next===0||next>=208&&next<=215){pos+=2;continue;}
        break;
      }
      if(pos===scanStart)invalid();
    }
  }
  if(!ended||!scan||!width)invalid();return {mediaType:'image/jpeg' as const,width,height,validation:'jpeg-marker-and-scan-structure' as const};
}
