import 'server-only';
import {ApiError,query} from './db';
import {getLearning} from './data';
import {safeAssignment} from './learning-workflows';
import type {LearningData} from '@gakja/content-contracts';

/** An old assignment is fetched by its owner and ID, never by a recent overview find(). */
export async function getStudentAssignment(studentId:string,id:string){
 const [assignment]=await query('select * from quiz_assignments where student_id=$1 and id=$2',[studentId,id]);
 if(!assignment)throw new ApiError(404,'과제를 찾을 수 없어요.');
 const [attempts,events,content]=await Promise.all([
  // One persisted submission per assignment/item; latest-per-item also handles legacy duplicates.
  query('select distinct on(memory_item_id) * from quiz_submissions where student_id=$1 and assignment_id=$2 order by memory_item_id,submitted_at desc,id desc',[studentId,id]),
  query('select e.*,p.name as actor_name from quiz_assignment_events e join profiles p on p.id=e.actor_id where e.student_id=$1 and e.assignment_id=$2 order by e.created_at desc,e.id desc limit 30',[studentId,id]),
  assignment.source_kind==='common'||!assignment.package_id?Promise.resolve(null):getLearning(studentId,Number(assignment.content_version)).catch(error=>{if(error instanceof ApiError&&error.status===404)return null;throw error;}),
 ]);
 return safeAssignment(assignment,attempts,events,content?.learning as LearningData|undefined);
}
