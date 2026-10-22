import test from 'node:test';
import assert from 'node:assert/strict';
import { publicIndexingAllowed, publicSiteJsonLd, publicSiteOrigin } from '../apps/web/src/lib/public-site';
import { screenMetadata } from '../apps/web/src/lib/screen-metadata';

test('public metadata uses an explicitly configured HTTPS origin and fails closed on invalid primary settings', () => {
  assert.equal(publicSiteOrigin({ APP_URL: 'https://service.example.org/', NEXT_PUBLIC_APP_URL: 'https://legacy.example.org' }), 'https://service.example.org');
  assert.equal(publicSiteOrigin({ NEXT_PUBLIC_APP_URL: 'https://service.example.org' }), 'https://service.example.org');
  for (const APP_URL of ['http://service.example.org', 'https://localhost', 'https://127.0.0.1', 'https://192.168.1.1', 'https://app.local', 'https://app.internal', 'https://app.example', 'https://app.test', 'https://name:secret@service.example.org', 'https://service.example.org/?secret=value', 'https://service.example.org/path', 'not-a-url']) {
    assert.equal(publicSiteOrigin({ APP_URL, NEXT_PUBLIC_APP_URL: 'https://legacy.example.org' }), undefined, APP_URL);
  }
  assert.equal(publicSiteOrigin({}), undefined);
});

test('only production with a public origin is eligible for indexing', () => {
  assert.equal(publicIndexingAllowed({ NODE_ENV: 'production', APP_URL: 'https://service.example.org' }), true);
  assert.equal(publicIndexingAllowed({ NODE_ENV: 'development', APP_URL: 'https://service.example.org' }), false);
  assert.equal(publicIndexingAllowed({ NODE_ENV: 'production', VERCEL_ENV: 'preview', APP_URL: 'https://service.example.org' }), false);
  assert.equal(publicIndexingAllowed({ NODE_ENV: 'production', APP_URL: 'http://localhost:3000' }), false);
});

test('structured data omits unknown operators and safely serializes a configured legal name', () => {
  assert.equal(publicSiteJsonLd({}), undefined);
  const website = JSON.parse(publicSiteJsonLd({ APP_URL: 'https://service.example.org' })!);
  assert.equal(website['@graph'].length, 1);
  assert.equal(website['@graph'][0]['@type'], 'WebSite');
  assert.equal(website['@graph'][0].publisher, undefined);
  const serialized = publicSiteJsonLd({ APP_URL: 'https://service.example.org', SITE_ORGANIZATION_NAME: '운영사 </script>' })!;
  assert.ok(!serialized.includes('</script>'));
  const graph = JSON.parse(serialized)['@graph'];
  assert.equal(graph[1].name, '운영사 </script>');
  assert.equal(graph[0].publisher['@id'], graph[1]['@id']);
  assert.equal(graph[1].logo, 'https://service.example.org/brand-logo.svg');
});

test('screen metadata describes routes without exposing route identifiers or inheriting a public canonical', () => {
  assert.equal(screenMetadata('schools', ['private-student-name', 'edit']).title, '지원 학교 수정');
  assert.equal(screenMetadata('admin', ['inquiries']).title, '문의 관리');
  assert.equal(screenMetadata('records', ['comparisons', 'private-answer']).title, '답변 비교');
  assert.equal(screenMetadata('materials', ['constructor']).title, '내 교재');
  const metadata = screenMetadata('interview', ['private-session']);
  assert.equal(metadata.title, '면접 연습');
  assert.deepEqual(metadata.robots, { index: false, follow: false, noarchive: true });
  assert.equal(metadata.alternates?.canonical, null);
  assert.ok(!JSON.stringify(metadata).includes('private-session'));
});
