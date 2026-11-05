import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ClovaSpeechStream, type SpeechStreamTransport, type TranscriptRevision } from '../server/providers/clova-stt';

type WireRequest = { type: 'CONFIG'; config: { config: string } } | { type: 'DATA'; data: { chunk: Buffer; extra_contents: string } };
class FakeCall extends EventEmitter {
  requests: WireRequest[] = [];
  writableLength = 0;
  cancelled = 0;
  write(request: WireRequest) { this.requests.push(request); return true; }
  cancel() { this.cancelled++; }
  receive(payload: unknown) { this.emit('data', { contents: JSON.stringify(payload) }); }
  dataRequests() { return this.requests.filter((request): request is Extract<WireRequest, { type: 'DATA' }> => request.type === 'DATA'); }
}
function fixture() {
  const call = new FakeCall();
  const revisions: TranscriptRevision[] = [];
  const errors: Error[] = [];
  let transportClosed = 0;
  const stream = new ClovaSpeechStream(result => revisions.push(result), error => errors.push(error), {}, () => ({
    call: call as unknown as SpeechStreamTransport['call'], close: () => transportClosed++,
  }));
  return { call, stream, revisions, errors, closed: () => transportClosed };
}
const ready = { config: { status: 'Success' } };
const result = (text: string, epFlag: boolean, seqId: number) => ({ transcription: { text, position: 0, epFlag, seqId } });

function assertEndpointTail(call: FakeCall, candidateChunks: Buffer[]) {
  const frames = call.dataRequests();
  assert.deepEqual(frames.slice(0, candidateChunks.length).map(frame => frame.data.chunk), candidateChunks);
  const tail = frames.slice(candidateChunks.length);
  assert.equal(tail.length, 7);
  assert.equal(tail.slice(0, 6).reduce((sum, frame) => sum + frame.data.chunk.length, 0), 19_200);
  for (const frame of tail.slice(0, 6)) {
    assert.equal(frame.data.chunk.length, 3_200);
    assert.ok(frame.data.chunk.every(byte => byte === 0));
    assert.deepEqual(JSON.parse(frame.data.extra_contents), { epFlag: false, seqId: 0 });
  }
  assert.equal(tail[6].data.chunk.length, 320);
  assert.ok(tail[6].data.chunk.every(byte => byte === 0));
  assert.deepEqual(JSON.parse(tail[6].data.extra_contents), { epFlag: true, seqId: 1 });
}

test('abrupt submit sends transport silence synchronously before the unique endpoint and awaits its matching final', async () => {
  const f = fixture();
  try {
    f.call.receive(ready);
    const pcm = Buffer.from([1, 2, 3, 4]);
    f.stream.write(pcm);
    f.call.receive(result('저 혼자 자료를 ', false, 0));
    const done = f.stream.finish();
    assertEndpointTail(f.call, [pcm]); // No wall-clock padding delay or client-tail requirement.
    assert.equal(f.stream.finish(), done);
    f.stream.write(Buffer.from([5, 6]));
    f.call.receive(result('저 혼자 자료를 정리했습니다.', true, 9));
    assert.equal(f.closed(), 0);
    assert.equal(f.revisions.at(-1)?.isFinal, false);
    f.call.receive(result('저 혼자 자료를 정리했습니다.', true, 1));
    assert.equal(await done, '저 혼자 자료를 정리했습니다.');
    assert.equal(f.closed(), 1);
    assert.equal(f.call.cancelled, 1);
    assert.equal(f.revisions.at(-1)?.isFinal, true);
    assert.equal(f.errors.length, 0);
    assertEndpointTail(f.call, [pcm]);
  } finally { f.stream.close(); }
});

test('submit before CONFIG success drains candidate PCM, then padding, then endpoint once', async () => {
  const f = fixture();
  try {
    const chunks = [Buffer.from([7, 8]), Buffer.from([9, 10])];
    chunks.forEach(chunk => f.stream.write(chunk));
    const done = f.stream.finish();
    assert.equal(f.call.requests.length, 1);
    assert.equal(f.call.requests[0].type, 'CONFIG');
    f.call.receive(ready);
    assertEndpointTail(f.call, chunks);
    f.call.receive(ready);
    assertEndpointTail(f.call, chunks);
    f.call.receive(result('답변입니다.', true, 1));
    assert.equal(await done, '답변입니다.');
  } finally { f.stream.close(); }
});

test('transport silence does not fabricate a spoken answer when the final is empty', async () => {
  const f = fixture();
  try {
    f.call.receive(ready);
    const done = f.stream.finish();
    assert.equal(f.revisions.length, 0);
    assertEndpointTail(f.call, []);
    f.call.receive(result('', true, 1));
    assert.equal(await done, '');
    assert.equal(f.revisions.length, 1);
    assert.equal(f.revisions[0].rawTranscript, '');
  } finally { f.stream.close(); }
});

test('provider disconnect after padding rejects finalization and retains the last raw transcript', async () => {
  const f = fixture();
  try {
    f.call.receive(ready);
    f.call.receive(result('마지막 부분 전사', false, 0));
    const done = f.stream.finish();
    const rejected = assert.rejects(done, /최종 전사를 확정하기 전에/);
    f.call.emit('end');
    await rejected;
    assert.equal(f.revisions.at(-1)?.rawTranscript, '마지막 부분 전사');
    assert.equal(f.revisions.at(-1)?.isFinal, false);
    assert.equal(f.errors.length, 1);
    assert.equal(f.closed(), 1);
  } finally { f.stream.close(); }
});

test('an empty matching endpoint acknowledges prior actual text without appending inferred words', async () => {
  const f = fixture();
  try {
    f.call.receive(ready);
    const actual = '신청 방법을 설명해 드렸습니다. ';
    f.call.receive(result(actual, false, 0));
    const done = f.stream.finish();
    f.call.receive({ transcription: { text: '', position: actual.length, epFlag: true, seqId: 1, confidence: 1 } });
    assert.equal(await done, actual);
    assert.equal(f.revisions.at(-1)?.rawTranscript, actual);
    assert.equal(f.revisions.at(-1)?.isFinal, true);
    assert.equal(f.errors.length, 0);
  } finally { f.stream.close(); }
});
