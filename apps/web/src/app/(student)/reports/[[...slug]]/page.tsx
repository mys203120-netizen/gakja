import { screenMetadata } from '@/lib/screen-metadata';
export async function generateMetadata({ params }: { params: Promise<{ slug?: string[] }> }) {
  return screenMetadata('reports', (await params).slug);
}
import { RecordsPages } from '@/components/records';
export default async function Page({params}:{params:Promise<{slug?:string[]}>}) {
  const {slug}=await params;return <RecordsPages key={slug?.join('/')||'root'} slug={slug}/>;
}
