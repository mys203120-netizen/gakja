import Link from 'next/link';
import styles from './public-faq.module.css';

export function PublicLinks() {
  return <nav className={styles.links} aria-label="서비스 안내">
    <Link href="/faq">자주 묻는 질문</Link>
    <Link href="/contact">문의하기</Link>
    <Link href="/privacy">개인정보 처리방침</Link>
  </nav>;
}
