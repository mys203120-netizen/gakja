/** Shared by the TypeScript server and the plain Node preparation script. */
export const interviewFiles = Object.freeze({
  studentPdf: '래퍼런스/윤지우학생 생활기록부.pdf',
  universitiesJson: 'universities.json',
  departmentsJson: 'departments.json',
  admissionTracksJson: 'admission_tracks.json',
  glossary: '각자의답_MD/1. 프로젝트_용어집_v2.2.md',
  brandGuidelines: '각자의답_MD/2. 브랜드_정체성_v1.2.md',
  guidebookGuidelines: '각자의답_MD/3. 웹가이드북_목차_콘텐츠배치_v3.0.md',
  prdGuidelines: '각자의답_MD/4. 서비스_PRD_v3.0.md',
  studentAnalysisGuidelines: '각자의답_MD/5. 학생부_분석_기준_v2.2.md',
  schoolGuidelines: '각자의답_MD/6. 대학별_면접_기준_v1.3.md',
  productionGuidelines: '각자의답_MD/7. 웹가이드북_통합제작프로세스_v2.2.md',
  operatingGuidelines: '각자의답_MD/8. 면접엔진_공통운영원칙_v2.0.md',
  questionGuidelines: '각자의답_MD/9. 면접엔진_질문생성_가이드라인_v2.3.md',
  evaluationGuidelines: '각자의답_MD/10. 면접엔진_답변평가_가이드라인_v2.3.md',
  termsDraft: '각자의답_MD/11. 요금제_결제및환불_약관_v0.2_검토초안.md',
  studentUxGuidelines: '각자의답_MD/12. 학생용_IA및UX_정밀설계_v1.2.md',
  preparedStudent: 'data/prepared/student.json',
  sourceManifest: 'data/prepared/source-manifest.json',
});
/** Question wording references only; never student facts or current admission-policy sources. */
export const interviewReferenceFiles = Object.freeze({
  bookContentMd: '각자의답_MD/2027_면접바이블_내용정리_v1.0.md',
  bookUniversityMd: '각자의답_MD/2027_면접바이블_대학별정리_v1.0.md',
  bookFiguresDirectory: '.local/book-analysis/figures',
  preparedQuestionReferences: 'data/prepared/question-references.json',
});
export const guidelineSourceVersions = Object.freeze({ operatingGuidelines: '2.0', questionGuidelines: '2.3', evaluationGuidelines: '2.3' });
export const guidelineSourceTitles = Object.freeze({
  operatingGuidelines: '각자의답 면접 엔진 공통 운영 원칙',
  questionGuidelines: '각자의답 서류기반 모의면접 질문 생성 가이드라인',
  evaluationGuidelines: '각자의답 서류기반 모의면접 답변 분석·평가·코칭 가이드라인',
});
