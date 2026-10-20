import assert from 'node:assert/strict';
import test from 'node:test';
import {PORTRAIT_EYES,portraitExpressionFrame} from '../apps/web/src/lib/client/portrait-expression';

test('five portraits have bounded eye patches and listening/thinking produce distinct real pose values',()=>{
  assert.equal(Object.keys(PORTRAIT_EYES).length,5);
  for(const eyes of Object.values(PORTRAIT_EYES))for(const[x,y,w,h]of eyes)assert.ok(x-w>0&&x+w<1254&&y-h>0&&y+h<1254);
  const listening=portraitExpressionFrame('listening',1000,1),thinking=portraitExpressionFrame('thinking',1000,1);
  assert.notEqual(listening.tilt,thinking.tilt);assert.notEqual(listening.y,thinking.y);assert.ok(Math.abs(thinking.tilt)<=1.1);assert.ok(Math.abs(thinking.gaze)<=1.6);
});
test('eyes blink asynchronously, idle and reduced-motion keep the portrait still',()=>{
  assert.ok(portraitExpressionFrame('listening',90,0).blink>.9);assert.equal(portraitExpressionFrame('listening',90,1).blink,0);
  for(const state of ['idle','listening','thinking','speaking']as const)assert.deepEqual(portraitExpressionFrame(state,90,0,true),{tilt:0,y:0,gaze:0,blink:0});
  assert.deepEqual(portraitExpressionFrame('idle',90,0),{tilt:0,y:0,gaze:0,blink:0});
});
