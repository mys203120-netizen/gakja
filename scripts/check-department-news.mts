/** Read-only live publisher check. Does not touch student data or start an automation. */
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { collectDepartmentNews } from '../apps/web/src/lib/department-news.ts';
import { majorNewsTopic } from '../apps/web/src/lib/department-news-model.ts';
const major = process.argv.find(value => value.startsWith('--major='))?.slice(8) || '환경공학과';
const topic = majorNewsTopic(major); if (!topic) throw new Error('확인할 학과를 지정해 주세요.');
const result = await collectDepartmentNews(topic);
const output = { checkedAt: new Date().toISOString(), major, topic, ...result };
await mkdir('.local', { recursive: true });
await writeFile(join('.local', 'department-news-live-check.json'), JSON.stringify(output, null, 2));
console.log(JSON.stringify({ major, sourcesSucceeded: result.successfulSources, failedSources: result.failedSources, articles: result.articles.length, newest: result.articles.slice(0, 3).map(({ title, publisher, publishedAt, url }) => ({ title, publisher, publishedAt, url })), evidence: '.local/department-news-live-check.json' }, null, 2));
if (!result.successfulSources) process.exitCode = 1;
