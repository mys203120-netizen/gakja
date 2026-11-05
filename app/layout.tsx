import type { Metadata } from 'next';
import '@fontsource-variable/noto-sans-kr';
import './globals.css';

export const metadata: Metadata = { title: '모의면접 | 각자의답', description: '서울시립대학교 융합응용화학과 모의면접' };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="ko"><body>{children}</body></html>;
}
