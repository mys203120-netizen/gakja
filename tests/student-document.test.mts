import test from 'node:test';
import assert from 'node:assert/strict';
import {recognizeStudentDocument,reviewedDocumentPages,validateDocumentAnalysis,documentLearning,DEFAULT_GUIDELINES,GUIDELINE_KINDS,type DocumentPage} from '../apps/web/src/lib/student-document-model.ts';
import {studentOnboardingDestination} from '../apps/web/src/lib/student-onboarding.ts';
const quote='교내 과학 탐구에서 자료의 출처를 비교하고 모둠 토론 과정의 차이를 기록함.';
const pages:DocumentPage[]=[{page:1,text:'학교생활기록부 인적사항 출결상황 창의적체험활동 '+(quote+' ').repeat(10)}];
const targets=[{id:'department-a',department:'환경공학부'}];
const analysis=()=>({reviewedPages:[1],activities:[{title:'과학 탐구',area:'창의적체험활동',grade:2,summary:'자료 출처를 비교한 탐구 활동입니다.',evidence:[{page:1,quote}],priorities:[{targetId:targets[0].id,priority:'A',reason:'탐구 과정의 설명을 연습할 수 있습니다.'}],questions:[{prompt:'자료의 출처를 비교한 과정을 설명해 주세요.',intent:'자료를 비교한 실제 과정 확인'}],confirmations:['모둠에서 맡은 역할을 확인해 주세요.']}],limitations:['개인 역할은 추가 확인이 필요합니다.']});
test('text structure recognition does not claim authenticity, rejects unreadable/nonrecord/incomplete pages',()=>{
  assert.equal(recognizeStudentDocument(pages).identityVerified,false);
  assert.throws(()=>recognizeStudentDocument([{page:1,text:'성적표 '+quote.repeat(20)}]));
  assert.throws(()=>recognizeStudentDocument([...pages,{page:2,text:''}]));
  assert.throws(()=>recognizeStudentDocument([{page:2,text:pages[0].text}]));
});
test('analysis must cover every page, exact owner targets and verbatim source evidence',()=>{
  assert.equal(validateDocumentAnalysis(analysis(),pages,targets).activities.length,1);
  const fabricated=analysis();fabricated.activities[0].evidence[0].quote='대학에서 실험실 연구를 주도하고 논문을 출판하였음.';
  assert.throws(()=>validateDocumentAnalysis(fabricated,pages,targets));
  const foreign=analysis();foreign.activities[0].priorities[0].targetId='someone-else-target';assert.throws(()=>validateDocumentAnalysis(foreign,pages,targets));
  assert.throws(()=>validateDocumentAnalysis(analysis(),[...pages,{page:2,text:quote}],targets));
  const duplicated=analysis();duplicated.reviewedPages=[1,1];assert.throws(()=>validateDocumentAnalysis(duplicated,[...pages,{page:2,text:quote}],targets));
});
test('new document questions reject long, multiple-sentence and direct talent-name demands without rewriting source input',()=>{
  const baseline=analysis(),before=structuredClone(baseline);
  assert.deepEqual(validateDocumentAnalysis(baseline,pages,targets),before);
  for(const prompt of ['가'.repeat(121),'자료를 어떻게 비교했나요? 무엇을 배웠나요?','자료를 비교한 과정을 설명해 주세요. 배운 점도 말해 주세요.','자료를 비교한 과정과 인재상을 연결해 주세요.','자료 비교에서 창의융합형 인재를 실천한 과정을 말해 주세요.']){
    const invalid=analysis();invalid.activities[0].questions[0].prompt=prompt;
    assert.throws(()=>validateDocumentAnalysis(invalid,pages,targets,['창의융합형 인재']),prompt);
    assert.equal(invalid.activities[0].questions[0].prompt,prompt);
  }
  assert.equal(validateDocumentAnalysis(analysis(),pages,targets,['창의융합형 인재']).activities[0].questions[0].prompt,before.activities[0].questions[0].prompt);
  const decimal=analysis();decimal.activities[0].questions[0].prompt='pH 7.2에서 비교한 자료의 차이를 설명해 주세요.';
  assert.equal(validateDocumentAnalysis(decimal,pages,targets).activities[0].questions[0].prompt,decimal.activities[0].questions[0].prompt);
});
test('published learning and markdown share raw evidence, but invent no verified answers',()=>{
  const input={documentId:'synthetic-record',revision:1,studentId:'student-a',analysis:validateDocumentAnalysis(analysis(),pages,targets),targets,guidelines:GUIDELINE_KINDS.map(kind=>({kind,version:0,body:DEFAULT_GUIDELINES[kind],id:null}))};
  const first=documentLearning(input),next=documentLearning({...input,revision:2});
  assert.equal(first.learning.activities[0].activity_summary,quote);
  assert.equal(first.learning.activities[0].fact_confirmation,'needs_confirmation');
  assert.equal(first.learning.source_refs[0].verification_status,'extracted_from_record');
  assert.deepEqual(first.learning.memory_items,[]);assert.deepEqual(first.learning.answer_scripts,[]);
  assert.ok(first.markdown.includes(quote));assert.ok(first.markdown.includes(input.analysis.activities[0].questions[0].prompt));
  assert.notEqual(first.learning.questions[0].id,next.learning.questions[0].id);
  assert.equal(first.learning.source_refs[0].id,next.learning.source_refs[0].id);
});
test('new students upload after target registration; legacy published learning stays accessible',()=>{
  const data={user:{role:'student'},targets:[{id:'a'}],studentDocument:null,package:null};
  assert.equal(studentOnboardingDestination(data,'/my'),'/student-document?onboarding=1');
  assert.equal(studentOnboardingDestination(data,'/student-document'),null);
  assert.equal(studentOnboardingDestination({...data,studentDocument:{id:'document'}},'/my'),null);
  assert.equal(studentOnboardingDestination({...data,package:{active_version:1}},'/my'),null);
  assert.equal(studentOnboardingDestination({...data,targets:[]},'/my'),'/schools/new?onboarding=1');
});

test('page review requires every page and preserves OCR evidence independently from correction',()=>{
  const raw:DocumentPage[]=[{...pages[0],extractedText:'',ocrText:pages[0].text,extractionMethod:'local_ocr',confidence:42,ocrStatus:'completed',issue:'확인 필요'},{page:2,text:'',extractedText:'',extractionMethod:'local_ocr',confidence:null,ocrStatus:'failed'}];
  assert.throws(()=>reviewedDocumentPages(raw,[{page:1,text:raw[0].text,reviewed:true}]));
  assert.throws(()=>reviewedDocumentPages(raw,raw.map(p=>({page:p.page,text:p.text,reviewed:false}))));
  assert.throws(()=>reviewedDocumentPages(raw,raw.map(p=>({page:p.page,text:p.text,reviewed:true}))));
  const fixed=reviewedDocumentPages(raw,[{page:1,text:raw[0].text+' 원본 대조 정정',reviewed:true},{page:2,text:'',blank:true,reviewed:true}]);
  assert.equal(fixed[0].ocrText,raw[0].text);assert.equal(fixed[0].confidence,42);assert.equal(fixed[0].corrected,true);assert.equal(fixed[1].ocrStatus,'failed');assert.equal(fixed[1].blank,true);assert.equal(recognizeStudentDocument(fixed).identityVerified,false);
  assert.throws(()=>reviewedDocumentPages(raw,[{page:1,text:raw[0].text,reviewed:true},{page:2,text:'있던 글자를 지우지 않고 빈 페이지로 표시',blank:true,reviewed:true}]));
});
test('reviewed OCR citations freeze transcription version without claiming PDF text verification',()=>{
  const result=validateDocumentAnalysis(analysis(),pages,targets),guidelines=GUIDELINE_KINDS.map(kind=>({kind,version:0,body:DEFAULT_GUIDELINES[kind],id:null}));
  const output=documentLearning({documentId:'synthetic',revision:3,studentId:'test',analysis:result,targets,guidelines,textRevision:2,pages:[{...pages[0],extractionMethod:'local_ocr',studentReviewed:true,confidence:72}]});
  const source=output.learning.source_refs[0];assert.equal(source.verification_status,'student_reviewed_transcription');assert.equal(source.text_revision,2);assert.equal(source.quote_basis,'student_reviewed_transcription');assert.equal(source.ocr_confidence,72);assert.match(output.markdown,/인식문 2차/);assert.equal(output.learning.student_document.text_revision,2);
});
