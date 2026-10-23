import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import * as nodeModule from 'node:module';
import * as fsPromises from 'node:fs/promises';
import * as nodePath from 'node:path';
import * as nodeOs from 'node:os';
import ts from 'typescript';
import {PDFParse} from 'pdf-parse';
import * as model from '../apps/web/src/lib/student-document-model.ts';

/** Small synthetic PDF with a Unicode mapping. Contains no real student information. */
function syntheticPdf(text:string){
  const chars=[...new Set([...text])],codes=new Map(chars.map((char,index)=>[char,index+33]));
  const hex=(value:string)=>[...value].map(char=>codes.get(char)!.toString(16).padStart(2,'0')).join('');
  const content=`BT /F1 10 Tf 40 750 Td <${hex(text)}> Tj ET`;
  const cmap='/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Synthetic def /CMapType 2 def 1 begincodespacerange <00> <FF> endcodespacerange '+chars.length+' beginbfchar '+chars.map(char=>`<${hex(char)}> <${char.charCodeAt(0).toString(16).padStart(4,'0')}>`).join(' ')+' endbfchar endcmap CMapName currentdict /CMap defineresource pop end end';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10000 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode 6 0 R >>','<< >>',`<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`,`<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let pdf='%PDF-1.7\n';const offsets=[0];objects.forEach((obj,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${obj}\nendobj\n`;});
  const start=Buffer.byteLength(pdf);pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(pdf);
}
const source=await readFile(new URL('../apps/web/src/lib/student-document-pdf.ts',import.meta.url),'utf8'),exported:any={};
vm.runInNewContext(ts.transpileModule(source.replaceAll('import.meta.url',JSON.stringify(new URL('../apps/web/src/lib/student-document-pdf.ts',import.meta.url).href)),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:exported,Buffer,Uint8Array,require:(name:string)=>{if(name==='server-only')return {};if(name==='node:module')return nodeModule;if(name==='node:fs/promises')return fsPromises;if(name==='node:path')return nodePath;if(name==='node:os')return nodeOs;if(name==='pdf-parse')return {PDFParse};if(name==='./student-document-model')return model;throw Error(name);}});
test('PDF parser reads the complete synthetic school record with source page numbering',async()=>{
  const quote='교내 과학 탐구에서 자료의 출처를 비교하고 모둠 토론 과정의 차이를 기록함. ';
  const parsed=await exported.readStudentDocumentPdf(syntheticPdf('학교생활기록부 인적사항 출결상황 창의적체험활동 '+quote.repeat(10)));
  assert.equal(parsed.pages.length,1);assert.equal(parsed.pages[0].page,1);assert.ok(parsed.pages[0].text.includes('학교생활기록부'));assert.equal(parsed.recognition.identityVerified,false);
});
test('PDF parser rejects arbitrary bytes and readable non-school-record PDFs before locking',async()=>{
  await assert.rejects(()=>exported.readStudentDocumentPdf(Buffer.from('not a pdf')));
  await assert.rejects(()=>exported.readStudentDocumentPdf(syntheticPdf('일반 메모 '.repeat(100))),/학교생활기록부/);
});
