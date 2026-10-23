import {privateMetadata} from '@/lib/public-site';
import {StudentDocument} from '@/components/student-document';
export const metadata=privateMetadata('생기부');
export default async function Page({searchParams}:{searchParams:Promise<{onboarding?:string}>}){const params=await searchParams;return <StudentDocument onboarding={params.onboarding==='1'}/>;}
