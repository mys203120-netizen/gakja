import { privateMetadata } from '@/lib/public-site';
export const metadata = privateMetadata('진단 훈련');
import {TrainingRun} from '@/components/training-run';
export default function Page(){return <TrainingRun diagnostic/>;}
