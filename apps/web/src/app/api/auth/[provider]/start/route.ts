import { NextResponse } from 'next/server';
import { appOrigin, assertLocalAuthAllowed, supabaseServer } from '@/lib/auth';
import { beginSocialAttempt, directSocialUrl, socialConfigured } from '@/lib/social-auth';
import { isSocialProvider } from '@/lib/social-auth-rules';

const starts = new Map<string, { count: number; expires: number }>();
function allowStart(request: Request) {
  const now = Date.now();
  for (const [key, entry] of starts) if (entry.expires <= now) starts.delete(key);
  const key = (request.headers.get('x-forwarded-for') || 'local').slice(0, 200), current = starts.get(key);
  if (current && current.count >= 20) return false;
  if (!current && starts.size >= 10_000) return false;
  starts.set(key, { count: (current?.count || 0) + 1, expires: current?.expires || now + 10 * 60_000 });
  return true;
}

export async function GET(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (!isSocialProvider(provider)) return Response.json({ error: '지원하지 않는 로그인 방식이에요.' }, { status: 404 });
  const origin = appOrigin(request);
  if (!socialConfigured(provider)) return NextResponse.redirect(new URL(`/login?error=${provider}_not_configured`, origin));
  if (!allowStart(request)) return Response.json({ error: '잠시 후 다시 연결해 주세요.' }, { status: 429, headers: { 'Cache-Control': 'no-store', 'Retry-After': '600' } });
  try {
    if (process.env.AUTH_MODE !== 'supabase') assertLocalAuthAllowed();
    const url = new URL(request.url), attempt = await beginSocialAttempt(provider, url.searchParams.get('next'));
    if (attempt.mode === 'local') return NextResponse.redirect(directSocialUrl(provider, request, attempt.state, attempt.verifier));
    const callback = new URL('/auth/callback', origin); callback.searchParams.set('flow', attempt.state);
    const { data, error } = await (await supabaseServer()).auth.signInWithOAuth({ provider, options: { redirectTo: callback.toString(), skipBrowserRedirect: true } });
    if (error || !data.url) throw new Error('oauth_failed');
    return NextResponse.redirect(data.url);
  } catch { return NextResponse.redirect(new URL('/login?error=oauth_failed', origin)); }
}
