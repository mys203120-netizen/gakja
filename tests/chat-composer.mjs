import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';

// Exercise the component's actual event handlers without a browser, server or AI call.
// Hook and JSX adapters keep this check focused on keyboard and submission behavior.
const source = fs.readFileSync(new URL('../apps/web/src/components/chat-composer.tsx', import.meta.url), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 } }).outputText;
const module = { exports: {} };
const enterModule={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../apps/web/src/lib/client/enter-send.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{module:enterModule,exports:enterModule.exports});
vm.runInNewContext(output, {
  module, exports: module.exports,
  require(name) {
    if (name === 'react') return { useRef: value => ({ current: value }), useState: value => [value, () => {}], useEffect: () => {} };
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
    if (name === 'lucide-react') return { ArrowUp: 'ArrowUp', LoaderCircle: 'LoaderCircle' };
    if(name==='@/lib/client/enter-send')return enterModule.exports;
    if (name.endsWith('.css')) return { default: {} };
    throw new Error(`Unexpected import: ${name}`);
  },
  requestAnimationFrame: callback => callback(),
});

let checks = 0;
function equal(actual, expected) { assert.equal(actual, expected); checks++; }
function fixture(props = {}) {
  let sends = 0, changed = '';
  const tree = module.exports.ChatComposer({ value: '내 답변', onChange: value => { changed = value; }, onSend: () => { sends++; }, label: '면접 답변', ...props });
  const form = tree.props.children[0], textarea = form.props.children.find(child => child?.type === 'textarea'), button = form.props.children.find(child => child?.type === 'button');
  return { tree, form: form.props, input: textarea.props, button: button.props, sends: () => sends, changed: () => changed };
}
function enter(input, details = {}) {
  let prevented = false;
  input.onKeyDown({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false, keyCode: 13 }, preventDefault: () => { prevented = true; }, ...details });
  return prevented;
}

let f = fixture();
equal(enter(f.input), true); equal(f.sends(), 1); equal(f.button.disabled, false); equal(f.input.rows, 1);
f = fixture(); equal(enter(f.input, { shiftKey: true }), false); equal(f.sends(), 0);
f = fixture({enterToSend:false}); equal(enter(f.input),false);equal(f.sends(),0);f.form.onSubmit({preventDefault(){}});equal(f.sends(),1);
for(const detail of [{repeat:true},{ctrlKey:true},{metaKey:true},{altKey:true},{defaultPrevented:true}]){f=fixture();equal(enter(f.input,detail),false);equal(f.sends(),0);}
f = fixture(); equal(enter(f.input, { nativeEvent: { isComposing: true, keyCode: 13 } }), false); equal(f.sends(), 0);
f = fixture(); equal(enter(f.input, { nativeEvent: { isComposing: false, keyCode: 229 } }), false); equal(f.sends(), 0);
f = fixture(); f.input.onCompositionStart(); equal(enter(f.input), false); equal(f.sends(), 0); f.input.onCompositionEnd(); equal(enter(f.input), true); equal(f.sends(), 1);
for (const props of [{ value: '  ' }, { busy: true }, { disabled: true }]) {
  f = fixture(props); enter(f.input); equal(f.sends(), 0); equal(f.button.disabled, true);
}
f = fixture(); f.input.onChange({ target: { value: '새 답변\n다음 줄' } }); equal(f.changed(), '새 답변\n다음 줄');

let finish, sendCount = 0;
f = fixture({ onSend: () => { sendCount++; return new Promise(resolve => { finish = resolve; }); } });
enter(f.input); enter(f.input); f.form.onSubmit({ preventDefault: () => {} }); equal(sendCount, 1);
finish(); await new Promise(resolve => setImmediate(resolve)); enter(f.input); equal(sendCount, 2);
finish(); await new Promise(resolve => setImmediate(resolve));
f = fixture({ maxLength: 12000, inputId: 'interview-answer', sendLabel: '답변 보내기' });
equal(f.input.maxLength, 12000); equal(f.input.id, 'interview-answer'); equal(f.button['aria-label'], '답변 보내기');
equal(f.button['aria-busy'], false);
f = fixture({busy:true,sendLabel:'답변 보내기'});equal(f.button['aria-busy'], true);equal(f.button['aria-label'], '전송 중');equal(f.button.title, '전송 중');
const attachmentAction = { type: 'button', props: { type: 'button', 'aria-label': '자료 첨부' } };
f = fixture({ variant: 'conversation', actions: attachmentAction });
equal(f.form.children.find(child => child?.type === 'div').props.children[0], attachmentAction);
equal(f.tree.props.children[1], false);
equal(enter(f.input), true); equal(f.sends(), 1);
f = fixture({ variant: 'conversation', busy: true, actions: attachmentAction });
equal(f.button.disabled, true); equal(f.button['aria-busy'], true); equal(f.input.disabled, true);
console.log(`Composer keyboard/guard behavior: ${checks} checks passed; API calls: 0`);
