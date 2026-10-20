import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createOwnedClassResolver} from '../apps/web/src/lib/owned-class-resolver';

test('style ownership keeps DOM hooks and adds aliases deterministically',()=>{
 const resolve=createOwnedClassResolver([{button:'control-button',element:'control-element'},{question:'practice-question',element:'layout-element'}]);
 assert.equal(resolve('button primary question'),'button primary question control-button practice-question');
 assert.equal(resolve('button primary question',true),'button primary question control-button practice-question control-element layout-element');
 assert.equal(resolve(resolve('button',true),true),'button control-button control-element layout-element');
 assert.equal(resolve('external-widget'),'external-widget');
 assert.equal(resolve(undefined),undefined);
 assert.equal(resolve(undefined,true),'control-element layout-element');
});
test('portal and new native controls receive defaults without an app ancestor',()=>{
 const resolve=createOwnedClassResolver([{element:'control-element',button:'control-button'}]);
 assert.equal(resolve('button',true),'button control-button control-element');
 assert.equal(resolve('',true),'control-element');
});
test('resolver handles composed classes, prototype-like hooks and bounded cache churn',()=>{
 const resolve=createOwnedClassResolver([{button:'module-button composed-button',element:'module-element'}]);
 assert.equal(resolve('__proto__ constructor button'),'__proto__ constructor button module-button composed-button');
 for(let n=0;n<3000;n++)resolve('record-'+n,true);
 assert.equal(resolve('button',true),'button module-button composed-button module-element');
});
