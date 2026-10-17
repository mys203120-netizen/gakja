/** Resolve a server redirect origin at request time, never from client build constants. */
export function resolveAppOrigin(request: Request, environment: NodeJS.ProcessEnv = process.env): string {
  // NEXT_PUBLIC_* direct property references are replaced during `next build`, even
  // in server bundles. Keep the legacy setting runtime-readable for local port
  // selection; APP_URL is the preferred server-only deployment setting.
  const configured = environment.APP_URL?.trim() || environment.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) {
    const url = new URL(configured);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid_app_origin');
    return url.origin;
  }
  if (environment.NODE_ENV === 'production') throw new Error('missing_app_origin');
  const url = new URL(request.url);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('invalid_app_origin');
  const host = request.headers.get('host') ?? url.host;
  const origin = new URL(`${url.protocol}//${host}`);
  // A Host value must be a single authority, not a credential, path, or URL.
  if (origin.host !== host || origin.username || origin.password || origin.pathname !== '/') throw new Error('invalid_app_origin');
  return origin.origin;
}
