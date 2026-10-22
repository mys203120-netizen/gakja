import test from 'node:test';
import assert from 'node:assert/strict';
import { ANALYTICS_CONSENT_COOKIE } from '../apps/web/src/lib/analytics-model';

test('client gates tag setup and every event, overrides URL/title/referrer, and strips UI payloads', async () => {
  const previous = { mode: process.env.NODE_ENV, id: process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID, confirmed: process.env.NEXT_PUBLIC_GA_MANUAL_MEASUREMENT_CONFIRMED };
  const globals = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  const location = { pathname: '/', origin: 'https://service.example', protocol: 'https:' };
  const browser: any = { location, localStorage: { setItem() {} }, dispatchEvent() {} };
  const doc = { cookie: '', title: '학생 이름과 비밀 답변', referrer: 'https://private.example/student?email=private@example.com' };
  const requests: unknown[] = [];
  try {
    Object.assign(process.env, { NODE_ENV: 'production', NEXT_PUBLIC_GA_MEASUREMENT_ID: 'G-TEST123', NEXT_PUBLIC_GA_MANUAL_MEASUREMENT_CONFIRMED: 'true' });
    Object.assign(globalThis, { window: browser, document: doc, fetch: async (url: string, options: unknown) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ events: [{ name: 'sign_up', method: 'google', email: 'private@example.com' }, { name: 'first_answer_saved', answer: '비밀 답변' }, { name: 'unknown', private: '정보' }] }) };
    } });
    const analytics = await import('../apps/web/src/lib/analytics');
    assert.equal(analytics.initializeAnalytics('/'), null);
    analytics.trackEvent('cta_start_click', { placement: 'hero' });
    assert.equal(browser.dataLayer, undefined, 'no script queue or measurement before opt-in');
    await analytics.collectVerifiedConversions();
    assert.equal(requests.length, 0, 'no receipt request before consent');

    doc.cookie = `${ANALYTICS_CONSENT_COOKIE}=granted.${Date.now()}`;
    location.pathname = '/interview/private-student-id';
    assert.equal(analytics.initializeAnalytics(location.pathname), 'G-TEST123');
    const commands = () => browser.dataLayer.map((args: IArguments) => Array.from(args));
    const config = commands().find((args: unknown[]) => args[0] === 'config');
    assert.equal(config[2].send_page_view, false);
    assert.equal(config[2].allow_google_signals, false);
    assert.equal(config[2].allow_ad_personalization_signals, false);
    assert.equal(config[2].page_location, 'https://service.example/interview');
    assert.equal(config[2].page_title, '모의면접');
    assert.equal(config[2].page_referrer, '');
    analytics.initializeAnalytics('/interview/another-id?email=private@example.com#answer');
    assert.equal(commands().filter((args: unknown[]) => args[0] === 'event' && args[1] === 'page_view').length, 1, 'record changes do not double-count one screen');
    analytics.trackEvent('cta_start_click', { placement: 'mobile', answer: '비밀 답변', email: 'private@example.com' } as any);
    const cta = commands().find((args: unknown[]) => args[0] === 'event' && args[1] === 'cta_start_click');
    assert.equal(cta[2].placement, 'mobile');
    assert.equal(cta[2].email, undefined);
    assert.equal(cta[2].answer, undefined);
    await analytics.collectVerifiedConversions();
    assert.equal(requests.length, 0, 'blocked or unloaded Google tag cannot consume receipts');
    analytics.markAnalyticsReady();
    await analytics.collectVerifiedConversions();
    assert.equal(requests.length, 1);
    assert.equal(commands().filter((args: unknown[]) => args[1] === 'sign_up').length, 1);
    assert.equal(commands().filter((args: unknown[]) => args[1] === 'first_answer_saved').length, 1);
    assert.equal(commands().some((args: unknown[]) => args[1] === 'unknown'), false);
    const serialized = JSON.stringify(commands());
    for (const privateValue of ['private-student-id', 'another-id', 'private@example.com', '비밀 답변', doc.title, doc.referrer]) assert.equal(serialized.includes(privateValue), false, privateValue);

    const beforeExcluded = commands().filter((args: unknown[]) => args[0] === 'event').length;
    location.pathname = '/auth/callback';
    assert.equal(analytics.initializeAnalytics(location.pathname), null);
    analytics.trackEvent('cta_start_click', { placement: 'hero' });
    await analytics.collectVerifiedConversions();
    assert.equal(commands().filter((args: unknown[]) => args[0] === 'event').length, beforeExcluded);
    assert.equal(browser['ga-disable-G-TEST123'], true);
    assert.equal(requests.length, 1);
    location.pathname = '/';
    analytics.setAnalyticsConsent('denied');
    assert.equal(analytics.readAnalyticsConsent(), 'denied');
    assert.equal(analytics.initializeAnalytics('/'), null);
    assert.equal(browser['ga-disable-G-TEST123'], true);
  } finally {
    if (previous.mode === undefined) delete process.env.NODE_ENV; else Object.assign(process.env, { NODE_ENV: previous.mode });
    if (previous.id === undefined) delete process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID; else process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID = previous.id;
    if (previous.confirmed === undefined) delete process.env.NEXT_PUBLIC_GA_MANUAL_MEASUREMENT_CONFIRMED; else process.env.NEXT_PUBLIC_GA_MANUAL_MEASUREMENT_CONFIRMED = previous.confirmed;
    Object.assign(globalThis, globals);
  }
});
