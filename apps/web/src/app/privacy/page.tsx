import Link from 'next/link';
import { PublicPage } from '@/components/public-page';
import { AnalyticsConsentSettings } from '@/components/analytics';
import { PRIVACY_POLICY_VERSION } from '@/lib/privacy-policy';
import { publicMetadata } from '@/lib/public-site';
import { privacyConfig, supportConfig } from '@/lib/support-config';
import styles from '@/components/public-page.module.css';

export function generateMetadata() {
  const config = privacyConfig();
  return { ...publicMetadata('/privacy', '개인정보 처리방침', '각자ON의 계정, 학생부, 답변, 음성·영상과 외부 AI 처리 범위, 개인정보 권리행사 및 분석 설정을 확인하세요.'), ...(!config.ready ? { robots: { index: false, follow: true } } : {}) };
}
export const dynamic = 'force-dynamic';
export default function PrivacyPage() {
  const config = privacyConfig(), support = supportConfig();
  return <PublicPage title="개인정보 처리방침" introduction="내 자료가 어떤 목적으로 처리되고, 누가 접근하며, 어떻게 요청할 수 있는지 안내해요.">
    <p className={styles.hint}>안내 버전: {PRIVACY_POLICY_VERSION}</p>
    {!config.ready && <div className={styles.notice} role="status"><strong>운영 정보 확인 중인 안내예요.</strong><p>아래에는 현재 서비스에서 확인되는 처리 범위를 적었어요. 운영 주체의 책임자·보관기간·수탁 업체의 계약과 국외이전 세부 사항은 확정 전이에요. 해당 정보가 확인되기 전까지 정식 운영 방침이 확정된 것으로 안내하지 않아요.</p></div>}
    <h2>1. 운영 주체와 문의 창구</h2><p>운영 주체: {config.operator || '확인 중'}</p><p>개인정보 보호 담당자: {config.officer || '확인 중'}</p><p>문의는 <Link href="/contact?type=privacy">개인정보 및 삭제 요청</Link>으로 접수할 수 있어요.{config.email && <> 이메일: <a href={`mailto:${config.email}`}>{config.email}</a></>}</p>
    <h2>2. 처리하는 정보와 목적</h2><ul>
      <li>계정: 이름·이메일·로그인 제공자의 계정 식별 정보와 인증 세션을 가입·로그인·접근 권한 확인에 사용해요. 이메일 인증 방식에 따라 비밀번호는 인증 서비스 또는 해시 형태로 관리해요.</li>
      <li>학습: 학생부·활동·지원 학교·면접 일정·학습 가능 시간, 답변·대화·학습 기록·피드백을 질문 준비, 연습, 기록 비교와 담당 업무에 사용해요.</li>
      <li>선택 미디어: 사용자가 동의한 음성·영상·첨부파일, 원전사·정리문·정정 이력과 실제 발화 관찰값을 답변 저장·전사·기록 확인에 사용해요. 카메라 없이 글이나 음성으로 연습할 수 있어요.</li>
      <li>문의: 이메일·문의 내용·유형·계정 연결 정보·접수 및 동의 이력을 문의 확인·회신·권리행사 처리에 사용해요.</li>
      <li>서비스 이용: 인증·안전한 파일 접근·오류 대응에 필요한 세션과 처리 기록을 관리해요. 선택 분석은 아래 설정에서 별도로 동의한 경우에만 사용해요.</li>
    </ul>
    <h2>3. 자료에 접근할 수 있는 사람</h2><p>개인 학습 자료를 다른 학생에게 공개하지 않아요. 운영 관리자와 학생별 업무 권한을 배정받은 담당자는 계정 관리·자료 제작·검수·피드백 등 허용된 업무 범위에서 접근할 수 있어요. 문의 내용은 운영 관리자만 확인해요.</p>
    <h2>4. 외부 서비스와 AI 처리</h2><p>AI 답변 정리·대화·면접 피드백에는 필요한 활동·질문·답변·대화 맥락을 OpenAI로 전송하는 기능이 있어요. 음성 전사를 사용하면 녹음이, 음성 낭독을 사용하면 낭독할 문장이 설정된 음성 처리 서비스로 전달돼요. 현재 음성 처리 코드는 OpenAI 또는 명시적으로 설정한 Google 공급자를 지원해요. 선택하지 않은 공급자로 자동 전환하지 않아요.</p><p>Supabase 인증·비공개 파일 저장을 사용하는 운영에서는 계정·파일이 해당 서비스에서 처리돼요. 로컬 운영에서는 PostgreSQL 등 서비스 저장소에서 관리해요. 실제 사용하는 업체·업무·계약상 보관·배포 지역은 아래 운영 안내를 기준으로 확인해 주세요.</p><p>{config.processors || '실제 사용하는 저장소·AI·음성 처리 업체와 위탁 범위는 운영 계약 확인 중이에요.'}</p><p>{config.transfers || '국외이전의 수령인·국가·시점·방법·항목·목적·보유기간·적용 근거·거부 방법은 실제 계약과 배포 지역 확인 후 안내해요. 국내 처리만 이루어진다고 안내하지 않아요.'}</p>
    <h2>5. 보유기간과 삭제</h2><p>{config.retention || '계정·학습 자료·답변·대화·미디어·백업의 항목별 보유기간과 파기 절차는 운영 확인 중이에요. 삭제 요청을 접수하면 본인 확인과 요청 범위를 확인한 뒤 처리 결과를 알려드려요. 즉시 자동 삭제가 완료되는 기능으로 안내하지 않아요.'}</p><p>문의 보관 안내: {support.retention}</p><p>삭제 요청 시 원본·파생 전사·첨부파일·학습 기록·외부 처리본과 백업 중 어떤 범위가 처리되는지 확인해 주세요. 별도 보관이 필요한 자료와 사유가 있으면 처리 과정에서 안내받을 수 있어요.</p>
    <h2>6. 열람·정정·삭제·처리정지 요청</h2><p>내 자료 열람·정정·삭제·처리정지, 계정 탈퇴 및 동의 철회는 <Link href="/contact?type=privacy">개인정보 및 삭제 요청</Link>에서 요청해 주세요. 계정 이메일과 대상 자료의 범위를 적어 주시면 본인 확인 후 처리 여부와 결과를 답변드려요. 비밀번호나 주민등록번호는 보내지 마세요. 법정대리인의 요청은 필요한 관계 확인 후 처리해요.</p>
    <h2>7. 쿠키와 선택 분석</h2><p>로그인 유지에 필요한 세션 쿠키를 사용해요. Google Analytics 4는 선택 동의 후 활성화하며 화면 단위 방문과 시작 버튼·가입 확인·첫 답변 저장·면접 결과 저장 같은 이용 전환을 측정해요. 학생 이름·이메일·학생부·답변 원문·파일명·계정 및 질문 식별자·인증 토큰은 분석 이벤트로 보내지 않아요. 주소의 쿼리·해시와 개인 식별 경로를 제거하고 고정된 화면 이름만 사용해요.</p><AnalyticsConsentSettings/>
    <h2>8. 안전한 관리와 안내 변경</h2><p>로그인·역할·배정 권한을 확인하고 개인 파일은 인증된 경로로 제공해요. 녹음 저장에 동의하면 적용한 안내 버전과 동의 내역을 함께 기록해요. 운영 정보가 확정되거나 처리 범위가 변경되면 이 페이지의 안내와 버전을 갱신해요.</p>
  </PublicPage>;
}
