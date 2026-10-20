
import {ownedClassName} from '@/components/owned-class-name';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getUser } from '@/lib/auth';
import { AppShell } from '@/components/app-shell';
export const dynamic = 'force-dynamic';
export default async function StudentLayout({children}:{children:React.ReactNode}) { const user = await getUser(); if(!user)redirect('/login'); if(user.role!=='student')redirect('/admin'); return <Suspense fallback={<div className={ownedClassName("loading",true)}>불러오는 중</div>}><AppShell>{children}</AppShell></Suspense>; }
