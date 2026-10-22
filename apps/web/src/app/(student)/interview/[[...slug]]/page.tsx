import { screenMetadata } from '@/lib/screen-metadata';
export async function generateMetadata({ params }: { params: Promise<{ slug?: string[] }> }) {
  return screenMetadata('interview', (await params).slug);
}
import { InterviewPages } from '@/components/interview-pages';
export default async function Page({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params;
  return <InterviewPages key={slug?.join('/') || 'root'} slug={slug}/>;
}
