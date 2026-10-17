import assert from 'node:assert/strict';
import { tsImport } from 'tsx/esm/api';

const { createClientRequestCache } = await tsImport('../apps/web/src/lib/client/request-cache.ts', import.meta.url);
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
let checks = 0;
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const ok = (actual, message) => { assert.ok(actual, message); checks++; };
function fixture(settings = {}) {
  let time = 0, owner = 'harin', handler = null;
  const calls = [];
  const cache = createClientRequestCache({ enabled: () => true, origin: () => 'http://localhost:3100', now: () => time, ...settings, fetcher: async (url, init) => {
    calls.push({ url, init });
    if (handler) { const response = await handler(url, init); if (response) return response; }
    return json(url === '/api/bootstrap' ? { user: owner ? { id: owner } : null } : { owner, url, sequence: calls.length, nested: { saved: true } });
  } });
  return { ...cache, calls, setHandler(value) { handler = value; }, setOwner(value) { owner = value; }, advance(value) { time += value; }, async ready() { await cache.request('/api/bootstrap'); calls.length = 0; } };
}

// No student data may be reused until the uncached bootstrap establishes its owner.
{
  const c = fixture(); await c.request('/api/learning'); await c.request('/api/learning');
  equal(c.calls.length, 2, 'unknown identity is never cached');
  await c.ready();
  const paths = ['/api/learning', '/api/planner', '/api/study-sessions', '/api/knowledge-bites?targetId=uos', '/api/quiz?targetId=uos&sourceVersion=6&sourceType=personal', '/api/schools?targetId=uos'];
  const dashboard = new AbortController(), today = new AbortController();
  const result = await Promise.all([...paths.map(path => c.request(path, { signal: dashboard.signal })), ...paths.map(path => c.request(path, { signal: today.signal }))]);
  equal(c.calls.length, 6, 'dashboard and today share six concurrent reads instead of twelve');
  ok(result[0] !== result[6] && result[0].nested !== result[6].nested, 'deduplicated consumers receive independent data');
  result[0].nested.saved = false;
  equal((await c.request(paths[0])).nested.saved, true, 'component mutation cannot corrupt the saved value');
  await Promise.all(paths.map(path => c.request(path)));
  equal(c.calls.length, 6, 'same-tab page revisits reuse fresh reads');
  ok(c.calls.every(call => call.init.cache === 'no-store'), 'all network requests bypass HTTP caches');
  c.advance(5_001); await c.request('/api/study-sessions');
  equal(c.calls.length, 7, 'changing active study state has a five-second maximum lifetime');
  c.advance(10_000); await c.request('/api/learning');
  equal(c.calls.length, 8, 'private read TTL expires at fifteen seconds');
  await c.request('/api/schools?targetId=uos'); equal(c.calls.length, 8, 'school data has a bounded one-minute lifetime');
  c.advance(45_000); await c.request('/api/schools?targetId=uos'); equal(c.calls.length, 9, 'school TTL also expires');
}

// Scope keys retain every target, publication version, activity and filter.
{
  const c = fixture(); await c.ready();
  const paths = ['/api/quiz?targetId=uos&sourceType=personal&sourceVersion=6', '/api/quiz?targetId=uos&sourceType=personal&sourceVersion=7', '/api/quiz?targetId=other&sourceType=personal&sourceVersion=6', '/api/quiz?targetId=uos&sourceType=common&sourceVersion=6', '/api/quiz?targetId=uos&sourceType=personal&sourceVersion=6&activityId=a1'];
  await Promise.all(paths.map(path => c.request(path))); await Promise.all(paths.map(path => c.request(path)));
  equal(c.calls.length, paths.length, 'target and source versions never borrow another combination');
  const alwaysFresh = ['/api/quiz?sessionId=active', '/api/quiz?recordingId=private-audio', '/api/quiz?unrecognized=future-state', '/api/study-sessions?id=frozen-report', '/api/knowledge-bites?videoId=history', '/api/interviews?id=live', '/api/reports?id=report', '/api/chat?threadId=chat', '/api/learning-help?questionId=q1'];
  await Promise.all(alwaysFresh.flatMap(path => [c.request(path), c.request(path)]));
  equal(c.calls.length, paths.length + alwaysFresh.length * 2, 'sessions, media, report detail, chat and evidence bypass caching');
  await c.request('/api/schools/catalog?schoolId=uos'); await c.request('/api/schools/catalog?schoolId=uos');
  equal(c.calls.length, paths.length + alwaysFresh.length * 2 + 1, 'registered school catalog is eligible');
}

// Each mounted page can cancel its subscription without cancelling shared work.
{
  const c = fixture(); await c.ready(); const gate = deferred();
  c.setHandler(url => url === '/api/learning' ? gate.promise : null);
  const controller = new AbortController(), normalController = new AbortController();
  const cancelled = c.request('/api/learning', { signal: controller.signal }).catch(error => error.name);
  const normal = c.request('/api/learning', { signal: normalController.signal }); controller.abort();
  equal(await cancelled, 'AbortError', 'the cancelled page stops awaiting its own subscription');
  const lateSubscriber = c.request('/api/learning', { signal: new AbortController().signal });
  equal(c.calls.length, 1, 'an aborted first subscriber does not evict pending shared work');
  equal(c.calls[0].init.signal, undefined, 'shared eligible GET has no subscriber-owned native signal');
  gate.resolve(json({ owner: 'harin', valid: true }));
  equal((await normal).valid, true, 'another component still receives its response');
  equal((await lateSubscriber).valid, true, 'a later subscriber joins the same unfinished work');
  equal(c.calls.length, 1, 'signalled subscribers share one request');
  equal((await c.request('/api/learning')).valid, true, 'cancelled request cannot replace the shared value');
  const alreadyAborted = new AbortController(); const reason = new DOMException('page disposed', 'AbortError'); alreadyAborted.abort(reason);
  await assert.rejects(c.request('/api/learning', { signal: alreadyAborted.signal }), error => error === reason); checks++;
  equal(c.calls.length, 1, 'already-aborted cache hits reject without starting a request');
  const cacheHitController = new AbortController(); const cacheHit = c.request('/api/learning', { signal: cacheHitController.signal }).catch(error => error.name);
  cacheHitController.abort(); equal(await cacheHit, 'AbortError', 'cache-hit delivery still honors cancellation before its microtask');
}

// Listener lifetimes and timeouts belong to the consumer, including failure paths.
{
  const c = fixture(); await c.ready();
  const instrument = () => {
    const controller = new AbortController(); let added = 0, removed = 0;
    const add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = (...args) => { if (args[0] === 'abort') added++; return add(...args); };
    controller.signal.removeEventListener = (...args) => { if (args[0] === 'abort') removed++; return remove(...args); };
    return { controller, counts: () => [added, removed] };
  };
  const success = instrument(); await c.request('/api/learning', { signal: success.controller.signal });
  equal(success.counts(), [1, 1], 'successful shared reads detach their abort listener');
  const cached = instrument(); await c.request('/api/learning', { signal: cached.controller.signal });
  equal(cached.counts(), [1, 1], 'cache hits also release their listener');
  const error = instrument(); c.setHandler(url => url === '/api/planner' ? json({ error: 'temporary failure' }, 503) : null);
  await assert.rejects(c.request('/api/planner', { signal: error.controller.signal }), /temporary failure/); checks++;
  equal(error.counts(), [1, 1], 'failed shared reads detach their listener');
  const gate = deferred(); c.setHandler(url => url === '/api/quiz' ? gate.promise : null);
  const aborted = instrument(); const abortedRead = c.request('/api/quiz', { signal: aborted.controller.signal }).catch(reason => reason.name);
  aborted.controller.abort(); equal(await abortedRead, 'AbortError', 'cancelled subscriber rejects promptly before shared fetch completes');
  equal(aborted.counts(), [1, 1], 'cancelled subscribers explicitly detach their listener');
  const timeout = AbortSignal.timeout(5);
  const timedOut = c.request('/api/quiz', { signal: timeout }).catch(reason => reason);
  const survivor = c.request('/api/quiz', { signal: new AbortController().signal });
  const timer = setTimeout(() => gate.resolve(json({ shared: 'completed after consumer timeout' })), 15);
  equal((await timedOut).name, 'TimeoutError', 'real AbortSignal timeout reason is preserved');
  equal((await survivor).shared, 'completed after consumer timeout', 'consumer timeout never cancels another page'); clearTimeout(timer);
  equal(c.calls.filter(call => call.url === '/api/quiz').length, 1, 'timeout and cancelled subscribers still use one shared network call');
  equal((await c.request('/api/quiz')).shared, 'completed after consumer timeout', 'valid response can warm cache after another consumer times out');
}

// Mutable details and explicit uncached requests still retain native cancellation.
{
  const c = fixture(); await c.ready();
  c.setHandler((url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })));
  for (const url of ['/api/quiz?sessionId=active', '/api/interviews?id=live', '/api/study-sessions?id=frozen-report']) {
    const controller = new AbortController(); const pending = c.request(url, { signal: controller.signal }).catch(error => error.name);
    equal(c.calls.at(-1).init.signal, controller.signal, 'uncacheable active/detail request forwards its native AbortSignal');
    controller.abort(); equal(await pending, 'AbortError', 'native cancellation remains intact for mutable data');
  }
}

// Both sides of every write invalidate; late old reads cannot resurrect old values.
{
  const c = fixture(); await c.ready(); const old = deferred(), write = deferred(), middle = deferred(); let learningCalls = 0;
  c.setHandler((url, init) => {
    if (url === '/api/actions') return write.promise;
    if (url === '/api/learning') return ++learningCalls === 1 ? old.promise : learningCalls === 2 ? middle.promise : json({ fresh: true });
  });
  const before = c.request('/api/learning');
  const mutation = c.request('/api/actions', { method: 'POST', body: JSON.stringify({ action: 'save' }) });
  const during = c.request('/api/learning');
  equal(learningCalls, 2, 'mutation invalidates the earlier inflight map before it starts');
  write.resolve(json({ saved: true })); await mutation;
  const after = await c.request('/api/learning');
  old.resolve(json({ stale: 'before' })); middle.resolve(json({ stale: 'during' })); await Promise.all([before, during]);
  equal(after, { fresh: true }, 'first post-write read sees new data');
  equal(await c.request('/api/learning'), { fresh: true }, 'neither old read repopulates the new generation');
  equal(learningCalls, 3, 'post-write cached data remains reusable');
  c.setHandler((url) => url === '/api/actions' ? json({ error: 'write failed' }, 500) : null);
  await assert.rejects(c.request('/api/actions', { method: 'POST', body: '{}' }), /write failed/); checks++;
  await c.request('/api/learning'); equal(c.calls.filter(call => call.url === '/api/learning').length, 4, 'failed writes also clear possibly stale data');
}

// Logout/login discard identity before the request and after success or failure.
{
  const c = fixture(); await c.ready(); await c.request('/api/learning'); const old = deferred();
  c.setHandler(url => url === '/api/planner' ? old.promise : null);
  const oldStudent = c.request('/api/planner').catch(error => error.name);
  await c.request('/api/auth', { method: 'POST', body: '{"action":"logout"}' });
  c.setOwner('another-student'); c.setHandler(null);
  await c.request('/api/learning'); await c.request('/api/learning');
  equal(c.calls.filter(call => call.url === '/api/learning').length, 3, 'no private cache between auth mutation and new bootstrap');
  await c.request('/api/auth', { method: 'POST', body: '{"action":"login"}' }); await c.request('/api/bootstrap');
  const fresh = await c.request('/api/learning'); old.resolve(json({ owner: 'harin' }));
  equal(await oldStudent, 'AbortError', 'old student response cannot reach a consumer after identity changes');
  equal(fresh.owner, 'another-student', 'new student data is isolated');
  equal((await c.request('/api/learning')).owner, 'another-student', 'old inflight data cannot reappear');
  const count = c.calls.length; await c.request('/api/bootstrap'); await c.request('/api/learning');
  equal(c.calls.length, count + 2, 'explicit shell refresh forces fresh dependent data');
  c.setOwner(null); await c.request('/api/bootstrap'); await c.request('/api/learning'); await c.request('/api/learning');
  equal(c.calls.slice(-2).map(call => call.url), ['/api/learning', '/api/learning'], 'anonymous bootstrap clears authenticated scope');
}

// A cached success must never hide a subsequent error or survive a lost session.
{
  const c = fixture(); await c.ready(); let attempts = 0;
  c.setHandler(url => url === '/api/learning' ? ++attempts === 1 ? json({ error: 'try again' }, 503) : json({ ok: true }) : null);
  await assert.rejects(c.request('/api/learning'), /try again/); checks++;
  equal(await c.request('/api/learning'), { ok: true }, 'errors are not cached'); equal(attempts, 2, 'error retries reach the server');
  c.setHandler(url => url === '/api/reports' ? json({ error: 'session ended' }, 401) : null);
  await assert.rejects(c.request('/api/reports'), /session ended/); checks++;
  c.setHandler(null); const before = c.calls.length; await c.request('/api/learning'); await c.request('/api/learning');
  equal(c.calls.length, before + 2, '401 removes all private cache and authentication identity');
  await c.ready();
  c.setHandler(url => url === '/api/learning' ? new Response('broken json', { status: 200 }) : null);
  await assert.rejects(c.request('/api/learning')); checks++;
  c.setHandler(null); equal((await c.request('/api/learning')).owner, 'harin', 'invalid JSON also cannot be retained');
}

// Opt-out semantics, custom credentials, SSR and memory bounds prevent accidental reuse.
{
  const c = fixture({ maxEntries: 2 }); await c.ready();
  for (const options of [{ cache: 'no-store' }, { cache: 'reload' }, { headers: { Authorization: 'Bearer fixture' } }, { credentials: 'omit' }]) {
    const before = c.calls.length; await c.request('/api/learning', options); await c.request('/api/learning', options);
    equal(c.calls.length, before + 2, 'explicit fresh/alternate credential reads do not enter memory cache');
  }
  await c.request('/api/learning'); await c.request('/api/planner'); await c.request('/api/schools');
  const before = c.calls.length; await c.request('/api/learning'); equal(c.calls.length, before + 1, 'oldest entries are evicted at the memory bound');
  c.setHandler(url => url === '/api/quiz' ? json({ text: 'x'.repeat(300_000) }) : null);
  const largeBefore = c.calls.length; await c.request('/api/quiz'); await c.request('/api/quiz'); equal(c.calls.length, largeBefore + 2, 'large payloads do not accumulate in memory');
  const foreignBefore = c.calls.length; await c.request('https://other.example/api/learning'); await c.request('https://other.example/api/learning'); equal(c.calls.length, foreignBefore + 2, 'foreign origins cannot enter the authenticated cache');
  const server = fixture({ enabled: () => false }); await server.ready(); await server.request('/api/learning'); await server.request('/api/learning');
  equal(server.calls.length, 2, 'server rendering never shares process-wide student data');
}

console.log(`Client request cache: ${checks} assertions passed; six shared page reads require six requests instead of twelve; auth isolation, TTL, write races, abort isolation, uncached mutable details and bounded memory verified without network or database access.`);
