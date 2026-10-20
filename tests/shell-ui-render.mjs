import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import assert from 'node:assert/strict';
import React from 'react';
import * as jsx from 'react/jsx-runtime';
import * as icons from 'lucide-react';
import { renderToStaticMarkup } from 'react-dom/server';
import { tsImport } from 'tsx/esm/api';
const search = await tsImport('../apps/web/src/lib/material-search.ts', import.meta.url);
const navigation = await tsImport('../apps/web/src/lib/app-navigation.ts', import.meta.url);
const onboarding = await tsImport('../apps/web/src/lib/student-onboarding.ts', import.meta.url);
const source = ts.transpileModule(fs.readFileSync(new URL('../apps/web/src/components/app-shell.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const target = { id: 'uos', university: '서울시립대학교', department: '환경공학부' };
const bootstrap = { user: { id: 'student', name: '하린',role:'student' }, targets: [target], preferences: {}, notifications: [], learning: { activities: [{ id: 'a1', title: '환경 실험' }], questions: [{ id: 'q1', prompt: '환경 문제는?', support_target_ids: ['uos'] }, { id: 'q2', prompt: '다른 학교 환경 질문', support_target_ids: ['other'] }] } };
const link = ({ href, children, ...props }) => React.createElement('a', { href, ...props }, children);
const wrapper = ({ children }) => React.createElement(React.Fragment, null, children);
function render({ admin = false, path = '/my', query = '', searchOpen = false, moreOpen = false, sidebarCollapsed = false, schoolSwitchOpen = false,account=bootstrap } = {}) {
  const state = [account, '', account.targets[0]?.id||'', false, searchOpen, query, '', 0, false, null, 0, moreOpen, sidebarCollapsed, schoolSwitchOpen]; let index = 0;
  const hooks = { ...React, useEffect() {}, useState(initial) { return [index < state.length ? state[index++] : initial, () => {}]; } };
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, console, Date, Event, require(name) {
    if (name === 'react') return hooks;
    if (name === 'react/jsx-runtime') return jsx;
    if (name === 'next/link') return { default: link };
    if (name === 'next/navigation') return { usePathname: () => path, useRouter: () => ({}) };
    if (name === 'lucide-react') return icons;
    if (name === 'gsap') return { default: {} };
    if (name.endsWith('.module.css')) return { default: new Proxy({}, { get: (_, key) => String(key) }) };
    if (name === '@/lib/app-navigation') return navigation;
    if (name === '@/lib/client/draft-save') return {flushPendingDrafts:async()=>{}};
    if (name === './section-navigation') return { SectionNavigation: () => null };
    if (name === '@/lib/material-search') return search;
    if (name === '@/lib/student-onboarding') return onboarding;
    if (name === './motion') return { PageMotion: wrapper };
    if (name === './help-preferences') return { HelpPreferencesProvider: wrapper };
    if (name === './mobile-tab-swipe') return { MobileTabSwipe: () => null };
    if (name === './mobile-scroll-navigation') return {MobileScrollNavigation:()=>null};
    if (name === './study-session-provider') return { StudySessionProvider: wrapper, finishStudySession() {} };
    if (name === './account-menu') return { AccountMenu: () => React.createElement('span', null, '계정 메뉴') };
    if (name === './resource-panel') return { ResourcePanel: wrapper };
    if (name === './school-logo') return { SchoolLogo: () => null };
    if (name === './shared') return { api() { throw new Error('No network during rendering'); }, post() { throw new Error('No writes during rendering'); }, Logo: ({size,wordmark=true}) => React.createElement('span',{'data-logo-size':size,'data-wordmark':String(wordmark)}), Spinner: () => null, Alert: wrapper, Modal: ({ title, children }) => React.createElement('section', { role: 'dialog', 'aria-label': title }, children), targetName: item => item.university, targetMajor: item => item.department };
    throw new Error(`Unexpected dependency: ${name}`);
  } });
  return renderToStaticMarkup(React.createElement(module.exports.AppShell, { admin }, React.createElement('p', null, '본문')));
}
const empty = render({ searchOpen: true, query: '일치하지 않는 단어' });
assert.ok(empty.includes('검색 결과 0개') && empty.includes('검색 결과가 없어요.'));
assert.ok(empty.includes('검색 초기화') && empty.includes('role="status"'));
assert.ok(empty.includes('선택한 지원처의 예상·공통 질문'));
const results = render({ searchOpen: true, query: '환경' });
assert.ok(results.includes('검색 결과 2개'));
assert.ok(results.includes('/materials/activities/a1') && results.includes('/materials/questions/q1'));
assert.ok(!results.includes('/materials/questions/q2'));
const initial = render({ searchOpen: true });
assert.ok(initial.includes('찾고 싶은 활동이나 질문을 입력해 주세요.') && !initial.includes('검색 결과가 없어요.'));
const admin = render({ admin: true, path: '/admin/reviews', moreOpen: true });
const mobile = admin.match(/<nav class="mobile-nav mobilePrimary"[^>]*>([\s\S]*?)<\/nav>/)?.[1] || '';
assert.equal((mobile.match(/<a /g) || []).length, 4);
assert.ok(mobile.includes('href="/admin/schedules"') && mobile.includes('운영 메뉴 더보기'));
assert.ok(mobile.includes('aria-expanded="true"') && mobile.includes('data-active="true"'));
const additional = admin.match(/<nav class="moreLinks"[^>]*>([\s\S]*?)<\/nav>/)?.[1] || '';
assert.equal((additional.match(/<a /g) || []).length, 6);
assert.ok(additional.includes('href="/admin/reviews" aria-current="page"'));
const desktop = admin.match(/<nav class="main-nav"[^>]*>([\s\S]*?)<\/nav>/)?.[1] || '';
assert.equal((desktop.match(/<a /g) || []).length, 10);
const student = render({path:'/materials/questions/q1'});
const studentRail = student.match(/<nav class="main-nav"[^>]*>([\s\S]*?)<\/nav>/)?.[1] || '';
assert.equal((studentRail.match(/<a /g)||[]).length,3);
assert.ok(studentRail.includes('href="/preparation"')&&studentRail.includes('aria-label="준비 현황"'));
assert.ok(studentRail.includes('href="/my"')&&studentRail.includes('title="오늘 훈련"'));
assert.ok(studentRail.includes('href="/records"')&&studentRail.includes('title="내 기록"'));
const resourceLink=studentRail.match(/<a[^>]*href="\/preparation"[^>]*>/)?.[0]||'';
assert.ok(resourceLink.includes('aria-label="준비 현황"')&&resourceLink.includes('aria-current="page"'));
assert.ok(student.includes('aria-label="각자ON 홈"')&&!student.includes('class="sidebar-tools"'));
assert.ok(student.includes('aria-label="오늘 훈련"')&&student.includes('href="/my"'));
const dockOf=markup=>markup.match(/<nav class="mobile-nav [^"]*"[^>]*aria-label="주 메뉴"[^>]*>([\s\S]*?)<\/nav>/)?.[1]||'';
const dockLinks=dock=>[...dock.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map(match=>({attributes:match[1],body:match[2],href:match[1].match(/href="([^"]+)"/)?.[1]}));
const dock=dockOf(student),links=dockLinks(dock);
assert.deepEqual(links.map(item=>item.href),['/my','/preparation','/records']);
for(const [index,label] of ['오늘 훈련','준비 현황','내 기록'].entries())assert.ok(links[index].attributes.includes(`aria-label="${label}"`) && links[index].body.includes(`<span class="sr-only">${label}</span>`));
assert.ok(links[0].body.includes('data-logo-size="25"')&&links[0].body.includes('data-wordmark="false"'),'mobile home receives the compact brand mark');
assert.ok(!dock.includes('href="/armory"'),'experience editing remains a preparation subroute with three primary destinations');
assert.ok(student.includes('<sup class="brand-on-sup">')&&student.includes('src="/brand-on.png"')&&student.includes('alt="" width="26" height="15"'),'wordmark uses a compact superscript ON without a separating space');
const topbar=student.match(/<header class="topbar">([\s\S]*?)<\/header>/)?.[1]||'';
assert.ok(topbar.includes('<div class="mobileAccount">'),'header account is limited to mobile, where the sidebar is unavailable');
assert.ok(student.includes('class="sidebar-account"'),'desktop keeps the sidebar account entry');
assert.ok(!topbar.includes('href="/on"'),'desktop AI primary link replaces the duplicate header shortcut');
assert.ok(!topbar.includes('locationLabel'),'school context does not repeat the current navigation title');
assert.ok(!topbar.includes('class="mobile-brand"')&&!topbar.includes('data-logo-size='),'student topbar leaves space for the school context');
assert.ok(topbar.includes('<span class="target-copy" aria-hidden="true"><strong>서울시립대학교</strong><small>환경공학부</small></span>'),'school and major have separate visible text elements');
assert.ok(topbar.includes('aria-label="지원 학교 변경 · 서울시립대학교 환경공학부"')&&topbar.includes('aria-haspopup="menu"')&&topbar.includes('aria-expanded="false"'),'school switcher is labelled and announces its closed menu');
const schoolMenu=render({schoolSwitchOpen:true});
assert.ok(schoolMenu.includes('role="menu" aria-label="지원 학교 선택"')&&schoolMenu.includes('role="menuitemradio" aria-checked="true"'),'school picker announces the selected school');
assert.ok(schoolMenu.includes('href="/schools"')&&schoolMenu.includes('지원 학교 관리'),'school picker links directly to school settings');
assert.match(topbar,/<svg[^>]*lucide-chevron-down/,'school switching retains a compact chevron affordance');
const unregisteredAccount={...bootstrap,targets:[],preferences:{schoolCalendarOnboardingCompleted:true}};
for(const path of ['/schools/new','/account','/account/settings']){
 const unregistered=render({path,account:unregisteredAccount,searchOpen:true,query:'환경'});
 assert.ok(!unregistered.includes('aria-label="자료 검색"')&&!unregistered.includes('aria-label="나의 자료 검색"'),'school registration gates both the search launcher and any previously open dialog');
 assert.ok(unregistered.includes('class="unregisteredBrand"')&&unregistered.includes('aria-label="각자ON · 지원 학교 선택"'),'unregistered school context carries the app logo');
 assert.ok(!unregistered.includes('지원처 미등록'),'mobile header does not show a dead school status');
 assert.ok(unregistered.includes('본문'),'account and settings remain available before school registration');
 assert.equal(dockLinks(dockOf(unregistered)).length,0,'no learning routes appear before initial school setup');
 assert.ok(!unregistered.includes('aria-label="주 메뉴"'),'an empty mobile dock is omitted instead of painting a floating pill');
}
assert.equal(studentOnboardingDestinationForHome(),'/schools/new?onboarding=1');
function studentOnboardingDestinationForHome(){return onboarding.studentOnboardingDestination(unregisteredAccount,'/my');}
for(const [path,href] of [
 ['/my/today','/my'],['/quiz/session/answer','/my'],['/chat/interviews/session','/my'],
 ['/my/diagnosis','/my'],['/my/train','/my'],['/availability','/my'],
 ['/on/interviews','/my'],['/on/interviews/new','/my'],['/on/interviews/session','/my'],['/on/interviews/session/turn','/my'],
 ['/on','/my'],['/on/conversation','/my'],['/armory/answer/edit','/preparation'],
 ['/preparation','/preparation'],['/materials/questions/question','/preparation'],['/reports/report','/records'],
]){
 const rendered=render({path});
 assert.deepEqual(dockLinks(dockOf(rendered)).filter(item=>item.attributes.includes('aria-current="page"')).map(item=>item.href),[href],`exactly one mobile area is active for ${path}`);
}
for(const path of ['/on','/on/conversation','/on/interviews-extra']){
 const assistant=render({path});
 assert.match(assistant,/class="app-shell [^"]*\bassistant-shell\b/);
 assert.match(assistant,/<a href="\/my" class="assistant-back icon-button" aria-label="오늘로 돌아가기"/);
 assert.ok(assistant.includes('id="main-content"')&&assistant.includes('본문'),'chat shell keeps the page content and keyboard target');
}
for(const options of [{path:'/my'},{path:'/online'},{path:'/on/interviews'},{path:'/on/interviews/new'},{path:'/on/interviews/session'},{path:'/on/interviews/session/turn'},{admin:true,path:'/on'}]){
 const ordinary=render(options);
 assert.ok(!ordinary.includes('assistant-shell')&&!ordinary.includes('assistant-back'),'assistant shell excludes admin and legacy interview routes');
}
assert.ok(admin.includes('class="mobile-brand" aria-label="관리자 홈"'),'admin topbar keeps its home shortcut');


for(const options of [{},{admin:true,path:'/admin'}]){
 const expanded=render(options),collapsed=render({...options,sidebarCollapsed:true});
 assert.match(expanded,/data-sidebar-collapsed="false"/);
 assert.match(expanded,/<button[^>]+aria-label="메뉴 접기"[^>]+aria-expanded="true"[^>]+aria-controls="desktop-navigation"/);
 assert.match(collapsed,/data-sidebar-collapsed="true"/);
 assert.match(collapsed,/<button[^>]+aria-label="메뉴 펼치기"[^>]+aria-expanded="false"[^>]+aria-controls="desktop-navigation"/);
 assert.ok(collapsed.includes('id="desktop-navigation"'),'toggle controls a real navigation landmark');
 const rail=collapsed.match(/<nav class="main-nav"[^>]*>([\s\S]*?)<\/nav>/)?.[1]||'';
 for(const match of rail.matchAll(/<a ([^>]+)>/g))assert.ok(match[1].includes('aria-label=')&&match[1].includes('title='),'icon links retain an accessible name and pointer tooltip');
}

// Exercise the real shell event handlers and mount effects without browser layout.
function interactiveShell({persisted='true',blocked=false,onboarding=false,admin=false}={}){
 const state=[bootstrap,'','uos',false,false,'','',0,false,null,0,false];
 const refs=[],effects=[],writes=[],events=[];let stateIndex=0,refIndex=0,mounted=false,reads=0,cancelAssistant=false;
 const account=()=>null;
 const hooks={...React,useRef(initial){const index=refIndex++;return refs[index]??=( {current:initial} );},useCallback:fn=>fn,
  useEffect(effect){if(!mounted)effects.push(effect);},
  useState(initial){const index=stateIndex++;if(!(index in state))state[index]=typeof initial==='function'?initial():initial;return [state[index],value=>{state[index]=typeof value==='function'?value(state[index]):value;}];}};
 const module={exports:{}};
 vm.runInNewContext(source,{module,exports:module.exports,console,Date,Event,
  localStorage:{getItem(key){reads++;assert.equal(key,'gakja-sidebar-collapsed');if(blocked)throw Error('Storage blocked');return persisted;},setItem(key,value){if(blocked)throw Error('Storage blocked');writes.push([key,value]);}},
  window:{dispatchEvent(event){events.push(event);if(cancelAssistant)event.preventDefault();return !event.defaultPrevented;}},
  require(name){
   if(name==='react')return hooks;if(name==='react/jsx-runtime')return jsx;
   if(name==='next/link')return {default:'a'};
   if(name==='next/navigation')return {usePathname:()=>admin?'/admin':'/my',useRouter:()=>({replace(){}})};
   if(name==='lucide-react')return icons;if(name==='gsap')return {default:{}};
   if(name.endsWith('.module.css'))return {default:new Proxy({},{get:(_,key)=>String(key)})};
   if(name==='@/lib/app-navigation')return navigation;if(name==='@/lib/material-search')return search;
   if(name==='@/lib/client/draft-save')return {flushPendingDrafts:async()=>{}};
   if(name==='@/lib/student-onboarding')return {studentOnboardingDestination:()=>onboarding?'/schools/register':null};
   if(name==='./section-navigation')return {SectionNavigation:()=>null};if(name==='./motion')return {PageMotion:wrapper};
   if(name==='./help-preferences')return {HelpPreferencesProvider:wrapper};if(name==='./mobile-tab-swipe')return {MobileTabSwipe:()=>null};
   if(name==='./mobile-scroll-navigation')return {MobileScrollNavigation:()=>null};
   if(name==='./study-session-provider')return {StudySessionProvider:wrapper,finishStudySession(){}};
   if(name==='./account-menu')return {AccountMenu:account};if(name==='./resource-panel')return {ResourcePanel:wrapper};
   if(name==='./school-logo')return {SchoolLogo:()=>null};
   if(name==='./shared')return {api:async()=>bootstrap,post:async()=>({}),Logo:()=>null,Spinner:()=>null,Alert:wrapper,Modal:wrapper,targetName:item=>item.university,targetMajor:item=>item.department};
   throw Error(name);
  }});
 return {render(){stateIndex=0;refIndex=0;return module.exports.AppShell({admin,children:jsx.jsx('p',{children:'본문'})});},mount(){mounted=true;for(const effect of effects)effect();},get reads(){return reads;},writes,events,cancelAssistant(){cancelAssistant=true;},account};
}
function descendants(node){if(!node||typeof node!=='object')return [];const children=React.Children.toArray(node.props?.children);return [node,...children.flatMap(descendants)];}
const toggleOf=tree=>descendants(tree).find(node=>node.type==='button'&&node.props.className==='collapseToggle');
for(const admin of [false,true]){
 const session=interactiveShell({admin});
 let tree=session.render();
 assert.equal(tree.props['data-sidebar-collapsed'],'false','first render exposes the menu labels before restoring a saved preference');
 assert.equal(session.reads,0,'storage is not read during rendering');
 session.mount();tree=session.render();
 assert.equal(tree.props['data-sidebar-collapsed'],'true','saved preference is restored after mounting');
 assert.equal(session.reads,1);assert.equal(session.writes.length,0,'mounting does not overwrite the saved preference');
 assert.equal(toggleOf(tree).props['aria-expanded'],false);
 toggleOf(tree).props.onClick();tree=session.render();
 assert.equal(tree.props['data-sidebar-collapsed'],'false');assert.equal(toggleOf(tree).props['aria-expanded'],true);
 toggleOf(tree).props.onClick();tree=session.render();
 assert.equal(tree.props['data-sidebar-collapsed'],'true');assert.equal(toggleOf(tree).props['aria-label'],'메뉴 펼치기');
 assert.deepEqual(session.writes,[['gakja-sidebar-collapsed','false'],['gakja-sidebar-collapsed','true']]);
 const sidebar=descendants(tree).find(node=>node.type==='aside');
 assert.equal(descendants(sidebar).find(node=>node.type===session.account).props.compact,undefined,'bottom account menu keeps opening above its trigger when labels collapse');
 if(!admin){
  const rail=descendants(tree).find(node=>node.props?.id==='desktop-navigation');
  assert.equal(descendants(rail).filter(node=>node.type==='a').length,3);
  assert.equal(descendants(rail).some(node=>node.props?.href==='/preparation'),true);
 }
}
const blockedStorage=interactiveShell({blocked:true});blockedStorage.render();assert.doesNotThrow(()=>blockedStorage.mount());
let blockedTree=blockedStorage.render();assert.doesNotThrow(()=>toggleOf(blockedTree).props.onClick());blockedTree=blockedStorage.render();
assert.equal(blockedTree.props['data-sidebar-collapsed'],'true','clicking works when localStorage throws');
for(const [persisted,expected] of [[null,'false'],['false','false']]){
 const preference=interactiveShell({persisted});preference.render();preference.mount();
 assert.equal(preference.render().props['data-sidebar-collapsed'],expected,'fresh navigation exposes labels and restores an explicit expansion preference');
}
const onboardingShell=interactiveShell({onboarding:true}),onboardingTree=onboardingShell.render();
assert.equal(descendants(onboardingTree).filter(node=>node.type==='a'&&node.props.href==='/on').length,0,'initial school setup does not expose the AI navigation early');
const locked=descendants(onboardingTree).filter(node=>node.type==='a'&&node.props['aria-disabled']==='true'&&String(node.props['aria-label']).includes('학교 등록 후 이용'));
assert.equal(locked.length,3,'unregistered rail reuses exactly the three primary navigation entries');
assert.deepEqual(locked.map(node=>node.props.href),['/my','/preparation','/records']);
assert.ok(locked.every(node=>descendants(node).some(child=>child.props?.className==='navigationLock')),'every locked menu includes a visible lock mark');
for(const node of locked){let prevented=false;node.props.onClick({preventDefault(){prevented=true;}});assert.equal(prevented,true);}
console.log('Shell UI passed: desktop/mobile routes, accessible sidebar toggling, preference restoration, blocked storage, onboarding and interview pause guard.');
