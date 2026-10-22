import { screenMetadata } from '@/lib/screen-metadata';
export async function generateMetadata({ params }: { params: Promise<{ slug?: string[] }> }) {
  return screenMetadata('materials', (await params).slug);
}
import { Materials } from '@/components/materials';
export default async function Page({params}:{params:Promise<{slug?:string[]}>}) { return <Materials key={(await params).slug?.join('/')||'root'} slug={(await params).slug}/>; }
