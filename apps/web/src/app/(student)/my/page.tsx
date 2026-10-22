import { privateMetadata } from '@/lib/public-site';
export const metadata = privateMetadata('오늘 훈련');
import { TodayTraining } from '@/components/training-hub';
export default function Page() { return <TodayTraining/>; }
