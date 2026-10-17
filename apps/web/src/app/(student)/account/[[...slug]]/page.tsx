import { AccountPages } from '@/components/account';
export default async function Page({params}:{params:Promise<{slug?:string[]}>}) { return <AccountPages key={(await params).slug?.join('/')||'root'} slug={(await params).slug}/>; }
