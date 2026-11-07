import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

// Keep this entry point when reverting the auth implementation. Missing auth
// modules fail closed; the legacy single-student engine is never imported.
export async function startServiceRealtime() {
  if (process.env.INTERVIEW_EXECUTION_MODE && process.env.INTERVIEW_EXECUTION_MODE !== 'service') {
    throw new Error('SERVICE_MODE_REQUIRED');
  }
  const [auth, jwt, transport] = await Promise.all([
    import(new URL('../server/auth/request-identity.ts', import.meta.url).href),
    import(new URL('../server/auth/jose-jwt-verifier.ts', import.meta.url).href),
    import(new URL('../server/request-realtime-server.ts', import.meta.url).href),
  ]);
  const port = Number(process.env.REALTIME_PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('SERVICE_PORT_INVALID');
  const deploymentFile=process.env.INTERVIEW_G_DEPLOYMENT_FILE;
  if(deploymentFile){
    const {createProductionServiceComposition}=await import(new URL('../server/service/production-composition.ts',import.meta.url).href);
    const composition=await createProductionServiceComposition({deployment:JSON.parse(await readFile(deploymentFile,'utf8'))});
    const service=composition.createServer({webPort:Number(process.env.WEB_PORT??3000)});
    service.server.listen(port,'127.0.0.1');service.server.on('error',()=>{process.exitCode=1;});
    const stop=()=>{void service.close().finally(()=>composition.close());};process.once('SIGTERM',stop);process.once('SIGINT',stop);
    return {...service,composition};
  }
  const identity = auth.createRequestIdentityBoundary({ mode: 'service', verifier: jwt.trustedJwtVerifierFromEnv() });
  const service = transport.createServiceRealtimeServer({ identity, webPort: Number(process.env.WEB_PORT ?? 3000) });
  service.server.listen(port, '127.0.0.1');
  service.server.on('error', () => { process.exitCode = 1; });
  const stop = () => { void service.close(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  return service;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServiceRealtime().catch(() => { console.error('SERVICE_BOUNDARY_UNAVAILABLE'); process.exitCode = 1; });
}
