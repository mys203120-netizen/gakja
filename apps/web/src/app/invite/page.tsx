import { privateMetadata } from '@/lib/public-site';
export const metadata = privateMetadata('초대 가입');
import { AuthScreen } from '@/components/auth-screen';
export default function Page() { return <AuthScreen mode="invite" />; }
