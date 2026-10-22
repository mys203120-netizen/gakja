import type { Metadata } from 'next';

export const SITE_NAME = '각자ON';
export const SITE_TITLE = '각자ON · 각자의답';
export const SITE_DESCRIPTION = '생활기록부 속 경험을 정리하고, 나에게 맞는 질문과 글·음성 면접 연습으로 답변을 준비하세요.';

/** Share and search URLs always use the deployment's configured public origin. */
export function publicSiteOrigin(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = environment.APP_URL?.trim() || environment.NEXT_PUBLIC_APP_URL?.trim();
  if (!configured) return undefined;
  try {
    const url = new URL(configured);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') return undefined;
    if (!host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':') || /(^|\.)(localhost|local|internal|example|test|invalid)$/.test(host)) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export function publicIndexingAllowed(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.NODE_ENV === 'production' && environment.VERCEL_ENV !== 'preview' && Boolean(publicSiteOrigin(environment));
}

export function publicMetadata(path: string, title: string, description: string): Metadata {
  const origin = publicSiteOrigin();
  const url = origin ? new URL(path, origin).toString() : undefined;
  const shareTitle = title === SITE_TITLE ? title : `${title} · ${SITE_NAME}`;
  return {
    title: title === SITE_TITLE ? { absolute: title } : title,
    description,
    ...(url ? { alternates: { canonical: url } } : {}),
    robots: { index: publicIndexingAllowed(), follow: true },
    openGraph: {
      type: 'website', locale: 'ko_KR', siteName: SITE_NAME,
      title: shareTitle, description, ...(url ? { url } : {}),
      images: [{ url: '/opengraph-image', width: 1200, height: 630, alt: `${SITE_NAME} · 나의 경험으로 준비하는 면접` }],
    },
    twitter: {
      card: 'summary_large_image', title: shareTitle, description,
      images: [{ url: '/opengraph-image', alt: `${SITE_NAME} · 나의 경험으로 준비하는 면접` }],
    },
  };
}

/** Private titles describe screens only; never use names, answer text, or IDs. */
export function privateMetadata(title: string): Metadata {
  return { title, alternates: { canonical: null }, robots: { index: false, follow: false, noarchive: true } };
}

export function publicSiteJsonLd(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const origin = publicSiteOrigin(environment);
  if (!origin) return undefined;
  const organizationName = environment.SITE_ORGANIZATION_NAME?.trim();
  const organizationId = `${origin}/#organization`;
  const graph: Record<string, unknown>[] = [{
    '@type': 'WebSite', '@id': `${origin}/#website`, url: `${origin}/`,
    name: SITE_NAME, alternateName: '각자의답', inLanguage: 'ko-KR', description: SITE_DESCRIPTION,
    ...(organizationName ? { publisher: { '@id': organizationId } } : {}),
  }];
  // Configure the verified legal operator; the product name alone is not evidence.
  if (organizationName) graph.push({
    '@type': 'Organization', '@id': organizationId, name: organizationName,
    url: `${origin}/`, logo: `${origin}/brand-logo.svg`,
  });
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c');
}
