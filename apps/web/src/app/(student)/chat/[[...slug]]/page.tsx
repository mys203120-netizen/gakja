import { screenMetadata } from '@/lib/screen-metadata';
export async function generateMetadata({ params }: { params: Promise<{ slug?: string[] }> }) {
  return screenMetadata('chat', (await params).slug);
}
import { ChatPages } from '@/components/chat';
export default async function Page({params}:{params:Promise<{slug?:string[]}>}) { return <ChatPages key={(await params).slug?.join('/')||'root'} slug={(await params).slug}/>; }
