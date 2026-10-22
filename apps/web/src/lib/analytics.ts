'use client';

import { ANALYTICS_CONSENT_COOKIE, ANALYTICS_CONSENT_EVENT, ANALYTICS_CONSENT_MAX_AGE, analyticsConfigured, analyticsConsent, analyticsScreen, safeConversionReceipt, type AnalyticsConsent } from './analytics-model';

type Gtag = (...args: unknown[]) => void;
type AnalyticsWindow = Window & { dataLayer?: unknown[]; gtag?: Gtag; [key: `ga-disable-${string}`]: boolean };
const measurementId = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID || '';
let initialized = false;
let tagReady = false;
let lastPage: string | null = null;
let conversionsPending = false;

export function analyticsEnabled(): boolean {
  return analyticsConfigured({ mode: process.env.NODE_ENV, measurementId, manualMeasurementConfirmed: process.env.NEXT_PUBLIC_GA_MANUAL_MEASUREMENT_CONFIRMED });
}

export function readAnalyticsConsent(): AnalyticsConsent {
  if (typeof document === 'undefined') return 'unset';
  const value = document.cookie.split('; ').find(cookie => cookie.startsWith(ANALYTICS_CONSENT_COOKIE + '='))?.slice(ANALYTICS_CONSENT_COOKIE.length + 1);
  return analyticsConsent(value);
}

function permitted() {
  return typeof window !== 'undefined' && analyticsEnabled() && readAnalyticsConsent() === 'granted' && analyticsScreen(window.location.pathname) !== null;
}

function gaWindow() { return window as unknown as AnalyticsWindow; }
function safePage(pathname: string) {
  const screen = analyticsScreen(pathname);
  if (!screen) return null;
  return { page_location: window.location.origin + screen.path, page_path: screen.path, page_title: screen.title, page_referrer: '' };
}

export function setAnalyticsConsent(consent: 'granted' | 'denied') {
  document.cookie = `${ANALYTICS_CONSENT_COOKIE}=${consent === 'granted' ? 'granted.' + Date.now() : 'denied'}; Path=/; Max-Age=${ANALYTICS_CONSENT_MAX_AGE}; SameSite=Lax${window.location.protocol === 'https:' ? '; Secure' : ''}`;
  try { window.localStorage.setItem(ANALYTICS_CONSENT_COOKIE, String(Date.now())); } catch { /* Cookie preference remains available when storage is restricted. */ }
  if (consent === 'denied') disableAnalytics();
  window.dispatchEvent(new Event(ANALYTICS_CONSENT_EVENT));
}

export function disableAnalytics() {
  if (typeof window === 'undefined') return;
  gaWindow()[`ga-disable-${measurementId}`] = true;
  lastPage = null;
  // Keep the tag disabled before consent mode changes: no cookieless pings.
  if (initialized) gaWindow().gtag?.('consent', 'update', { analytics_storage: 'denied', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
}

export function initializeAnalytics(pathname: string): string | null {
  if (!permitted()) { disableAnalytics(); return null; }
  const page = safePage(pathname);
  if (!page) return null;
  const target = gaWindow();
  target[`ga-disable-${measurementId}`] = false;
  target.dataLayer ||= [];
  target.gtag ||= function () { target.dataLayer!.push(arguments); };
  if (!initialized) {
    target.gtag('consent', 'default', { analytics_storage: 'denied', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
    target.gtag('js', new Date());
    target.gtag('set', { ...page, allow_google_signals: false, allow_ad_personalization_signals: false });
    target.gtag('consent', 'update', { analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
    target.gtag('config', measurementId, { ...page, send_page_view: false, allow_google_signals: false, allow_ad_personalization_signals: false });
    initialized = true;
  } else {
    target.gtag('set', page);
    target.gtag('consent', 'update', { analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
  }
  // Query/hash changes and record IDs in one screen do not duplicate pageviews.
  if (lastPage !== page.page_path) {
    target.gtag('event', 'page_view', { ...page, send_to: measurementId });
    lastPage = page.page_path;
  }
  return measurementId;
}

export function markAnalyticsReady() { tagReady = true; }

/** Only the CTA event is callable by UI actions; conversions require server receipts. */
export function trackEvent(name: 'cta_start_click', params: { placement: 'hero' | 'mobile' }): void {
  if (name !== 'cta_start_click' || !params || !['hero', 'mobile'].includes(params.placement) || !permitted()) return;
  if (!initializeAnalytics(window.location.pathname)) return;
  gaWindow().gtag?.('event', name, { placement: params.placement, ...safePage(window.location.pathname), send_to: measurementId });
}

export async function collectVerifiedConversions() {
  if (!permitted()) { disableAnalytics(); return; }
  if (!initialized || !tagReady || conversionsPending) return;
  conversionsPending = true;
  try {
    const response = await fetch('/api/analytics/conversions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) return;
    const result = await response.json();
    if (!permitted() || !Array.isArray(result.events)) return;
    for (const value of result.events) {
      const event = safeConversionReceipt(value);
      if (!event) continue;
      gaWindow().gtag?.('event', event.name, { ...(event.method ? { method: event.method } : {}), ...safePage(window.location.pathname), send_to: measurementId });
    }
  } catch { /* Analytics never interrupts account or learning actions. */ }
  finally { conversionsPending = false; }
}
