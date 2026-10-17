import assert from 'node:assert/strict';
import { test } from 'node:test';
import { interviewPreviewHref, interviewSetupHref, interviewSetupState, sourceVersionInput } from '../apps/web/src/lib/interview-flow';

test('a selected question, activity or briefing begins as one-question practice', () => {
  for (const context of ['questionId=q_previous&sourceVersion=2', 'activityId=a_selected', 'briefingId=b_selected&briefingQuestionIndex=3']) {
    const params = new URLSearchParams(context);
    assert.equal(interviewSetupState(params).count, 1);
    assert.equal(interviewSetupState(params).advanced, false);
  }
  assert.equal(interviewSetupState(new URLSearchParams()).count, 4);
});
test('Chat to Live to Chat keeps selected context and every adjusted setting', () => {
  const original = new URLSearchParams('questionId=q_previous&activityId=a_previous&sourceVersion=2&sourceType=personal&targetId=t_selected');
  const live = new URL(interviewSetupHref('video', original, { mode: 'major', count: 3, panelistCount: 5, difficulty: 'deep', followups: true, pressure: true, timing: 'turn', reactions: true, advanced: true }), 'http://localhost');
  const chat = new URL(interviewSetupHref('chat', live.searchParams), 'http://localhost');
  for (const name of ['questionId', 'activityId', 'sourceVersion', 'sourceType', 'targetId']) assert.equal(chat.searchParams.get(name), original.get(name));
  assert.equal(chat.searchParams.get('kind'), 'chat');
  assert.deepEqual(interviewSetupState(chat.searchParams), { mode: 'major', count: 3, panelistCount: 5, difficulty: 'deep', followups: true, pressure: true, timing: 'turn', reactions: true, advanced: true });
});
test('reaction and feedback remain consistent after reload and setting changes', () => {
  const start = new URLSearchParams('feedback=end');
  const optedIn = new URL(interviewSetupHref('chat', start, { reactions: true }), 'http://localhost').searchParams;
  assert.equal(interviewSetupState(optedIn).timing, 'turn');
  const optedOut = new URL(interviewSetupHref('chat', optedIn, { timing: 'end' }), 'http://localhost').searchParams;
  assert.equal(interviewSetupState(optedOut).reactions, false);
  assert.equal(interviewSetupState(optedOut).timing, 'end');
});
test('invalid restored settings cannot become oversized requests or arbitrary modes', () => {
  const state = interviewSetupState(new URLSearchParams('count=0&panelists=900&mode=other&difficulty=anything&reactions=true&feedback=other'));
  assert.deepEqual(state, { mode: 'basic', count: 4, panelistCount: 2, difficulty: 'standard', reactions: false, followups: false, pressure: false, timing: 'end', advanced: false });
});
test('preview requests include the selected source but no changing UI settings', () => {
  const params = new URLSearchParams('questionId=q1&sourceVersion=2&activityId=a1&briefingId=b1&briefingQuestionIndex=2&count=8&reactions=1&feedback=turn');
  const preview = new URL(interviewPreviewHref(params, 'target1'), 'http://localhost').searchParams;
  assert.equal(preview.get('questionId'), 'q1'); assert.equal(preview.get('sourceVersion'), '2');
  assert.equal(preview.get('briefingQuestionIndex'), '2'); assert.equal(preview.get('targetId'), 'target1');
  assert.equal(preview.has('reactions'), false); assert.equal(preview.has('count'), false); assert.equal(preview.has('feedback'), false);
});
test('source versions are integer references rather than synthesized metadata', () => {
  for (const value of ['-1', '0', '1.5', '100001', 'any-version']) assert.equal(sourceVersionInput(new URLSearchParams({ sourceVersion: value })), undefined);
  assert.equal(sourceVersionInput(new URLSearchParams('sourceVersion=2')), 2);
  assert.equal(sourceVersionInput(new URLSearchParams()), undefined);
});
