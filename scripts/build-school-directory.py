"""Refresh the verified 88-school directory from the Ministry CSV and Adiga.

Input: the original downloadable 2026 Ministry CSV (not an API credential).
Only current-year undergraduate departments with a positive recruitment count
are offered. Every department carries its original school/department code.
The resulting snapshot is reference data, not a 2027 admission-unit guarantee.
"""
import argparse,concurrent.futures,csv,hashlib,json,pathlib,re,urllib.request,urllib.parse
from html import unescape
ROOT=pathlib.Path(__file__).resolve().parents[1]
DEFAULT_SOURCE=ROOT/'.local/school-departments-source.csv'
OUT=ROOT/'apps/web/src/data/school-directory.json'
ASSETS=ROOT/'apps/web/public/school-logos'
DATA_URL='https://www.data.go.kr/data/15163924/fileData.do'
ADIGA='https://www.adiga.kr'
def get(url,max_bytes=1500000):
    request=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0 (compatible; GakjaON university directory)'})
    with urllib.request.urlopen(request,timeout=20) as response:
        data=response.read(max_bytes+1)
        if len(data)>max_bytes:raise ValueError('size_limit')
        return response.url,response.headers.get('Content-Type',''),data
def clean_school(name):
    return re.sub(r'\s+(GIST|DGIST|UNIST|POSTECH|KAIST|KENTECH)$','',name.split(' — ')[0])
def attrs(tag):
    return {m[0].lower():unescape(m[2]) for m in re.findall(r'([\w-]+)\s*=\s*([\"\x27])(.*?)\2',tag,re.S)}
def official_details(school):
    code=school['publicSchoolCode']
    url=f'{ADIGA}/ucp/uvt/uni/univDetail.do?menuId=PCUVTINF2000&searchSyr=2027&unvCd={code}'
    result={'directoryUrl':url,'checkedAt':'2026-10-12','admissionUrl':None,'websiteUrl':None,'logoUrl':None,'linkStatus':'unavailable'}
    try:
        resolved,kind,data=get(url);text=data.decode('utf8',errors='replace')
        name=re.search(r'<h[1-6][^>]*>([^<]*'+re.escape(school['canonicalName'][:3])+r'[^<]*)</h[1-6]>',text)
        if not name:raise ValueError('school_identity_not_found')
        for match in re.finditer(r'<a\b([^>]+)>\s*(홈페이지|입시홈페이지)\s*</a>',text,re.S):
            a=attrs('<a '+match[1]+'>');link=re.search(r'fnOpenNewUrl\([\"\x27](.*?)[\"\x27]\)',a.get('onclick',''))
            if not link:continue
            source=link[1].replace('\\/','/')
            if source.startswith('www.'):source='https://'+source
            if urllib.parse.urlparse(source).scheme not in ['https','http']:continue
            result['admissionUrl' if match[2]=='입시홈페이지' else 'websiteUrl']=source
        result['linkStatus']='official_directory' if result['admissionUrl'] else 'unavailable'
        result['directorySha256']=hashlib.sha256(data).hexdigest()
        logo=next((attrs(tag).get('src') for tag in re.findall(r'<img\b[^>]+>',text,re.I) if '대학교 로고' in attrs(tag).get('alt','')),None)
        if logo:
            image_url=urllib.parse.urljoin(resolved,logo);final,kind,image=get(image_url,2000000)
            ext='.svg' if b'<svg' in image[:500] else '.png' if image[:8]==b'\x89PNG\r\n\x1a\n' else '.jpg' if image[:3]==b'\xff\xd8\xff' else '.gif' if image[:3]==b'GIF' else None
            if ext and not (ext=='.svg' and re.search(rb'<script|onload=|<foreignObject|<!DOCTYPE',image,re.I)):
                filename=code+ext;ASSETS.mkdir(exist_ok=True);(ASSETS/filename).write_bytes(image)
                result.update({'logoUrl':'/school-logos/'+filename,'logoSourceUrl':final,'logoSha256':hashlib.sha256(image).hexdigest()})
    except Exception as error:result['fetchError']=str(error)[:150]
    return {**school,**result}
def build(source,online=True):
    bible=json.loads((ROOT/'apps/web/src/data/school-bible.json').read_text(encoding='utf8'))
    rows=list(csv.DictReader(source.read_text(encoding='utf-8-sig').splitlines()))
    rows=[row for row in rows if row['공시연도']=='2026' and row['학교종류'] in ['대학교','교육대학']]
    schools=[]
    for entry in bible['schools']:
        canonical=clean_school(entry['university'])
        selected=[row for row in rows if row['학교명']==canonical]
        if ' — ' in entry['university']:selected=[row for row in selected if row['본분교명']=='본교']
        if not selected:raise ValueError('no_source_rows:'+entry['university'])
        departments={}
        for row in selected:
            if float(row['모집인원_계'] or '0')<=0:continue
            key=row['학과코드']+'-'+row['본분교명']
            departments[key]={'id':key,'name':row['학과명'],'campus':row['본분교명'],'college':row['단과대학'],'schoolCode':row['학교코드'],'departmentCode':row['학과코드'],'field':row['표준분류_대계열'],'category':row['표준분류_중계열'],'year':2026,'sourceUrl':DATA_URL}
        school={'id':entry['id'],'university':entry['university'],'canonicalName':canonical,'publicSchoolCode':selected[0]['학교코드'],'campusLabel':entry['university'].split(' — ')[1] if ' — ' in entry['university'] else None,'departments':sorted(departments.values(),key=lambda dep:(dep['name'],dep['campus']))}
        if not school['departments']:raise ValueError('no_current_departments:'+entry['university'])
        schools.append(school)
    if online:
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:schools=list(pool.map(official_details,schools))
        overrides_path=ROOT/'apps/web/src/data/school-directory-overrides.json'
        overrides=json.loads(overrides_path.read_text(encoding='utf8')) if overrides_path.exists() else []
        for school in schools:
            override=next((entry for entry in overrides if entry['id']==school['id']),None)
            if not override:continue
            for key in ['admissionUrl','logoUrl','logoSourceUrl','logoSha256','officialSourceUrl','linkStatus','checkedAt']:
                if override.get(key) and (not school.get(key) or key in ['officialSourceUrl','linkStatus']):school[key]=override[key]
    payload={'generatedAt':'2026-10-12','departmentSource':{'title':'교육부 대학알리미 신입생 충원 현황 대학·학과별','url':DATA_URL,'year':2026,'license':'공공누리 제1유형(출처표시)','sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'scope':'2026 공시 대학·교육대학 학과 중 모집인원 1명 이상; 2027 모집단위와 다를 수 있음'},'officialDirectorySource':{'title':'한국대학교육협의회 대입정보포털 어디가 2027 대학정보','url':ADIGA,'checkedAt':'2026-10-12'},'schools':schools}
    OUT.write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps({'schools':len(schools),'departments':sum(len(s['departments']) for s in schools),'officialAdmissionLinks':sum(bool(s.get('admissionUrl')) for s in schools),'logos':sum(bool(s.get('logoUrl')) for s in schools),'missingLinks':[s['university'] for s in schools if not s.get('admissionUrl')]},ensure_ascii=False))
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--source',type=pathlib.Path,default=DEFAULT_SOURCE);parser.add_argument('--offline',action='store_true');args=parser.parse_args();build(args.source,not args.offline)
