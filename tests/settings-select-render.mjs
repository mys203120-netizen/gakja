import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import assert from 'node:assert/strict';
import React from 'react';
import * as jsx from 'react/jsx-runtime';
import * as icons from 'lucide-react';

const source=ts.transpileModule(fs.readFileSync(new URL('../apps/web/src/components/settings-select.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
const selectedValues=[],listeners=new Map(),refs=[],states=[],effects=[];
let stateIndex=0,refIndex=0,triggerFocus=0,focused=-1;
const document={activeElement:null,addEventListener:(name,handler)=>listeners.set(name,handler),removeEventListener:(name,handler)=>{if(listeners.get(name)===handler)listeners.delete(name);}};
const buttons=Array.from({length:3},(_,index)=>({focus(){focused=index;document.activeElement=this;}}));
const root={querySelectorAll:()=>buttons,contains:node=>buttons.includes(node)||node===root};
const hooks={...React,useId:()=>':settings:',useRef:initial=>refs[refIndex++]??={current:initial},useState(initial){const index=stateIndex++;if(!(index in states))states[index]=initial;return [states[index],value=>states[index]=typeof value==='function'?value(states[index]):value];},useEffect:effect=>effects.push(effect)};
const module={exports:{}};
vm.runInNewContext(source,{module,exports:module.exports,document,require(name){if(name==='react')return hooks;if(name==='react/jsx-runtime')return jsx;if(name==='lucide-react')return icons;if(name.endsWith('.module.css'))return {default:new Proxy({},{get:(_,key)=>String(key)})};throw Error(name);}});
const options=[{value:'short',label:'짧게'},{value:'normal',label:'보통'},{value:'long',label:'자세히'}];
function descendants(node){if(!node||typeof node!=='object')return [];return [node,...React.Children.toArray(node.props?.children).flatMap(descendants)];}
function render(disabled=false){stateIndex=0;refIndex=0;effects.length=0;const tree=module.exports.SettingsSelect({label:'설명 길이',value:'normal',options,onChange:value=>selectedValues.push(value),disabled});refs[0].current=root;refs[1].current={focus(){triggerFocus++;}};return tree;}
function flush(){for(const effect of effects)effect();}
function key(tree,key){let prevented=false;tree.props.onKeyDown({key,preventDefault(){prevented=true;},stopPropagation(){}});return prevented;}
let tree=render();
let trigger=descendants(tree).find(node=>node.props?.['aria-haspopup']==='listbox');
assert.equal(trigger.props['aria-expanded'],false);
assert.equal(trigger.props['aria-label'],'설명 길이 · 보통');
assert.equal(descendants(tree).filter(node=>node.props?.role==='option').length,0);
assert.equal(key(tree,'ArrowDown'),true);tree=render();flush();
assert.equal(focused,1,'opening by keyboard focuses the saved selection');
assert.equal(descendants(tree).filter(node=>node.props?.role==='option').length,3);
assert.equal(descendants(tree).find(node=>node.props?.role==='option'&&node.props['aria-selected']).props.children[0].props.children,'보통');
key(tree,'ArrowDown');assert.equal(focused,2);key(tree,'ArrowDown');assert.equal(focused,0,'arrow navigation wraps without moving the page');
key(tree,'End');assert.equal(focused,2);key(tree,'Home');assert.equal(focused,0);
descendants(tree).filter(node=>node.props?.role==='option')[2].props.onClick();
assert.deepEqual(selectedValues,['long']);assert.equal(triggerFocus,1,'selection returns focus to its trigger');
tree=render();assert.equal(descendants(tree).filter(node=>node.props?.role==='option').length,0);
descendants(tree).find(node=>node.props?.['aria-haspopup']==='listbox').props.onClick();tree=render();flush();key(tree,'Escape');tree=render();
assert.equal(triggerFocus,2);assert.equal(descendants(tree).filter(node=>node.props?.role==='option').length,0);
descendants(tree).find(node=>node.props?.['aria-haspopup']==='listbox').props.onClick();tree=render();flush();listeners.get('pointerdown')({target:{}});tree=render();
assert.equal(descendants(tree).filter(node=>node.props?.role==='option').length,0,'outside click closes the choice menu');
tree=render(true);assert.equal(key(tree,'ArrowDown'),false);assert.equal(descendants(tree).find(node=>node.props?.['aria-haspopup']==='listbox').props.disabled,true);
console.log('Settings select passed: selected value, roving keys, selection, Escape, focus restoration, outside click and pending state.');
