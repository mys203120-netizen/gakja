// node --conditions=react-server --import tsx tests/social-auth.mts
// Provider responses below are synthetic. No external OAuth request or account is created.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadProjectEnv, projectRoot } from '../scripts/load-env.mjs';
loadProjectEnv();
const base = JSON.parse(readFileSync(join(projectRoot,'.local/server.json'),'utf8')).url;
if (process.env.AUTH_MODE !== 'local' || !['localhost','127.0.0.1'].includes(new URL(process.env.DATABASE_URL!).hostname) || !['localhost','127.0.0.1'].includes(new URL(base).hostname)) throw new Error('소셜 인증 검증은 로컬 DB와 서버에서만 실행해 주세요.');
registerHooks({resolve(specifier,context,nextResolve) { return specifier === 'server-only' ? {url:pathToFileURL(join(projectRoot,'node_modules/next/dist/compiled/server-only/empty.js')).href,shortCircuit:true} : nextResolve(specifier,context); }});
const { pool, ApiError } = await import('../apps/web/src/lib/db.ts');
const { provisionSocialStudent } = await import('../apps/web/src/lib/social-auth-provision.ts');
const { directSocialUrl, exchangeDirectSocial, supabaseSocialProfile } = await import('../apps/web/src/lib/social-auth.ts');
const { socialNext } = await import('../apps/web/src/lib/social-auth-rules.ts');
const db = await pool.connect(), fixture = randomUUID(), users: string[] = [], attempts: string[] = [];
let checks = 0;
function check(value: unknown, message: string) { assert.ok(value,message); checks++; }
const digest = (value:string) => createHash('sha256').update(value).digest('hex');
async function provision(provider:'google'|'kakao', identity:any, mode:'local'|'supabase'='local', userId?:string) {
  await db.query('begin');
  try { const result = await provisionSocialStudent(db,provider,identity,mode,userId); await db.query('commit'); if (!users.includes(result.user.id)) users.push(result.user.id); return result; }
  catch(error) { await db.query('rollback'); throw error; }
}
async function rejects(work:Promise<unknown>, code:string) { await assert.rejects(work,(error:any) => error instanceof ApiError && error.message === code); checks++; }
const identity = (suffix:string, extra:any={}) => ({providerId:`synthetic-${fixture}-${suffix}`,email:`oauth-${suffix}-${fixture}@gakja.test`,emailVerified:true,name:'소셜 인증 격리 검증',...extra});
async function attempt(options:{provider?:string;expired?:boolean}={}) {
  const state = randomBytes(32).toString('base64url'), browser = randomBytes(32).toString('base64url'), key = digest(state); attempts.push(key);
  await db.query("insert into oauth_login_attempts(state_hash,browser_hash,provider,auth_mode,next_path,expires_at) values($1,$2,$3,'local','/my',now()+$4::interval)",[key,digest(browser),options.provider||'google',options.expired?'-1 minute':'10 minutes']);
  return {state,browser,key};
}
const callback = async (a:any, provider='google', browser=a.browser, state=a.state) => fetch(`${base}/api/auth/callback/${provider}?state=${state}&error=access_denied`,{headers:browser?{Cookie:`gakja_oauth_browser=${browser}`}:{},redirect:'manual'});
try {
  for(const path of ['https://evil.test','//evil.test','/admin','/api/auth','/\\evil.example','/my\\evil','/quiz/../../admin','/onboarding/../../api/auth','/my\nLocation: evil']) check(socialNext(path)==='/my',`unsafe redirect blocked: ${JSON.stringify(path)}`);
  check(socialNext('/quiz/session/abcd?mode=choice')==='/quiz/session/abcd?mode=choice','student child route retained');
  check(socialNext('/quiz','staff')==='/admin','staff always returns to administration');
  // Email and social login must share the same redirect boundary; helper tests alone
  // would miss the previous email-only startsWith check being reintroduced.
  const authScreen = readFileSync(join(projectRoot,'apps/web/src/components/auth-screen.tsx'),'utf8');
  const emailSuccess = authScreen.slice(authScreen.indexOf("if (mode === 'login' || result.user)"),authScreen.indexOf("setNotice(result.message"));
  check(emailSuccess.includes("router.push(socialNext(next, result.user?.role || 'student'))") && !emailSuccess.includes('next.startsWith'),'email login success uses the tested safe redirect boundary');
  const first = await provision('google',identity('first',{role:'admin',active:false}));
  check(first.created && first.user.role==='student' && first.user.active===true,'new provider student role and active are server-owned');
  const repeat = await provision('google',identity('first',{email:'changed@gakja.test',name:'바뀐 이름'}));
  check(!repeat.created && repeat.user.id===first.user.id && repeat.user.email===first.user.email,'same identity keeps original account and fields');
  await db.query("update profiles set role='admin' where id=$1",[first.user.id]);
  check((await provision('google',identity('first'))).user.role==='admin','existing admin role preserved');
  await db.query('update profiles set active=false where id=$1',[first.user.id]);
  await rejects(provision('google',identity('first')),'suspended');
  check((await db.query('select active,role from profiles where id=$1',[first.user.id])).rows[0].active===false,'disabled account not reactivated');
  await rejects(provision('kakao',identity('collision',{email:first.user.email})),'oauth_existing');
  await rejects(provision('kakao',identity('no-email',{email:null,emailVerified:false})),'oauth_email');
  await rejects(provision('google',identity('unverified',{emailVerified:false})),'oauth_email');
  const kakao = await provision('kakao',identity('kakao'));
  check(kakao.created && kakao.user.id!==first.user.id,'Kakao identity creates separate owned student');
  const supabaseId = randomUUID(), sb = await provision('google',identity('supabase'),'supabase',supabaseId);
  check(sb.user.id===supabaseId && sb.user.role==='student','Supabase auth UUID preserved with server student role');
  await db.query("update profiles set role='staff',active=false where id=$1",[supabaseId]);
  await rejects(provision('kakao',identity('pending'),'supabase',supabaseId),'suspended');
  await rejects(provision('kakao',identity('kakao'),'supabase',randomUUID()),'oauth_existing');
  const accessToken='synthetic-access-token'; let requested:{url:string;init:any}[]=[];
  const googleFetch = (async(url:any,init:any) => {requested.push({url:String(url),init});return Response.json(requested.length===1?{access_token:accessToken}:{sub:'google-synthetic-sub',email:'test@example.com',email_verified:true,name:'학생'});}) as typeof fetch;
  const request = new Request(base), verifier = randomBytes(48).toString('base64url');
  const oldGoogleId = process.env.GOOGLE_CLIENT_ID, oldGoogleSecret = process.env.GOOGLE_CLIENT_SECRET;
  process.env.GOOGLE_CLIENT_ID='synthetic-client'; process.env.GOOGLE_CLIENT_SECRET='synthetic-secret';
  try {
    const authUrl = new URL(directSocialUrl('google',request,'synthetic-state',verifier));
    check(authUrl.origin==='https://accounts.google.com' && authUrl.searchParams.get('code_challenge_method')==='S256' && authUrl.searchParams.get('state')==='synthetic-state','Google authorization uses state and PKCE');
    const profile = await exchangeDirectSocial('google','synthetic-code',request,verifier,googleFetch);
    check(profile.emailVerified && profile.providerId==='google-synthetic-sub','Google identity comes from authenticated provider userinfo');
    check(String(requested[0].init.body).includes('code_verifier=') && requested[1].init.headers.Authorization===`Bearer ${accessToken}`,'Google token exchange and userinfo authorization');
    check(requested.every(call=>call.init.redirect==='error'&&call.init.cache==='no-store'),'provider tokens have no redirect/cache exposure');
    await rejects(exchangeDirectSocial('google','synthetic-code',request,null,googleFetch),'oauth_state');
  } finally { if(oldGoogleId===undefined)delete process.env.GOOGLE_CLIENT_ID;else process.env.GOOGLE_CLIENT_ID=oldGoogleId;if(oldGoogleSecret===undefined)delete process.env.GOOGLE_CLIENT_SECRET;else process.env.GOOGLE_CLIENT_SECRET=oldGoogleSecret; }
  let kakaoCall=0; const kakaoFetch=(async()=>Response.json(++kakaoCall===1?{access_token:accessToken}:{id:123456789,kakao_account:{email:'test@example.com',is_email_valid:true,is_email_verified:false,profile:{nickname:'학생'}}})) as typeof fetch;
  check(!(await exchangeDirectSocial('kakao','synthetic-code',request,null,kakaoFetch)).emailVerified,'Kakao requires both validity and ownership flags');
  const sbUser:any={id:supabaseId,email:'test@example.com',email_confirmed_at:'2026-10-12',identities:[{id:'provider-sub',user_id:supabaseId,provider:'google',identity_data:{email_verified:true,full_name:'학생'}}],user_metadata:{role:'admin'}};
  check(supabaseSocialProfile(sbUser,'google').providerId==='provider-sub','Supabase uses server validated linked provider identity');
  assert.throws(()=>supabaseSocialProfile({...sbUser,identities:[]},'google'));checks++;
  const publicAuth=await fetch(base+'/api/auth'), publicBody=await publicAuth.json();
  check(publicAuth.status===200 && typeof publicBody.providers?.google==='boolean' && typeof publicBody.providers?.kakao==='boolean','anonymous provider readiness endpoint');
  check(publicAuth.headers.get('cache-control')==='private, no-store' && !JSON.stringify(publicBody).includes('CLIENT_SECRET'),'readiness response does not leak keys or cache identity');
  check((await fetch(base+'/api/auth/apple/start',{redirect:'manual'})).status===404,'unknown provider denied');
  for(const p of ['google','kakao']) if(!publicBody.providers[p]) { const response=await fetch(`${base}/api/auth/${p}/start?next=https://evil.test`,{redirect:'manual'});check(response.status===307 && response.headers.get('location')===`${base}/login?error=${p}_not_configured`,'unconfigured start remains inside app with truthful error'); }
  const invalid=await attempt();
  check((await callback(invalid,'google','')).headers.get('location')?.endsWith('error=oauth_state'),'missing browser cookie denied');
  check((await callback(invalid,'google',randomBytes(32).toString('base64url'))).headers.get('location')?.endsWith('error=oauth_state'),'wrong browser denied');
  check((await callback(invalid,'kakao')).headers.get('location')?.endsWith('error=oauth_state'),'provider mismatch denied');
  check((await db.query('select state_hash from oauth_login_attempts where state_hash=$1',[invalid.key])).rows.length===1,'invalid callback cannot consume another browser attempt');
  const expired=await attempt({expired:true});check((await callback(expired)).headers.get('location')?.endsWith('error=oauth_state'),'expired callback denied');
  const valid=await attempt(), accepted=await callback(valid);
  check(!accepted.headers.get('location')?.endsWith('error=oauth_state'),'matching browser and state accepted before cancellation/config check');
  check((await db.query('select state_hash from oauth_login_attempts where state_hash=$1',[valid.key])).rows.length===0,'accepted state consumed atomically');
  check((await callback(valid)).headers.get('location')?.endsWith('error=oauth_state'),'callback replay denied');
  const token=randomBytes(32).toString('hex');await db.query("insert into sessions(id,user_id,expires_at) values($1,$2,now()+interval '1 hour')",[digest(token),kakao.user.id]);
  const bootstrap=await fetch(base+'/api/bootstrap',{headers:{Cookie:`gakja_session=${token}`}}), bootstrapBody=await bootstrap.json();
  check(bootstrap.status===200&&bootstrapBody.user.id===kakao.user.id&&!bootstrapBody.package&&bootstrapBody.targets.length===0,'new social student has safe owned empty bootstrap');
  check(bootstrapBody.learning.activities.length===0&&bootstrapBody.learning.questions.length===0,'new user never inherits tester learning data');
  console.log(`Social auth: ${checks} checks passed; external OAuth requests: 0.`);
} finally {
  await db.query('delete from oauth_login_attempts where state_hash=any($1::text[])',[attempts]);
  await db.query('delete from sessions where user_id=any($1::uuid[])',[users]);
  await db.query('delete from audit_logs where actor_id=any($1::uuid[]) or student_id=any($1::uuid[])',[users]);
  await db.query('delete from social_identities where user_id=any($1::uuid[])',[users]);
  await db.query('delete from profiles where id=any($1::uuid[])',[users]);
  db.release(); await pool.end();
}
