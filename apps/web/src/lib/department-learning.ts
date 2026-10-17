import {createHash} from 'node:crypto';
import {schoolDirectoryForTarget} from './school-directory';
import {KNOWLEDGE_CATALOG,majorKnowledgeTopics,type KnowledgeTarget} from './knowledge-bites-catalog';

/** Editorial explanations of the linked learning resource, never a school's admissions syllabus. */
const explanations:Record<string,{summary:string;check:string}>={
  '미세플라스틱':{summary:'미세플라스틱은 작은 플라스틱 입자예요. 유입 경로와 노출량, 측정 방법을 구분해야 결과를 해석할 수 있어요.',check:'유입 경로와 실제 영향을 구분하려면 어떤 자료가 더 필요할까요?'},
  '플라스틱':{summary:'플라스틱의 환경 영향은 재질뿐 아니라 사용 기간, 회수와 재활용, 최종 처리 경로에 따라 달라져요.',check:'같은 재질도 사용·폐기 방식에 따라 평가가 달라지는 예를 들어 보세요.'},
  '수질과 정수':{summary:'수처리는 물속 물질의 성질에 따라 물리·생물·화학적 방법을 조합해요. 한 지표가 좋아졌다고 모든 오염이 제거됐다고 말할 수는 없어요.',check:'수질 개선을 확인할 측정 지표와 그 지표의 한계를 하나씩 설명해 보세요.'},
  '녹지와 기후':{summary:'녹지는 그늘과 증산 등으로 주변 열환경에 영향을 주어요. 효과를 비교할 때 기온·위치·시간과 관측 조건을 함께 살펴야 해요.',check:'녹지의 효과를 비교할 때 같게 유지할 조건은 무엇인가요?'},
  '탄소 순환':{summary:'탄소는 대기·생물·토양·바다 사이를 이동해요. 탄소의 저장량과 이동 속도, 배출과 흡수를 구분해야 변화를 설명할 수 있어요.',check:'탄소의 저장과 흡수가 어떻게 다른지 예로 설명해 보세요.'},
  '항생제 내성':{summary:'항생제 내성은 사람의 몸이 아니라 세균이 항생제에 견디는 성질이에요. 선택 압력과 내성의 확산을 구분해 원인을 살펴보아요.',check:'항생제 사용과 내성 세균의 증가 사이를 어떤 과정으로 설명할 수 있나요?'},
  '생물다양성':{summary:'생물다양성은 종의 수만 아니라 유전적 다양성과 생태계의 차이도 포함해요. 생물 사이의 상호작용이 생태계 기능에 영향을 주어요.',check:'종의 수가 같아도 생태계 기능이 다를 수 있는 이유는 무엇인가요?'},
  '효소':{summary:'효소는 반응의 활성화 에너지를 낮추는 생체 촉매예요. 온도·pH·기질 농도에 따라 작용이 달라지므로 조건을 나눠 비교해야 해요.',check:'효소 실험에서 한 번에 한 조건만 바꾸는 이유를 설명해 보세요.'},
  '삼투':{summary:'삼투는 선택적으로 투과하는 막을 사이에 둔 물의 이동이에요. 물의 이동과 용질의 이동을 구분하고 막의 성질을 확인해야 해요.',check:'삼투를 단순히 모든 물질이 섞이는 현상으로 설명하면 무엇을 놓칠까요?'},
  '유전자 발현':{summary:'유전 정보는 전사와 번역 등의 과정을 거쳐 단백질 생성으로 이어져요. 유전자의 존재와 실제 발현 정도는 다른 정보예요.',check:'같은 유전 정보를 가진 세포도 기능이 달라질 수 있는 이유는 무엇인가요?'},
  '자료 해석':{summary:'그래프를 읽을 때 축의 범위와 단위, 표본과 비교 기준을 확인해요. 상관관계만으로 인과관계를 결론 내릴 수는 없어요.',check:'그래프의 인상을 바꾸는 표현 한 가지와 확인할 원자료를 말해 보세요.'},
  '근거 검토':{summary:'주장·근거·숨은 전제를 나누어 살피고 반례와 다른 설명을 검토해요. 근거가 부족하면 결론의 범위를 좁히거나 확인할 질문을 남겨요.',check:'내 결론을 바꿀 수 있는 반례나 추가 근거는 무엇인가요?'},
  '연습과 학습':{summary:'효과적인 연습에는 구체적인 목표, 피드백과 수정이 필요해요. 같은 내용을 다시 읽은 것과 도움 없이 꺼내 설명한 것은 다른 경험이에요.',check:'다음 연습에서 확인할 한 가지와 실제 수행 여부를 알아볼 방법을 정해 보세요.'},
  '경청과 협업':{summary:'경청은 상대의 말을 기다리는 것에서 더 나아가 의미를 확인하고 이해한 내용을 되돌려 주는 과정이에요. 이해와 동의도 구분할 수 있어요.',check:'의견이 다른 상대의 뜻을 확인할 질문을 하나 만들어 보세요.'},
  '공동 자원':{summary:'여럿이 쓰는 자원에서는 개인에게 유리한 선택이 전체 자원의 소모를 키울 수 있어요. 규칙·감시·협력과 비용 분담을 함께 검토해요.',check:'공동 자원 문제의 해결 규칙과 그 규칙의 한계를 설명해 보세요.'},
  '정보와 미디어':{summary:'기사의 사실 진술과 해석·의견을 구분해요. 원출처와 작성 시점, 빠진 맥락을 비교하면 같은 사건에 대한 다른 설명을 검토할 수 있어요.',check:'기사를 전공 관련 주장에 활용하기 전에 무엇을 확인하겠어요?'},
  '관찰과 발견':{summary:'관찰에서 질문과 가설을 만들고, 비교 가능한 조건에서 확인해요. 예상과 다른 결과도 관측 조건과 대안 설명을 살펴볼 근거가 돼요.',check:'관찰 한 가지를 검증 가능한 탐구 질문으로 바꿔 보세요.'},
  '알고리즘':{summary:'알고리즘은 문제를 해결하기 위한 절차예요. 입력과 출력, 각 단계의 의미를 정하고 정확성과 효율을 따로 검토할 수 있어요.',check:'익숙한 문제의 해결 절차를 설명하고 실패할 입력을 하나 찾아보세요.'},
  '윤리와 선택':{summary:'윤리적 선택은 결과뿐 아니라 권리·의무·공정성 등 서로 다른 기준에서 살펴볼 수 있어요. 선택의 영향을 받는 사람과 충돌하는 가치를 밝혀요.',check:'같은 선택을 두 가지 윤리 기준으로 비교해 보세요.'},
  '음악 읽기':{summary:'악보는 음높이와 길이, 박자 등의 정보를 기호로 나타내요. 기호의 뜻을 읽는 것과 실제 소리로 해석해 표현하는 과정을 연결해 보아요.',check:'같은 악보도 표현이 달라질 수 있는 요소를 설명해 보세요.'},
  '시장과 기대':{summary:'가격은 현재의 수요·공급과 함께 미래에 대한 기대의 영향을 받을 수 있어요. 자산 가격 상승과 기초 가치의 변화를 나누어 검토해요.',check:'가격이 올랐다는 사실만으로 가치를 판단하기 어려운 이유를 설명해 보세요.'},
};
export function departmentLearningContext(target:Record<string,any>){
  const school=schoolDirectoryForTarget(target),name=String(target.department||target.major||'');
  const department=school?.departments.find(item=>item.id===target.department_catalog_id&&item.name===name&&(item.campus===target.campus||school.campusLabel===target.campus));
  if(!school||!department)return null;
  const interest=department.programs?.includes(target.interest_department)?String(target.interest_department):null,learningName=interest||name;
  const lens:KnowledgeTarget={id:target.id||school.id,university:school.canonicalName,department:learningName,campus:target.campus,departmentCatalogId:department.id,departmentField:department.field,departmentCategory:department.category,snapshot:{}};
  const topics=majorKnowledgeTopics(lens).map(topic=>{const video=KNOWLEDGE_CATALOG.find(item=>item.topic===topic),explanation=explanations[topic];return video&&explanation?{topic,videoId:video.id,url:video.source,resourceTitle:video.title,...explanation}:null;}).filter((item):item is NonNullable<typeof item>=>Boolean(item)).slice(0,4);
  return {schoolReferenceId:school.id,university:school.canonicalName,department:learningName,admissionUnit:name,departmentCatalogId:department.id,campus:target.campus,field:department.field,category:department.category,topics,basis:'department_learning' as const,officialCurriculum:false};
}
export function departmentQuestionMatchesTarget(question:Record<string,any>,target:Record<string,any>){
  const context=question.department_context;if(!context)return true;
  const current=departmentLearningContext(target);
  return Boolean(current&&context.schoolReferenceId===current.schoolReferenceId&&context.departmentCatalogId===current.departmentCatalogId&&context.department===current.department&&context.campus===current.campus);
}
export function departmentPracticeQuestions(target:Record<string,any>){
  const context=departmentLearningContext(target);if(!context)return [];
  return context.topics.map(concept=>{
    const key=createHash('sha256').update(JSON.stringify([context.schoolReferenceId,context.departmentCatalogId,context.department,context.campus,concept.topic])).digest('hex').slice(0,24),id='common_major_'+key;
    const sourceId='major_learning_'+key;
    return {id,common_revision:1,prompt:`${context.department}와 연결해 ${concept.topic}의 핵심을 설명해 주세요. ${concept.check} 관련 학생부 활동이 있다면 실제 과정에 연결하고, 없다면 앞으로 탐구할 질문을 말해 주세요.`,
      question_types:['major','academic','department'],grounding_types:['department_learning'],answer_elements:['핵심 개념','이유와 근거','적용 또는 탐구 계획','한계와 확인할 점'],activity_ids:[],source_ref_ids:[sourceId],allocation_bucket:'major',
      source_type:'general_practice',verification_status:'published',school_reference_id:context.schoolReferenceId,department_context:{...context,topics:undefined,topic:concept.topic,knowledgeVideoId:concept.videoId},
      source_snapshot:{kind:'department_learning',title:`${context.department} · ${concept.topic}`,summary:concept.summary,url:concept.url,knowledgeVideoId:concept.videoId,resourceTitle:concept.resourceTitle,checkedAt:'2026-10-17',scope:'department_learning',officialCurriculum:false,questionBasis:'service_practice'},practice_label:'학과 개념 연결 연습'};
  });
}
