import { redirect } from 'next/navigation';
import { AuthScreen } from '@/components/auth-screen';
import { getUser } from '@/lib/auth';
import { socialNext } from '@/lib/social-auth-rules';
import { publicMetadata, publicSiteJsonLd, SITE_DESCRIPTION, SITE_TITLE } from '@/lib/public-site';

export const metadata = publicMetadata('/', SITE_TITLE, SITE_DESCRIPTION);

export default async function Page() {
  const user=await getUser();
  if(user)redirect(socialNext(null,user.role));
  const jsonLd = publicSiteJsonLd();
  return <>{jsonLd && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }}/>}<AuthScreen/></>;
}
