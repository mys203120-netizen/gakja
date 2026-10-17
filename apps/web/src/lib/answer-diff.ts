export type AnswerTextPart = { text: string; added: boolean };

// A text comparison only. It never infers answer quality or verifies evidence.
// Spaces are kept verbatim but do not participate in word matching.
export function addedAnswerText(previous: string, current: string): AnswerTextPart[] {
  const tokenize = (text: string) => text.match(/\s+|[\p{L}\p{N}]+|[^\s\p{L}\p{N}]+/gu) || [];
  const oldWords = tokenize(previous).filter(word => word.trim());
  const pieces = tokenize(current);
  const newWords = pieces.filter(word => word.trim());
  const added = newWords.map(() => true);
  let start = 0;
  while (start < oldWords.length && start < newWords.length && oldWords[start] === newWords[start]) {
    added[start] = false;
    start++;
  }
  let oldEnd = oldWords.length, newEnd = newWords.length;
  while (oldEnd > start && newEnd > start && oldWords[oldEnd - 1] === newWords[newEnd - 1]) {
    added[--newEnd] = false;
    oldEnd--;
  }
  const rows = oldEnd - start, columns = newEnd - start;
  if (rows && columns && rows * columns <= 750_000) {
    const width = columns + 1;
    const lengths = new Uint32Array((rows + 1) * width);
    for (let row = rows - 1; row >= 0; row--) {
      for (let column = columns - 1; column >= 0; column--) {
        const cell = row * width + column;
        lengths[cell] = oldWords[start + row] === newWords[start + column]
          ? 1 + lengths[cell + width + 1]
          : Math.max(lengths[cell + width], lengths[cell + 1]);
      }
    }
    let row = 0, column = 0;
    while (row < rows && column < columns) {
      if (oldWords[start + row] === newWords[start + column]) {
        added[start + column] = false;
        row++; column++;
      } else if (lengths[(row + 1) * width + column] >= lengths[row * width + column + 1]) row++;
      else column++;
    }
  } else if (rows && columns) {
    // Bound work for unusually long transcripts: only flag words with a new
    // occurrence. This avoids quadratic memory use while preserving all text.
    const remaining = new Map<string, number>();
    for (let index = start; index < oldEnd; index++) {
      const word = oldWords[index];
      remaining.set(word, (remaining.get(word) || 0) + 1);
    }
    for (let index = start; index < newEnd; index++) {
      const word = newWords[index], count = remaining.get(word) || 0;
      if (count) { added[index] = false; remaining.set(word, count - 1); }
    }
  }
  let wordIndex = 0;
  const result: AnswerTextPart[] = [];
  for (const text of pieces) {
    const isAdded = text.trim()
      ? added[wordIndex++]
      : !!(wordIndex > 0 && added[wordIndex - 1] && added[wordIndex]);
    const last = result[result.length - 1];
    if (last?.added === isAdded) last.text += text;
    else result.push({ text, added: isAdded });
  }
  return result;
}
