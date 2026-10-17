import {learningTargetIdentityMatches} from '@gakja/content-contracts/workflows';
import {schoolQuizTargetIdentity} from './school-quiz';

/** A stable target ID cannot move a published school question to a new school.
 * Unscoped biography questions remain usable across the student's applications. */
export function publishedQuestionMatchesTarget(question:Record<string,any>,learning:Record<string,any>,target:Record<string,any>|null){
  const ids=Array.isArray(question.support_target_ids)?question.support_target_ids:[];
  if(!ids.length)return true;
  if(!target?.id || !ids.includes(target.id))return false;
  const published=Array.isArray(learning.support_targets)?learning.support_targets.find((row:Record<string,any>)=>row.id===target.id):null;
  return !published || learningTargetIdentityMatches(schoolQuizTargetIdentity(published)!,schoolQuizTargetIdentity(target)!);
}
