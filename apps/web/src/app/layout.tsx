import type { Metadata, Viewport } from 'next';
import { Analytics } from '@/components/analytics';
import { ScrollBehavior } from '@/components/scroll-behavior';
import { publicMetadata, publicSiteOrigin, SITE_DESCRIPTION, SITE_TITLE } from '@/lib/public-site';
import './globals.css';
export const metadata: Metadata = {
  ...publicMetadata('/', SITE_TITLE, SITE_DESCRIPTION),
  metadataBase: new URL(publicSiteOrigin() || 'http://localhost:3000'),
  title: { default: SITE_TITLE, template: '%s · 각자ON' },
  icons: { icon: '/brand-logo.svg' },
};
export const viewport: Viewport = { width:'device-width', initialScale:1, viewportFit:'cover', interactiveWidget:'resizes-content', themeColor:'#F7F8FA' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="ko"><body>{children}<ScrollBehavior/><Analytics/></body></html>; }
