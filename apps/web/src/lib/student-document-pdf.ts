import 'server-only';
import {copyFile,mkdtemp,rm} from 'node:fs/promises';
import {join,dirname,resolve,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {PDFParse} from 'pdf-parse';
import {DocumentValidationError,recognizeStudentDocument,type DocumentPage} from './student-document-model';

const parserFor=(bytes:Buffer)=>new PDFParse({data:new Uint8Array(bytes),isEvalSupported:false,useWorkerFetch:false,stopAtErrors:true,maxImageSize:16_000_000});
const clean=(value:string)=>value.replace(/\u0000/g,'').trim();
export const OCR_LOW_CONFIDENCE=75;
export async function extractStudentDocumentPages(bytes:Buffer):Promise<DocumentPage[]>{
  if(bytes.subarray(0,5).toString('ascii')!=='%PDF-')throw new DocumentValidationError('PDF 파일 형식을 확인해 주세요.');
  const parser=parserFor(bytes);
  try{
    const info=await parser.getInfo();if(info.total<1||info.total>60)throw new DocumentValidationError('생기부 PDF는 1~60쪽으로 등록해 주세요.');
    const result=await parser.getText();
    const images=await parser.getImage({imageBuffer:false,imageDataUrl:false,imageThreshold:128});
    if(result.pages.length!==info.total)throw new DocumentValidationError('일부 페이지를 읽지 못했어요. 암호를 해제한 전체 PDF를 확인해 주세요.');
    return result.pages.map(p=>{const text=clean(p.text),hasImage=!!images.pages.find(x=>x.pageNumber===p.num)?.images.length,needsOcr=text.replace(/\s/g,'').length<50||hasImage;return {page:p.num,text,extractedText:text,extractionMethod:needsOcr?(text?'mixed_ocr':'local_ocr'):'pdf_text',confidence:null,...(needsOcr?{ocrStatus:'pending' as const}:{})};});
  }catch(error){if(error instanceof DocumentValidationError)throw error;throw new DocumentValidationError('PDF를 읽지 못했어요. 암호를 해제하고 열 수 있는 전체 PDF인지 확인해 주세요.');}
  finally{await parser.destroy();}
}
export async function renderStudentDocumentPage(bytes:Buffer,page:number,width=1500):Promise<Buffer>{
  const parser=parserFor(bytes);
  try{
    const info=await parser.getInfo({parsePageInfo:true});const shape=info.pages.find(p=>p.pageNumber===page);
    if(!Number.isInteger(page)||page<1||page>info.total||!shape)throw new DocumentValidationError('페이지 번호를 확인해 주세요.');
    const desiredWidth=Math.max(1,Math.min(width,Math.floor(Math.sqrt(4_000_000*shape.width/shape.height))));
    if(!Number.isFinite(desiredWidth)||shape.width<=0||shape.height<=0)throw new DocumentValidationError('페이지 크기를 확인하지 못했어요.');
    const result=await parser.getScreenshot({partial:[page],desiredWidth,imageBuffer:true,imageDataUrl:false});
    const image=result.pages[0];if(!image?.data.length)throw new DocumentValidationError('페이지 미리보기를 만들지 못했어요.');return Buffer.from(image.data);
  }finally{await parser.destroy();}
}
export type LocalOcr=(image:Buffer)=>Promise<{text:string;confidence:number}>;
export async function createLocalStudentOcr(){
  const [{createWorker},kor,eng]=await Promise.all([import('tesseract.js'),import('@tesseract.js-data/kor'),import('@tesseract.js-data/eng')]);
  const directory=await mkdtemp(join(tmpdir(),'gakja-ocr-model-'));
  const cleanup=async()=>{const target=resolve(directory);if(dirname(target)!==resolve(tmpdir())||!basename(target).startsWith('gakja-ocr-model-'))throw new Error('UNEXPECTED_MODEL_DIRECTORY');await rm(target,{recursive:true,force:true});};
  try{
    // Use the external packages' absolute __dirname-derived paths. Webpack rewrites
    // require.resolve(external) to an identifier, which is not a filesystem path.
    const packages=[{code:'kor',langPath:kor.default.langPath},{code:'eng',langPath:eng.default.langPath}];
    await Promise.all(packages.map(({code,langPath})=>copyFile(join(dirname(langPath),'4.0.0_best_int',`${code}.traineddata.gz`),join(directory,`${code}.traineddata.gz`))));
    // Explicit local path; no CDN/model call. Only public language data enters this directory.
    const worker=await createWorker(['kor','eng'],1,{langPath:directory,cacheMethod:'none',errorHandler:()=>{}});
    await worker.setParameters({preserve_interword_spaces:'1'});
    return {recognize:async(image:Buffer)=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([worker.recognize(image,{rotateAuto:true}).then(({data})=>({text:clean(data.text),confidence:data.confidence})),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{void worker.terminate();reject(new Error('OCR_TIMEOUT'));},45_000);})]);}finally{clearTimeout(timer);}},terminate:async()=>{try{await worker.terminate();}finally{await cleanup();}}};
  }catch(error){await cleanup();throw error;}
}
export async function ocrStudentPage(bytes:Buffer,page:DocumentPage,recognize:LocalOcr):Promise<DocumentPage>{
  try{const result=await recognize(await renderStudentDocumentPage(bytes,page.page));const confidence=Number.isFinite(result.confidence)?Math.max(0,Math.min(100,result.confidence)):0;const text=clean(result.text);return {...page,text:text||page.extractedText||'',ocrText:text,confidence,ocrStatus:'completed',...(confidence<OCR_LOW_CONFIDENCE||text.replace(/\s/g,'').length<15?{issue:'인식이 불확실해요. 원본과 대조해 빠지거나 잘못된 글자를 정정해 주세요.'}:{issue:undefined})};}
  catch{return {...page,text:page.extractedText||'',ocrStatus:'failed',confidence:null,issue:'자동 인식을 완료하지 못했어요. 원본을 보며 직접 입력하거나 다시 인식할 수 있어요.'};}
}
/** Legacy text reader; uploads use staged extraction and explicit page review. */
export async function readStudentDocumentPdf(bytes:Buffer){const pages=await extractStudentDocumentPages(bytes);return {pages,recognition:recognizeStudentDocument(pages)};}
