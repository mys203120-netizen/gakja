import { z } from 'zod';
import { learningTargetIdentityMatches } from '@gakja/content-contracts';
import { schoolQuizTargetIdentity } from '@/lib/school-quiz';
import { requireUser } from '@/lib/auth';
import { ownedInterviewHelpScope,ownedInterviewChatContext } from '@/lib/interview-assistance';
import { getQuizHelpContext } from '@/lib/quiz-assistance';
import { getLearningContext, requireStudent, featureError, FeatureError } from '@/lib/ai';
const id=z.string().trim().min(1).max(160);
export async function GET(request:Request) {
  try {
    const user=await requireUser();requireStudent(user);const url=new URL(request.url);
    const interviewScope=url.searchParams.has('interviewSessionId')?await ownedInterviewHelpScope(user.id,z.string().uuid().parse(url.searchParams.get('interviewSessionId')),z.string().uuid().parse(url.searchParams.get('interviewTurnId'))):null;
    if(url.searchParams.has('quizSessionId')&&!url.searchParams.has('quizItemIndex'))throw new z.ZodError([]);
    const quizScope=url.searchParams.has('quizSessionId')?await getQuizHelpContext(user.id,z.string().uuid().parse(url.searchParams.get('quizSessionId')),z.coerce.number().int().min(0).max(10000).parse(url.searchParams.get('quizItemIndex'))):null;
    const selection={questionId:url.searchParams.has('questionId')?id.parse(url.searchParams.get('questionId')):undefined,activityId:url.searchParams.has('activityId')?id.parse(url.searchParams.get('activityId')):undefined,targetId:url.searchParams.has('targetId')?id.parse(url.searchParams.get('targetId')):undefined,briefingId:url.searchParams.has('briefingId')?z.string().uuid().parse(url.searchParams.get('briefingId')):undefined,sourceVersion:url.searchParams.has('sourceVersion')?z.coerce.number().int().positive().max(100000).parse(url.searchParams.get('sourceVersion')):undefined,allowCommon:true};
    const sourceType=url.searchParams.has('sourceType')?z.enum(['personal','common']).parse(url.searchParams.get('sourceType')):undefined;
    const scopedSelection=quizScope?{...quizScope,allowCommon:true}:{...selection,sourceType};
    const context=interviewScope?await ownedInterviewChatContext(user.id,interviewScope):await getLearningContext(user.id,scopedSelection);
    if(quizScope?.targetSnapshot){const frozen=schoolQuizTargetIdentity(quizScope.targetSnapshot),actual=schoolQuizTargetIdentity(context.target);if(frozen&&(!actual||!learningTargetIdentityMatches(frozen,actual)))throw new FeatureError(409,'퀴즈에 연결된 당시 지원처에서 확인해 주세요.','HELP_CONTEXT_MISMATCH');}
    // Only the owned question and its evidence; model answers are deliberately excluded.
    return Response.json({learning:{questions:context.questions,activities:context.activities,source_refs:context.sources,answer_scripts:[],memory_items:[]},documents:[],briefing:context.briefing,contentVersion:context.contentVersion,...(quizScope?{selection:{questionId:context.questionId,activityId:context.activityId,targetId:context.targetId,briefingId:context.briefingId||null,sourceType:quizScope.sourceType,sourceVersion:quizScope.sourceVersion},quizScope:{sessionId:quizScope.sessionId,itemIndex:quizScope.itemIndex},supportTarget:context.target}:{})},{headers:{'Cache-Control':'private, no-store'}});
  }catch(error){const r=featureError(error);return Response.json({error:r.error,code:r.code},{status:r.status,headers:{'Cache-Control':'private, no-store'}});}
}
