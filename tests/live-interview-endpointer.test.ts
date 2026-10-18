import assert from 'node:assert/strict';
import test from 'node:test';
import {INITIAL_LIVE_TURN,observeLiveTurn} from '../apps/web/src/lib/live-interview-turn';

test('opening silence and isolated clicks never submit an answer',()=>{
  let state={...INITIAL_LIVE_TURN};
  for(let at=0;at<=180000;at+=100)state=observeLiveTurn(state,at,at%10000===0?.05:0);
  assert.equal(state.speechStarted,false);assert.equal(state.endingSoon,false);assert.equal(state.shouldStop,false);
});
test('a spoken answer warns after four seconds and ends after five observed silent seconds',()=>{
  let state={...INITIAL_LIVE_TURN};
  for(let at=0;at<=600;at+=100)state=observeLiveTurn(state,at,.04);
  assert.equal(state.speechStarted,true);
  for(let at=700;at<4600;at+=100)state=observeLiveTurn(state,at,0);
  assert.equal(state.endingSoon,false);state=observeLiveTurn(state,4600,0);
  assert.equal(state.endingSoon,true);assert.equal(state.shouldStop,false);
  for(let at=4700;at<=5600;at+=100)state=observeLiveTurn(state,at,0);
  assert.equal(state.shouldStop,true);
});
test('speaking during the warning cancels the pending endpoint',()=>{
  let state={...INITIAL_LIVE_TURN};
  for(let at=0;at<=600;at+=100)state=observeLiveTurn(state,at,.04);
  for(let at=700;at<=4600;at+=100)state=observeLiveTurn(state,at,0);
  assert.equal(state.endingSoon,true);
  state=observeLiveTurn(state,4700,.04);
  assert.equal(state.endingSoon,false);assert.equal(state.silenceMs,0);assert.equal(state.shouldStop,false);
});
test('background gaps and invalid frames cannot manufacture continuous silence',()=>{
  let state={...INITIAL_LIVE_TURN};
  for(let at=0;at<=600;at+=100)state=observeLiveTurn(state,at,.04);
  for(let at=700;at<=4600;at+=100)state=observeLiveTurn(state,at,0);
  state=observeLiveTurn(state,60000,0);
  assert.equal(state.silenceMs,0);assert.equal(state.shouldStop,false);
  assert.equal(observeLiveTurn(state,60000,0),state);assert.equal(observeLiveTurn(state,59999,0),state);
  assert.equal(observeLiveTurn(state,60100,NaN),state);assert.equal(observeLiveTurn(state,NaN,0),state);
  for(let at=60100;at<65000;at+=100)state=observeLiveTurn(state,at,0);
  assert.equal(state.shouldStop,false);assert.equal(observeLiveTurn(state,65000,0).shouldStop,true);
});
