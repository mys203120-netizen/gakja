import { RecordsPages } from '@/components/records';
export default async function Page({params}:{params:Promise<{slug?:string[]}>}) { return <RecordsPages key={(await params).slug?.join('/')||'root'} slug={(await params).slug}/>; }
