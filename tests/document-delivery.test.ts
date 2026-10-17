import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { createDemoPack, renderLearningHtml, parseLearningHtml } from '../packages/content-contracts/src/index';
const require = createRequire(import.meta.url);
class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }
function load(path:string,mocks:Record<string,unknown>,globals:Record<string,unknown>={}) {
  const module={exports:{} as any};
  const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(code,{module,exports:module.exports,require:(name:string)=>name in mocks?mocks[name]:require(name),Buffer,Request,Response,URL,...globals});return module.exports;
}
const [pack]=createDemoPack('00000000-0000-4000-8000-000000000001','Synthetic','environment');
const base=renderLearningHtml(pack);
const html=base+'<!--'+'x'.repeat(5*1024*1024-Buffer.byteLength(base)-7)+'-->';
const document={id:'00000000-0000-4000-8000-000000000002',kind:'guidebook',html,file_hash:createHash('sha256').update(html).digest('hex'),data:pack.document};
function harness() {
  const state={mode:'supabase',exists:false,uploadError:null as any,infoError:null as any,signError:false,uploads:0,signs:0};
  const storage={info:async()=>({error:state.infoError||(state.exists?null:{statusCode:'404'})}),upload:async(path:string,bytes:Buffer,options:any)=>{state.uploads++;assert.equal(path,`${document.id}/${document.file_hash}.html`);assert.equal(bytes.toString(),html);assert.equal(options.upsert,false);return {error:state.uploadError};},createSignedUrl:async(_path:string,ttl:number)=>{state.signs++;assert.equal(ttl,60);return {data:{signedUrl:'https://storage.example.test/signed'},error:state.signError};}};
  const delivery=load('apps/web/src/lib/document-delivery.ts',{'server-only':{},'./db':{ApiError},'@supabase/supabase-js':{createClient:()=>({storage:{from:(bucket:string)=>{assert.equal(bucket,'document-originals');return storage;}}})}},{process:{env:{get AUTH_MODE(){return state.mode;},NEXT_PUBLIC_SUPABASE_URL:'https://storage.example.test',SUPABASE_SERVICE_ROLE_KEY:'synthetic-secret'}}});
  return {state,delivery};
}
test('valid 5MiB original produces a small metadata response without HTML or structured body',async()=>{
  assert.equal(Buffer.byteLength(html),5242880);assert.equal(parseLearningHtml(html).fileHash,document.file_hash);
  const {delivery,state}=harness();const result=await delivery.documentDelivery(document,'/local');
  assert.ok(Buffer.byteLength(JSON.stringify(result))<1024);assert.equal(result.html,undefined);assert.equal(result.data,undefined);assert.equal(state.uploads,1);
  state.exists=true;await delivery.documentDelivery(document,'/local');assert.equal(state.uploads,1);assert.equal(state.signs,2);
});
test('storage failures and tampering fail closed; concurrent immutable upload is allowed',async()=>{
  const {delivery,state}=harness();
  await assert.rejects(delivery.documentDelivery({...document,file_hash:'wrong'},'/local'),{status:409});assert.equal(state.uploads,0);
  state.uploadError={statusCode:'500'};await assert.rejects(delivery.documentDelivery(document,'/local'),{status:503});assert.equal(state.signs,0);
  state.uploadError={statusCode:'409'};await delivery.documentDelivery(document,'/local');
  state.infoError={statusCode:'403'};await assert.rejects(delivery.documentDelivery(document,'/local'),{status:503});
  state.infoError=null;state.exists=true;state.signError=true;await assert.rejects(delivery.documentDelivery(document,'/local'),{status:503});
});
test('local raw delivery is no-store and inert; hosted raw delivery is forbidden',async()=>{
  const {delivery,state}=harness();assert.throws(()=>delivery.localDocumentResponse(html),{status:400});
  state.mode='local';assert.equal((await delivery.documentDelivery(document,'/local')).original_url,'/local');
  const response=delivery.localDocumentResponse(html);assert.equal(await response.text(),html);assert.equal(response.headers.get('Cache-Control'),'private, no-store');assert.match(response.headers.get('Content-Type'),/text\/plain/);assert.equal(state.uploads,0);
});
for(const preview of [false,true])test(`${preview?'staff preview':'student read'} authenticates and validates before issuing original URLs`,async()=>{
  const {delivery,state}=harness();let allowed=true,valid=true,role=preview?'staff':'student',found=true;
  const version={id:document.id,package_id:'package',version:1,review:{}};
  const route=load(preview?'apps/web/src/app/api/imports/[id]/preview/route.ts':'apps/web/src/app/api/documents/route.ts',{
    '@/lib/auth':{requireUser:async()=>{if(!allowed)throw new ApiError(401,'inactive');return {id:'student',role};},requireStaff:async()=>{if(!allowed)throw new ApiError(403,'unassigned');}},
    '@/lib/db':{ApiError,query:async(sql:string)=>sql.includes('from documents')?[document]:found?[version]:[],errorResponse:(error:ApiError)=>Response.json({error:error.message},{status:error.status})},
    '@/lib/content-publication':{validatePublication:()=>{if(!valid)throw new ApiError(409,'invalid');},publicationDigest:()=> 'digest'},'@/lib/document-delivery':delivery,
  });
  const get=()=>route.GET(new Request('http://local/api/documents'),{params:Promise.resolve({id:document.id})});
  assert.equal((await get()).status,200);assert.equal(state.signs,1);
  allowed=false;assert.equal((await get()).status,401);allowed=true;
  role=preview?'student':'staff';assert.equal((await get()).status,403);role=preview?'staff':'student';
  found=false;assert.equal((await get()).status,404);found=true;
  valid=false;assert.equal((await get()).status,409);assert.equal(state.signs,1);
});

test('browser fetches and verifies original bytes before extracting the structured book',async()=>{
  const { webcrypto } = await import('node:crypto');
  let ok=true,body=html,parses=0;
  class Parser { parseFromString(value:string) { parses++;assert.equal(value,html);return {querySelector:(selector:string)=>{assert.equal(selector,'script#gakja-learning-pack');return {textContent:JSON.stringify(pack)};}}; } }
  const client=load('apps/web/src/lib/document-delivery-client.ts',{}, {crypto:webcrypto,TextDecoder,Uint8Array,DOMParser:Parser,fetch:async(url:string,options:any)=>{assert.equal(url,'https://storage.example.test/signed');assert.equal(options.referrerPolicy,'no-referrer');return new Response(body,{status:ok?200:403});}});
  const descriptor={original_url:'https://storage.example.test/signed',file_hash:document.file_hash};
  const result=await client.loadDocumentOriginal(descriptor);assert.equal(result.html,html);assert.equal(result.data.kind,'guidebook');assert.equal(parses,1);
  body+='tampered';await assert.rejects(client.loadDocumentOriginal(descriptor),/확인할 수/);assert.equal(parses,1);
  ok=false;await assert.rejects(client.loadDocumentOriginal(descriptor),/다시 열어/);assert.equal(parses,1);
});
