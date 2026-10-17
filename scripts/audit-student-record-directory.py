"""Audit all 88 immutable disclosure snapshots; do not infer current admission units from zero quota rows."""
import collections,csv,hashlib,json,pathlib
ROOT=pathlib.Path(__file__).resolve().parents[1]
source=ROOT/'.local/school-departments-source.csv'
directory=json.loads((ROOT/'apps/web/src/data/school-directory.json').read_text(encoding='utf8'))
details=json.loads((ROOT/'apps/web/src/data/school-department-details.json').read_text(encoding='utf8'))
index=collections.defaultdict(list)
with source.open(encoding='utf-8-sig',newline='') as stream:
    for row in csv.DictReader(stream):
        if row['공시연도']=='2026' and row['학교종류'] in ('대학교','교육대학') and float(row['모집인원_계'] or 0)>0:
            index[row['학교명']].append(row)
issues=[];schools=[]
fields={'name':'학과명','college':'단과대학','field':'표준분류_대계열','category':'표준분류_중계열'}
for school in directory['schools']:
    rows=[r for r in index[school['canonicalName']] if not school['campusLabel'] or r['본분교명']=='본교']
    expected={r['학과코드']+'-'+r['본분교명'] for r in rows};actual={d['id'] for d in school['departments']}
    wrong=[]
    for department in school['departments']:
        matches=[r for r in rows if r['학교코드']==department['schoolCode'] and r['학과코드']==department['departmentCode'] and r['본분교명']==department['campus'] and all(department[k]==r[v] for k,v in fields.items())]
        if not matches:wrong.append(department['id'])
    report={'id':school['id'],'university':school['university'],'departments':len(actual),'missingFromSourceRule':sorted(expected-actual),'extraOrWrongCampus':sorted(actual-expected),'mismatchedOwnershipOrMetadata':wrong}
    schools.append(report)
    if wrong or actual!=expected:issues.append(report)
payload={'checkedAt':'2026-10-17','sourceUrl':directory['departmentSource']['url'],'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'sourceHashMatches':hashlib.sha256(source.read_bytes()).hexdigest()==directory['departmentSource']['sha256'],'originalSchools':len(schools),'originalDepartments':sum(s['departments'] for s in schools),'issues':issues,'all2027AdmissionUnitsVerified':False,'scope':'2026 공시 원본의 학교·캠퍼스·학과코드·명칭·분류와 양방향 전수 대조. 2027 모집단위 전수 검증과 구분.','broadUnitDetails':{'units':len(details['units']),'programConnections':sum(len(u['programs']) for u in details['units']),'sourceUrls':sorted({u['sourceUrl'] for u in details['units']})},'schools':schools}
out=ROOT/'docs/student-record-directory-audit-2026-10-17.json'
out.write_text(json.dumps(payload,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
print(json.dumps({k:v for k,v in payload.items() if k not in ('schools','scope')},ensure_ascii=False))
if issues or not payload['sourceHashMatches']:raise SystemExit(1)
