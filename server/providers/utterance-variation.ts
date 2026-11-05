import { createHash } from 'node:crypto';

export interface UtteranceTemplateIdentity { id: string; family: string }
export interface UtteranceHistoryItem { templateId: string; family: string }

/** Seeded shuffle bags vary across answers, remain stable on retry, and avoid the last sentence family. */
export function selectNonRepeatingTemplate<T extends UtteranceTemplateIdentity>(
  candidates: readonly T[],
  seed: string,
  history: readonly UtteranceHistoryItem[] = [],
): T | null {
  if (!candidates.length) return null;
  const ids = new Set(candidates.map(candidate => candidate.id));
  if (ids.size !== candidates.length) throw new Error('Duplicate utterance template identity');
  const used = new Set<string>();
  for (const item of history) {
    if (!ids.has(item.templateId)) continue;
    used.add(item.templateId);
    if (used.size === ids.size) used.clear();
  }
  let available = candidates.filter(candidate => !used.has(candidate.id));
  const last = history.at(-1);
  const otherFamily = available.filter(candidate => candidate.family !== last?.family);
  if (otherFamily.length) available = otherFamily;
  else {
    // A previous family must not force an immediate repeat merely to finish a bag.
    const alternatives = candidates.filter(candidate => candidate.family !== last?.family);
    if (alternatives.length) available = alternatives;
    else {
      const otherId = available.filter(candidate => candidate.id !== last?.templateId);
      if (otherId.length) available = otherId;
    }
  }
  const rank = (id: string) => createHash('sha256').update(`${seed}\u0000${id}`).digest('hex');
  return [...available].sort((left, right) => rank(left.id).localeCompare(rank(right.id)) || left.id.localeCompare(right.id))[0] ?? null;
}
