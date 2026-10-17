import assert from 'node:assert/strict';
import test from 'node:test';
import { streamedJsonContent, readAssistantStream } from '../apps/web/src/lib/assistant-stream-model.ts';

test('structured deltas preserve Markdown, quotes, Unicode and source order', () => {
  const content = '# 나의 답\n\n1. **조건**을 말해요. "비교"\\기준 😀';
  for (const json of [JSON.stringify({ content, source_ids: [] }), JSON.stringify({ source_ids: ['content', '{"content":"다른 값"}'], content })]) {
    let previous = '';
    for (let end = 1; end <= json.length; end++) {
      const partial = streamedJsonContent(json.slice(0, end));
      assert.ok(content.startsWith(partial)); assert.ok(partial.startsWith(previous)); previous = partial;
    }
    assert.equal(previous, content);
  }
  assert.equal(streamedJsonContent('{"content":"\\ud83d'), '');
  assert.equal(streamedJsonContent('{"content":"\\ud83d\\ude00'), '😀');
  assert.equal(streamedJsonContent('{"nested":{"content":"fake"},"content":"real'), 'real');
});

test('SSE decodes split Korean bytes and emits deltas before completion', async () => {
  const events = [{ type: 'start', threadId: 'test' }, { type: 'delta', delta: '조건 ' }, { type: 'delta', delta: '**비교**' }, { type: 'done', message: { content: '조건 **비교**' } }];
  const bytes = new TextEncoder().encode(events.map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join(''));
  const seen: any[] = [];
  const body = new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3)); controller.close(); } });
  await readAssistantStream(new Response(body, { headers: { 'content-type': 'text/event-stream' } }), e => { seen.push(e); });
  assert.deepEqual(seen, events);
});

test('a disconnected SSE reply never becomes completed', async () => {
  await assert.rejects(readAssistantStream(new Response('data: {"type":"delta","delta":"일부"}\n\n', { headers: { 'content-type': 'text/event-stream' } }), () => {}), /중단/);
});

test('JSON fallback preserves the owned thread handoff before the completed message', async () => {
  const thread = { id: 'owned-thread', title: '지원 동기', target_id: 'owned-school', content_version: 6, context: { questionId: 'q1', targetId: 'owned-school' } };
  const message = { id: 'owned-reply', status: 'completed', role: 'assistant', content: '**내 역할**을 확인해요.' };
  const seen: any[] = [];
  await readAssistantStream(new Response(JSON.stringify({ threadId: thread.id, thread, message }), { headers: { 'content-type': 'application/json' } }), event => { seen.push(event); });
  assert.deepEqual(seen.map(event => event.type), ['start', 'done']);
  assert.deepEqual(seen[0].thread, thread);
  assert.equal(seen[0].assistantId, message.id);
  assert.deepEqual(seen[1].message, message);
});
