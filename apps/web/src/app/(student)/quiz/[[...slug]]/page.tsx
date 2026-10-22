import { screenMetadata } from '@/lib/screen-metadata';
export async function generateMetadata({ params }: { params: Promise<{ slug?: string[] }> }) {
  return screenMetadata('quiz', (await params).slug);
}
import { QuizPages } from '@/components/practice';
export default async function Page({params}:{params:Promise<{slug?:string[]}>}) {
  const {slug}=await params;return <QuizPages key={slug?.join('/')||'root'} slug={slug}/>;
}
