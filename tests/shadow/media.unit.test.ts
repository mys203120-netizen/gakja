import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inspectAudioFormat,inspectImageFormat,MediaFormatError } from '../../server/storage/media-format';
import { syntheticWav } from '../storage/fixtures';
import { syntheticMp3,syntheticPng,syntheticJpeg } from './media-fixtures';
const invalid=(e:unknown)=>e instanceof MediaFormatError;

test('D actual encoded synthetic MP3 and existing C WAV retain bytes and report distinct MIME',()=>{
  for(const [bytes,mime] of [[syntheticMp3(),'audio/mpeg'],[syntheticWav(),'audio/wav']] as const) {
    const before=createHash('sha256').update(bytes).digest('hex'),r=inspectAudioFormat(bytes);
    assert.equal(r.mediaType,mime);assert.ok(r.durationSeconds>0);assert.equal(createHash('sha256').update(bytes).digest('hex'),before);
  }
  const mp3=inspectAudioFormat(syntheticMp3());assert.equal('frames' in mp3?mp3.frames:0,13);assert.equal(mp3.sampleRate,24000);
});
test('D MP3 rejects ID3-only, forged extension-style signature, truncated frames and appended bytes',()=>{
  for(const bytes of [Buffer.from('ID3\x04\0\0\0\0\0\0'),Buffer.from('ID3not-a-valid-mp3'),syntheticMp3().subarray(0,-1),Buffer.concat([syntheticMp3(),Buffer.from('junk')])]) {
    assert.throws(()=>inspectAudioFormat(bytes),invalid);
  }
  const wav=syntheticWav();wav.writeUInt32LE(100,28);assert.throws(()=>inspectAudioFormat(wav),invalid);
});
test('D PNG chunk CRC/scanlines and JPEG segment/frame dimensions are bounded and retain exact bytes',()=>{
  assert.deepEqual(inspectImageFormat(syntheticPng()),{mediaType:'image/png',width:3,height:2,validation:'png-chunks-crc-and-scanlines'});
  assert.deepEqual(inspectImageFormat(syntheticJpeg()),{mediaType:'image/jpeg',width:3,height:2,validation:'jpeg-marker-and-scan-structure'});
  const corrupt=syntheticPng();corrupt[42]^=1;assert.throws(()=>inspectImageFormat(corrupt),invalid);
  assert.throws(()=>inspectImageFormat(syntheticJpeg().subarray(0,-2)),invalid);
  assert.throws(()=>inspectImageFormat(Buffer.from([255,216,255,217])),invalid);
});
