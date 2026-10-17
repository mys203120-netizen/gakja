import { KnowledgeBites } from '@/components/knowledge-bites';
export default async function Page({params}:{params:Promise<{slug?:string[]}>}) {
  const {slug}=await params;return <KnowledgeBites key={slug?.join('/')||'root'} slug={slug}/>;
}
