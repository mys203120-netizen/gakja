import 'server-only';
import { cookies, headers } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { compare, hash } from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { ApiError, query } from './db';
import { resolveAppOrigin } from './auth-origin';

export type Profile = { id: string; email: string; name: string; role: 'student' | 'staff' | 'admin'; active: boolean; is_test?: boolean };
export const SESSION_COOKIE = 'gakja_session';
export const PASSWORD_SETUP_COOKIE = 'gakja_password_setup';
export const hashPassword = (password: string) => hash(password, 12);
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
export function assertLocalAuthAllowed() {
  if (process.env.AUTH_MODE !== 'supabase' && process.env.NODE_ENV === 'production' && process.env.ALLOW_LOCAL_AUTH !== 'true') throw new ApiError(503, '배포 환경은 Supabase 인증을 연결해 주세요.');
}
export function appOrigin(request: Request): string {
  try { return resolveAppOrigin(request); }
  catch { throw new ApiError(503, '서비스 주소 설정이 필요해요.'); }
}
export async function beginPasswordSetup(userId: string) {
  const token = randomBytes(32).toString('hex');
  await query('insert into sessions(id,user_id,expires_at) values($1,$2,now()+interval \'30 minutes\')', [`password_setup:${digest(token)}`, userId]);
  (await cookies()).set(PASSWORD_SETUP_COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 30 * 60 });
}
export async function passwordSetupId(userId: string): Promise<string | null> {
  const token = (await cookies()).get(PASSWORD_SETUP_COOKIE)?.value; if (!token) return null;
  const id = `password_setup:${digest(token)}`;
  const [session] = await query('select id from sessions where id=$1 and user_id=$2 and expires_at>now()', [id, userId]);
  return session?.id ?? null;
}

export async function supabaseServer() {
  const jar = await cookies();
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) throw new ApiError(503, 'Supabase 연결 설정이 필요해요.');
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: { getAll: () => jar.getAll(), setAll: (items) => { try { items.forEach(({ name, value, options }) => jar.set(name, value, options)); } catch { /* Server Components cannot write cookies. */ } } },
  });
}
export async function getUser(): Promise<Profile | null> {
  assertLocalAuthAllowed();
  if (process.env.AUTH_MODE === 'supabase') {
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) throw new ApiError(503, 'Supabase 연결 설정이 필요해요.');
    const authorization = (await headers()).get('authorization');
    const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
    if (bearer && bearer.length > 8_192) throw new ApiError(401, '인증 정보를 확인해 주세요.');
    const client = bearer
      ? createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } })
      : await supabaseServer();
    const { data } = await client.auth.getUser(bearer ?? undefined);
    if (!data.user) return null;
    const [profile] = await query<Profile>('select id,email,name,role,active from profiles where id=$1 and active=true', [data.user.id]);
    return profile ? { ...profile, is_test: profile.email.endsWith('@gakja.test') } : null;
  }
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const [profile] = await query<Profile>('select p.id,p.email,p.name,p.role,p.active from sessions s join profiles p on p.id=s.user_id where s.id=$1 and s.expires_at>now() and p.active=true', [digest(token)]);
  return profile ? { ...profile, is_test: profile.email.endsWith('@gakja.test') } : null;
}
export async function requireUser(): Promise<Profile> {
  const user = await getUser(); if (!user) throw new ApiError(401, '로그인이 필요해요.'); return user;
}
export async function loginLocal(email: string, password: string): Promise<Profile> {
  assertLocalAuthAllowed();
  const [row] = await query<Profile & { password_hash: string }>('select * from profiles where lower(email)=lower($1) and active=true', [email]);
  if (!row?.password_hash || !(await compare(password, row.password_hash))) throw new ApiError(401, '이메일 또는 비밀번호를 확인해 주세요.');
  await createLocalSession(row.id);
  return { id: row.id, email: row.email, name: row.name, role: row.role, active: row.active, is_test: row.email.endsWith('@gakja.test') };
}
export async function createLocalSession(userId: string) {
  assertLocalAuthAllowed();
  const token = randomBytes(32).toString('hex');
  const rows = await query('insert into sessions(id,user_id,expires_at) select $1,id,now()+interval \'7 days\' from profiles where id=$2 and active=true returning user_id', [digest(token), userId]);
  if (!rows.length) throw new ApiError(403, '이 계정은 이용이 중지되어 있어요.');
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 7 });
}
export async function logoutLocal() {
  assertLocalAuthAllowed();
  const jar = await cookies(); const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await query('delete from sessions where id=$1', [digest(token)]); jar.delete(SESSION_COOKIE);
}
export function checkOrigin(request: Request) {
  const origin = request.headers.get('origin');
  // Next's internal Request URL may use the bind host (0.0.0.0). Match the
  // incoming Host so localhost and deployed reverse proxies retain CSRF checks.
  const host = request.headers.get('host') ?? new URL(request.url).host;
  if (origin) {
    let originHost: string; try { originHost = new URL(origin).host; } catch { throw new ApiError(403, '허용되지 않은 요청이에요.'); }
    if (originHost !== host) throw new ApiError(403, '허용되지 않은 요청이에요.');
  }
}
export async function requireStaff(studentId?: string, permission = 'review'): Promise<Profile> {
  const user = await requireUser();
  if (user.role === 'admin') return user;
  if (user.role !== 'staff') throw new ApiError(403, '접근 권한이 없어요.');
  if (studentId) {
    const assignments = await query('select permissions from staff_assignments where staff_id=$1 and student_id=$2', [user.id, studentId]);
    if (!assignments[0]?.permissions?.includes(permission)) throw new ApiError(403, '배정된 학생의 업무만 처리할 수 있어요.');
  }
  return user;
}
