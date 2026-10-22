const validEmail = (value: string) => value.length <= 254 && /^[^\s@\x00-\x1f]+@[^\s@\x00-\x1f]+\.[^\s@\x00-\x1f]+$/.test(value);
export function supportConfig(env: NodeJS.ProcessEnv = process.env) {
  const email = (env.SUPPORT_EMAIL || '').trim();
  const responseTime = (env.SUPPORT_RESPONSE_TIME || '').trim();
  const retention = (env.SUPPORT_RETENTION_NOTICE || '').trim();
  const configured = Boolean(validEmail(email) && responseTime && retention && env.SITE_ORGANIZATION_NAME?.trim());
  return {
    email: validEmail(email) ? email : null,
    responseTime: responseTime || '문의 응답 시간을 확인하고 있어요. 접수 후 답변 시점을 별도로 안내해요.',
    retention: retention || '시험 운영 중인 문의는 처리와 후속 확인을 위해 보관해요. 운영 보관기간은 확정 전이며 삭제를 요청할 수 있어요.',
    available: env.NODE_ENV !== 'production' || configured,
    configured,
  };
}

export function privacyConfig(env: NodeJS.ProcessEnv = process.env) {
  const support = supportConfig(env);
  const operator = env.SITE_ORGANIZATION_NAME?.trim() || null;
  const officer = env.PRIVACY_OFFICER?.trim() || null;
  const retention = env.PRIVACY_RETENTION_NOTICE?.trim() || null;
  const processors = env.PRIVACY_PROCESSORS_NOTICE?.trim() || null;
  const transfers = env.PRIVACY_TRANSFERS_NOTICE?.trim() || null;
  const contact = env.PRIVACY_CONTACT_EMAIL?.trim() || support.email;
  const email = contact && validEmail(contact) ? contact : null;
  const ready = Boolean(operator && officer && retention && processors && transfers && email && support.configured);
  return { operator, officer, retention, processors, transfers, email, ready };
}
