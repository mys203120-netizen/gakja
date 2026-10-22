import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source=ts.transpileModule(readFileSync('apps/web/src/components/school-picker.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const nodes=(value:any):any[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];
function harness(){
 const hooks:any[]=[],effects:any[]=[],pending:Function[]=[],changes:string[]=[],focused:string[]=[],scrolled:any[]=[];let cursor=0,tree:any,dirty=true;
 const props={label:'지원 학과',choices:[{id:'env',label:'환경공학부'},{id:'econ',label:'경제학부'}],value:'',onChange:(value:string)=>changes.push(value),placeholder:'학과 선택',disabled:false};
 const react={useId:()=> 'picker',useState(initial:any){const index=cursor++;if(!(index in hooks))hooks[index]=initial;return [hooks[index],(value:any)=>{hooks[index]=typeof value==='function'?value(hooks[index]):value;dirty=true;}];},useRef(initial:any){return hooks[cursor++]??={current:initial};},useEffect(callback:Function,deps:any[]){const index=cursor++,old=effects[index];if(!old||deps.some((value,i)=>!Object.is(value,old.deps[i]))){effects[index]={deps};pending.push(()=>{old?.cleanup?.();effects[index].cleanup=callback();});}}};
 const jsx={jsx:(type:any,props:any)=>({type,props}),jsxs:(type:any,props:any)=>({type,props})},module={exports:{} as any};
 vm.runInNewContext(source,{module,exports:module.exports,document:{addEventListener(){},removeEventListener(){}},CSS:{escape:(text:string)=>text},require(name:string){
  if(name==='react')return react;if(name==='react/jsx-runtime')return jsx;if(name==='./owned-class-name')return {ownedClassName:(value:any)=>value};
  if(name==='lucide-react')return {Check:'Check',Ellipsis:'Ellipsis',Search:'Search'};
  if(name.endsWith('.module.css'))return {default:new Proxy({},{get:(_,key)=>String(key)})};throw Error(name);
 }});
 function render(){cursor=0;tree=module.exports.SchoolPicker(props);for(const node of nodes(tree)){if(!node.props?.ref)continue;node.props.ref.current=node.type==='input'?{focus:()=>focused.push('search')}:node.type==='button'?{focus:()=>focused.push('trigger')}:{contains:()=>true,querySelector:(selector:string)=>({scrollIntoView:(options:any)=>scrolled.push({selector,options})})};}return tree;}
 function flush(){for(let i=0;i<10;i++){if(!dirty)return;dirty=false;render();while(pending.length)pending.shift()!();}throw Error('Unexpected render loop');}
 function key(key:string,composing=false,keyCode=0){const event={key,keyCode,nativeEvent:{isComposing:composing},prevented:false,stopped:false,preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;}};return event;}
 return {props,changes,focused,scrolled,key,render,flush,get tree(){return tree;},open(){nodes(tree).find(node=>node.props?.['aria-haspopup']==='listbox').props.onClick();flush();},input(){return nodes(tree).find(node=>node.type==='input');},option(){return nodes(tree).find(node=>node.props?.role==='option');},disable(){props.disabled=true;dirty=true;}};
}

test('Korean IME Enter and Escape keep composition and the picker open; a later Enter selects the intended option',()=>{
 const h=harness();h.flush();h.open();h.input().props.onChange({target:{value:'환경'}});h.flush();
 for(const event of [h.key('Enter',true),h.key('Enter',false,229),h.key('Escape',true)]){h.input().props.onKeyDown(event);h.tree.props.onKeyDown(event);h.flush();assert.equal(event.prevented,false);assert.ok(h.input());assert.equal(h.changes.length,0);}
 const enter=h.key('Enter');h.input().props.onKeyDown(enter);h.flush();assert.equal(enter.prevented,true);assert.deepEqual(h.changes,['env']);assert.equal(h.input(),undefined);assert.ok(h.focused.includes('trigger'));
});

test('becoming disabled closes the open list and blocks option clicks before the closing effect runs',()=>{
 const h=harness();h.flush();h.open();h.disable();h.render();const option=h.option();assert.equal(option.props.disabled,true);option.props.onClick();assert.deepEqual(h.changes,[]);
 h.input().props.onKeyDown(h.key('Enter'));assert.deepEqual(h.changes,[]);h.flush();assert.equal(h.input(),undefined);
});

test('arrow selection, Escape focus return and empty searches remain available without submitting the form',()=>{
 const h=harness();h.flush();h.open();const arrow=h.key('ArrowDown');h.input().props.onKeyDown(arrow);h.flush();assert.equal(arrow.prevented,true);assert.equal(h.scrolled.length,1);
 h.input().props.onKeyDown(h.key('Enter'));h.flush();assert.deepEqual(h.changes,['econ']);
 h.open();h.input().props.onChange({target:{value:'없는학과'}});h.flush();h.input().props.onKeyDown(h.key('Enter'));assert.deepEqual(h.changes,['econ']);
 const escape=h.key('Escape');h.tree.props.onKeyDown(escape);h.flush();assert.equal(escape.prevented,true);assert.equal(escape.stopped,true);assert.equal(h.input(),undefined);assert.ok(h.focused.includes('trigger'));
});
