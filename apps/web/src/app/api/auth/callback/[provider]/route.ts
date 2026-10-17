import { NextResponse } from 'next/server';
import { appOrigin, createLocalSession } from '@/lib/auth';
import { ApiError, transaction } from '@/lib/db';
import { consumeSocialAttempt, exchangeDirectSocial, socialConfigured } from '@/lib/social-auth';
import { provisionSocialStudent } from '@/lib/social-auth-provision';
import { isSocialProvider, socialNext, socialErrors } from '@/lib/social-auth-rules';

export async function GET(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (!isSocialProvider(provider)) return Response.json({ error: '지원하지 않는 로그인 방식이에요.' }, { status: 404 });
  const origin = appOrigin(request), url = new URL(request.url);
  try {
    const attempt = await consumeSocialAttempt(url.searchParams.get('state'), provider);
    if (attempt.auth_mode !== 'local' || !socialConfigured(provider)) throw new ApiError(400, 'oauth_failed');
    if (url.searchParams.has('error')) throw new ApiError(400, 'oauth_cancelled');
    const identity = await exchangeDirectSocial(provider, url.searchParams.get('code') || '', request, attempt.code_verifier);
    const { user, created } = await transaction(db => provisionSocialStudent(db, provider, identity, 'local'));
    await createLocalSession(user.id);
    const destination = created ? '/schools/new?onboarding=1' : socialNext(attempt.next_path, user.role);
    return NextResponse.redirect(new URL(destination, origin));
  } catch (error) {
    const reason = error instanceof ApiError && socialErrors[error.message] ? error.message : 'oauth_failed';
    return NextResponse.redirect(new URL(`/login?error=${reason}`, origin));
  }
}
