import { cookies } from 'next/headers';
import { appOrigin, checkOrigin, loginLocal, logoutLocal, getUser, passwordSetupId, PASSWORD_SETUP_COOKIE, requireUser, supabaseServer } from '@/lib/auth';
import { ApiError, errorResponse, transaction } from '@/lib/db';
import { publicSocialProviders } from '@/lib/social-auth';
const attempts = new Map<string, { count: number; reset: number }>();
function limit(request: Request, key: string) {
  const rateKey = `${request.headers.get('x-forwarded-for') ?? 'local'}:${key}`, attempt = attempts.get(rateKey);
  if (attempt && attempt.reset > Date.now() && attempt.count >= 10) throw new ApiError(429, '잠시 후 다시 시도해 주세요.');
  attempts.set(rateKey, { count: attempt && attempt.reset > Date.now() ? attempt.count + 1 : 1, reset: Date.now() + 15 * 60_000 });
  return rateKey;
}
export async function GET() { try { const user = await getUser(); return Response.json({ user, providers: publicSocialProviders(), authMode: process.env.AUTH_MODE === 'supabase' ? 'supabase' : 'local', canSetPassword: !!user && process.env.AUTH_MODE === 'supabase' && !!await passwordSetupId(user.id) }, { headers: { 'Cache-Control': 'private, no-store' } }); } catch (error) { return errorResponse(error); } }
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const body = await request.json();
    if (body.action === 'logout') {
      if (process.env.AUTH_MODE === 'supabase') {
        const user = await getUser(), setup = user ? await passwordSetupId(user.id) : null;
        if (setup) await transaction(async (db) => { await db.query('delete from sessions where id=$1', [setup]); });
        const { error } = await (await supabaseServer()).auth.signOut(); if (error) throw new ApiError(503, '로그아웃을 처리하지 못했어요. 다시 시도해 주세요.');
        (await cookies()).delete(PASSWORD_SETUP_COOKIE);
      } else await logoutLocal();
      return Response.json({ ok: true });
    }
    if (body.action === 'reset_password') {
      const email = String(body.email ?? '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new ApiError(400, '가입한 이메일을 입력해 주세요.');
      if (process.env.AUTH_MODE !== 'supabase') throw new ApiError(503, '테스트 환경은 관리자에게 비밀번호 변경을 요청해 주세요.');
      limit(request, `reset:${email}`);
      const { error } = await (await supabaseServer()).auth.resetPasswordForEmail(email, { redirectTo: `${appOrigin(request)}/auth/callback?next=/reset-password` });
      if (error) throw new ApiError(503, '재설정 메일을 보내지 못했어요. 잠시 후 다시 시도해 주세요.');
      return Response.json({ ok: true, message: '가입한 이메일이면 재설정 링크를 보냈어요. 메일을 확인해 주세요.' });
    }
    if (body.action === 'set_password') {
      if (process.env.AUTH_MODE !== 'supabase') throw new ApiError(503, '테스트 환경은 관리자에게 비밀번호 변경을 요청해 주세요.');
      const password = String(body.password ?? '');
      if (password.length < 10 || password.length > 256) throw new ApiError(400, '새 비밀번호는 10~256자로 입력해 주세요.');
      const user = await requireUser(), setupId = await passwordSetupId(user.id);
      if (!setupId) throw new ApiError(403, '초대 또는 재설정 메일의 링크를 다시 열어 주세요.');
      const supabase = await supabaseServer();
      await transaction(async (db) => {
        const token = (await db.query('select id from sessions where id=$1 and user_id=$2 and expires_at>now() for update', [setupId, user.id])).rows[0];
        if (!token) throw new ApiError(403, '링크가 만료되었어요. 새 메일의 링크를 열어 주세요.');
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw new ApiError(400, '비밀번호를 변경하지 못했어요. 다른 비밀번호로 다시 시도해 주세요.');
        await db.query('delete from sessions where id=$1', [setupId]);
        await db.query('insert into audit_logs(actor_id,student_id,action,data) values($1,$1,\'account.password.set\',\'{}\')', [user.id]);
      });
      (await cookies()).delete(PASSWORD_SETUP_COOKIE);
      return Response.json({ ok: true, user, message: '비밀번호를 저장했어요.' });
    }
    if (body.action !== 'login') throw new ApiError(400, body.action === 'accept_invite' ? '초대 메일의 연결 링크를 먼저 열어 주세요.' : '인증 작업을 확인해 주세요.');
    const email = String(body.email ?? '').trim().toLowerCase(), password = String(body.password ?? '');
    if (!email || !password || email.length > 254 || password.length > 256) throw new ApiError(400, '이메일과 비밀번호를 입력해 주세요.');
    const key = limit(request, `login:${email}`);
    let user;
    if (process.env.AUTH_MODE === 'supabase') {
      const { error } = await (await supabaseServer()).auth.signInWithPassword({ email, password });
      if (error) throw new ApiError(401, '이메일 또는 비밀번호를 확인해 주세요.');
      user = await getUser();
      if (!user) throw new ApiError(403, '아직 배정되지 않은 계정이에요.');
    } else user = await loginLocal(email, password);
    attempts.delete(key); return Response.json({ user });
  } catch (error) { return errorResponse(error); }
}
