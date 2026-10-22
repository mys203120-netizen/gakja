import { screenMetadata } from '@/lib/screen-metadata';
export async function generateMetadata({ params }: { params: Promise<{ slug?: string[] }> }) {
  return screenMetadata('admin', (await params).slug);
}
import { AdminPages } from '@/components/admin';
export default async function Page({params}:{params:Promise<{slug?:string[]}>}) { return <AdminPages key={(await params).slug?.join('/')||'root'} slug={(await params).slug}/>; }
