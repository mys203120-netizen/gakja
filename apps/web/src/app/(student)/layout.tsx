
import {ownedClassName} from '@/components/owned-class-name';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getUser } from '@/lib/auth';
import { AppShell } from '@/components/app-shell';
import { bootstrap } from '@/lib/data';
import { privateMetadata } from '@/lib/public-site';
export const metadata = privateMetadata('내 면접 준비');
export const dynamic = 'force-dynamic';
async function AuthenticatedShell({children}:{children:React.ReactNode}) {
 const user=await getUser();
 if(!user)redirect('/login');
 if(user.role!=='student')redirect('/admin');
 const initialData=await bootstrap(user);
 return <AppShell key={user.id} initialData={initialData}>{children}</AppShell>;
}
export default function StudentLayout({children}:{children:React.ReactNode}) {
 return <Suspense fallback={<div className={ownedClassName("loading",true)}>불러오는 중</div>}><AuthenticatedShell>{children}</AuthenticatedShell></Suspense>;
}
