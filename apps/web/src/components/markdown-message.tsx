import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Parent, Root, Strong, Text } from 'mdast';
import type { Plugin, PluggableList } from 'unified';
import styles from './markdown-message.module.css';

/** CommonMark treats a closing quote before a Korean particle as punctuation,
 * so **「질문」**라면 can remain literal. Repair that narrow text case after
 * parsing; source offsets protect escaped literals, entities and code. */
const remarkKoreanQuotedStrong: Plugin<[], Root> = () => (tree, file) => {
  const source = String(file);
  const quotePairs: Record<string, string> = { '「': '」', '『': '』', '“': '”', '‘': '’', '《': '》', '〈': '〉', '【': '】' };
  function repair(node: Text): Array<Text | Strong> {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined || source.slice(start, end) !== node.value) return [node];
    const pattern = /\*\*([「『“‘《〈【])([^\n*\\]+)([」』”’》〉】])\*\*(?=[\p{Script=Hangul}])/gu;
    const result: Array<Text | Strong> = [];
    let cursor = 0;
    for (const match of node.value.matchAll(pattern)) {
      const index = match.index;
      if (node.value[index - 1] === '*' || quotePairs[match[1]] !== match[3] || !/\p{Script=Hangul}/u.test(match[2])) continue;
      if (index > cursor) result.push({ type: 'text', value: node.value.slice(cursor, index) });
      result.push({ type: 'strong', children: [{ type: 'text', value: `${match[1]}${match[2]}${match[3]}` }] });
      cursor = index + match[0].length;
    }
    if (!result.length) return [node];
    if (cursor < node.value.length) result.push({ type: 'text', value: node.value.slice(cursor) });
    return result;
  }
  function walk(parent: Parent) {
    for (let index = 0; index < parent.children.length; index++) {
      const node = parent.children[index];
      if (node.type === 'text') {
        const replacements = repair(node);
        parent.children.splice(index, 1, ...replacements);
        index += replacements.length - 1;
      } else if ('children' in node) walk(node);
    }
  }
  walk(tree);
};

const learningStatusLabels: Record<string, string> = {
  needs_confirmation: '확인 필요',
  student_says_different: '기록과 다름',
  cannot_confirm: '확인 어려움',
  confirmed_from_record: '학생부에서 확인',
  confirmed_by_student: '내가 확인함',
};

/** A display-only translation. Saved text, URLs and code examples stay intact. */
const remarkLearningStatusLabels: Plugin<[], Root> = () => tree => {
  const pattern = /(?<![A-Za-z0-9_./:@?=&%+\-])(?:needs_confirmation|student_says_different|cannot_confirm|confirmed_from_record|confirmed_by_student)(?![A-Za-z0-9_./:@?=&%+\-])/g;
  function walk(parent: Parent) {
    for (const node of parent.children) {
      if (node.type === 'text') node.value = node.value.replace(pattern, value => learningStatusLabels[value]);
      else if (node.type === 'inlineCode' && Object.hasOwn(learningStatusLabels, node.value)) node.value = learningStatusLabels[node.value];
      else if (node.type !== 'code' && node.type !== 'html' && node.type !== 'link' && node.type !== 'linkReference' && 'children' in node) walk(node);
    }
  }
  walk(tree);
};

const markdownPlugins: PluggableList = [remarkGfm, remarkKoreanQuotedStrong];
const learningStatusPlugins: PluggableList = [...markdownPlugins, remarkLearningStatusLabels];
const markdownComponents: Components = {
  a: ({ href, children }) => href ? <a href={href} target={/^https?:\/\//i.test(href) ? '_blank' : undefined} rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
  img: ({ alt }) => alt ? <span className={styles.imageAlt}>{alt}</span> : null,
  table: ({ children }) => <div className={`markdown-table ${styles.tableScroll}`} role="region" aria-label="답변 표" tabIndex={0}><table>{children}</table></div>,
};

/** AI text stays text: no raw HTML, embeds, or active URL schemes.
 * Unchanged history keeps its parsed tree while another message streams. */
export const MarkdownMessage = memo(function MarkdownMessage({ content, humanizeLearningStatuses = false }: { content: string; humanizeLearningStatuses?: boolean }) {
  return <div className={`markdown-content ${styles.markdown}`}>
    <ReactMarkdown
      remarkPlugins={humanizeLearningStatuses ? learningStatusPlugins : markdownPlugins}
      skipHtml
      components={markdownComponents}
    >{content}</ReactMarkdown>
  </div>;
});
