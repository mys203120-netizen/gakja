import {privateMetadata} from '@/lib/public-site';
import {TodayTraining} from '@/components/training-hub';

export const metadata=privateMetadata('훈련하기');
export default function Page(){return <TodayTraining/>;}
