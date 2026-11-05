"""Generate PROPOSED service contracts; never patches the application."""
from pathlib import Path
from copy import deepcopy
import hashlib,json

ROOT=Path(__file__).resolve().parent
ROOT.mkdir(parents=True,exist_ok=True)
VERSION='proposed-v2-2026-11-06'
# An explicit codepoint set avoids Python/ECMAScript \s differences.
NONBLANK=r'[^\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff\u200b]'
def st(maximum=200):return {'type':'string','minLength':1,'maxLength':maximum,'pattern':NONBLANK}
def ident():return {'type':'string','minLength':1,'maxLength':160,'pattern':'^[A-Za-z0-9][A-Za-z0-9._:-]*$'}
def sha():return {'type':'string','pattern':'^[a-f0-9]{64}$'}
def const(x):return {'const':x}
def integer(minimum=0):return {'type':'integer','minimum':minimum}
def arr(items,minimum=0,maximum=100):return {'type':'array','items':items,'minItems':minimum,'maxItems':maximum,'uniqueItems':True}
def obj(fields):return {'type':'object','properties':fields,'required':list(fields),'additionalProperties':False}
def header(name,body):return {'$schema':'https://json-schema.org/draft/2020-12/schema','$id':'urn:gakja:proposed:'+name+':v2','title':name+' — PROPOSED, not production','description':'검토용 계약. 앱 적용 전 정책 승인·런타임 검사·공유 검증기를 함께 연결해야 한다.',**body}
def dump(name,data):(ROOT/name).write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')

submission_common={'schema_version':const(VERSION),'session_id':ident(),'turn_id':ident(),'answer_id':ident(),'expected_session_revision':integer(),'idempotency_key':ident()}
submission=header('answer-submission',{'oneOf':[
 obj({**submission_common,'kind':const('text_answer'),'text':st(20000)}),
 obj({**submission_common,'kind':const('finalized_transcript'),'transcript_revision_id':ident()}),
 obj({**submission_common,'kind':const('confirmed_non_answer'),'reason':const('observed_silence'),'capture_id':ident(),'capture_revision':integer(),'capture_evidence_revision_id':ident(),'confirmation':const('student_confirmed')})
]})

evidence_common={'schema_version':const(VERSION),'evidence_id':ident(),'source_version_id':ident(),'source_sha256':sha(),'start_utf16':integer(),'end_utf16':integer(1),'offset_unit':const('utf16_code_unit'),'quote':st(20000),'quote_sha256':sha()}
evidence=header('evidence-ref',{'oneOf':[
 obj({**evidence_common,'kind':const('record'),'record_version_id':ident(),'page_number':integer(1),'block_id':ident(),'claim_status':const('record_text')}),
 obj({**evidence_common,'kind':const('university'),'profile_version_id':ident(),'document_version_id':ident(),'source_authority':{'enum':['official','reference','unverified']},'claim_status':const('university_source_text')}),
 obj({**evidence_common,'kind':const('answer'),'answer_revision_id':ident(),'session_id':ident(),'turn_id':ident(),'claim_status':const('student_claim_unverified')}),
 obj({**evidence_common,'kind':const('student_confirmation'),'confirmation_revision_id':ident(),'student_id':ident(),'claim_status':{'enum':['student_confirmed','student_says_different','cannot_confirm']}})
]})

playback_common={'schema_version':const(VERSION),'event_id':ident(),'session_id':ident(),'turn_id':ident(),'question_version_id':ident(),'utterance_id':ident(),'utterance_sha256':sha(),'playback_attempt_id':ident(),'clock_id':ident(),'sequence':integer(1),'client_monotonic_ms':{'type':'number','minimum':0},'client_occurred_at':{'type':'string','format':'date-time'}}
playback=header('playback-event',{'oneOf':[
 obj({**playback_common,'kind':const('started'),'position_ms':integer()}),
 obj({**playback_common,'kind':const('completed'),'position_ms':integer(),'duration_ms':integer()}),
 obj({**playback_common,'kind':const('interrupted'),'position_ms':integer(),'reason':{'enum':['pause','navigation','device_change','user_cancel','session_end']}}),
 obj({**playback_common,'kind':const('failed'),'position_ms':integer(),'error_code':{'enum':['autoplay_blocked','audio_fetch_failed','audio_decode_failed','device_unavailable','unknown']}})
]})

functions=['FACT','MOTIVE','ROLE','PROCESS','CHOICE','CONCEPT','EVIDENCE','RESULT','LIMIT','ALTERNATIVE','TRANSFER','CONNECTION','VALUE','CLARIFY_CONTENT','VERIFY_CLAIM']
assessment=obj({'coverage':{'enum':['met','partial','unknown']},'response':{'enum':['answered','unavailable','unrelated','unclear']},'reason':st(180)})
reaction={'oneOf':[{'type':'null'},obj({'quote':st(28),'text':st(76)})]}
decision_common={'schema_version':const(VERSION),'source_turn_id':ident(),'source_answer_revision_id':ident(),'source_question_version_id':ident(),'policy_version_id':ident(),'source_manifest_sha256':sha()}
next_variants=[]
next_variants.append(obj({'action':const('FOLLOW_UP'),'trigger_kind':{'enum':['missing_subpoint','new_claim','unresolved_difference','important_ambiguity','concept_extension']},'question':obj({'text':st(75),'target':st(180),'primary_function':{'enum':functions},'depth':{'enum':['D1','D2','D3','D4']},'strategy_id':{'oneOf':[ident(),{'type':'null'}]},'evidence_ref_ids':arr(ident(),1,12)})}))
next_variants.append(obj({'action':const('CLARIFICATION'),'trigger_kind':const('same_requirement'),'question':obj({'text':st(80),'preserved_question_version_id':ident()})}))
next_variants.append(obj({'action':const('REPLAY'),'trigger_kind':{'enum':['replay_requested','observed_silence']},'question':{'type':'null'}}))
next_variants.append(obj({'action':const('TRANSITION'),'trigger_kind':{'enum':['requirement_satisfied','no_useful_probe','declined_scope','answer_unavailable','budget_exhausted']},'question':{'type':'null'}}))
next_variants.append(obj({'action':const('CLOSING'),'trigger_kind':{'enum':['time_exhausted','session_requested_end','pool_exhausted']},'question':{'type':'null'}}))
decision=header('interview-decision',{'oneOf':[
 obj({**decision_common,'kind':const('continue_answer'),'assessment':{'type':'null'},'next':obj({'action':const('CONTINUE_ANSWER'),'trigger_kind':const('unfinished_thought'),'question':{'type':'null'}}),'reaction':{'type':'null'}}),
 obj({**decision_common,'kind':const('assessed_turn'),'assessment':assessment,'next':{'oneOf':next_variants},'reaction':reaction})
]})

packet=obj({'packet_id':ident(),'packet_version_id':ident(),'content_sha256':sha()})
scope_common={'schema_version':const(VERSION),'scope_approval_id':ident(),'session_id':ident(),'turn_id':ident(),'question_version_id':ident(),'question_contract_sha256':sha(),'answer_revision_ids':arr(ident(),1,20),'source_manifest_sha256':sha(),'policy_version_id':ident()}
scope=header('evaluation-scope-approval',{'oneOf':[
 obj({**scope_common,'scope':const('record_consistency_only'),'approval_status':const('approved'),'approved_by':ident(),'approval_revision_id':ident(),'packet_refs':arr(packet,0,0),'claim_review_ids':arr(ident(),0,0),'claim_coverage':const('not_applicable'),'scientific_truth_authority':const('none')}),
 obj({**scope_common,'scope':const('objective_knowledge'),'approval_status':const('approved'),'approved_by':ident(),'approval_revision_id':ident(),'packet_refs':arr(packet,1,20),'claim_review_ids':arr(ident(),1,100),'claim_coverage':const('all_core_claims_reviewed'),'scientific_truth_authority':const('approved_packet_and_claim')}),
 obj({**scope_common,'scope':const('none'),'approval_status':const('unresolved'),'hold_reason_codes':arr({'enum':['scope_not_approved','scope_unresolved','source_unavailable','claim_review_required','source_binding_changed']},1,10),'packet_refs':arr(packet,0,0),'claim_review_ids':arr(ident(),0,0),'scientific_truth_authority':const('none')})
]})
schemas={'answer-submission':submission,'evidence-ref':evidence,'playback-event':playback,'interview-decision':decision,'evaluation-scope-approval':scope}
for name,data in schemas.items():dump(name+'.schema.json',data)

fixtures=[]
def case(name,schema,data,valid,note=''):fixtures.append({'name':name,'schema':schema+'.schema.json','expected_valid':valid,'note':note,'instance':deepcopy(data)})
def mutated(data,**updates):return {**deepcopy(data),**updates}
base={'schema_version':VERSION,'session_id':'sess_demo','turn_id':'turn_1','answer_id':'ans_1','expected_session_revision':7,'idempotency_key':'submit_1'}
text_answer={**base,'kind':'text_answer','text':'제가 자료를 표로 정리했습니다.'}
transcript={**base,'kind':'finalized_transcript','transcript_revision_id':'tr_rev_1'}
silence={**base,'kind':'confirmed_non_answer','reason':'observed_silence','capture_id':'cap_1','capture_revision':1,'capture_evidence_revision_id':'cap_ev_1','confirmation':'student_confirmed'}
case('text-valid','answer-submission',text_answer,True)
case('transcript-valid-shape-only','answer-submission',transcript,True,'실제 전사가 finalized/비어있지 않음/해당 turn 소유인지 서버에서 검사')
case('silence-valid-shape-only','answer-submission',silence,True,'서버가 capture 정상종료·장치정상·실제 무음 관찰 근거를 검사')
case('no-answer-variant','answer-submission',base,False)
case('both-text-and-transcript','answer-submission',mutated(text_answer,transcript_revision_id='tr_rev_1'),False)
case('text-empty','answer-submission',mutated(text_answer,text=''),False)
case('text-ascii-whitespace','answer-submission',mutated(text_answer,text=' \t\r\n '),False)
case('text-unicode-whitespace','answer-submission',mutated(text_answer,text='\u3000\u00a0\u200b\ufeff'),False)
case('transcript-with-text','answer-submission',mutated(transcript,text='동시 입력'),False)
case('silence-cannot-claim-stt-failure','answer-submission',mutated(silence,reason='stt_failed'),False)
case('silence-no-evidence','answer-submission',{k:v for k,v in silence.items() if k!='capture_evidence_revision_id'},False)
case('client-injected-owner','answer-submission',mutated(text_answer,owner_id='another_user'),False)

digest=hashlib.sha256('발표😀 준비'.encode()).hexdigest()
quote='발표😀'
ev={'schema_version':VERSION,'evidence_id':'ev_1','source_version_id':'src_rev_1','source_sha256':digest,'start_utf16':0,'end_utf16':4,'offset_unit':'utf16_code_unit','quote':quote,'quote_sha256':hashlib.sha256(quote.encode()).hexdigest()}
record={**ev,'kind':'record','record_version_id':'rec_rev_1','page_number':1,'block_id':'block_1','claim_status':'record_text'}
university={**ev,'kind':'university','profile_version_id':'profile_v1','document_version_id':'doc_v1','source_authority':'official','claim_status':'university_source_text'}
answer={**ev,'kind':'answer','answer_revision_id':'ans_rev_1','session_id':'sess_demo','turn_id':'turn_1','claim_status':'student_claim_unverified'}
confirmation={**ev,'kind':'student_confirmation','confirmation_revision_id':'confirmation_rev_1','student_id':'student_demo','claim_status':'student_confirmed'}
for k,v in [('record',record),('university',university),('answer',answer),('confirmation',confirmation)]:case(k+'-evidence-valid-shape','evidence-ref',v,True)
case('answer-is-not-record-fact','evidence-ref',mutated(answer,claim_status='record_fact'),False)
case('record-page-zero','evidence-ref',mutated(record,page_number=0),False)
case('wrong-offset-unit','evidence-ref',mutated(record,offset_unit='codepoint'),False)
case('quote-hash-malformed','evidence-ref',mutated(record,quote_sha256='abc'),False)
case('cross-kind-extra-fields','evidence-ref',mutated(record,answer_revision_id='ans_rev_1'),False)
case('reversed-offset-shape-only','evidence-ref',mutated(record,start_utf16=9,end_utf16=2),True,'구조상 허용; runtime-source-check에서 반드시 거부')
case('wrong-quote-shape-only','evidence-ref',mutated(record,quote='꾸민 내용'),True,'구조상 허용; runtime-source-check에서 반드시 거부')

pb={'schema_version':VERSION,'event_id':'event_1','session_id':'sess_demo','turn_id':'turn_1','question_version_id':'q_rev_1','utterance_id':'utt_1','utterance_sha256':'a'*64,'playback_attempt_id':'play_1','clock_id':'clock_tab_1','sequence':1,'client_monotonic_ms':120.5,'client_occurred_at':'2026-11-06T10:00:00+09:00'}
for kind,fields in [('started',{'position_ms':0}),('completed',{'position_ms':3200,'duration_ms':3200}),('interrupted',{'position_ms':1500,'reason':'pause'}),('failed',{'position_ms':0,'error_code':'autoplay_blocked'})]:case(kind+'-playback','playback-event',{**pb,'kind':kind,**fields},True)
case('ready-is-not-playback','playback-event',{**pb,'kind':'tts.ready','position_ms':0},False)
case('completed-no-duration','playback-event',{**pb,'kind':'completed','position_ms':10},False)
case('playback-negative-sequence','playback-event',{**pb,'kind':'started','position_ms':0,'sequence':0},False)
case('playback-no-clock','playback-event',{**{k:v for k,v in pb.items() if k!='clock_id'},'kind':'started','position_ms':0},False)
case('playback-invalid-date','playback-event',{**pb,'kind':'started','position_ms':0,'client_occurred_at':'yesterday'},False)

db={'schema_version':VERSION,'source_turn_id':'turn_1','source_answer_revision_id':'ans_rev_1','source_question_version_id':'q_rev_1','policy_version_id':'policy_v1','source_manifest_sha256':'b'*64}
ass={'coverage':'met','response':'answered','reason':'실제 질문의 본인 행동 한 가지를 답했습니다.'}
follow={**db,'kind':'assessed_turn','assessment':ass,'next':{'action':'FOLLOW_UP','trigger_kind':'new_claim','question':{'text':'성과를 확인한 근거는 무엇인가요?','target':'실제 언급한 성과의 근거 한 가지','primary_function':'EVIDENCE','depth':'D2','strategy_id':None,'evidence_ref_ids':['ev_1']}},'reaction':None}
cont={**db,'kind':'continue_answer','assessment':None,'next':{'action':'CONTINUE_ANSWER','trigger_kind':'unfinished_thought','question':None},'reaction':None}
case('followup-met-new-claim-permitted','interview-decision',follow,True,'met이어도 실익 있는 새 주장 F 가능; 의미 적합성은 스키마가 증명하지 않음')
case('continue-without-assessment','interview-decision',cont,True)
for action,trigger,question in [('CLARIFICATION','same_requirement',{'text':'본인이 직접 한 일을 말씀해 주세요.','preserved_question_version_id':'q_rev_1'}),('REPLAY','replay_requested',None),('TRANSITION','requirement_satisfied',None),('CLOSING','time_exhausted',None)]:case(action+'-valid','interview-decision',{**db,'kind':'assessed_turn','assessment':ass,'next':{'action':action,'trigger_kind':trigger,'question':question},'reaction':None},True)
case('continue-with-assessment','interview-decision',mutated(cont,assessment=ass),False)
case('assessed-null-assessment','interview-decision',mutated(follow,assessment=None),False)
bad=deepcopy(follow);bad['next']['trigger_kind']='same_requirement';case('f-cannot-have-same-trigger','interview-decision',bad,False)
bad=deepcopy(follow);bad['next']['question']['primary_function']='new_claim';case('trigger-is-not-function','interview-decision',bad,False)
bad=deepcopy(follow);bad['next']['question']['evidence_ref_ids']=[];case('f-no-source-ids','interview-decision',bad,False)
bad=deepcopy(follow);bad['next']['question']['text']='가'*76;case('f-too-long','interview-decision',bad,False)

sb={'schema_version':VERSION,'scope_approval_id':'scope_1','session_id':'sess_demo','turn_id':'turn_1','question_version_id':'q_rev_1','question_contract_sha256':'c'*64,'answer_revision_ids':['ans_rev_1'],'source_manifest_sha256':'b'*64,'policy_version_id':'policy_v1'}
general={**sb,'scope':'record_consistency_only','approval_status':'approved','approved_by':'reviewer_demo','approval_revision_id':'scope_rev_1','packet_refs':[],'claim_review_ids':[],'claim_coverage':'not_applicable','scientific_truth_authority':'none'}
academic={**sb,'scope':'objective_knowledge','approval_status':'approved','approved_by':'reviewer_demo','approval_revision_id':'scope_rev_1','packet_refs':[{'packet_id':'packet_1','packet_version_id':'packet_rev_1','content_sha256':'d'*64}],'claim_review_ids':['review_1'],'claim_coverage':'all_core_claims_reviewed','scientific_truth_authority':'approved_packet_and_claim'}
none={**sb,'scope':'none','approval_status':'unresolved','hold_reason_codes':['scope_not_approved'],'packet_refs':[],'claim_review_ids':[],'scientific_truth_authority':'none'}
case('general-approved','evaluation-scope-approval',general,True)
case('academic-approved-shape-only','evaluation-scope-approval',academic,True)
case('none-explicitly-held','evaluation-scope-approval',none,True)
case('academic-without-packets','evaluation-scope-approval',mutated(academic,packet_refs=[]),False)
case('academic-without-claim-reviews','evaluation-scope-approval',mutated(academic,claim_review_ids=[]),False)
case('general-cannot-authorize-scientific-truth','evaluation-scope-approval',mutated(general,scientific_truth_authority='approved_packet_and_claim'),False)
case('none-cannot-self-approve','evaluation-scope-approval',mutated(none,approval_status='approved'),False)
case('scope-no-manifest','evaluation-scope-approval',{k:v for k,v in general.items() if k!='source_manifest_sha256'},False)
dump('fixtures.json',{'status':'PROPOSED','fixture_origin':'synthetic,no_student_data','cases':fixtures})
dump('runtime-source-fixtures.json',{'source_text':'발표😀 준비','cases':[{'name':'utf16-valid','evidence':record,'expected_valid':True},{'name':'reversed-offset','evidence':mutated(record,start_utf16=9,end_utf16=2),'expected_valid':False},{'name':'wrong-quote','evidence':mutated(record,quote='꾸민 내용'),'expected_valid':False},{'name':'split-surrogate','evidence':mutated(record,end_utf16=3),'expected_valid':False}]})
dump('examples.json',{'status':'PROPOSED','answer_submission':[text_answer,transcript,silence],'evidence':[record,university,answer,confirmation],'decision':[cont,follow],'evaluation_scope':[general,academic,none]})
print(json.dumps({'schemas':len(schemas),'shape_cases':len(fixtures),'output':str(ROOT)},ensure_ascii=False))
