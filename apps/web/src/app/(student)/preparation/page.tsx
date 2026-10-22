import { privateMetadata } from '@/lib/public-site';
export const metadata = privateMetadata('준비 현황');
import { PreparationOverview } from '@/components/training-hub';
export default function Page() { return <PreparationOverview/>; }
