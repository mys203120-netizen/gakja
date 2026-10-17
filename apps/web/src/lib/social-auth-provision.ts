import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { ApiError } from './db';
import type { Profile } from './auth';
import type { SocialProvider } from './social-auth-rules';

export type VerifiedSocialProfile = { providerId: string; email: string | null; emailVerified: boolean; name: string };
// Only data returned from provider APIs (or validated Supabase getUser) reaches this helper.
export async function provisionSocialStudent(db: PoolClient, provider: SocialProvider, identity: VerifiedSocialProfile, mode: 'local' | 'supabase', authUserId?: string): Promise<{ user: Profile; created: boolean }> {
  if (!identity.providerId || identity.providerId.length > 255 || (mode === 'supabase' && !authUserId)) throw new ApiError(401, 'oauth_failed');
  await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`social:${provider}:${identity.providerId}`]);
  const existingIdentity = (await db.query('select p.id,p.email,p.name,p.role,p.active,i.auth_mode from social_identities i join profiles p on p.id=i.user_id where i.provider=$1 and i.provider_id=$2 for update of p', [provider, identity.providerId])).rows[0];
  if (existingIdentity) {
    if (existingIdentity.auth_mode !== mode || (authUserId && existingIdentity.id !== authUserId)) throw new ApiError(409, 'oauth_existing');
    if (!existingIdentity.active) throw new ApiError(403, 'suspended');
    await db.query('update social_identities set last_signed_in_at=now() where provider=$1 and provider_id=$2', [provider, identity.providerId]);
    return { user: existingIdentity, created: false };
  }
  // Supabase owns its UUID. Existing assigned/admin/pending profiles must never be overwritten.
  const existingProfile = authUserId ? (await db.query('select id,email,name,role,active from profiles where id=$1 for update', [authUserId])).rows[0] : null;
  if (existingProfile && !existingProfile.active) throw new ApiError(403, 'suspended');
  let user = existingProfile as Profile | null;
  if (!user) {
    const email = identity.email?.trim().toLowerCase();
    if (!identity.emailVerified || !email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, 'oauth_email');
    await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`social-email:${email}`]);
    // A matching email alone cannot authorize attachment to a local invite, admin or disabled account.
    if ((await db.query('select id from profiles where lower(email)=lower($1)', [email])).rows.length) throw new ApiError(409, 'oauth_existing');
    const name = String(identity.name || email.split('@')[0]).trim().slice(0, 80) || '학생';
    user = (await db.query("insert into profiles(id,email,name,role,active) values($1,$2,$3,'student',true) returning id,email,name,role,active", [authUserId || randomUUID(), email, name])).rows[0];
  }
  await db.query('insert into social_identities(provider,provider_id,user_id,auth_mode) values($1,$2,$3,$4)', [provider, identity.providerId, user!.id, mode]);
  await db.query('insert into audit_logs(actor_id,student_id,action,data) values($1,$2,$3,$4)', [user!.id, user!.role === 'student' ? user!.id : null, existingProfile ? 'account.social.connected' : 'account.social.created', JSON.stringify({ provider })]);
  return { user: user!, created: !existingProfile };
}
