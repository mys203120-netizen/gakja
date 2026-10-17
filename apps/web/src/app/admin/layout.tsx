import { redirect } from 'next/navigation';
import { getUser } from '@/lib/auth';
import { AppShell } from '@/components/app-shell';
export const dynamic = 'force-dynamic';
export default async function AdminLayout({children}:{children:React.ReactNode}) { const user=await getUser();if(!user)redirect('/login');if(user.role==='student')redirect('/my');return <AppShell admin>{children}</AppShell>; }
