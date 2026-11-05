import dotenv from 'dotenv';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { maskConversationSecrets } from '../server/storage/conversation-log';
import { summarizeSessionLatency } from '../server/session-latency';
import type { InterviewSession } from '../server/protocol';
import { obviousAnswerReaction } from '../server/providers/answer-reaction';
import { syntheticInterviewProvenance } from '../server/interviewer-quality';

dotenv.config({ path: '.env.local', quiet: true });

type Item = Record<string, any>;
const object = (value: unknown): Item => value && typeof value === 'object' && !Array.isArray(value) ? value as Item : {};
const validSession = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const safeLabel = (value: unknown) => typeof value === 'string' && /^[a-z0-9_.:-]{1,96}$/i.test(value) ? value : null;
export function parseConversationJsonl(content: string) {
  const rows: Item[] = []; let malformedLines = 0;
  for (const line of content.split('\n')) { if (!line.trim()) continue; try { const row = JSON.parse(line); if (!row || typeof row !== 'object' || !Number.isSafeInteger(row.seq) || row.seq < 1) throw new Error('Invalid row'); rows.push(row); } catch { malformedLines++; } }
  return { rows, malformedLines };
}
function repetitions(turns: Item[], field: string, full: boolean) {
  const groups = new Map<string, { count: number; turnIds: string[]; text?: string }>();
  for (const turn of turns) { const text = typeof turn[field] === 'string' ? turn[field].trim() : ''; if (!text) continue; const canonical = text.normalize('NFKC').replace(/\s+/gu, ' ').replace(/[.!?。]+$/u, ''); const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 16); const previous = groups.get(hash) ?? { count: 0, turnIds: [], ...(full ? { text } : {}) }; previous.count++; previous.turnIds.push(turn.id); groups.set(hash, previous); }
  return [...groups].filter(([, group]) => group.count >= 2).map(([fingerprint, group]) => ({ fingerprint, ...group }));
}
/** Offline observations, not an automatic judgment of answer quality or a new LLM evaluation. */
export function buildConversationReview(sessionInput: unknown, eventsInput: unknown[], options: { full?: boolean; malformedLines?: number } = {}) {
  const session = object(maskConversationSecrets(sessionInput)), events = eventsInput.map(event => object(maskConversationSecrets(event))), full = Boolean(options.full);
  const verification = object(object(session.metrics).verification);
  const declaredFlags = Object.fromEntries(['syntheticTest', 'syntheticVoice', 'syntheticProvider', 'syntheticClientObservation'].filter(key => typeof verification[key] === 'boolean').map(key => [key, verification[key]]));
  const syntheticTest: boolean | null = Object.values(declaredFlags).some(value => value === true) ? true : typeof verification.syntheticTest === 'boolean' ? verification.syntheticTest : null;
  const provenance = Object.keys(verification).length ? { source: 'session.metrics.verification', ...declaredFlags, scenario: safeLabel(verification.syntheticScenario ?? verification.scenario) } : null;
  const turns: Item[] = Array.isArray(session.turns) ? session.turns.map(object) : [];
  const byType: Record<string, number> = {}, actions: Record<string, number> = {}, classifications: Record<string, number> = {}, reasons: Record<string, number> = {};
  for (const row of events) { const label = safeLabel(row.type); if (label) byType[label] = (byType[label] ?? 0) + 1; }
  const relevanceByTurn = new Map<string, Item>();
  for (const row of events.filter(row => /relevance|reaction/i.test(row.type ?? ''))) { const payload = object(row.payload), entry = object(payload.reaction ?? payload.answerReaction ?? payload); relevanceByTurn.set(entry.sourceTurnId ?? row.turnId ?? `event:${row.seq}`, entry); }
  for (const turn of turns) { const metadata = object(turn.metadata); const assessment = metadata.answerReaction ?? metadata.answerRelevance ?? metadata.relevanceAssessment ?? metadata.relevance; if (assessment) { const entry = object(assessment), id = entry.sourceTurnId ?? turn.id; if (!relevanceByTurn.has(id)) relevanceByTurn.set(id, entry); } }
  const relevance = [...relevanceByTurn.values()];
  for (const entry of relevance) for (const [value, counts] of [[entry.action, actions], [entry.classification, classifications], [entry.reasonCode, reasons]] as const) { const label = safeLabel(value); if (label) counts[label] = (counts[label] ?? 0) + 1; }
  const voices: Array<{ interviewerId: string | null; speaker: string; speed: number; pitch: number | null; volume: number | null }> = [];
  const findVoices = (value: unknown, depth = 0, interviewerId: string | null = null) => { if (!value || typeof value !== 'object' || depth > 8) return; const entry = object(value), identity = safeLabel(entry.interviewerId) ?? interviewerId; if (typeof entry.speaker === 'string' && /^[a-z][a-z0-9_-]{0,63}$/i.test(entry.speaker) && typeof entry.speed === 'number' && Number.isFinite(entry.speed)) { const voice = { interviewerId: identity, speaker: entry.speaker, speed: entry.speed, pitch: typeof entry.pitch === 'number' ? entry.pitch : null, volume: typeof entry.volume === 'number' ? entry.volume : null }; if (!voices.some(item => JSON.stringify(item) === JSON.stringify(voice))) voices.push(voice); } Object.values(value).forEach(child => findVoices(child, depth + 1, identity)); };
  events.filter(row => /provider[._]config|voice[._]config/i.test(row.type ?? '')).forEach(row => findVoices(row.payload));
  findVoices(session.providerConfig);
  for (const turn of turns) findVoices(object(turn.metadata).voiceSettings, 0, safeLabel(turn.interviewerId));
  const greeting = (turn: Item) => /안녕하세요|만나서\s*반갑|반갑습니다|면접을\s*시작/u.test(`${turn.acknowledgement ?? ''} ${turn.questionText ?? ''}`);
  const answerPatternSignals = turns.filter(turn => turn.transcriptStatus === 'finalized').flatMap(turn => {
    const signal = obviousAnswerReaction(typeof turn.questionText === 'string' ? turn.questionText : '', typeof turn.rawTranscript === 'string' ? turn.rawTranscript : '');
    return signal ? [{ turnId: turn.id, classification: signal.classification, reasonCode: signal.reasonCode }] : [];
  });
  const timelineEvents = full ? events : events.filter(row => !/stt[._]partial/i.test(row.type ?? ''));
  const shownEvents = !full && timelineEvents.length > 120 ? [...timelineEvents.slice(0, 40), ...timelineEvents.slice(-80)] : timelineEvents;
  const timeline = shownEvents.map(row => ({ seq: row.seq, timestamp: row.timestamp, type: safeLabel(row.type), actor: safeLabel(row.actor), turnId: validSession(row.turnId ?? '') ? row.turnId : null, answerId: safeLabel(row.answerId), role: safeLabel(row.role), ...(full ? { payload: row.payload ?? null } : {}) }));
  const latencyTurns = turns.map(turn => ({ ...turn, metadata: object(turn.metadata) })) as InterviewSession['turns'];
  const report = {
    version: 'local-conversation-review-v1', generatedAt: new Date().toISOString(), localOnly: true, includesOriginalText: full,
    session: { id: validSession(session.id ?? '') ? session.id : null, createdAt: session.createdAt ?? null, status: safeLabel(session.status), evaluationStatus: safeLabel(session.evaluationStatus), syntheticTest, provenance, turns: turns.length, finalizedAnswers: turns.filter(turn => turn.transcriptStatus === 'finalized').length, elapsedMs: typeof session.elapsedMs === 'number' ? session.elapsedMs : null },
    log: { events: events.length, malformedLines: options.malformedLines ?? 0, byType, timelineOmittedEvents: events.length - shownEvents.length, source: events.length ? 'append-only-jsonl-and-session-snapshot' : 'session-snapshot-only-no-historical-playback-proof' },
    observations: { repeatedAcknowledgements: repetitions(turns, 'acknowledgement', full), repeatedQuestions: repetitions(turns, 'questionText', full), repeatedAnswers: repetitions(turns, 'rawTranscript', full), greetingTurnCount: turns.filter(greeting).length, regreetingTurnCount: turns.slice(1).filter(greeting).length, answerPatternSignals, answerPatternNote: '확정 원문의 전체 사과·인사·질문복창·맥락 없는 숫자 등 기존 결정 규칙을 오프라인 적용한 신호입니다. 의미 관련성의 새 AI 판정이나 과거 실시간 판정의 증거가 아닙니다.', relevance: { observedAssessments: relevance.length, actions, classifications, reasonCodes: reasons, offTopicObserved: relevance.filter(entry => entry.classification === 'off_topic').length, offTopicTransitions: relevance.filter(entry => entry.classification === 'off_topic' && entry.action === 'transition').length, note: '저장된 관련성 판정만 집계하며 대화 원문으로 새 판정을 만들지 않습니다.' }, voiceSettings: voices.length ? voices : null, voiceSettingsNote: voices.length ? '세션 로그에 기록된 실제 설정값입니다.' : '과거 세션에 음성 설정 로그가 없어 현재 환경값으로 추정하지 않았습니다.' },
    latency: summarizeSessionLatency({ turns: latencyTurns, metrics: session.metrics }),
    timeline: events.length ? timeline : turns.map((turn, index) => ({ seq: index + 1, type: 'session.turn_snapshot', turnId: turn.id, questionKind: safeLabel(turn.questionKind), transcriptStatus: safeLabel(turn.transcriptStatus), questionChars: typeof turn.questionText === 'string' ? turn.questionText.length : 0, answerChars: typeof turn.rawTranscript === 'string' ? turn.rawTranscript.length : 0 })),
    ...(full ? { conversation: turns.map(turn => ({ turnId: turn.id, acknowledgement: turn.acknowledgement ?? null, question: turn.questionText ?? null, answer: turn.rawTranscript ?? null, transcriptStatus: turn.transcriptStatus ?? null })) } : {}),
    scope: '로컬 저장 기록의 검토 자료입니다. 새 외부 요청, 모델 학습, 자동 코드 변경이나 반복 실행은 수행하지 않습니다.',
  };
  return maskConversationSecrets(report) as typeof report;
}
export function reviewMarkdown(report: ReturnType<typeof buildConversationReview>) {
  let content = `# 로컬 면접 대화 로그 검토\n\n세션: ${report.session.id ?? 'unknown'}\n상태: ${report.session.status ?? 'unknown'} / 평가: ${report.session.evaluationStatus ?? 'unknown'}\n합성 테스트 표시: ${report.session.syntheticTest ?? 'unknown'}\n저장된 출처: ${JSON.stringify(report.session.provenance)}\n질문 ${report.session.turns}개, 확정 답변 ${report.session.finalizedAnswers}개, 로그 ${report.log.events}건\n원문 포함: ${report.includesOriginalText ? '예 (--full)' : '아니요'}\n\n\`\`\`json\n${JSON.stringify({ observations: report.observations, latency: report.latency, timeline: report.timeline }, null, 2)}\n\`\`\`\n`;
  if ('conversation' in report && report.conversation) for (const [index, turn] of report.conversation.entries()) content += `\n## 대화 ${index + 1}\n\n연결 발화: ${turn.acknowledgement ?? '(없음)'}\n\n질문: ${turn.question ?? '(없음)'}\n\n답변: ${turn.answer ?? '(미관찰)'}\n`;
  return content;
}
export async function exportPrivateReview(root: string, requested: string, content: string) {
  const file = path.resolve(root, requested), data = path.resolve(root, 'data');
  const relative = path.relative(data, file); if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('내보내기 경로는 프로젝트 data/ 내부여야 합니다.');
  await mkdir(data, { recursive: true, mode: 0o700 });
  let directory = data;
  for (const component of ['', ...path.dirname(relative).split(path.sep).filter(part => part !== '.')]) { if (component) directory = path.join(directory, component); try { const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('내보내기 디렉터리 연결은 허용하지 않습니다.'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await mkdir(directory, { mode: 0o700 }); } }
  await writeFile(file, content, { mode: 0o600, flag: 'wx' }); return path.relative(root, file);
}
async function optionalRead(file: string) { try { return await readFile(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; } }
async function sessions(root: string) {
  const files = await readdir(path.join(root, 'data/sessions')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
  const entries = await Promise.all(files.filter(file => validSession(file.replace(/\.json$/, '')) && file.endsWith('.json')).map(async file => {
    const source = path.join(root, 'data/sessions', file), info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink()) return null;
    let provenance: ReturnType<typeof syntheticInterviewProvenance> | null = null;
    try { provenance = syntheticInterviewProvenance(JSON.parse(await readFile(source, 'utf8'))); } catch { /* A malformed selected snapshot still fails when opened; never invent provenance. */ }
    return { id: file.slice(0, -5), modifiedMs: info.mtimeMs, syntheticTest: provenance?.syntheticTest ?? null, provenance };
  }));
  return entries.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)).sort((a, b) => b.modifiedMs - a.modifiedMs);
}
export async function reviewLogsCli(args: string[], root = process.cwd()) {
  if (!args.length || args.includes('--help')) return '사용법: npx tsx scripts/review-interview-logs.ts --list | --latest [--include-synthetic] | --session UUID [--full] [--export-json data/log-reviews/report.json] [--export-markdown data/log-reviews/report.md]\n--latest는 합성 검증 회차를 기본 제외합니다. --include-synthetic은 --latest에서만 사용하며 --session은 지정한 합성 회차도 조회합니다. --list는 합성 여부와 함께 전체 회차를 표시합니다. 기본 출력에는 원문 질문·답변을 포함하지 않습니다. --full은 원문을 명시적으로 표시하며 외부 전송은 없습니다.';
  let id: string | undefined, latest = false, includeSynthetic = false, list = false, full = false, json: string | undefined, markdown: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const item = args[index];
    if (['--session', '--sessionUUID', '--export-json', '--export-markdown'].includes(item)) {
      const value = args[++index]; if (!value || value.startsWith('--')) throw new Error('로그 검토 옵션의 값을 입력해 주세요.');
      if (item === '--export-json') json = value; else if (item === '--export-markdown') markdown = value; else id = value;
    } else if (item.startsWith('--session=')) id = item.slice(10);
    else if (item === '--latest') latest = true; else if (item === '--include-synthetic') includeSynthetic = true; else if (item === '--list') list = true; else if (item === '--full') full = true;
    else throw new Error('지원하지 않는 로그 검토 옵션입니다. --help를 확인해 주세요.');
  }
  if ([Boolean(id), latest, list].filter(Boolean).length !== 1) throw new Error('--session UUID, --latest, --list 중 하나를 선택해 주세요.');
  if (includeSynthetic && !latest) throw new Error('--include-synthetic은 --latest에서만 사용합니다.');
  if (list) { if (json || markdown || full) throw new Error('원문 및 내보내기 옵션에는 한 세션을 선택해 주세요.'); return JSON.stringify({ localOnly: true, sessions: await sessions(root) }, null, 2); }
  if (latest) id = (await sessions(root)).find(entry => includeSynthetic || entry.syntheticTest !== true)?.id;
  if (!id || !validSession(id)) throw new Error('검토할 로컬 세션 UUID가 없습니다.');
  const sessionText = await optionalRead(path.join(root, 'data/sessions', `${id}.json`)); if (!sessionText) throw new Error('로컬 세션 파일을 찾지 못했습니다.');
  const log = parseConversationJsonl(await optionalRead(path.join(root, 'data/conversation-logs', `${id}.jsonl`)));
  const report = buildConversationReview(JSON.parse(sessionText), log.rows.filter(row => row.sessionId === id), { full, malformedLines: log.malformedLines });
  if (json) await exportPrivateReview(root, json, JSON.stringify(report, null, 2));
  if (markdown) await exportPrivateReview(root, markdown, reviewMarkdown(report));
  return JSON.stringify(report, null, 2);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) reviewLogsCli(process.argv.slice(2)).then(output => process.stdout.write(`${output}\n`)).catch(() => { process.stderr.write('로컬 로그 검토를 완료하지 못했습니다. 세션·옵션·data/ 경로·파일 권한을 확인해 주세요.\n'); process.exitCode = 1; });
