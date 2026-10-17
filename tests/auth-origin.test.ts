import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAppOrigin } from '../apps/web/src/lib/auth-origin';

test('server APP_URL takes precedence over the public build URL and untrusted Host', () => {
  const request = new Request('http://0.0.0.0:3127/api/auth/google/start?next=https://evil.test', { headers: { host: 'evil.test' } });
  assert.equal(resolveAppOrigin(request, { NODE_ENV: 'production', APP_URL: 'https://app.example', NEXT_PUBLIC_APP_URL: 'http://localhost:3000' }), 'https://app.example');
});

test('legacy public origin is read at runtime after importing the resolver', () => {
  const oldPublic = process.env.NEXT_PUBLIC_APP_URL, oldPrivate = process.env.APP_URL;
  try {
    delete process.env.APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
    assert.equal(resolveAppOrigin(new Request('http://localhost:3127')), 'http://localhost:3000');
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3127';
    assert.equal(resolveAppOrigin(new Request('http://localhost:3127')), 'http://localhost:3127');
    process.env.APP_URL = 'https://runtime.example';
    assert.equal(resolveAppOrigin(new Request('http://localhost:3127')), 'https://runtime.example');
  } finally {
    if (oldPublic === undefined) delete process.env.NEXT_PUBLIC_APP_URL; else process.env.NEXT_PUBLIC_APP_URL = oldPublic;
    if (oldPrivate === undefined) delete process.env.APP_URL; else process.env.APP_URL = oldPrivate;
  }
});

test('production without an explicit origin fails closed instead of trusting Host', () => {
  assert.throws(() => resolveAppOrigin(new Request('https://evil.test'), { NODE_ENV: 'production' }), /missing_app_origin/);
});

test('invalid canonical URLs are rejected without falling back to the request host', () => {
  for (const APP_URL of ['not-a-url', 'javascript:alert(1)', 'file:///tmp/test', 'https://name:secret@app.example', '//evil.test']) {
    assert.throws(() => resolveAppOrigin(new Request('https://app.example'), { APP_URL, NEXT_PUBLIC_APP_URL: 'https://fallback.example' }));
  }
});

test('local dynamically selected ports and IPv6 origins remain compatible', () => {
  assert.equal(resolveAppOrigin(new Request('http://0.0.0.0:3100', { headers: { host: 'localhost:3100' } }), { NODE_ENV: 'development' }), 'http://localhost:3100');
  assert.equal(resolveAppOrigin(new Request('http://[::1]:3127'), { NODE_ENV: 'test' }), 'http://[::1]:3127');
  assert.equal(resolveAppOrigin(new Request('http://localhost:3127'), { APP_URL: '  ', NEXT_PUBLIC_APP_URL: 'http://localhost:3127' }), 'http://localhost:3127');
});

test('malformed Host authorities cannot inject credentials or URL paths', () => {
  for (const host of ['evil.test/path', 'user@evil.test', 'evil.test?next=/login', 'evil.test#hash', '//evil.test']) {
    assert.throws(() => resolveAppOrigin(new Request('http://localhost:3127', { headers: { host } }), { NODE_ENV: 'development' }));
  }
});
