import type { Metadata, Viewport } from 'next';
import { ScrollBehavior } from '@/components/scroll-behavior';
import './globals.css';
export const metadata: Metadata = { title: { default: '각자ON · 각자의답', template: '%s · 각자ON' }, description: '물음 너머에는 각자의 답이 있습니다.', icons: { icon: '/brand-logo.svg' }, robots: { index: false, follow: false } };
export const viewport: Viewport = { width:'device-width', initialScale:1, viewportFit:'cover', interactiveWidget:'resizes-content', themeColor:'#F7F8FA' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="ko"><body>{children}<ScrollBehavior/></body></html>; }
