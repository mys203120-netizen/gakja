import { z } from 'zod';
export type PreflightStatus='pass'|'fail'|'blocked'|'not-run';
export interface PreflightCheck {id:string;status:PreflightStatus;evidence:string[]}
export interface ServicePreflight {version:'scoped-service-preflight-v1';ready:boolean;checks:PreflightCheck[];commercialCalls:number;operatingChanges:number;commercialValidation:'not-run';featureReadiness:{requests:boolean;sessionWrites:boolean;evaluation:boolean}}
const text=z.string().min(1);
export const deploymentConfigSchema=z.object({version:z.literal('scoped-service-deployment-v1'),
  responsibility:z.object({environmentId:text,startsAt:z.string().datetime(),endsAt:z.string().datetime(),observer:text,stopOwner:text,recoveryOwner:text,storageRetentionOwner:text}).strict(),
  bindings:z.array(z.object({ownerId:text,studentId:text,applicationTargetId:text,supportTargetId:text,sourceRevision:z.string().min(1).nullable().optional(),runId:text,plan:z.unknown()}).strict()).min(1).max(64),
  reviewSynchronization:z.object({assertionPath:text,maxAgeMs:z.number().int().positive()}).strict().optional(),
}).strict();
export type ServiceDeploymentConfig=z.infer<typeof deploymentConfigSchema>;
const required:Record<string,readonly string[]>={auth:['INTERVIEW_AUTH_ISSUER','INTERVIEW_AUTH_AUDIENCE','INTERVIEW_AUTH_JWKS_URL','INTERVIEW_AUTH_ALGORITHMS'],
  'database-roles':['INTERVIEW_DB_REQUEST_URL','INTERVIEW_DB_MAPPING_URL','INTERVIEW_DB_WORKER_URL'],storage:['INTERVIEW_STORAGE_API_URL','INTERVIEW_STORAGE_SERVICE_KEY','INTERVIEW_STORAGE_BUCKET','INTERVIEW_STORAGE_KEY_PREFIX'],
  providers:['OPENAI_API_KEY','CLOVA_VOICE_CLIENT_ID','CLOVA_VOICE_CLIENT_SECRET','CLOVA_SPEECH_SECRET_KEY']};
export type ServicePreflightProbes=Partial<Record<'auth'|'account-mapping'|'database-roles'|'migrations-rls-fk'|'storage'|'review-trust'|'providers'|'transition-scope',()=>Promise<Omit<PreflightCheck,'id'>>>>;
/** Presence is never a connectivity, approval, commercial-call or RLS result.
 * Probes must be explicitly supplied; no operating endpoint is auto-discovered. */
export async function runServicePreflight(options:{environment?:Readonly<Record<string,string|undefined>>;deployment?:unknown;probes?:ServicePreflightProbes}={}):Promise<ServicePreflight>{
  const env=options.environment??{},parsed=deploymentConfigSchema.safeParse(options.deployment),checks:PreflightCheck[]=[];
  const suppliedDeployment=options.deployment!==undefined;
  function invalidConfiguration(id:string){
    try{
      if(id==='auth'){for(const key of ['INTERVIEW_AUTH_ISSUER','INTERVIEW_AUTH_JWKS_URL']){const url=new URL(env[key]!);if(url.protocol!=='https:'||url.username||url.password||url.hash)return true;}if(!env.INTERVIEW_AUTH_ALGORITHMS!.split(',').every(value=>['RS256','RS384','RS512','PS256','PS384','PS512','ES256','ES384','ES512','EdDSA'].includes(value)))return true;}
      if(id==='database-roles')for(const role of ['REQUEST','MAPPING','WORKER']){const url=new URL(env['INTERVIEW_DB_'+role+'_URL']!);if(!['postgres:','postgresql:'].includes(url.protocol)||decodeURIComponent(url.username)!=='gakja_'+role.toLowerCase()||!url.password||url.hash)return true;}
      if(id==='storage'){const url=new URL(env.INTERVIEW_STORAGE_API_URL!);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!['','/storage/v1'].includes(url.pathname.replace(/\/$/u,''))||!/^[a-z0-9][a-z0-9-]{2,62}$/u.test(env.INTERVIEW_STORAGE_BUCKET!)||!/^[a-zA-Z0-9_-]{8,64}$/u.test(env.INTERVIEW_STORAGE_KEY_PREFIX!))return true;}
      if(id==='providers'&&required.providers.some(key=>/\s/u.test(env[key]!)))return true;
      return false;
    }catch{return true;}
  }
  for(const id of ['auth','account-mapping','database-roles','migrations-rls-fk','storage','review-trust','providers','transition-scope'] as const){
    const absent=(required[id]??[]).filter(key=>!env[key]?.trim());let base:PreflightCheck;
    if(suppliedDeployment&&!parsed.success&&['account-mapping','transition-scope','review-trust'].includes(id))base={id,status:'fail',evidence:['DEPLOYMENT_CONFIGURATION_INVALID']};
    else if(!absent.length&&invalidConfiguration(id))base={id,status:'fail',evidence:['CONFIGURATION_INVALID']};
    else if(absent.length)base={id,status:'blocked',evidence:['CONFIGURATION_MISSING',...absent]};
    else if(['account-mapping','transition-scope'].includes(id)&&!parsed.success)base={id,status:'blocked',evidence:['EXPLICIT_DEPLOYMENT_SCOPE_AND_RESPONSIBILITY_REQUIRED']};
    else if(id==='review-trust'&&(!parsed.success||!parsed.data.reviewSynchronization))base={id,status:'blocked',evidence:['EXTERNAL_REVIEW_SYNCHRONIZATION_POLICY_UNSET']};
    else base={id,status:'not-run',evidence:['EXPLICIT_READ_ONLY_VERIFICATION_NOT_RUN']};
    if(base.status==='not-run'&&options.probes?.[id]){try{const actual=await options.probes[id]!();base={id,status:actual.status,evidence:actual.evidence.filter(value=>/^[A-Z0-9_:-]{1,160}$/u.test(value))};}catch{base={id,status:'fail',evidence:['READ_ONLY_PROBE_FAILED']};}}
    checks.push(base);
  }
  const passed=(ids:string[])=>ids.every(id=>checks.find(check=>check.id===id)?.status==='pass');
  const requests=passed(['auth','account-mapping','database-roles','migrations-rls-fk','storage','transition-scope']);
  const writes=checks.find(check=>check.id==='transition-scope')?.evidence.includes('TRANSITION_DB_PRIMARY_FINITE_WRITE_ENABLED')===true;
  return {version:'scoped-service-preflight-v1',ready:requests,checks,commercialCalls:0,operatingChanges:0,commercialValidation:'not-run',featureReadiness:{requests,sessionWrites:requests&&writes&&passed(['providers']),evaluation:requests&&writes&&checks.every(check=>check.status==='pass')}};
}
export function parseServiceDeployment(value:unknown):ServiceDeploymentConfig{return deploymentConfigSchema.parse(value);}
