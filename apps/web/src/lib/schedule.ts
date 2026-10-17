export type AdmissionSchedule = {
  period_start: string | null; period_end: string | null; personal_date: string | null; personal_at: string | null;
  location: string; required_materials: string[]; source_url: string; checked_at: string | null;
  status: 'awaiting' | 'needs_review' | 'reviewed' | 'changed'; review_note: string;
  revision?: number; reviewed_by?: string | null; updated_at?: string;
};

const record = (value: unknown): Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const field = (value: unknown, name: string, limit = 2000) => {
  if (value !== undefined && value !== null && typeof value !== 'string') throw new Error(`${name} 형식을 확인해 주세요.`);
  const result = String(value ?? '').trim();
  if (result.length > limit) throw new Error(`${name} 길이를 확인해 주세요.`);
  return result;
};

export function safeSourceURL(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try { const url = new URL(value.trim()); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}

export function validateDateOnly(value: unknown, name = '날짜'): string | null {
  const result = field(value, name, 30);
  if (!result) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw new Error(`${name}는 연-월-일로 입력해 주세요.`);
  const parsed = new Date(`${result}T00:00:00+09:00`);
  const shifted = new Date(parsed.getTime() + 9 * 3600000);
  if (!Number.isFinite(parsed.getTime()) || shifted.toISOString().slice(0, 10) !== result) throw new Error(`${name}를 확인해 주세요.`);
  return result;
}

export function validateKSTDateTime(value: unknown, name = '개별 면접 시각'): string | null {
  const result = field(value, name, 40);
  if (!result) return null;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/.exec(result);
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4] ?? 0) > 59) throw new Error(`${name}는 한국 시각으로 입력해 주세요.`);
  validateDateOnly(match[1], name);
  const parsed = new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4] ?? '00'}${match[6] ?? '+09:00'}`);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${name}를 확인해 주세요.`);
  return `${new Date(parsed.getTime() + 9 * 3600000).toISOString().slice(0, 19)}+09:00`;
}

export function normalizeSchedule(value: unknown, previous: unknown = {}): AdmissionSchedule {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('일정 정보를 확인해 주세요.');
  const input = { ...record(previous), ...record(value) };
  const period_start = validateDateOnly(input.period_start, '면접 기간 시작일');
  const period_end = validateDateOnly(input.period_end, '면접 기간 종료일');
  if (period_start && period_end && period_start > period_end) throw new Error('면접 기간의 시작일과 종료일을 확인해 주세요.');
  const personal_at = validateKSTDateTime(input.personal_at);
  const personal_date = validateDateOnly(input.personal_date, '개별 면접일') || personal_at?.slice(0, 10) || null;
  if (personal_at && personal_date !== personal_at.slice(0, 10)) throw new Error('개별 면접일과 시각의 날짜가 서로 달라요.');
  if (personal_date && ((period_start && personal_date < period_start) || (period_end && personal_date > period_end))) throw new Error('개별 면접일이 학교 면접 기간 밖에 있어요.');
  const checkedText = field(input.checked_at, '확인일', 40);
  const checked_at = checkedText.includes('T') ? validateKSTDateTime(checkedText, '확인 시각') : validateDateOnly(checkedText, '확인일');
  const sourceText = field(input.source_url, '공식 출처 URL');
  const source_url = sourceText ? safeSourceURL(sourceText) : '';
  if (sourceText && !source_url) throw new Error('공식 출처 URL을 확인해 주세요.');
  const status = input.status ?? 'awaiting';
  if (!['awaiting', 'needs_review', 'reviewed', 'changed'].includes(status)) throw new Error('일정 검수 상태를 확인해 주세요.');
  if (status === 'reviewed' && (!source_url || !checked_at)) throw new Error('검수 완료 전 공식 출처와 확인일을 입력해 주세요.');
  const materials = Array.isArray(input.required_materials) ? input.required_materials : field(input.required_materials, '준비할 자료', 4000).split('\n').filter(Boolean);
  if (materials.length > 20) throw new Error('준비할 자료는 20개 이내로 입력해 주세요.');
  const required_materials = materials.map(item => field(item, '준비할 자료', 500)).filter(Boolean);
  return { period_start, period_end, personal_date, personal_at, location: field(input.location, '면접 장소', 500), required_materials, source_url: source_url || '', checked_at, status, review_note: field(input.review_note, '검수 메모', 4000) };
}

export function scheduleDetails(target: unknown): Partial<AdmissionSchedule> {
  const item = record(target), data = item.data ? { ...record(item.data), ...item } : item;
  return record(data.schedule);
}

export function personalDate(target: unknown): string | null {
  const item = record(target), data = item.data ? { ...record(item.data), ...item } : item;
  const schedule = scheduleDetails(data);
  // A new schedule with no personal time must never inherit a school-period date.
  if (data.schedule) { const personal = schedule.personal_at || schedule.personal_date; return typeof personal === 'string' && Number.isFinite(new Date(personal).getTime()) ? personal : null; }
  const legacy = data.interview_date ?? data.interview_at;
  return typeof legacy === 'string' && /^(\d{4}-\d{2}-\d{2})(T.*)?$/.test(legacy) && Number.isFinite(new Date(legacy.length === 10 ? `${legacy}T00:00:00+09:00` : legacy).getTime()) ? legacy : null;
}

export function scheduleDateLabel(value: string | null | undefined, includeTime = false): string {
  if (!value) return '';
  const date = new Date(value.length === 10 ? `${value}T00:00:00+09:00` : value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', ...(includeTime && value.includes('T') ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}) }).format(date);
}

export function scheduleLabel(target: unknown): string {
  const personal = personalDate(target);
  if (personal) return `${scheduleDateLabel(personal, true)}${personal.includes('T') ? '' : ' · 시간 발표 대기'}`;
  const schedule = scheduleDetails(target);
  if (schedule.period_start && schedule.period_end) return schedule.period_start === schedule.period_end ? `${scheduleDateLabel(schedule.period_start)} · 개별 시각 대기` : `${scheduleDateLabel(schedule.period_start)}–${scheduleDateLabel(schedule.period_end)}`;
  if (schedule.period_start || schedule.period_end) return `${scheduleDateLabel(schedule.period_start || schedule.period_end)} ${schedule.period_start ? '이후' : '이전'}`;
  return '개별 일정 발표 대기';
}

export function scheduleChanged(before: unknown, after: unknown): boolean {
  const old = record(before), next = record(after);
  return ['period_start', 'period_end', 'personal_date', 'personal_at', 'location', 'required_materials'].some(key => {
    if (key === 'required_materials') { const list = (v: unknown) => Array.isArray(v) ? v : String(v ?? '').split('\n').filter(Boolean); return JSON.stringify(list(old[key])) !== JSON.stringify(list(next[key])); }
    return String(old[key] ?? '') !== String(next[key] ?? '');
  });
}
