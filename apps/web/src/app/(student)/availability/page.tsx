import { privateMetadata } from '@/lib/public-site';
export const metadata = privateMetadata('훈련 가능 시간');
import {TrainingAvailability} from '@/components/training-availability';
export default async function Page({searchParams}:{searchParams:Promise<{onboarding?:string}>}){
  const params=await searchParams;
  return <TrainingAvailability onboarding={params.onboarding==='1'}/>;
}
