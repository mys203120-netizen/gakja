import { PublicPage } from '@/components/public-page';
import { ContactForm } from '@/components/contact-form';
import { publicMetadata } from '@/lib/public-site';
import { supportConfig } from '@/lib/support-config';
import styles from '@/components/public-page.module.css';

export const metadata = publicMetadata('/contact', '문의하기', '각자ON 이용 중 궁금한 점, 오류 신고, 계정과 개인정보·삭제 요청을 접수하고 이메일로 답변받으세요.');
export const dynamic = 'force-dynamic';
export default async function ContactPage({ searchParams }: { searchParams: Promise<{ type?: string | string[] }> }) {
  const config = supportConfig();
  const initialType = (await searchParams).type === 'privacy' ? 'privacy' : 'service';
  return <PublicPage title="문의하기" introduction="이용 중 궁금한 점이나 도움이 필요한 내용을 알려 주세요.">
    <div className={styles.notice}><strong>답변 안내</strong><p>{config.responseTime}</p>{config.email && <p>문의 이메일: <a href={`mailto:${config.email}`}>{config.email}</a></p>}</div>
    {config.available ? <>{!config.configured && <p className={styles.hint}>현재 시험 운영 중이에요. 정식 문의 응답 시간과 보관기간을 확인하고 있어요.</p>}<ContactForm responseTime={config.responseTime} retention={config.retention} initialType={initialType}/></> : <p role="status">문의 창구를 준비하고 있어요. 운영 안내가 준비되면 접수를 시작할게요.</p>}
  </PublicPage>;
}
