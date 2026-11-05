"""Validate proposed schema shapes and a separate pure source-span example."""
from pathlib import Path
import json,hashlib,sys,re
from datetime import datetime
import importlib.metadata
from jsonschema import Draft202012Validator,FormatChecker

ROOT=Path(__file__).resolve().parent
checker=FormatChecker()
@checker.checks('date-time',raises=(ValueError,TypeError))
def date_time(value):
    if not isinstance(value,str):return True
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})',value):return False
    parsed=datetime.fromisoformat(value.upper().replace('Z','+00:00'))
    return parsed.tzinfo is not None

def hash_text(value):return hashlib.sha256(value.encode('utf-8')).hexdigest()
def verify_source_span(evidence,source_text):
    # Pure demonstration only. The application must first authorize/read the
    # exact immutable source version; never take source_text from the client.
    if evidence['offset_unit']!='utf16_code_unit':return False
    start,end=evidence['start_utf16'],evidence['end_utf16']
    raw=source_text.encode('utf-16-le')
    if not 0 <= start < end <= len(raw)//2:return False
    try:quote=raw[start*2:end*2].decode('utf-16-le',errors='strict')
    except UnicodeDecodeError:return False
    return quote==evidence['quote'] and hash_text(source_text)==evidence['source_sha256'] and hash_text(quote)==evidence['quote_sha256']

def main():
    validators={}
    for path in sorted(ROOT.glob('*.schema.json')):
        schema=json.loads(path.read_text());Draft202012Validator.check_schema(schema)
        validators[path.name]=Draft202012Validator(schema,format_checker=checker)
    outcomes=[]
    for fixture in json.loads((ROOT/'fixtures.json').read_text())['cases']:
        errors=list(validators[fixture['schema']].iter_errors(fixture['instance']))
        actual=not errors
        outcomes.append({'name':fixture['name'],'expected_valid':fixture['expected_valid'],'actual_valid':actual,'passed':actual==fixture['expected_valid'],'error_count':len(errors)})
    source_fixtures=json.loads((ROOT/'runtime-source-fixtures.json').read_text())
    source_outcomes=[]
    for fixture in source_fixtures['cases']:
        actual=verify_source_span(fixture['evidence'],source_fixtures['source_text'])
        source_outcomes.append({'name':fixture['name'],'expected_valid':fixture['expected_valid'],'actual_valid':actual,'passed':actual==fixture['expected_valid']})
    result={'status':'passed' if all(x['passed'] for x in outcomes+source_outcomes) else 'failed','artifact_status':'PROPOSED_NOT_INTEGRATED','validator':'jsonschema','validator_version':importlib.metadata.version('jsonschema'),'dialect':'2020-12','schema_count':len(validators),'shape_cases':len(outcomes),'shape_passed':sum(x['passed'] for x in outcomes),'source_span_cases':len(source_outcomes),'source_span_passed':sum(x['passed'] for x in source_outcomes),'typescript_ajv':'not_run_dependency_unavailable','pydantic':'not_run_no_production_adapter','application_tests':'not_run_no_application_changes','paid_api_calls':0,'database_authorization_validation':'not_run_not_claimed','cases':outcomes,'source_span_results':source_outcomes}
    (ROOT/'validation-results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({k:v for k,v in result.items() if k not in ['cases','source_span_results']},ensure_ascii=False))
    return result['status']!='passed'
if __name__=='__main__':sys.exit(main())
