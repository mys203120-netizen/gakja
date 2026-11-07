/** Public synthetic PDF with an explicit ToUnicode map; no copied student data. */
export function syntheticTextPdf(lines) {
  const characters=[...new Set([...lines.join('')])];
  const codes=new Map(characters.map((character,index)=>[character,index+1]));
  const hex=value=>value.toString(16).padStart(4,'0');
  const unicode=character=>Buffer.from(character,'utf16le').swap16().toString('hex');
  const mappings=characters.map(character=>`<${hex(codes.get(character))}> <${unicode(character)}>`).join('\n');
  const cmap=`/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /SyntheticUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <ffff>\nendcodespacerange\n${characters.length} beginbfchar\n${mappings}\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
  const contents=`BT\n/F1 10 Tf\n12 TL\n20 100 Td\n${lines.map((line,index)=>`${index?'T*\n':''}<${[...line].map(character=>hex(codes.get(character))).join('')}> Tj`).join('\n')}\nET`;
  const stream=value=>`<< /Length ${Buffer.byteLength(value)} >>\nstream\n${value}\nendstream`;
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 800 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',stream(contents),
    '<< /Type /Font /Subtype /Type0 /BaseFont /Synthetic /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>',
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Synthetic /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 500 >>',stream(cmap)];
  let body='%PDF-1.4\n';const offsets=[0];
  objects.forEach((object,index)=>{offsets.push(Buffer.byteLength(body));body+=`${index+1} 0 obj\n${object}\nendobj\n`;});
  const xref=Buffer.byteLength(body);body+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Root 1 0 R /Size ${objects.length+1} >>\nstartxref\n${xref}\n%%EOF\r\n`;
  return Buffer.from(body);
}
