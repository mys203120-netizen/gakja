import { ChatPages } from '@/components/chat';
export default async function Page({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params;
  return <ChatPages key={slug?.join('/') || 'root'} slug={slug}/>;
}
