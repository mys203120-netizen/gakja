import { privateMetadata } from '@/lib/public-site';
export const metadata = privateMetadata('훈련 시작');
import {TrainingRun} from '@/components/training-run';
export default function Page(){return <TrainingRun/>;}
