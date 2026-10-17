import 'server-only';
import { cookies } from 'next/headers';
import { createHash, randomBytes } from 'node:crypto';
import type { User } from '@supabase/supabase-js';
import { ApiError, query } from './db';
import { appOrigin } from './auth';
import { socialNext, type SocialProvider } from './social-auth-rules';
import type { VerifiedSocialProfile } from './social-auth-provision';

export const SOCIAL_COOKIE = 'gakja_oauth_browser';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function socialConfigured(provider: SocialProvider): boolean {
  if (process.env.AUTH_MODE === 'supabase') return !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY && process.env[`SUPABASE_${provider.toUpperCase()}_ENABLED`] === 'true';
  return provider === 'google' ? !!process.env.GOOGLE_CLIENT_ID?.trim() && !!process.env.GOOGLE_CLIENT_SECRET?.trim() : !!process.env.KAKAO_CLIENT_ID?.trim();
}
export function publicSocialProviders() { return { google: socialConfigured('google'), kakao: socialConfigured('kakao') }; }
export type SocialAttempt = { provider: SocialProvider; auth_mode: 'local' | 'supabase'; next_path: string; code_verifier: string | null };
export async function beginSocialAttempt(provider: SocialProvider, next: unknown) {
  const state = randomBytes(32).toString('base64url'), browser = randomBytes(32).toString('base64url');
  const mode = process.env.AUTH_MODE === 'supabase' ? 'supabase' : 'local';
  const verifier = mode === 'local' && provider === 'google' ? randomBytes(48).toString('base64url') : null;
  await query('delete from oauth_login_attempts where expires_at<now()');
  await query("insert into oauth_login_attempts(state_hash,browser_hash,provider,auth_mode,next_path,code_verifier,expires_at) values($1,$2,$3,$4,$5,$6,now()+interval '10 minutes')", [digest(state), digest(browser), provider, mode, socialNext(next), verifier]);
  (await cookies()).set(SOCIAL_COOKIE, browser, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 600 });
  return { state, verifier, mode };
}
export async function consumeSocialAttempt(state: string | null, provider?: SocialProvider): Promise<SocialAttempt> {
  const jar = await cookies(), browser = jar.get(SOCIAL_COOKIE)?.value;
  jar.delete(SOCIAL_COOKIE);
  if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || !browser || !/^[A-Za-z0-9_-]{43}$/.test(browser)) throw new ApiError(400, 'oauth_state');
  const [attempt] = await query<SocialAttempt>(`delete from oauth_login_attempts where state_hash=$1 and browser_hash=$2 and expires_at>now()${provider ? ' and provider=$3' : ''} returning provider,auth_mode,next_path,code_verifier`, provider ? [digest(state), digest(browser), provider] : [digest(state), digest(browser)]);
  if (!attempt || attempt.auth_mode !== (process.env.AUTH_MODE === 'supabase' ? 'supabase' : 'local')) throw new ApiError(400, 'oauth_state');
  return attempt;
}
export function directSocialUrl(provider: SocialProvider, request: Request, state: string, verifier: string | null) {
  const redirect = `${appOrigin(request)}/api/auth/callback/${provider}`;
  const url = new URL(provider === 'google' ? 'https://accounts.google.com/o/oauth2/v2/auth' : 'https://kauth.kakao.com/oauth/authorize');
  url.searchParams.set('client_id', (provider === 'google' ? process.env.GOOGLE_CLIENT_ID : process.env.KAKAO_CLIENT_ID)!);
  url.searchParams.set('redirect_uri', redirect); url.searchParams.set('response_type', 'code'); url.searchParams.set('state', state);
  if (provider === 'google') {
    url.searchParams.set('scope', 'openid email profile'); url.searchParams.set('prompt', 'select_account');
    if (verifier) { url.searchParams.set('code_challenge', digestBase64(verifier)); url.searchParams.set('code_challenge_method', 'S256'); }
  } else if (process.env.KAKAO_SCOPE?.trim()) url.searchParams.set('scope', process.env.KAKAO_SCOPE.trim());
  return url.toString();
}
const digestBase64 = (value: string) => createHash('sha256').update(value).digest('base64url');
async function providerJson(url: string, init: RequestInit, fetcher: typeof fetch) {
  const response = await fetcher(url, { ...init, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new ApiError(401, 'oauth_failed');
  return response.json();
}
export async function exchangeDirectSocial(provider: SocialProvider, code: string, request: Request, verifier: string | null, fetcher: typeof fetch = fetch): Promise<VerifiedSocialProfile> {
  if (!code || code.length > 4096) throw new ApiError(400, 'oauth_failed');
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: `${appOrigin(request)}/api/auth/callback/${provider}`, client_id: (provider === 'google' ? process.env.GOOGLE_CLIENT_ID : process.env.KAKAO_CLIENT_ID)! });
  const secret = provider === 'google' ? process.env.GOOGLE_CLIENT_SECRET : process.env.KAKAO_CLIENT_SECRET;
  if (secret) body.set('client_secret', secret);
  if (provider === 'google') { if (!verifier) throw new ApiError(400, 'oauth_state'); body.set('code_verifier', verifier); }
  const token = await providerJson(provider === 'google' ? 'https://oauth2.googleapis.com/token' : 'https://kauth.kakao.com/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }, fetcher);
  if (typeof token.access_token !== 'string' || !token.access_token || token.access_token.length > 16_384) throw new ApiError(401, 'oauth_failed');
  const me = await providerJson(provider === 'google' ? 'https://openidconnect.googleapis.com/v1/userinfo' : 'https://kapi.kakao.com/v2/user/me', { headers: { Authorization: `Bearer ${token.access_token}` } }, fetcher);
  if (provider === 'google') {
    if (typeof me.sub !== 'string' || !me.sub || me.sub.length > 255) throw new ApiError(401, 'oauth_failed');
    return { providerId: me.sub, email: typeof me.email === 'string' ? me.email : null, emailVerified: me.email_verified === true, name: typeof me.name === 'string' ? me.name : '학생' };
  }
  if (!Number.isSafeInteger(me.id) || me.id <= 0) throw new ApiError(401, 'oauth_failed');
  const account = me.kakao_account;
  return { providerId: String(me.id), email: typeof account?.email === 'string' ? account.email : null, emailVerified: account?.is_email_valid === true && account?.is_email_verified === true, name: typeof account?.profile?.nickname === 'string' ? account.profile.nickname : '학생' };
}
export function supabaseSocialProfile(user: User, provider: SocialProvider): VerifiedSocialProfile {
  const identity = user.identities?.find(item => item.provider === provider && item.user_id === user.id);
  const subject = identity?.id;
  if (!subject || subject.length > 255) throw new ApiError(401, 'oauth_failed');
  const info = identity?.identity_data;
  return { providerId: subject, email: user.email || null, emailVerified: !!user.email_confirmed_at && info?.email_verified !== false, name: typeof info?.full_name === 'string' ? info.full_name : typeof info?.name === 'string' ? info.name : '학생' };
}
