import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import postcss from 'postcss';

const sourceRoot=path.resolve('apps/web/src');
const scale=new Map([
  ['--font-size-caption','14px'],
  ['--font-size-body','16px'],
  ['--font-size-section','20px'],
  ['--font-size-title','28px'],
]);
const sizeReferences=new Set([...scale.keys()].map(token=>`var(${token})`));
function cssFiles(directory:string):string[]{
  return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
    const filename=path.join(directory,entry.name);
    return entry.isDirectory()?cssFiles(filename):entry.name.endsWith('.css')?[filename]:[];
  });
}

test('app typography has exactly four fixed, shared size tokens',()=>{
  const tokens=new Map<string,string[]>();
  for(const filename of cssFiles(sourceRoot)){
    postcss.parse(readFileSync(filename,'utf8'),{from:filename}).walkDecls(declaration=>{
      if(scale.has(declaration.prop)){
        tokens.set(declaration.prop,[...(tokens.get(declaration.prop)||[]),declaration.value]);
      }
    });
  }
  for(const [token,value] of scale)assert.deepEqual(tokens.get(token),[value],token);
});

test('all app CSS uses the four sizes without relative sizes or hidden zero-size labels',()=>{
  const violations:string[]=[];
  for(const filename of cssFiles(sourceRoot)){
    postcss.parse(readFileSync(filename,'utf8'),{from:filename}).walkDecls(declaration=>{
      const value=declaration.value.trim();
      if(declaration.prop==='font-size'&&value!=='inherit'&&!sizeReferences.has(value)){
        violations.push(`${path.relative(sourceRoot,filename)}:${declaration.source?.start?.line} ${value}`);
      }
      // A font shorthand can introduce a fifth size without a font-size declaration.
      if(declaration.prop==='font'&&!['inherit','unset'].includes(value)&&![...sizeReferences].some(reference=>value.includes(reference))){
        violations.push(`${path.relative(sourceRoot,filename)}:${declaration.source?.start?.line} font: ${value}`);
      }
    });
  }
  assert.deepEqual(violations,[]);
});
