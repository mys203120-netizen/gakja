import { appOrigin, beginPasswordSetup, getUser, supabaseServer } from '@/lib/auth';
import { consumeSocialAttempt, supabaseSocialProfile } from '@/lib/social-auth';
import { provisionSocialStudent } from '@/lib/social-auth-provision';
import { socialNext, socialErrors } from '@/lib/social-auth-rules';
import { ApiError, transaction } from '@/lib/db';
export async function GET(request: Request) {
  const url = new URL(request.url), origin = appOrigin(request);
  try {
    if (process.env.AUTH_MODE !== 'supabase') return Response.redirect(new URL('/login?error=auth', origin));
    if (url.searchParams.has('flow')) {
      const attempt = await consumeSocialAttempt(url.searchParams.get('flow'));
      if (attempt.auth_mode !== 'supabase') throw new ApiError(400, 'oauth_state');
      if (url.searchParams.has('error')) throw new ApiError(400, 'oauth_cancelled');
      const socialCode = url.searchParams.get('code'); if (!socialCode || socialCode.length > 4096) throw new ApiError(400, 'oauth_failed');
      const socialClient = await supabaseServer();
      const { error } = await socialClient.auth.exchangeCodeForSession(socialCode); if (error) throw new ApiError(401, 'oauth_failed');
      const { data, error: userError } = await socialClient.auth.getUser();
      if (userError || !data.user) throw new ApiError(401, 'oauth_failed');
      try {
        const identity = supabaseSocialProfile(data.user, attempt.provider);
        const { user, created } = await transaction(db => provisionSocialStudent(db, attempt.provider, identity, 'supabase', data.user.id));
        return Response.redirect(new URL(created ? '/schools/new?onboarding=1' : socialNext(attempt.next_path, user.role), origin));
      } catch (error) { await socialClient.auth.signOut(); throw error; }
    }
    const code = url.searchParams.get('code'), tokenHash = url.searchParams.get('token_hash'), type = url.searchParams.get('type');
    const desired = url.searchParams.get('next');
    const next = ['/my','/admin','/invite','/reset-password'].includes(desired ?? '') ? desired! : type === 'invite' ? '/invite' : type === 'recovery' ? '/reset-password' : '/my';
    const supabase = await supabaseServer();
    const result = code ? await supabase.auth.exchangeCodeForSession(code) : tokenHash && (type === 'invite' || type === 'recovery') ? await supabase.auth.verifyOtp({ token_hash: tokenHash, type }) : null;
    if (!result || result.error) return Response.redirect(new URL('/login?error=auth', origin));
    const user = await getUser(); if (!user) return Response.redirect(new URL('/login?error=unassigned', origin));
    if (next === '/invite' || next === '/reset-password') {
      await beginPasswordSetup(user.id); return Response.redirect(new URL(`${next}?setup=1`, origin));
    }
    return Response.redirect(new URL(user.role === 'student' && next === '/admin' ? '/my' : user.role !== 'student' && next === '/my' ? '/admin' : next, origin));
  } catch (error) {
    const reason = error instanceof ApiError && socialErrors[error.message] ? error.message : 'auth';
    return Response.redirect(new URL(`/login?error=${reason}`, origin));
  }
}
