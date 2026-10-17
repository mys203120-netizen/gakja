import { InterviewPages } from '@/components/interview-pages';
export default async function Page({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params;
  return <InterviewPages key={slug?.join('/') || 'root'} slug={slug}/>;
}
