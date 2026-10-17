import { AdminPages } from '@/components/admin';
export default async function Page({params}:{params:Promise<{slug?:string[]}>}) { return <AdminPages key={(await params).slug?.join('/')||'root'} slug={(await params).slug}/>; }
