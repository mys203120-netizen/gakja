import assert from 'node:assert/strict';
import test from 'node:test';
import { createAssistantDeltaBuffer } from '../apps/web/src/lib/assistant-delta-buffer.ts';

function virtualScheduler() {
  let nextHandle = 0;
  const pending = new Map<number, () => void>();
  const callbacks = new Map<number, () => void>();
  const cancelled: number[] = [];
  return {
    pending, callbacks, cancelled,
    schedule(callback: () => void) {
      const handle = nextHandle++;
      pending.set(handle, callback);
      callbacks.set(handle, callback);
      return handle;
    },
    cancel(handle: number) {
      cancelled.push(handle);
      pending.delete(handle);
    },
    runNext() {
      const entry = pending.entries().next().value;
      assert.ok(entry, 'expected a scheduled update');
      pending.delete(entry[0]);
      entry[1]();
    },
  };
}

test('many packets produce one update while preserving Unicode and Markdown exactly', () => {
  const timer = virtualScheduler();
  const updates: string[] = [];
  const buffer = createAssistantDeltaBuffer((text) => updates.push(text), timer);
  const chunks = ['## 답변\n', '**근거**: ', '\uD83D', '\uDE42', '\n\n', '- 활동\n', '`code`\n', ' '.repeat(2)];
  for (let index = 0; index < 100; index++) {
    for (const chunk of chunks) buffer.append(chunk);
  }
  buffer.append('');
  assert.equal(timer.pending.size, 1);
  assert.deepEqual(updates, []);
  timer.runNext();
  assert.deepEqual(updates, [chunks.join('').repeat(100)]);
  assert.equal(timer.pending.size, 0);
});

test('terminal flush immediately publishes the final text once and cancels its update', () => {
  const timer = virtualScheduler();
  const updates: string[] = [];
  const buffer = createAssistantDeltaBuffer((text) => updates.push(text), timer);
  buffer.append('첫 문장.\n');
  timer.runNext();
  buffer.append('마지막 **문장**');
  buffer.append('\n');
  const staleCallback = timer.callbacks.get(1)!;
  buffer.flush();
  assert.deepEqual(updates, ['첫 문장.\n', '마지막 **문장**\n']);
  assert.deepEqual(timer.cancelled, [1]);
  assert.equal(timer.pending.size, 0);
  staleCallback();
  buffer.flush();
  assert.equal(updates.length, 2);
});

test('discard cancels even handle zero and stale callbacks cannot publish discarded text', () => {
  const timer = virtualScheduler();
  const updates: string[] = [];
  const buffer = createAssistantDeltaBuffer((text) => updates.push(text), timer);
  buffer.append('이전 요청');
  const staleCallback = timer.callbacks.get(0)!;
  buffer.discard();
  assert.deepEqual(timer.cancelled, [0]);
  assert.equal(timer.pending.size, 0);
  buffer.append('새 요청');
  staleCallback();
  assert.deepEqual(updates, []);
  assert.equal(timer.pending.size, 1);
  timer.runNext();
  assert.deepEqual(updates, ['새 요청']);
  buffer.discard();
  buffer.flush();
  assert.equal(updates.length, 1);
});

test('a delivery may enqueue another packet without losing its independent update', () => {
  const timer = virtualScheduler();
  const updates: string[] = [];
  const buffer = createAssistantDeltaBuffer((text) => {
    updates.push(text);
    if (text === '첫째') buffer.append('둘째');
  }, timer);
  buffer.append('첫째');
  timer.runNext();
  assert.deepEqual(updates, ['첫째']);
  assert.equal(timer.pending.size, 1);
  timer.runNext();
  assert.deepEqual(updates, ['첫째', '둘째']);
});

test('synchronous scheduling and reentrant delivery leave no stale pending job', () => {
  const updates: string[] = [];
  const cancelled: number[] = [];
  let nextHandle = 0;
  const buffer = createAssistantDeltaBuffer((text) => {
    updates.push(text);
    if (text === '처음') buffer.append('중간');
  }, {
    schedule(callback) {
      const handle = nextHandle++;
      callback();
      return handle;
    },
    cancel(handle) { cancelled.push(handle); },
  });
  buffer.append('처음');
  buffer.append('끝');
  buffer.flush();
  buffer.discard();
  assert.deepEqual(updates, ['처음', '중간', '끝']);
  assert.deepEqual(cancelled, []);
});
