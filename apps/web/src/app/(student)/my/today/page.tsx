import { privateMetadata } from '@/lib/public-site';
export const metadata = privateMetadata('오늘 학습');
import { TodayLearning } from '@/components/today-learning';
export default function Page() { return <TodayLearning/>; }
