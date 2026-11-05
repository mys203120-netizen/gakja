import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeVisionRecords} from '../lib/interview/vision-metrics';

test('unavailable faces never become good gaze samples and empty denominators stay null',()=>{
  const summary=summarizeVisionRecords([{phase:'listening',durationMs:500,faceDetected:false,gazeValidFrameCount:0,gazeValidDurationMs:0}]);
  assert.equal(summary.gazeOffFrameRatio,null);assert.equal(summary.gazeOffTimeRatio,null);
  assert.equal(summary.unavailableRatio,1);assert.equal(summary.smileObservedFrameRatio,null);
  assert.equal(summarizeVisionRecords([]).unavailableRatio,null);
});
test('answer phase counts only actual valid frames and actual observed durations',()=>{
  const summary=summarizeVisionRecords([
    {phase:'speaking_question',durationMs:500,gazeValidFrameCount:4,gazeOffFrameCount:4,gazeValidDurationMs:500,gazeOffDurationMs:500},
    {phase:'listening',durationMs:500,gazeValidFrameCount:3,gazeOffFrameCount:1,gazeValidDurationMs:300,gazeOffDurationMs:100,gazeEpisodeStarts:1,smileValidFrameCount:3,smileFrameCount:2,browDownValidFrameCount:3,browDownFrameCount:1},
    {phase:'suspended',durationMs:10000,gazeValidFrameCount:10,gazeOffFrameCount:10},
    {phase:'listening',durationMs:500,gazeValidFrameCount:0,gazeValidDurationMs:0}
  ]);
  assert.equal(summary.answerRecordCount,2);assert.equal(summary.gazeOffFrameRatio,1/3);
  assert.equal(summary.gazeOffTimeRatio,1/3);assert.equal(summary.unavailableRatio,.7);
  assert.equal(summary.smileObservedFrameRatio,2/3);assert.equal(summary.gazeEpisodeCount,1);
});
