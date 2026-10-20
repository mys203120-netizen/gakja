import assert from 'node:assert/strict';
import {test} from 'node:test';
import {nextTrainingStep,trainingSequence,trainingStepHref} from '../apps/web/src/lib/training-flow';

const task=(id:string,kind='focus',extra={})=>({id,kind,title:id,minutes:25,...extra});
test('daily order excludes rest and keeps reflection after unfinished lessons without mutating the source',()=>{
 const tasks=[task('review','review'),task('focus'),task('break','break'),task('recall','recall')];
 assert.deepEqual(trainingSequence(tasks).map(row=>row.id),['focus','recall','review']);
 assert.equal(tasks[0].id,'review');
});
test('the actual next step skips saved completion and the confirmed current lesson but keeps other work',()=>{
 const tasks=[task('saved','focus',{performedAt:'2026-10-21'}),task('done','recall',{completed:true}),task('current'),task('manual','other',{manual:true}),task('review','review'),task('next')];
 assert.equal(nextTrainingStep(tasks,'current')?.id,'next');
 assert.equal(nextTrainingStep([task('current'),task('review','review')],'current')?.id,'review');
 assert.equal(nextTrainingStep([task('current')],'current'),null);
});
test('manual resources preserve their actual route and automatic lessons open their owned plan wrapper',()=>{
 const manual=task('material','reading',{manual:true,href:'/materials/questions/q1'});
 assert.equal(nextTrainingStep([manual])?.id,'material');assert.equal(trainingStepHref(manual),'/materials/questions/q1');
 assert.equal(trainingStepHref(task('plan id')),'/my/train?planId=plan%20id');
});
