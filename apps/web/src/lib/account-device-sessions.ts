import 'server-only';
import {cookies, headers} from 'next/headers';
import {createHash} from 'node:crypto';
import {ApiError, query, transaction} from './db';
import type {AccountDeviceSession} from './account-data-model';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function verifiedSupabaseSession(token: string, userId: string) {
  // This is identity extraction ONLY. Callers must first verify this token with auth.getUser().
  try {
    const value = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    if (value.sub !== userId || !Number.isFinite(value.exp) || !Number.isFinite(value.iat)) throw new Error();
    return {key: 'supabase:' + (typeof value.session_id === 'string' ? value.session_id : digest(token)), expiresAt: new Date(value.exp * 1000),issuedAt:new Date(value.iat*1000)};
  } catch { throw new ApiError(401, '로그인 정보를 확인해 주세요.'); }
}
export async function observeDeviceSession(userId: string, session: {key: string; expiresAt: Date; issuedAt?:Date}) {
  if(session.key.startsWith('supabase:')){
    const [revoked]=await query('select 1 from account_session_revocations where student_id=$1 and allowed_session_key<>$2 and $3::timestamptz<=revoked_before',[userId,session.key,session.issuedAt]);
    if(revoked)throw new ApiError(401,'이 기기에서 로그아웃됐어요. 다시 로그인해 주세요.');
  }
  const ua = (await headers()).get('user-agent') || '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '브라우저';
  const device = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '기기';
  const [row] = await query(`insert into account_device_sessions(student_id,session_key,label,expires_at) values($1,$2,$3,$4)
    on conflict(student_id,session_key) do update set last_seen_at=now(),expires_at=greatest(account_device_sessions.expires_at,excluded.expires_at)
    returning id,revoked_at`, [userId, session.key, `${device} · ${browser}`, session.expiresAt]);
  if (row.revoked_at) throw new ApiError(401, '이 기기에서 로그아웃됐어요. 다시 로그인해 주세요.');
  return row.id as string;
}
export async function currentDeviceKey(userId: string) {
  if (process.env.AUTH_MODE !== 'supabase') {
    const token = (await cookies()).get('gakja_session')?.value;
    return token ? 'local:' + digest(token) : '';
  }
  const authorization = (await headers()).get('authorization');
  let token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!token) {
    const {supabaseServer} = await import('./auth');
    token = (await (await supabaseServer()).auth.getSession()).data.session?.access_token || '';
  }
  return token ? verifiedSupabaseSession(token, userId).key : '';
}
export async function deviceSessions(userId: string): Promise<AccountDeviceSession[]> {
  const current = await currentDeviceKey(userId);
  return query(`select id,label,session_key=$2 as current,created_at as "createdAt",last_seen_at as "lastSeenAt"
    from account_device_sessions where student_id=$1 and revoked_at is null and expires_at>now() order by (session_key=$2) desc,last_seen_at desc`, [userId,current]);
}
export async function revokeOtherDeviceSessions(userId: string) {
  const current = await currentDeviceKey(userId);
  if (!current) throw new ApiError(401, '현재 로그인 정보를 확인해 주세요.');
  if (process.env.AUTH_MODE === 'supabase') {
    const {supabaseServer} = await import('./auth');
    const client=await supabaseServer(),authorization=(await headers()).get('authorization');
    const {error} = authorization?.startsWith('Bearer ')?await client.auth.admin.signOut(authorization.slice(7),'others'):await client.auth.signOut({scope:'others'});
    if (error) throw new ApiError(503, '다른 기기의 로그아웃을 처리하지 못했어요. 다시 시도해 주세요.');
  }
  return transaction(async db => {
    if(process.env.AUTH_MODE==='supabase')await db.query('insert into account_session_revocations(student_id,revoked_before,allowed_session_key) values($1,now(),$2) on conflict(student_id) do update set revoked_before=excluded.revoked_before,allowed_session_key=excluded.allowed_session_key',[userId,current]);
    const rows = await db.query('update account_device_sessions set revoked_at=now() where student_id=$1 and session_key<>$2 and revoked_at is null returning id',[userId,current]);
    if (process.env.AUTH_MODE !== 'supabase') await db.query('delete from sessions where user_id=$1 and id<>$2 and id not like $3',[userId,current.slice(6),'password_setup:%']);
    return rows.rowCount || 0;
  });
}
