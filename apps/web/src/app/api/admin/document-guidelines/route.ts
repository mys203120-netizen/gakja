import {z} from 'zod';
import {checkOrigin,requireUser} from '@/lib/auth';
import {ApiError,errorResponse} from '@/lib/db';
import {GUIDELINE_KINDS} from '@/lib/student-document-model';
import {documentGuidelines,saveDocumentGuideline} from '@/lib/student-document-service';
import {curriculumPolicySchema} from '@/lib/curriculum-policy';
export const runtime='nodejs';
async function admin(){const user=await requireUser();if(user.role!=='admin')throw new ApiError(403,'관리자만 운영 지침을 변경할 수 있어요.');return user;}
export async function GET(){try{await admin();return Response.json(await documentGuidelines(),{headers:{'Cache-Control':'private, no-store'}});}catch(error){return errorResponse(error);}}
export async function POST(request:Request){try{
  checkOrigin(request);const user=await admin();
  const input=z.object({kind:z.enum(GUIDELINE_KINDS),body:z.string().trim().min(10).max(20_000),publish:z.boolean(),review:z.boolean().optional(),rules:curriculumPolicySchema.optional()}).strict().parse(await request.json());
  if(input.kind==='curriculum'&&!input.rules)throw new ApiError(400,'커리큘럼의 시간 배분 규칙을 입력해 주세요.');
  if(input.kind!=='curriculum'&&input.rules)throw new ApiError(400,'시간 배분 규칙은 커리큘럼 지침에서 설정해 주세요.');
  return Response.json(await saveDocumentGuideline(user.id,input),{status:201});
}catch(error){return errorResponse(error instanceof z.ZodError?new ApiError(400,'지침 본문과 시간 배분 규칙의 입력 범위를 확인해 주세요.'):error);}}
