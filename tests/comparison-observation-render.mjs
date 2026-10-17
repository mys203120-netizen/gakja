import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';
import React from 'react';
import * as runtime from 'react/jsx-runtime';
import {renderToStaticMarkup} from 'react-dom/server';
import {tsImport} from 'tsx/esm/api';

function load(file,require) {
  const module={exports:{}};
  const source=fs.readFileSync(new URL(file,import.meta.url),'utf8');
  const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(output,{module,exports:module.exports,require});return module.exports;
}
const growth=await tsImport('../apps/web/src/lib/learning-growth.ts',import.meta.url);
const {ComparisonObservation}=load('../apps/web/src/components/comparison-observation.tsx',name=>{
  if(name==='react/jsx-runtime')return runtime;
  if(name==='@/lib/learning-growth')return growth;
  throw new Error(name);
});
const before={id:'a',question_id:'q',script:'참여했습니다.',created_at:'2026-01-01T23:55:00Z',revision_kind:'interview_answer',response_mode:'text',content_version:1};
const after={...before,id:'b',script:'제 담당은 채취 조건을 정하고 측정표를 작성하는 일이었습니다.',created_at:'2026-01-02T00:00:00Z',comparison:{required_meanings:[{text:'본인 역할'}]},assistance_recorded:true};
const render=(a,b)=>renderToStaticMarkup(React.createElement(ComparisonObservation,{before:a,after:b}));
const view=render(before,after);
assert.ok(view.includes('바로 재답변')&&view.includes('입력한 답변'));
assert.ok(view.includes('도움 조회 기록 없음'));
assert.ok(view.includes(after.script));
assert.ok(!view.includes('결과·한계')&&!view.includes('음성으로'));
assert.ok(render(before,{...after,assistance_recorded:false}).includes('도움 여부 미기록'));
assert.ok(render(before,{...after,revision_kind:'transcript_correction'}).includes('같은 발화의 인식 오류'));
assert.ok(render(before,{...after,revision_kind:'answer_edit'}).includes('작성 내용 수정'));
assert.ok(render(before,{...after,script:'제 담당은 앞으로 측정표를 작성할 계획입니다.'}).includes('자동으로 찾은 문장이 없어요'));
assert.ok(render(before,{...after,created_at:'2026-01-05T00:00:00Z'}).includes('시간이 지난 재답변'));
assert.ok(!render(before,{...after,created_at:'2026-01-05T00:00:00Z'}).includes('복습 예정 시점 이후'));
console.log('Comparison observation: 10 real React render assertions passed; no external calls.');
