import { screenMetadata } from '@/lib/screen-metadata';
export async function generateMetadata({ params }: { params: Promise<{ slug?: string[] }> }) {
  return screenMetadata('knowledge', (await params).slug);
}
import { KnowledgeBites } from '@/components/knowledge-bites';
export default async function Page({params}:{params:Promise<{slug?:string[]}>}) {
  const {slug}=await params;return <KnowledgeBites key={slug?.join('/')||'root'} slug={slug}/>;
}
