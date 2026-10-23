import { privateMetadata } from '@/lib/public-site';
export const metadata = privateMetadata('홈');
import { HomeGateway } from '@/components/home-gateway';
export default function Page() { return <HomeGateway/>; }
