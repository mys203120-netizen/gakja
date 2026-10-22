import Link from 'next/link';
import {ArrowLeft} from 'lucide-react';
import {Logo} from '@/components/shared';
import {PublicFaq} from '@/components/public-faq';
import {PublicLinks} from '@/components/public-links';
import {publicMetadata} from '@/lib/public-site';
import styles from '@/components/public-faq.module.css';

export const metadata=publicMetadata('/faq','자주 묻는 질문','학생부 없이 시작하는 방법, 각자ON 대화와 모의면접의 차이, 자료 공개 범위와 녹음 동의를 확인하세요.');

export default function FaqPage(){
  return <main className={styles.page}><div className={styles.pageInner}>
    <header className={styles.header}><Link href="/" aria-label="각자ON 홈"><Logo size={36}/></Link><Link href="/" className={styles.home}><ArrowLeft size={16}/>홈으로</Link></header>
    <PublicFaq standalone/>
    <footer className={styles.pageFooter}><PublicLinks/></footer>
  </div></main>;
}
