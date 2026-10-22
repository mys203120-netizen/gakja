import { screenMetadata } from '@/lib/screen-metadata';
export async function generateMetadata({ params }: { params: Promise<{ slug?: string[] }> }) {
  return screenMetadata('on', (await params).slug);
}
import { ChatPages } from '@/components/chat';
export default async function Page({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params;
  return <ChatPages key={slug?.join('/') || 'root'} slug={slug}/>;
}
