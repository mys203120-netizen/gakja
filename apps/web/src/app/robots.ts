import type { MetadataRoute } from 'next';
import { publicIndexingAllowed, publicSiteOrigin } from '@/lib/public-site';

export default function robots(): MetadataRoute.Robots {
  const origin = publicSiteOrigin();
  if (!publicIndexingAllowed() || !origin) return { rules: { userAgent: '*', disallow: '/' } };
  // Private screens expose noindex through metadata. Do not block that directive.
  return { rules: { userAgent: '*', allow: '/', disallow: '/api/' }, sitemap: `${origin}/sitemap.xml`, host: origin };
}
