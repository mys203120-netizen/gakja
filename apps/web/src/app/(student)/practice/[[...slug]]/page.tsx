import { screenMetadata } from '@/lib/screen-metadata';
export async function generateMetadata({ params }: { params: Promise<{ slug?: string[] }> }) {
  return screenMetadata('practice', (await params).slug);
}
import { PracticePages } from '@/components/practice';
export default async function Page({params}:{params:Promise<{slug?:string[]}>}) { return <PracticePages key={(await params).slug?.join('/')||'root'} slug={(await params).slug}/>; }
