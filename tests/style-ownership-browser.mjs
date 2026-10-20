import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import postcss from 'postcss';
import local from 'next/dist/compiled/postcss-modules-local-by-default/index.js';
import scope from 'next/dist/compiled/postcss-modules-scope/index.js';
import ts from 'typescript';
import {chromium} from '@playwright/test';

let checks=0;function check(value,label){assert.ok(value,label);checks++;}
async function compile(file){const namespace=path.basename(file).replace(/\W/g,'_');const result=await postcss([local({mode:'pure'}),scope({generateScopedName:name=>`qa_${namespace}_${name}`})]).process(fs.readFileSync(file,'utf8'),{from:file});const exports={};result.root.walkRules(':export',rule=>rule.walkDecls(decl=>{exports[decl.prop]=decl.value;}));return {css:result.css,exports};}
const ownerFiles=[...fs.readFileSync('apps/web/src/components/owned-class-name.ts','utf8').matchAll(/import \w+ from '@\/styles\/([^']+)'/g)].map(m=>'apps/web/src/styles/'+m[1]);
const owners=await Promise.all(ownerFiles.map(compile));
const rail=await compile('apps/web/src/components/navigation-rail.module.css'),shell=await compile('apps/web/src/components/shell-refinement.module.css'),modal=await compile('apps/web/src/components/modal.module.css');
const features=await Promise.all(['training-hub','training-calendar','records-toolbar','quiz-session-ui','school-registration','live-interview-session'].map(name=>compile(`apps/web/src/components/${name}.module.css`)));
const byHook={},elements=[];
for(const {exports} of owners)for(const [hook,classes] of Object.entries(exports)){if(hook==='element')elements.push(...classes.split(/\s+/));else byHook[hook]=[...(byHook[hook]||[]),...classes.split(/\s+/)];}
const css=fs.readFileSync('apps/web/src/app/globals.css','utf8')+owners.map(o=>o.css).join('\n')+rail.css+shell.css+modal.css;
const markup=`<div class="app-shell ${rail.exports.collapsibleShell} ${rail.exports.studentShell} ${shell.exports.shell}"><aside class="sidebar"><nav class="main-nav"><a href="#today">오늘 훈련</a><a href="#preparation">준비 현황</a></nav></aside><div class="app-body"><header class="topbar"><div class="topbar-context"><strong>각자ON</strong></div><div class="topbar-actions"><button id="search" class="icon-button" aria-label="검색">⌕</button></div></header><main class="main-content" style="min-height:2600px"><div class="page-title"><h1>오늘 훈련</h1></div><button id="primary" class="button primary">훈련 시작</button><button id="choice" aria-pressed="true">주제 선택</button><input id="answer" aria-label="답변"><button id="toggle" class="motion-toggle-button" role="switch" aria-checked="true"><span class="motion-toggle-track"><span class="motion-toggle-thumb"></span></span></button><section id="route-content"><h2>오늘의 순서</h2></section></main><nav class="mobile-nav ${shell.exports.mobilePrimary}" aria-label="주 메뉴"><a id="nav-today" href="#today">○</a><a href="#preparation">□</a><a href="#records">↶</a></nav></div></div>`;
const code=ts.transpileModule(fs.readFileSync('apps/web/src/lib/client/scroll-navigation.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:390,height:844}});
async function setup(width=390,reduced='no-preference'){
 await page.setViewportSize({width,height:844});await page.emulateMedia({reducedMotion:reduced,forcedColors:'none'});
 await page.setContent(`<style>${css}</style>${markup}`);
 await page.evaluate(({byHook,elements})=>{for(const node of document.body.querySelectorAll('*')){const classes=[...node.classList];for(const hook of classes)for(const alias of byHook[hook]||[])node.classList.add(alias);node.classList.add(...elements);}}, {byHook,elements});
 await page.evaluate(()=>scrollTo({top:0,behavior:'instant'}));
 await page.addScriptTag({content:`(()=>{const module={exports:{}};const exports=module.exports;${code};window.stopScrollNavigation=module.exports.installScrollNavigation(document.querySelector('nav.mobile-nav'));})();`});
 await page.waitForTimeout(600);
}
const stable=()=>page.evaluate(()=>{const selectors=['.topbar','nav.mobile-nav','#primary','#answer'];return selectors.map(selector=>{const s=getComputedStyle(document.querySelector(selector));return [s.display,s.width,s.padding,s.backgroundColor,s.color,s.borderRadius,s.fontWeight,s.transitionDuration];});});
try{
 for(const width of [390,700,701,1280]){
  await setup(width);const value=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,display:getComputedStyle(document.querySelector('nav.mobile-nav')).display,padding:getComputedStyle(document.querySelector('.main-content')).paddingLeft,right:getComputedStyle(document.querySelector('.main-content')).paddingRight,button:getComputedStyle(document.querySelector('#primary')).backgroundColor,ink:getComputedStyle(document.querySelector('#primary')).color,weight:getComputedStyle(document.querySelector('#primary')).fontWeight}));
  check(value.scroll<=width,`no horizontal overflow at ${width}`);check(value.display===(width<=700?'grid':'none'),`navigation breakpoint at ${width}`);check(value.padding===value.right,`balanced gutters at ${width}`);check(value.button==='rgb(0, 237, 119)'&&value.ink==='rgb(34, 13, 42)'&&value.weight==='600',`brand button contract at ${width}: ${JSON.stringify(value)}`);
 }
 await setup();const before=await stable();for(const feature of features)await page.addStyleTag({content:feature.css});const after=await stable();assert.deepEqual(after,before,'loading other route modules cannot change shell or common controls');checks++;
 await setup();for(const feature of [...features].reverse())await page.addStyleTag({content:feature.css});assert.deepEqual(await stable(),before,'route loading order preserves the shell and controls');checks++;
 await page.evaluate(()=>{const button=document.createElement('button');button.id='external';button.className='button primary';button.textContent='External widget';document.body.append(button);});
 check(await page.locator('#external').evaluate(node=>getComputedStyle(node).backgroundColor)!=='rgb(0, 237, 119)','unowned external controls do not receive owned button appearance');
 await page.locator('#external').hover();check(await page.locator('#external').evaluate(node=>getComputedStyle(node).scale)==='none','unowned buttons do not receive the shared hover motion');
 await setup();check(await page.locator('nav.mobile-nav').evaluate(node=>getComputedStyle(node).opacity)==='0','navigation starts hidden');
 await page.evaluate(()=>scrollTo({top:200,behavior:'instant'}));await page.waitForTimeout(700);check(await page.locator('nav.mobile-nav').getAttribute('data-scroll-active')==='true','downward scroll shows the dock');check(Number(await page.locator('nav.mobile-nav').evaluate(node=>getComputedStyle(node).opacity))>.99,'show transition reaches full opacity');
 await page.waitForTimeout(800);check(await page.locator('nav.mobile-nav').getAttribute('data-scroll-active')==='false','inactivity switches to hidden after 1.4 seconds');const fading=Number(await page.locator('nav.mobile-nav').evaluate(node=>getComputedStyle(node).opacity));check(fading>0&&fading<1,'dock fades instead of blinking out');await page.waitForTimeout(850);check(Number(await page.locator('nav.mobile-nav').evaluate(node=>getComputedStyle(node).opacity))<.01,'fade completes');
 await page.evaluate(()=>scrollTo({top:100,behavior:'instant'}));await page.waitForTimeout(80);check(await page.locator('nav.mobile-nav').getAttribute('data-scroll-active')==='false','upward scroll keeps navigation hidden');
 await page.keyboard.press('Tab');await page.locator('#choice').focus();const focus=await page.locator('#choice').evaluate(node=>({visible:node.matches(':focus-visible'),outline:getComputedStyle(node).outlineWidth}));check(focus.visible&&focus.outline==='2px','selected controls keep keyboard focus');
 await page.locator('#nav-today').focus();await page.waitForTimeout(650);check(Number(await page.locator('nav.mobile-nav').evaluate(node=>getComputedStyle(node).opacity))>.99,'keyboard focus keeps dock available');
 await page.emulateMedia({forcedColors:'active'});await page.locator('#answer').focus();const forced=await page.locator('#answer').evaluate(node=>({border:getComputedStyle(node).borderTopWidth,outline:getComputedStyle(node).outlineWidth}));check(forced.border==='1px'&&forced.outline==='2px',`forced colors restores field border and keyboard outline: ${JSON.stringify(forced)}`);
 await setup(390,'reduce');const motion=await page.evaluate(()=>({duration:getComputedStyle(document.querySelector('nav.mobile-nav')).transitionDuration,translate:getComputedStyle(document.querySelector('nav.mobile-nav')).translate,toggle:getComputedStyle(document.querySelector('.motion-toggle-thumb')).transitionDuration}));check(motion.duration==='0.5s'&&['0px','0px 0px'].includes(motion.translate),`reduced motion retains only the dock fade: ${JSON.stringify(motion)}`);check(motion.toggle==='0s','toggle respects reduced motion');
 console.log(`Style ownership browser regression passed: ${checks} checks (390/700/701/1280, route order, focus, forced colors, smooth directional navigation).`);
}finally{await browser.close();}
