import { RecordsPages } from '@/components/records';
export default async function Page({params}:{params:Promise<{slug?:string[]}>}) {
  const {slug}=await params;return <RecordsPages key={slug?.join('/')||'root'} slug={slug}/>;
}
