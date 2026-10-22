import { privateMetadata } from '@/lib/public-site';
export const metadata = privateMetadata('로그인');
import { AuthScreen } from '@/components/auth-screen';
export default function Page() { return <AuthScreen />; }
