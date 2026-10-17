import {test} from 'node:test';
import assert from 'node:assert/strict';
import {stoppedInterviewTimer as stop, settledInterviewTimer as settle, renewInterviewTimer as renew, INTERVIEW_LEASE_MS} from '../apps/web/src/lib/interview-timer';

test('leaving freezes elapsed time and repeated suspends cannot double count',()=>{
  const active={elapsedMs:2000,activeSince:1000,timerLeaseUntil:31000,paused:false};
  const paused={...stop(active,6000),paused:true};
  assert.equal(paused.elapsedMs,7000);
  assert.equal(stop(paused,600000).elapsedMs,7000);
  assert.equal(stop(paused,6000000).elapsedMs,7000);
});
test('resume counts only the new active interval, excluding time away',()=>{
  const paused={...stop({elapsedMs:2000,activeSince:1000,timerLeaseUntil:31000},6000),paused:true};
  const resumed={...paused,activeSince:600000,paused:false,timerLeaseUntil:600000+INTERVIEW_LEASE_MS};
  assert.equal(stop(resumed,605000).elapsedMs,12000);
});
test('lost unload requests and late heartbeat cannot extend an expired timer',()=>{
  const active={elapsedMs:2000,activeSince:1000,timerLeaseUntil:31000};
  assert.equal(stop(active,900000).elapsedMs,32000);
  assert.equal(renew(active,900000).paused,true);
  assert.equal(renew(active,900000).elapsedMs,32000);
});
test('healthy presence renews lease without double counting time',()=>{
  const active={elapsedMs:0,activeSince:1000,timerLeaseUntil:31000};
  const pulse=renew(active,10000);
  assert.equal(pulse.activeSince,1000);
  assert.equal(pulse.timerLeaseUntil,40000);
  assert.equal(stop(pulse,15000).elapsedMs,14000);
});
test('legacy sessions preserve saved time but cannot charge days of absence',()=>{
  const old={elapsedMs:9000,activeSince:1000,paused:false};
  assert.equal(settle(old,900000).paused,true);
  assert.equal(stop(old,900000).elapsedMs,9000);
});
test('AI processing with no active clock accrues no time; paused pulse never resumes',()=>{
  assert.equal(stop({elapsedMs:9000,activeSince:null,timerLeaseUntil:50000},40000).elapsedMs,9000);
  assert.equal(renew({elapsedMs:9000,activeSince:null,paused:true},40000).paused,true);
  assert.equal(stop({elapsedMs:2,activeSince:5000,timerLeaseUntil:35000},4000).elapsedMs,2);
});
