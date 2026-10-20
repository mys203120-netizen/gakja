import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const code=ts.transpileModule(readFileSync('apps/web/src/components/account-menu.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const nodes=(value:any):any[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];
const text=(value:any):string=>typeof value==='string'?value:Array.isArray(value)?value.map(text).join(''):value?.props?text(value.props.children):'';
function harness(){
  const hooks:any[]=[],effects:any[]=[],pending:Function[]=[];let cursor=0,tree:any,calls=0,complete!:(error?:Error)=>void;
  const mod={exports:{} as any};
  vm.runInNewContext(code,{module:mod,exports:mod.exports,document:{body:{}},require(name:string){if(name==='./owned-class-name'||name==='@/components/owned-class-name')return {ownedClassName:(value:string|undefined)=>value};
    if(name==='react')return {useId:()=> 'account-menu',useRef:(initial:any)=>hooks[cursor++]??={current:initial},useState:(initial:any)=>{const index=cursor++;if(!(index in hooks))hooks[index]=initial;return [hooks[index],(value:any)=>{hooks[index]=typeof value==='function'?value(hooks[index]):value;}];},useEffect:effect,useLayoutEffect:effect};
    if(name==='react/jsx-runtime')return {jsx:(type:any,props:any)=>({type,props}),jsxs:(type:any,props:any)=>({type,props})};
    if(name==='next/link')return {default:'Link'};if(name==='next/navigation')return {usePathname:()=>'/my'};
    if(name==='react-dom')return {createPortal:(child:any)=>child};if(name==='lucide-react')return {};
    throw Error(name);
  }});
  function effect(fn:Function,deps:any[]){const index=cursor++,previous=effects[index];if(!previous||deps.some((value,i)=>!Object.is(value,previous.deps[i]))){effects[index]={deps};pending.push(()=>{previous?.cleanup?.();effects[index].cleanup=fn();});}}
  function render(){cursor=0;tree=mod.exports.AccountMenu({name:'테스트 학생',admin:false,onLogout:()=>{calls++;return new Promise<void>((resolve,reject)=>{complete=error=>error?reject(error):resolve();});}});while(pending.length)pending.shift()!();return tree;}
  const logout=()=>nodes(tree).find(node=>node.type==='button'&&node.props.role==='menuitem');
  return {render,logout,get calls(){return calls;},get tree(){return tree;},open(){nodes(render()).find(node=>node.type==='button'&&node.props['aria-haspopup']==='menu').props.onClick();render();},async settle(error?:Error){complete(error);await new Promise(resolve=>setImmediate(resolve));render();}};
}

test('logout starts immediately, saves through its callback once and displays inline failure with an accessible retry',async()=>{
  const h=harness();h.open();assert.equal(nodes(h.tree).some(node=>node.type==='dialog'),false);h.logout().props.onClick();h.logout().props.onClick();h.render();
  assert.equal(h.calls,1);assert.equal(h.logout().props.disabled,true);assert.match(text(h.logout()),/저장하고 로그아웃 중/);assert.equal(nodes(h.tree).some(node=>node.type==='dialog'),false);
  const link=nodes(h.tree).find(node=>node.type==='Link');let prevented=false;link.props.onClick({preventDefault(){prevented=true;}});assert.equal(prevented,true,'navigation cannot unmount a writer during logout');
  await h.settle(new Error('초안을 보관하지 못했어요.'));assert.equal(nodes(h.tree).find(node=>node.props.role==='alert').props.children,'초안을 보관하지 못했어요.');assert.equal(h.logout().props.disabled,false);
  h.logout().props.onClick();h.render();assert.equal(h.calls,2);await h.settle();assert.equal(nodes(h.tree).some(node=>node.props.role==='alert'),false);assert.equal(nodes(h.tree).some(node=>node.type==='dialog'),false);assert.equal(h.logout().props.disabled,true,'keep the menu stable until the successful navigation replaces it');
});
