import { materialQuestionMatchesTarget } from './material-learning-flow';

type SearchEntity = Record<string, any>;
export type MaterialSearchResult = { key: string; label: string; href: string; kind: '활동' | '예상 질문' };
export function normalizeMaterialQuery(value: string) {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ko-KR');
}

/** Activities belong to the student; school-specific questions follow the selected target. */
export function searchStudentMaterials(learning: SearchEntity | null | undefined, query: string, targetId?: string): MaterialSearchResult[] {
  const term = normalizeMaterialQuery(query);
  if (!term) return [];
  const activities: SearchEntity[] = Array.isArray(learning?.activities) ? learning.activities : [];
  const questions: SearchEntity[] = Array.isArray(learning?.questions) ? learning.questions : [];
  return [
    ...activities.map(item => ({ key: `activity:${item.id}`, id: item.id, label: item.title, kind: '활동' as const, section: 'activities' })),
    ...questions.filter(item => materialQuestionMatchesTarget(item, targetId)).map(item => ({ key: `question:${item.id}`, id: item.id, label: item.prompt, kind: '예상 질문' as const, section: 'questions' })),
  ].filter(item => typeof item.id === 'string' && typeof item.label === 'string' && normalizeMaterialQuery(item.label).includes(term))
    .map(({ key, id, label, kind, section }) => ({ key, label, kind, href: `/materials/${section}/${encodeURIComponent(id)}` }));
}
