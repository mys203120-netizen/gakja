import { privateMetadata } from '@/lib/public-site';
export const metadata = privateMetadata('마이 대시보드');
import { PreparationDashboard } from '@/components/preparation-dashboard';
export default function Page() { return <PreparationDashboard/>; }
