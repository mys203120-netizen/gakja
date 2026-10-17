import assert from 'node:assert/strict';
import {test} from 'node:test';
import {experienceSchema} from '../apps/web/src/lib/armory-model';
import {interviewPreviewHref,interviewSetupHref} from '../apps/web/src/lib/interview-flow';
const draft={title:'경험',category:'협업',situation:'',action:'',result:'',confirmed:false};
test('incomplete memories can be drafts but cannot be confirmed',()=>{
 assert.equal(experienceSchema.safeParse(draft).success,true);
 assert.equal(experienceSchema.safeParse({...draft,confirmed:true}).success,false);
 assert.equal(experienceSchema.safeParse({...draft,situation:'상황',action:'내 행동',confirmed:true}).success,true);
});
test('card identity and version survive Chat/Live switching and preview',()=>{
 const params=new URLSearchParams('questionId=common_test&experienceCardId=card-test&experienceRevision=3&sourceType=common');
 const live=new URL(interviewSetupHref('video',params,{targetId:'target-test'}),'http://localhost');
 const chat=new URL(interviewSetupHref('chat',live.searchParams),'http://localhost');
 const preview=new URL(interviewPreviewHref(chat.searchParams,'target-test'),'http://localhost');
 assert.equal(preview.searchParams.get('experienceCardId'),'card-test');
 assert.equal(preview.searchParams.get('experienceRevision'),'3');
 assert.equal(preview.searchParams.get('questionId'),'common_test');
 assert.equal(preview.searchParams.get('targetId'),'target-test');
});
