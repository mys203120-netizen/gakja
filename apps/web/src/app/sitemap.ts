import type { MetadataRoute } from 'next';
import { publicIndexingAllowed, publicSiteOrigin } from '@/lib/public-site';
import { privacyConfig } from '@/lib/support-config';

export default function sitemap(): MetadataRoute.Sitemap {
  const origin = publicSiteOrigin();
  if (!publicIndexingAllowed() || !origin) return [];
  const paths = ['/', '/faq', '/contact', ...(privacyConfig().ready ? ['/privacy'] : [])];
  return paths.map(path => ({ url: `${origin}${path}` }));
}
