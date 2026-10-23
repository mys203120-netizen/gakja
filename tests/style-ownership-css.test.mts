import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync,readdirSync} from 'node:fs';
import postcss from 'postcss';
import local from 'next/dist/compiled/postcss-modules-local-by-default/index.js';
import scope from 'next/dist/compiled/postcss-modules-scope/index.js';

test('root owns document foundation and no feature stylesheet imports',()=>{
 const layout=readFileSync('apps/web/src/app/layout.tsx','utf8');
 assert.deepEqual([...layout.matchAll(/import ['"]\.\/(.+\.css)['"]/g)].map(m=>m[1]),['globals.css']);
 const ast=postcss.parse(readFileSync('apps/web/src/app/globals.css','utf8'));
 ast.walkRules(rule=>{
  if(rule.parent?.type==='atrule'&&rule.parent.name.endsWith('keyframes'))return;
  assert.doesNotMatch(rule.selector,/\.(?:app-shell|button|quiz|auth|topbar|sidebar|school|chat|calendar|interview|records)/);
  assert.doesNotMatch(rule.selector,/data-chat-composer/);
 });
});
test('every ownership stylesheet compiles in CSS Modules pure mode',async()=>{
 const names=readdirSync('apps/web/src/styles').filter(name=>name.endsWith('.module.css'));
 assert.equal(names.length,15);
 for(const name of names){
  const css=readFileSync('apps/web/src/styles/'+name,'utf8');
  assert.doesNotMatch(css,/@apply|@import/,'owned components use ordinary CSS rather than hidden global imports');
  const result=await postcss([local({mode:'pure'}),scope({generateScopedName:(className:string)=>'owned_'+className})]).process(css,{from:name});
  assert.match(result.css,/:export\s*\{/);
 }
});
test('keyboard focus, forced colors and motion remain explicit component states',()=>{
 const controls=readFileSync('apps/web/src/styles/controls.module.css','utf8');
 assert.match(controls,/border:1px solid ButtonText !important/);
 assert.match(controls,/focus-visible:where\(\.element\)/);
 assert.match(controls,/outline:2px solid var\(--clarity-green\) !important/);
 assert.match(controls,/\.motion-toggle-track,\.motion-toggle-thumb \{ transition:none/);
 const rail=readFileSync('apps/web/src/components/navigation-rail.module.css','utf8');
 assert.match(rail,/nav\.mobile-nav\) \{ opacity:1; translate:0 0; pointer-events:auto; transition:none/);
 assert.match(rail,/nav\.mobile-nav:has\(:focus-visible\)/);
 assert.match(rail,/@media\(prefers-reduced-motion:reduce\)[^\n]*nav\.mobile-nav[^\n]*transition:none!important/);
 assert.match(rail,/nav\.mobile-nav\[data-scroll-active=true\]/);
});

test('shared animation names use explicit tokens across CSS Module compilers',()=>{
 const foundation=postcss.parse(readFileSync('apps/web/src/app/globals.css','utf8'));
 const names=new Set<string>();foundation.walkDecls(/^--gakja-keyframe-/,decl=>{names.add(decl.prop);});
 assert.ok(names.size>0);
 for(const file of readdirSync('apps/web/src/styles').filter(name=>name.endsWith('.module.css'))){
  const css=readFileSync('apps/web/src/styles/'+file,'utf8');
  assert.doesNotMatch(css,/(?:animation|animation-name):[^;}]*global\(/,'Turbopack must never receive CSS Loader-only animation syntax');
  for(const match of css.matchAll(/var\((--gakja-keyframe-[\w-]+)\)/g))assert.ok(names.has(match[1]),`declared motion token: ${match[1]}`);
 }
});
