import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';

export const alt = '각자ON · 나의 경험으로 준비하는 면접';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function Image() {
  const [logo, font] = await Promise.all([
    readFile(join(process.cwd(), 'public/brand-logo.svg')),
    readFile(join(process.cwd(), 'public/fonts/GakjaShare-Semibold.ttf')),
  ]);
  return new ImageResponse(
    <div style={{ display: 'flex', width: '100%', height: '100%', background: '#101A19', color: '#FFFFFF', padding: '62px 70px', fontFamily: 'Gakja Share', fontWeight: 600 }}>
      <div style={{ display: 'flex', flexDirection: 'column', width: 710 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18, color: '#00ED77', fontSize: 30 }}>
          <img src={`data:image/svg+xml;base64,${logo.toString('base64')}`} width={50} height={50} alt=""/>
          <span>각자ON · 각자의답</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 56, fontSize: 74, lineHeight: 1.22, letterSpacing: -3 }}>
          <span>나의 경험으로</span><span>준비하는 면접</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 32, color: '#BDCEC7', fontSize: 28, lineHeight: 1.5 }}>
          <span>생활기록부 정리부터</span><span>글·음성 면접 연습까지</span>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 20, width: 300 }}>
        {['경험 정리', '맞춤 질문', '면접 연습'].map((label, index) => <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 18, padding: '26px 24px', borderRadius: 22, border: '1px solid #375047', background: index === 1 ? '#00ED77' : '#1B2D26', color: index === 1 ? '#10271D' : '#E8F7EF', fontSize: 29 }}>
          <div style={{ display: 'flex', width: 12, height: 12, borderRadius: 6, background: index === 1 ? '#10271D' : '#00ED77' }}/>
          <span>{label}</span>
        </div>)}
      </div>
    </div>,
    { ...size, fonts: [{ name: 'Gakja Share', data: font, weight: 600, style: 'normal' }] },
  );
}
