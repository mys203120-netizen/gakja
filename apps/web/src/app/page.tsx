import { redirect } from 'next/navigation';
import { AuthScreen } from '@/components/auth-screen';
import { getUser } from '@/lib/auth';
import { socialNext } from '@/lib/social-auth-rules';

export default async function Page() {
  const user=await getUser();
  if(user)redirect(socialNext(null,user.role));
  return <AuthScreen/>;
}
