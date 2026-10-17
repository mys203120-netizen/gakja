import { z } from 'zod';
import { requireUser,checkOrigin } from '@/lib/auth';
import { ApiError,errorResponse } from '@/lib/db';
import { getGrowthPayload,analyzeOwnedRecording,transcribeOwnedQuizRecording } from '@/lib/speech-growth-store';
import { FeatureError,featureError } from '@/lib/ai';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=90;
const headers={'Cache-Control':'private, no-store'};
const uuid=z.string().uuid();
export async function GET(request:Request) {
  try {
    const params=new URL(request.url).searchParams,scope:Record<string,string>={};
    for(const key of ['sessionId','reportId','studySessionId'])if(params.get(key)){const result=uuid.safeParse(params.get(key));if(!result.success)throw new ApiError(400,'기록 주소를 확인해 주세요.');scope[key]=result.data;}
    return Response.json(await getGrowthPayload(await requireUser(),scope),{headers});
  }catch(error){return errorResponse(error);}
}
export async function POST(request:Request) {
  try {
    checkOrigin(request);const user=await requireUser();
    const raw=await request.text();if(raw.length>100_000)throw new ApiError(413,'시간 측정 자료가 너무 커요.');
    let input;try{input=JSON.parse(raw);}catch{throw new ApiError(400,'요청 형식을 확인해 주세요.');}
    const parsed=z.object({action:z.enum(['analyze','transcribe']),recordingId:uuid,kind:z.enum(['interview','quiz']),speechTelemetry:z.unknown().optional()}).safeParse(input);
    if(!parsed.success)throw new ApiError(400,'분석할 녹음을 선택해 주세요.');
    if(parsed.data.action==='transcribe'){
      if(parsed.data.kind!=='quiz')throw new ApiError(400,'면접 전사는 녹음·전사 화면에서 생성해 주세요.');
      return Response.json(await transcribeOwnedQuizRecording(user,parsed.data.recordingId),{headers});
    }
    return Response.json(await analyzeOwnedRecording(user,parsed.data),{headers});
  }catch(error){if(error instanceof FeatureError){const result=featureError(error);return Response.json({error:result.error,code:result.code},{status:result.status,headers});}return errorResponse(error);}
}
