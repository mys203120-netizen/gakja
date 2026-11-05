import type { Metadata, Viewport } from 'next';

export const metadata: Metadata = { title: '나의 학습 공간 | 각자의답', description: '나의 기록에서, 나다운 답으로. 각자의답 학습 공간.' };
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', interactiveWidget: 'resizes-content', themeColor: '#171717' };

export default function W0Layout({ children }: { children: React.ReactNode }) { return children; }
