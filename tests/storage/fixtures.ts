import { createHash } from 'node:crypto';
import type { PrivateObjectKind } from '../../server/storage/private-object-ports';

export const rawHash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export function syntheticWav() {
  const bytes = Buffer.alloc(48); bytes.write('RIFF'); bytes.writeUInt32LE(40, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(4, 40); bytes.writeInt16LE(0, 44); bytes.writeInt16LE(1, 46); return bytes;
}
/** Public synthetic bytes only. The PDF is a minimal one-page document, not a
 * copied student record. Text fixtures deliberately retain CRLF/key order. */
export function syntheticPdf() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>', '<< /Length 0 >>\nstream\n\nendstream'];
  let text = '%PDF-1.4\n', offset = Buffer.byteLength(text); const positions = [0];
  objects.forEach((value, index) => { positions.push(offset); const item = `${index + 1} 0 obj\n${value}\nendobj\n`; text += item; offset += Buffer.byteLength(item); });
  text += `xref\n0 5\n0000000000 65535 f \n${positions.slice(1).map(value => String(value).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\r\n`;
  return Buffer.from(text);
}
function controlledPdf(objects: string[], trailer = '') {
  let text = '%PDF-1.4\n', offset = Buffer.byteLength(text); const positions = [0];
  objects.forEach((value, index) => { positions.push(offset); const item = `${index + 1} 0 obj\n${value}\nendobj\n`; text += item; offset += Buffer.byteLength(item); });
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${positions.slice(1).map(value => String(value).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailer} >>\nstartxref\n${offset}\n%%EOF\n`;
  return Buffer.from(text);
}
export function syntheticTwoPagePdf() {
  return controlledPdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>']);
}
/** Deliberately password-protected header/standard-security dictionary. No
 * password is accepted by C's registration path; it must refuse this resource. */
export function syntheticEncryptedPdf() {
  return controlledPdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>',
    `<< /Filter /Standard /V 1 /R 2 /O <${'00'.repeat(32)}> /U <${'00'.repeat(32)}> /P -4 >>`],
  `/Encrypt 4 0 R /ID [<${'11'.repeat(16)}> <${'11'.repeat(16)}>]`);
}
/** Legacy PDF Standard Security R2 with an empty user password. Fixture-only
 * RC4/MD5 reproduce that file format; they are not application crypto choices. */
export function syntheticEmptyPasswordPdf() {
  const padding = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
  function rc4(key: Buffer, input: Buffer) {
    const state = Array.from({ length: 256 }, (_, index) => index); let j = 0;
    for (let i = 0; i < 256; i++) { j = (j + state[i] + key[i % key.length]) % 256; [state[i], state[j]] = [state[j], state[i]]; }
    const output = Buffer.alloc(input.length); let i = 0; j = 0;
    for (let index = 0; index < input.length; index++) { i = (i + 1) % 256; j = (j + state[i]) % 256; [state[i], state[j]] = [state[j], state[i]]; output[index] = input[index] ^ state[(state[i] + state[j]) % 256]; }
    return output;
  }
  const fileId = Buffer.alloc(16, 0x11), permission = Buffer.alloc(4); permission.writeInt32LE(-4);
  const owner = rc4(createHash('md5').update(padding).digest().subarray(0, 5), padding);
  const encryptionKey = createHash('md5').update(Buffer.concat([padding, owner, permission, fileId])).digest().subarray(0, 5);
  const user = rc4(encryptionKey, padding);
  return controlledPdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>',
    `<< /Filter /Standard /V 1 /R 2 /O <${owner.toString('hex')}> /U <${user.toString('hex')}> /P -4 >>`],
  `/Encrypt 4 0 R /ID [<${fileId.toString('hex')}> <${fileId.toString('hex')}>]`);
}
export const syntheticBytes: Record<PrivateObjectKind, () => Buffer> = {
  'source-pdf': syntheticPdf,
  'source-markdown': () => Buffer.from('# 합성 원문🙂\r\n첫째 줄\r\n둘째 줄\n', 'utf8'),
  'source-json': () => Buffer.from('{"z":"합성🙂","nullable":null,"a":1}\r\n', 'utf8'),
  'analysis-json': () => Buffer.from('{"z":"합성 분석🙂","nullable":null,"a":1}\r\n', 'utf8'),
  audio: syntheticWav,
  'review-bundle': () => Buffer.from('{"kind":"synthetic-review-bundle","approved":false,"z":"🙂","a":null}\r\n', 'utf8'),
};
