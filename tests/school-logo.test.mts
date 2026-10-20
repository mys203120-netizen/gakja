import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync,existsSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as fitLibrary from '../apps/web/src/lib/school-logo-fit.ts';
import * as jsx from 'react/jsx-runtime';
import {renderToStaticMarkup} from 'react-dom/server';

const source=ts.transpileModule(readFileSync('apps/web/src/components/school-logo.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
function harness(){
 let failed:string|null=null;const module={exports:{} as any};
 vm.runInNewContext(source,{module,exports:module.exports,Math,require(name:string){if(name==='react')return {useState:()=>[failed,(value:string|null)=>{failed=value;}]};if(name==='react/jsx-runtime')return jsx;if(name==='@/lib/school-logo-fit')return fitLibrary;throw Error(name);}});
 return {render(school:any,size=34){return module.exports.SchoolLogo({school,size});}};
}

test('every configured directory logo blends its real image pixels without a white image backdrop',()=>{
 const catalog=JSON.parse(readFileSync('apps/web/src/data/school-directory.json','utf8')).schools;
 const h=harness();let count=0;
 for(const school of catalog){
  if(!school.logoUrl)continue;
  const rendered=h.render(school),img=rendered.props.children;
  assert.equal(img.type,'img',school.university);assert.equal(img.props.style.mixBlendMode,'multiply',school.university);
  assert.equal(img.props.style.width,'100%');assert.equal(img.props.style.height,'100%');
  assert.ok(renderToStaticMarkup(rendered).includes('mix-blend-mode:multiply'),school.university);count++;
 }
 assert.ok(count>=80,'the actual shared component covers the complete catalog, not a school-specific wrapper');
});

test('UNIST aliases retain the visible wide blue mark and Ajou retains the enlarged seal',()=>{
 const h=harness();
 for(const university of ['울산과학기술원 UNIST','유니스트','UNIST']){
  const rendered=h.render({university}),img=rendered.props.children;
  assert.equal(rendered.props.style.width,56);assert.equal(rendered.props.style.height,34);
  assert.ok(existsSync('apps/web/public'+img.props.src));assert.ok(img.props.style.filter.includes('brightness(0)'));
 }
 const ajou=h.render({university:'아주대학교',logoUrl:'/school-logos/0000146.jpg'});
 assert.equal(ajou.props.style.width,34);assert.equal(ajou.props.children.props.style.objectFit,'cover');assert.equal(ajou.props.children.props.style.transform,'scale(1.22)');
});

test('a failed image still resolves to the university fallback',()=>{
 const h=harness(),school={university:'검증대학교',logoUrl:'/unavailable.png'};
 h.render(school).props.children.props.onError();const fallback=h.render(school);
 assert.equal(fallback.props.className,'school-logo-fallback');assert.equal(fallback.props.children,'검증');
});
