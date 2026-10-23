import {redirect} from 'next/navigation';
import {requireUser} from '@/lib/auth';
import {StudentDocumentGuidelines} from '@/components/student-document-guidelines';
import {privateMetadata} from '@/lib/public-site';
export const metadata=privateMetadata('운영 지침');
export default async function Page(){const user=await requireUser();if(user.role!=='admin')redirect('/my');return <StudentDocumentGuidelines/>;}
