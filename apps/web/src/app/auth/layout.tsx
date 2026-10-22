import { privateMetadata } from '@/lib/public-site';

export const metadata = privateMetadata('인증');

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return children;
}
