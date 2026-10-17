import { SchoolPages } from '@/components/schools';
export default async function Page({params}:{params:Promise<{slug?:string[]}>}) { const {slug=[]}=await params;return <SchoolPages key={slug.join('/')||'list'} slug={slug}/>; }
