import Link from 'next/link';
import styles from './public-faq.module.css';

export const PUBLIC_FAQ = [
  {question:'학생부가 아직 없어도 시작할 수 있나요?',answer:'학생부 자료가 준비되기 전에도 공통 질문으로 답변 작성과 면접 연습을 시작할 수 있어요. 개인 학생부를 활용한 질문은 관련 자료가 준비된 뒤 이용할 수 있어요.'},
  {question:'각자ON 대화와 모의면접은 어떻게 다른가요?',answer:'각자ON에서는 경험과 답변을 함께 정리하고, 모의면접에서는 면접관의 질문에 직접 답하며 연습 기록과 피드백을 확인해요.'},
  {question:'지원 학교 정보는 어떤 기준으로 반영되나요?',answer:'선택한 지원처에 연결된 정보와 자료를 활용해요. 공식 정보가 확인되지 않은 경우에는 일반 면접 연습으로 구분하며, 실제 전형은 대학의 최신 모집요강을 확인해 주세요.'},
  {question:'내 자료와 답변이 다른 학생에게 공개되나요?',answer:'개인 학습 자료로 관리해요. 운영자와 업무 권한을 배정받은 담당자의 접근 범위, 외부 AI 처리 범위는 개인정보 처리방침에서 안내해요.',privacy:true},
  {question:'카메라와 마이크를 꼭 켜야 하나요?',answer:'글로 답할 수 있고, 카메라 없이 음성으로도 연습할 수 있어요. 녹음·영상 저장과 음성 전사는 관련 안내와 동의 후 이용해요.'},
] as const;

export function PublicFaq({standalone=false}:{standalone?:boolean}) {
  return <section className={styles.faq} aria-labelledby={standalone?'faq-title':'intro-faq-title'}>
    {standalone?<h1 id="faq-title">자주 묻는 질문</h1>:<h2 id="intro-faq-title">시작하기 전에 궁금한 점</h2>}
    <p className={styles.intro}>각자ON을 이용하기 전, 많이 궁금해하시는 내용을 모았어요.</p>
    <div className={styles.questions}>{PUBLIC_FAQ.map(item=><details key={item.question}>
      <summary>{item.question}</summary>
      <div className={styles.answer}><p>{item.answer}</p>{'privacy' in item&&<Link href="/privacy">개인정보 처리방침 보기</Link>}</div>
    </details>)}</div>
    <p className={styles.help}>더 궁금한 점이 있나요? <Link href="/contact">문의하기</Link></p>
  </section>;
}
