import assert from 'node:assert/strict';
import test from 'node:test';
import {swipeDestination} from '../apps/web/src/lib/mobile-tab-swipe';

test('deliberate horizontal swipe follows the three primary menus without wrapping',()=>{
  assert.equal(swipeDestination('/my',-110,6,200),'/training');
  assert.equal(swipeDestination('/training',-90,-10,300),'/preparation');
  assert.equal(swipeDestination('/preparation',100,12,400),'/training');
  assert.equal(swipeDestination('/training',90,5,180),'/my');
  assert.equal(swipeDestination('/my',100,0,200),null);
  assert.equal(swipeDestination('/preparation',-100,0,200),null);
});
test('vertical/short/slow gestures and answer or school workspaces never change tabs',()=>{
  for(const [dx,dy,time] of [[-30,1,200],[-90,100,150],[-80,65,250],[-100,1,950],[-90,0,-1]])assert.equal(swipeDestination('/my',dx,dy,time),null);
  for(const path of ['/my/train','/my/diagnosis','/interview/session','/schools/new','/availability','/account/settings'])assert.equal(swipeDestination(path,-120,2,200),null);
});
