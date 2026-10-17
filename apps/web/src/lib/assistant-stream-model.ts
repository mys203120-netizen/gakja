type ParsedString = { value: string; end: number; complete: boolean };

function readString(input: string, start: number): ParsedString {
  let value = '';
  for (let i = start + 1; i < input.length; i++) {
    const char = input[i];
    if (char === '"') return { value, end: i + 1, complete: true };
    if (char !== '\\') { value += char; continue; }
    if (++i >= input.length) break;
    const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
    if (input[i] === 'u') {
      const hex = input.slice(i + 1, i + 5);
      if (!/^[0-9a-f]{4}$/i.test(hex)) break;
      value += String.fromCharCode(parseInt(hex, 16)); i += 4;
    } else if (Object.hasOwn(escapes, input[i])) value += escapes[input[i]];
    else break;
  }
  // Never paint half of an escaped emoji when a provider chunk splits a pair.
  if (/[\uD800-\uDBFF]$/.test(value)) value = value.slice(0, -1);
  return { value, end: input.length, complete: false };
}

/** Read a top-level JSON string as provider tokens arrive, preserving Markdown escapes. */
export function streamedJsonContent(input: string, key = 'content'): string {
  let depth = 0, expectingKey = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === '{' || char === '[') { depth++; if (depth === 1) expectingKey = true; continue; }
    if (char === '}' || char === ']') { depth--; continue; }
    if (char === ',' && depth === 1) { expectingKey = true; continue; }
    if (char === ':' && depth === 1) { expectingKey = false; continue; }
    if (char !== '"') continue;
    const item = readString(input, i);
    if (!item.complete) return '';
    if (depth === 1 && expectingKey && item.value === key) {
      let next = item.end;
      while (/\s/.test(input[next] || '') && next < input.length) next++;
      if (input[next++] !== ':') return '';
      while (/\s/.test(input[next] || '') && next < input.length) next++;
      return input[next] === '"' ? readString(input, next).value : '';
    }
    i = item.end - 1;
  }
  return '';
}

export type AssistantStreamEvent = {
  type: 'start' | 'delta' | 'done' | 'pending' | 'error';
  threadId?: string; assistantId?: string; delta?: string;
  userMessage?: Record<string, any>; message?: Record<string, any>; thread?: Record<string, any>;
  error?: string; code?: string; contextChanged?: boolean;
};

/** Incremental SSE reader: no completed-response replay or artificial typing timer. */
export async function readAssistantStream(response: Response, onEvent: (event: AssistantStreamEvent) => void | Promise<void>) {
  if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || '대화를 연결하지 못했어요.');
    if (result.threadId) await onEvent({ type: 'start', threadId: result.threadId, thread: result.thread, userMessage: result.userMessage, assistantId: result.message?.id });
    await onEvent({ type: result.message?.status === 'pending' ? 'pending' : result.message?.status === 'failed' ? 'error' : 'done', ...result });
    return;
  }
  if (!response.body) throw new Error('응답 연결을 확인해 주세요.');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', terminal = false;
  async function consume(frame: string) {
    const text = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!text || text === '[DONE]') return;
    const event = JSON.parse(text) as AssistantStreamEvent;
    if (!['start', 'delta', 'done', 'pending', 'error'].includes(event.type)) return;
    if (['done', 'pending', 'error'].includes(event.type)) terminal = true;
    await onEvent(event);
  }
  try {
    for (;;) {
      const part = await reader.read();
      buffer += decoder.decode(part.value, { stream: !part.done });
      buffer = buffer.replace(/\r\n/g, '\n');
      if (buffer.length > 100000) throw new Error('응답 연결 형식을 확인해 주세요.');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) { const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2); await consume(frame); }
      if (part.done) { if (buffer.trim()) await consume(buffer); break; }
    }
    if (!terminal) throw new Error('응답 연결이 중단됐어요. 대화를 다시 불러올 수 있어요.');
  } finally { reader.releaseLock(); }
}
