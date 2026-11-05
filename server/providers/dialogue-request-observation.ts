export const PURE_DIALOGUE_REQUEST_VERSION = 'whole-answer-dialogue-request-v1';
export interface PureDialogueRequestObservation {
  kind: 'repeat_audio' | 'explain_question';
  version: typeof PURE_DIALOGUE_REQUEST_VERSION;
  source: 'whole_finalized_transcript';
  sourceStartOffset: 0;
  sourceEndOffset: number;
  matchedRule: 'explicit_replay' | 'hearing_then_replay' | 'meaning_question' | 'meaning_rephrase' | 'embedded_meaning_request';
}

const requestEnding = '(?:주세요|주십시오|주시겠어요|주시겠습니까|주실수있을까요|주실수있나요|주실래요|줄수있을까요|줄수있나요|줄래요|줘요|줘)';
const replay = new RegExp(`^(?:(?:방금|지금|아까|앞서|그|이)(?:의)?)?(?:(?:질문(?:내용)?|말씀)(?:을|이|은)?)?(?:(?:한번만|한번|다시|좀|조금|천천히)){1,4}(?:들려|읽어|말씀해|말해|재생해)${requestEnding}$`, 'u');
const hearingPrefix = /^(?:(?:방금|지금|아까|앞서)(?:의)?)?(?:질문(?:내용)?|말씀)(?:이|을)?(?:잘)?(?:안들렸(?:어요|습니다)|못들었(?:어요|습니다)|들리지않았(?:어요|습니다))/u;
const hearingReplay = new RegExp(`^(?:(?:질문(?:내용)?|말씀)(?:을)?)?(?:(?:한번만|한번|다시|좀|조금|천천히)){0,4}(?:들려|읽어|말씀해|말해|재생해)${requestEnding}$`, 'u');
const meaningQuestion = /^(?:(?:방금|지금|앞서|그|이)(?:의)?)?(?:질문(?:내용)?(?:이|은)?|질문의(?:뜻|의미)(?:이|가|는)?)(?:무슨|어떤)뜻(?:인가요|인지요|인지모르겠습니다|인지모르겠어요)$/u;
const meaningRephrase = new RegExp(`^(?:(?:방금|지금|앞서|그|이|말씀하신)(?:의)?)?질문(?:내용|의뜻|의미)?(?:을|를)?(?:(?:좀|조금|더)){0,2}(?:쉽게|다른말로|풀어서)(?:다시)?(?:설명해|말씀해|말해)${requestEnding}$`, 'u');
const meaningDirect = new RegExp(`^(?:(?:방금|지금|앞서|그|이)(?:의)?)?질문(?:(?:의뜻|의미)(?:을|를)?|(?:이|은)?(?:무슨|어떤)뜻인지|(?:내용)?(?:을)?)(?:(?:다시|좀|조금|더|쉽게)){0,3}설명해${requestEnding}$`, 'u');
const meaningPrelude = /^(?:질문(?:이|의뜻이)?(?:잘)?이해가(?:잘)?안(?:돼요|됩니다|됐어요)|(?:질문(?:이|의뜻이)?)?(?:무슨|어떤)뜻인지(?:잘)?모르(?:겠습니다|겠어요))/u;
const embeddedMeaning = new RegExp(`^(?:(?:이|그|두|주|각))?(?:활동|경험|내용|부분|개념|용어|표현|관심사|질문)[가-힣A-Za-z0-9]{0,60}(?:이라는|라는|다는)(?:말|뜻)(?:이|은)?(?:무슨뜻인지|어떤뜻인지|인지)(?:(?:좀|조금|더)){0,2}(?:쉽게|다른말로|풀어서)?(?:설명해|말씀해|말해)${requestEnding}$`, 'u');
const blockedSubstantive = /저는|제가|저희|우리는|우리가|나는|내가|제경험|내경험|기억나|기억이|모르겠습니다만|했(?:습니다|어요|는데|고|던)|하였|맡았|비교했|수행했|하고|이며|이고/u;

/** High-precision observation, not semantic grading or an exhaustive request
 * classifier. Only a full meta-request can bypass the core. A factual answer
 * mixed with a request returns null so the semantic core sees both meanings.
 * Source offsets always address the untouched original transcript. MD8 §15,
 * MD9 §16: replay/rephrasing is separate from evaluative follow-up allowance.
 */
export function observePureDialogueRequest(raw: string): PureDialogueRequestObservation | null {
  if (!raw.trim() || raw.length > 400 || /[“”‘’"'`<>]/u.test(raw)) return null;
  let value = raw.normalize('NFC').replace(/[\s.!?。？！，,]/gu, '');
  value = value.replace(/^(?:(?:죄송하지만|죄송합니다만|죄송한데|실례지만|혹시|저기요)){0,2}/u, '');
  if (!value || blockedSubstantive.test(value)) return null;
  const observation = (kind: PureDialogueRequestObservation['kind'], matchedRule: PureDialogueRequestObservation['matchedRule']): PureDialogueRequestObservation => ({
    kind, version: PURE_DIALOGUE_REQUEST_VERSION, source: 'whole_finalized_transcript',
    sourceStartOffset: 0, sourceEndOffset: raw.length, matchedRule,
  });
  // Explicit understanding words take precedence over the acoustic replay path.
  if (meaningQuestion.test(value)) return observation('explain_question', 'meaning_question');
  if (meaningRephrase.test(value) || meaningDirect.test(value)) return observation('explain_question', 'meaning_rephrase');
  const afterMeaning = value.replace(meaningPrelude, '');
  if (afterMeaning !== value && meaningRephrase.test(afterMeaning)) return observation('explain_question', 'meaning_rephrase');
  // Embedded interrogative topics remain meta-requests, but an arbitrary
  // declarative claim ending in "뜻인지" is intentionally left to the core.
  if (/어떻게|어떤|무슨|무엇|왜|언제|어디|몇/u.test(value) && embeddedMeaning.test(value)) return observation('explain_question', 'embedded_meaning_request');
  if (replay.test(value) && /다시|한번/u.test(value)) return observation('repeat_audio', 'explicit_replay');
  const afterHearing = value.replace(hearingPrefix, '');
  if (afterHearing !== value && hearingReplay.test(afterHearing)) return observation('repeat_audio', 'hearing_then_replay');
  return null;
}
