import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JSONWebKeySet, type JWTVerifyGetKey } from 'jose';
import { RequestAccessError, type PrincipalVerifier, type VerifiedPrincipal } from './request-identity';

const supportedAlgorithms = new Set(['RS256', 'ES256', 'EdDSA']);
interface TrustBase { issuer: string; audience: string | readonly string[]; algorithms: readonly string[]; now?: () => number }
export type TrustedJwtOptions = TrustBase & ({ jwks: JSONWebKeySet; jwksUrl?: never; keyResolver?: never } |
  { jwksUrl: string; jwks?: never; keyResolver?: never } | { keyResolver: JWTVerifyGetKey; jwks?: never; jwksUrl?: never });

/** Trust configuration is supplied by server composition, never the token header. */
export function createTrustedJwtVerifier(options: TrustedJwtOptions): PrincipalVerifier {
  const audience = typeof options.audience === 'string' ? [options.audience] : [...options.audience];
  if (!options.issuer.trim() || options.issuer !== options.issuer.trim() || !audience.length || audience.some(value => !value.trim() || value !== value.trim()) || !options.algorithms.length ||
    options.algorithms.some(value => !supportedAlgorithms.has(value))) throw new RequestAccessError(503, 'AUTH_UNAVAILABLE');
  let key: JWTVerifyGetKey;
  try {
    if (options.jwks) key = createLocalJWKSet(structuredClone(options.jwks));
    else if (options.keyResolver) key = options.keyResolver;
    else {
      const url = new URL(options.jwksUrl!);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Invalid trusted key endpoint');
      key = createRemoteJWKSet(url, { timeoutDuration: 5_000, cooldownDuration: 30_000, cacheMaxAge: 300_000 });
    }
  } catch { throw new RequestAccessError(503, 'AUTH_UNAVAILABLE'); }
  const issuer = options.issuer, algorithms = [...options.algorithms], now = options.now ?? Date.now;
  return Object.freeze({
    kind: 'trusted-jwt' as const,
    async verify(token: string): Promise<VerifiedPrincipal> {
      try {
        const { payload } = await jwtVerify(token, key, {
          issuer, audience, algorithms, requiredClaims: ['iss', 'sub', 'aud', 'exp'], currentDate: new Date(now()), clockTolerance: 0,
        });
        if (typeof payload.sub !== 'string' || !payload.sub.trim() || payload.sub !== payload.sub.trim() ||
          typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || !Number.isFinite(payload.exp * 1000) ||
          payload.iat !== undefined && (!Number.isFinite(payload.iat) || payload.iat * 1000 > now()) ||
          payload.jti !== undefined && (typeof payload.jti !== 'string' || !payload.jti.trim())) {
          throw new RequestAccessError(401, 'AUTH_INVALID');
        }
        return Object.freeze({ issuer: payload.iss!, subject: payload.sub, expiresAt: payload.exp * 1000,
          ...(payload.iat === undefined ? {} : { issuedAt: payload.iat * 1000 }), ...(payload.jti === undefined ? {} : { tokenId: payload.jti }) });
      } catch (error) {
        if (error instanceof RequestAccessError) throw error;
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        if (code === 'ERR_JWT_EXPIRED') throw new RequestAccessError(401, 'AUTH_EXPIRED');
        // Missing/unavailable/malformed trusted key material is an infrastructure
        // failure. Signature/claim/algorithm rejection is an authentication failure.
        if (/^ERR_(?:JWT_|JWS_|JOSE_ALG_NOT_ALLOWED|JWKS_NO_MATCHING_KEY)/u.test(code)) throw new RequestAccessError(401, 'AUTH_INVALID');
        throw new RequestAccessError(503, 'AUTH_UNAVAILABLE');
      }
    },
  });
}

export function trustedJwtVerifierFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): PrincipalVerifier | undefined {
  const values = [env.INTERVIEW_AUTH_ISSUER, env.INTERVIEW_AUTH_AUDIENCE, env.INTERVIEW_AUTH_JWKS_URL, env.INTERVIEW_AUTH_ALGORITHMS];
  if (values.every(value => !value)) return undefined;
  if (values.some(value => !value || value !== value.trim())) throw new RequestAccessError(503, 'AUTH_UNAVAILABLE');
  return createTrustedJwtVerifier({ issuer: values[0]!, audience: values[1]!, jwksUrl: values[2]!, algorithms: values[3]!.split(',') });
}
