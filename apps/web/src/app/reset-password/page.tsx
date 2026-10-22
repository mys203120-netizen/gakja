import { privateMetadata } from '@/lib/public-site';
export const metadata = privateMetadata('비밀번호 재설정');
import { AuthScreen } from '@/components/auth-screen';
export default function Page() { return <AuthScreen mode="reset-password" />; }
