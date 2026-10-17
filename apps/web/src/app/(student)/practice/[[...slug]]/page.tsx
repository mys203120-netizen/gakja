import { PracticePages } from '@/components/practice';
export default async function Page({params}:{params:Promise<{slug?:string[]}>}) { return <PracticePages key={(await params).slug?.join('/')||'root'} slug={(await params).slug}/>; }
