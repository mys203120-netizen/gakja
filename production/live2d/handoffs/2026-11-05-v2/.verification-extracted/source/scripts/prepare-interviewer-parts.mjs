/**
 * Deterministic part extraction from the approved, single-character masters.
 * Generative repainting is performed separately with ImageGen (sources/).
 * This script preserves source pixels except explicitly recorded occluded-eye
 * white/iris-highlight reconstruction. It does not author a Cubism rig.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { createHash } from 'node:crypto';

const root = path.resolve('public/live2d/production');
const W = 1672, H = 941;
const P = points => `<polygon points="${points.map(p => p.join(',')).join(' ')}"/>`;
const E = (cx, cy, rx, ry) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}"/>`;
const D = d => `<path d="${d}"/>`;
const R = (x, y, w, h) => `<rect x="${x}" y="${y}" width="${w}" height="${h}"/>`;
const mask = (include, exclude = []) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><mask id="m" maskUnits="userSpaceOnUse"><rect width="100%" height="100%" fill="black"/><g fill="white">${include.join('')}</g><g fill="black">${exclude.join('')}</g></mask></defs><rect width="100%" height="100%" fill="white" mask="url(#m)"/></svg>`);
const bytes = async (source, shapes, excluded = []) => sharp(source).composite([{ input: mask(shapes, excluded), blend: 'dest-in' }]).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const hash = data => createHash('sha256').update(data).digest('hex');

const male = {
  id: 'interviewer-1', label: 'Male',
  visibleSkin:D('M428 217 C429 194 452 185 477 171 C494 159 501 132 524 134 C553 133 586 154 611 173 C637 194 643 225 645 254 C649 286 631 321 610 345 C588 369 563 381 535 382 C496 381 463 362 446 338 C429 312 415 275 418 244 Z'),
  featureErase:[R(472,200,62,47),R(560,218,57,44),R(459,161,84,38),R(567,182,67,39),R(477,296,105,46)],
  hairBounds:R(387,42,305,290),
  face: D('M420 205 C412 144 435 101 483 99 C532 86 590 104 626 148 C652 182 659 244 642 291 C625 341 584 378 535 383 C485 382 452 358 432 318 C418 285 416 245 420 205 Z'),
  neck: P([[437,332],[591,341],[619,426],[567,478],[484,462],[420,391]]),
  earR: D('M418 211 C395 207 388 228 394 253 C397 281 414 301 431 296 L435 247 Z'),
  earL: D('M641 254 C656 241 659 251 655 273 C653 300 637 325 624 327 L631 282 Z'),
  nose: D('M523 247 C530 252 550 257 559 272 C570 284 567 298 552 302 C532 302 515 292 516 279 Z'),
  hair: D('M396 219 C392 172 401 128 424 105 C459 70 500 48 550 49 C602 47 633 76 655 112 C678 119 686 154 683 179 L664 246 L647 278 L641 221 C631 183 610 166 578 149 C548 134 518 125 497 153 C477 172 454 181 434 188 L425 245 L413 272 L407 235 Z'),
  hairCuts: [R(0,0,445,H),R(445,0,175,H),R(620,0,1052,H)],
  browR: D('M464 186 C480 166 508 164 532 177 L539 190 C513 183 492 175 475 190 Z'),
  browL: D('M571 199 C583 182 607 194 622 204 L628 217 C608 207 591 200 573 207 Z'),
  eyes: [
    { side:'R', white:D('M479 221 C487 209 508 207 523 225 C507 238 490 234 479 229 Z'), iris:[501,222,11.3,11.3], upper:D('M475 219 C488 201 512 205 527 224 L524 228 C509 212 491 212 480 225 Z'), lower:D('M479 229 C491 238 511 242 526 230 L525 234 C509 246 489 240 478 233 Z') },
    { side:'L', white:D('M567 240 C576 225 596 223 608 243 C595 250 577 250 567 246 Z'), iris:[587,239,11.3,11.3], upper:D('M564 238 C579 218 602 221 612 243 L608 246 C598 230 580 231 569 243 Z'), lower:D('M566 245 C578 252 596 254 610 245 L609 249 C595 259 577 255 565 249 Z') },
  ],
  upperLip: D('M483 303 C501 303 515 312 531 313 C548 314 561 318 575 315 L572 319 C551 324 538 319 525 318 C509 317 493 312 483 307 Z'),
  lowerLip: D('M483 306 C504 318 549 325 575 315 C558 337 508 331 483 309 Z'),
  mouthHole: D('M484 304 C506 312 545 324 575 315 L575 319 C549 329 504 317 484 308 Z'),
  mouthPatch:R(471,285,116,76),
  openInside:D('M487 310 C508 313 541 320 569 318 C561 339 542 347 523 340 C506 336 494 326 487 310 Z'),
  openTeeth:D('M490 311 C509 315 542 322 566 320 L558 326 C534 328 509 322 495 318 Z'),
  openLipRef:R(480,301,100,52),
  shirt:P([[456,401],[485,443],[510,462],[553,449],[592,397],[603,722],[445,724]]),
  upperArmR:P([[182,452],[227,421],[283,422],[323,492],[331,587],[302,694],[258,731],[126,734],[155,608]]),
  upperArmL:P([[697,430],[756,449],[790,510],[805,607],[844,688],[814,731],[754,741],[713,660],[679,535]]),
  forearmR:P([[104,711],[207,690],[312,702],[364,735],[344,825],[274,838],[91,818],[80,787],[84,751]]),
  forearmL:P([[754,700],[825,686],[875,720],[907,764],[915,808],[884,829],[764,840],[733,816],[746,753]]),
  handR:D('M328 774 C327 751 344 743 367 733 C389 726 408 710 425 708 C450 705 481 719 499 735 C517 749 523 769 514 791 C502 816 471 835 439 835 L373 830 C344 825 326 803 328 774 Z'),
  handL:D('M554 807 C574 779 601 756 625 746 C652 734 697 735 733 746 C756 755 773 777 764 800 C755 827 716 840 682 840 L575 836 C555 837 548 821 554 807 Z'),
  pen: [P([[422,702],[433,701],[444,710],[440,716],[427,711]]),P([[521,754],[539,762],[565,777],[560,784],[541,778],[523,769]])],
  frame:D('M443 203 C448 195 457 193 467 194 C497 188 527 195 537 211 C541 222 537 244 524 252 C505 263 476 258 465 248 C454 239 451 222 452 209 M443 202 L422 216 M537 218 C547 215 556 217 564 224 M562 228 C565 215 580 216 596 219 C615 221 633 226 639 237 C642 250 633 270 620 276 C601 281 581 271 573 261 C564 252 561 237 562 228 M638 235 L651 236'),
};

const female = {
  id:'interviewer-2', label:'Female',
  visibleSkin:D('M1164 132 C1184 125 1202 125 1219 131 C1248 133 1266 166 1283 192 C1294 207 1304 219 1312 235 C1317 256 1313 278 1311 303 C1306 342 1287 373 1258 389 C1236 402 1213 401 1192 393 C1159 380 1132 358 1116 330 C1104 311 1097 288 1103 265 C1111 244 1128 223 1138 199 C1148 178 1150 149 1164 132 Z'),
  featureErase:[R(1117,229,69,48),R(1218,211,75,49),R(1120,194,63,34),R(1207,181,79,35),R(1164,307,109,61)],
  hairBounds:R(999,43,410,394),
  face:D('M1094 215 C1089 155 1112 117 1166 104 C1224 87 1280 112 1301 160 C1324 202 1328 260 1313 313 C1302 356 1273 390 1222 399 C1172 398 1130 372 1110 329 C1091 294 1086 251 1094 215 Z'),
  neck:P([[1150,361],[1288,359],[1314,472],[1270,571],[1180,539],[1135,431]]),
  earR:D('M1102 274 C1086 264 1082 280 1087 302 C1092 322 1104 332 1119 328 L1117 291 Z'),
  earL:D('M1312 239 C1329 226 1341 238 1337 261 C1336 286 1327 305 1311 305 L1305 272 Z'),
  nose:D('M1193 270 C1203 268 1224 272 1233 285 C1242 300 1233 311 1217 313 C1195 312 1187 300 1193 286 Z'),
  hair:D('M1008 300 C1005 253 1025 205 1041 168 C1057 130 1084 92 1125 67 C1171 38 1211 51 1238 62 C1290 37 1333 67 1354 113 C1370 147 1373 183 1390 223 C1411 269 1404 324 1385 365 C1370 400 1336 420 1290 425 L1266 381 C1293 356 1310 315 1309 280 C1311 233 1302 195 1283 166 C1264 136 1243 119 1217 119 C1188 118 1169 140 1155 165 C1137 193 1120 209 1097 221 C1080 249 1095 304 1117 343 L1150 390 L1148 424 C1103 432 1066 408 1041 374 C1020 347 1010 324 1008 300 Z'),
  hairCuts:[R(0,0,1105,H),R(1105,0,190,H),R(1295,0,377,H)],
  browR:D('M1120 221 C1134 205 1158 195 1172 201 L1176 208 C1156 206 1141 213 1126 225 Z'),
  browL:D('M1213 199 C1228 182 1256 182 1270 191 L1273 199 C1251 192 1232 192 1217 205 Z'),
  eyes:[
    {side:'R',white:D('M1128 254 C1136 240 1157 233 1175 254 C1160 266 1141 267 1128 260 Z'),iris:[1155,252,11.7,12.1],upper:D('M1125 253 C1137 231 1161 230 1179 252 L1176 257 C1159 240 1142 240 1130 258 Z'),lower:D('M1128 260 C1142 271 1164 269 1178 257 L1177 261 C1161 274 1140 275 1127 264 Z')},
    {side:'L',white:D('M1225 238 C1234 223 1252 216 1268 231 C1258 246 1239 248 1225 244 Z'),iris:[1246,234,11.3,12.3],upper:D('M1222 237 C1233 216 1259 213 1272 229 L1269 234 C1256 223 1240 224 1226 241 Z'),lower:D('M1224 243 C1239 252 1258 247 1270 235 L1269 240 C1257 252 1239 258 1223 247 Z')},
  ],
  upperLip:D('M1171 335 C1185 331 1202 328 1217 330 C1234 330 1251 326 1261 320 L1259 325 C1244 339 1219 340 1201 341 C1185 340 1177 338 1171 337 Z'),
  lowerLip:D('M1171 336 C1193 344 1234 342 1261 321 C1250 347 1232 354 1210 352 C1195 351 1183 344 1171 338 Z'),
  mouthHole:D('M1170 334 C1196 342 1238 337 1262 320 L1261 324 C1238 344 1192 347 1170 337 Z'),
  mouthPatch:R(1160,303,117,78),
  openInside:D('M1177 340 C1198 344 1232 337 1257 329 C1252 353 1238 364 1218 364 C1199 360 1184 350 1177 340 Z'),
  openTeeth:D('M1181 340 C1200 342 1234 336 1254 330 L1250 337 C1231 345 1201 347 1187 345 Z'),
  openLipRef:R(1169,321,95,49),
  shirt:P([[1153,418],[1200,536],[1262,575],[1294,424],[1314,790],[1128,792]]),
  upperArmR:P([[971,453],[1037,441],[1082,475],[1081,606],[1047,733],[1003,785],[887,770],[927,617]]),
  upperArmL:P([[1429,449],[1481,457],[1516,503],[1517,611],[1562,710],[1532,779],[1432,789],[1409,670],[1395,535]]),
  forearmR:P([[884,739],[973,727],[1072,756],[1093,795],[1064,862],[939,868],[855,853],[843,812],[856,773]]),
  forearmL:P([[1450,747],[1532,723],[1575,748],[1617,791],[1632,835],[1614,856],[1498,868],[1418,863],[1394,818]]),
  handR:D('M1012 827 C1019 806 1048 796 1080 791 C1110 786 1147 768 1168 767 C1193 769 1228 790 1253 808 C1277 822 1299 837 1297 852 C1291 868 1272 869 1256 863 C1238 864 1220 860 1209 856 C1176 864 1145 862 1116 860 L1043 855 C1020 852 1007 846 1012 827 Z'),
  handL:D('M1252 806 C1276 800 1312 796 1340 798 C1368 799 1397 803 1417 815 C1431 825 1437 842 1420 851 C1393 861 1347 861 1314 859 L1261 851 L1236 828 Z'),
  earrings:[E(1116,343,12,16),E(1320,310,12,16)],
};

async function saveLayer(directory, config, output, source, definition) {
  const {data,info} = await bytes(source, definition.shapes, definition.exclude);
  if(definition.darkOnly)for(let i=0;i<data.length;i+=4){const luminance=(data[i]+data[i+1]+data[i+2])/3;data[i+3]=Math.round(data[i+3]*Math.min(1,Math.max(0,(definition.darkOnly-luminance)/28)));}
  if(definition.clip){const clip=await sharp(mask([definition.clip])).ensureAlpha().raw().toBuffer();for(let i=3;i<data.length;i+=4)data[i+3]=Math.round(data[i+3]*clip[i]/255);}
  let left=W,top=H,right=-1,bottom=-1, count=0;
  for(let i=0;i<W*H;i++) if(data[i*4+3]>0) { const x=i%W,y=Math.floor(i/W);left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);count++; }
  if (!count) throw new Error(`${config.id}/${definition.name}: empty layer`);
  left=Math.max(0,left-2);top=Math.max(0,top-2);right=Math.min(W-1,right+2);bottom=Math.min(H-1,bottom+2);
  const filename=definition.name+'.png';
  await sharp(data,{raw:{width:info.width,height:info.height,channels:4}}).extract({left,top,width:right-left+1,height:bottom-top+1}).withIccProfile('srgb').png().toFile(path.join(directory,filename));
  output.push({id:definition.name,name:definition.name,group:definition.group,path:filename,x:left,y:top,z:definition.z,visible:definition.visible!==false,role:definition.role??'part',sideBasis:'character-anatomical-left-right',source:definition.source??'approved-master.png',reconstructed:definition.reconstructed??false,notes:definition.notes??''});
}

async function cleanFaceSource(master, underpaint, config) {
  const skin=await bytes(master,[config.visibleSkin]);
  const erasers=[...config.featureErase];
  if(config.frame)erasers.push(config.frame.replace('/>',' fill="none" stroke="white" stroke-width="11" stroke-linecap="round"/>'));
  const erase=await sharp(mask(erasers)).blur(1.6).ensureAlpha().raw().toBuffer();
  for(let i=3;i<skin.data.length;i+=4)skin.data[i]=Math.round(skin.data[i]*(1-erase[i]/255));
  return sharp(underpaint).composite([{input:skin.data,raw:{width:W,height:H,channels:4}}]).png().toBuffer();
}

async function eyeSources(master, eye) {
  const {data,info}=await sharp(master).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const white=Buffer.from(data), iris=Buffer.from(data), highlights=Buffer.from(data);
  const [cx,cy,rx,ry]=eye.iris;
  for(let y=Math.floor(cy-ry-2);y<=cy+ry+2;y++) for(let x=Math.floor(cx-rx-2);x<=cx+rx+2;x++) {
    const i=(y*W+x)*4, r2=((x-cx)/rx)**2+((y-cy)/ry)**2;
    if(r2<.94) {
      const shade=(y-(cy-ry))/(2*ry);
      // Reconstruct the hidden sclera from the source's warm eye-white palette.
      white[i]=Math.round(221+16*shade);white[i+1]=Math.round(215+15*shade);white[i+2]=Math.round(204+14*shade);
    }
    const bright=r2<.9 && data[i]>172 && data[i+1]>155 && data[i+2]>135;
    if(bright) { iris[i]=67;iris[i+1]=44;iris[i+2]=31; }
    else highlights[i+3]=0;
  }
  // All non-iris pixels must be absent from the standalone highlight layer.
  for(let y=0;y<H;y++) for(let x=0;x<W;x++) if(((x-cx)/rx)**2+((y-cy)/ry)**2>=.9) highlights[(y*W+x)*4+3]=0;
  const make=data=>sharp(data,{raw:{width:info.width,height:info.height,channels:4}}).png().toBuffer();
  return {white:await make(white),iris:await make(iris),highlights:await make(highlights)};
}

async function prepare(config) {
  const directory=path.join(root,config.id), sourceDirectory=path.join(directory,'sources'), partsDirectory=path.join(directory,'parts');
  await fs.mkdir(partsDirectory,{recursive:true});
  const sourceRegistrations=[];
  const readSource=async name=>{
    const buffer=await fs.readFile(path.join(sourceDirectory,name+'.png'));
    const m=await sharp(buffer).metadata();
    if(!m.hasAlpha||m.height!==H||![W,W-1].includes(m.width))throw new Error(`${config.id} ${name}: unsupported source canvas, expected ${W}x${H} RGBA with at most one missing right-edge pixel`);
    sourceRegistrations.push({file:name+'.png',width:m.width,height:m.height,padding:{right:W-m.width,bottom:0},scale:1,translation:[0,0]});
    // ImageGen returned 1671px for some sources: add only a transparent right
    // column. No artwork is scaled, moved or cropped to register those sources.
    return m.width===W?buffer:sharp(buffer).extend({top:0,bottom:0,left:0,right:1,background:'#00000000'}).png().toBuffer();
  };
  const master=await readSource('approved-master');
  const underpaint=await readSource('underpaint');
  const open=await readSource('mouth-open-source');
  const faceClean=await cleanFaceSource(master,underpaint,config);
  const layers=[];
  const add=async(name,group,z,source,shapes,extra={})=>saveLayer(partsDirectory,config,layers,source,{name,group,z,shapes,...extra});
  const arms=[config.upperArmR,config.upperArmL,config.forearmR,config.forearmL], hands=[config.handR,config.handL];
  const body=[R(0,350,W,H-350)];
  await add('Jacket','Body',0,master,body,{exclude:[config.neck,config.shirt,...arms,...hands,config.hair],notes:'Arm/hand regions removed; hidden large arm-turn surfaces still require Editor/artist verification.'});
  await add('Shirt','Body',1,master,[config.shirt],{exclude:[config.neck,...arms,...hands]});
  await add('UpperArm_R','Body',2,master,[config.upperArmR],{exclude:[config.forearmR,...hands]});
  await add('UpperArm_L','Body',3,master,[config.upperArmL],{exclude:[config.forearmL,...hands]});
  await add('Forearm_R','Body',4,master,[config.forearmR],{exclude:hands});
  await add('Forearm_L','Body',5,master,[config.forearmL],{exclude:hands});
  await add('Neck','Head/Neck',20,master,[config.neck],{notes:'Observed neck preserved; large-turn hidden extension remains unverified.'});
  await add('Ear_R','Head/Skin',40,underpaint,[config.earR],{source:'underpaint.png',reconstructed:true});
  await add('Ear_L','Head/Skin',41,underpaint,[config.earL],{source:'underpaint.png',reconstructed:true});
  await add('Face_Base','Head/Skin',42,faceClean,[config.face],{source:'approved-master.png visible skin + underpaint.png occluded skin',reconstructed:true,notes:'Observed cheek/forehead skin retained. Eyes/brows/mouth/glasses erased using underpaint; hair absent. Hidden skin is reconstructed, not observed original.'});
  for(const [index,eye] of config.eyes.entries()) {
    const group=`Head/Eye_${eye.side}`,z=50+index*10, reconstructed=await eyeSources(master,eye);
    await add(`EyeWhite_${eye.side}`,group,z,reconstructed.white,[eye.white],{source:'approved-master.png + hidden-sclera reconstruction',reconstructed:true});
    await add(`Iris_${eye.side}`,group,z+1,reconstructed.iris,[E(...eye.iris)],{reconstructed:true,notes:'Source iris texture; bright reflection pixels reconstructed under separate highlight. Editor eyelid clipping still required.'});
    await add(`EyeHighlight_${eye.side}`,group,z+2,reconstructed.highlights,[E(...eye.iris)]);
    await add(`UpperLid_${eye.side}`,group,z+3,master,[eye.upper]);
    await add(`LowerLid_${eye.side}`,group,z+4,master,[eye.lower]);
  }
  const browRegions=config.id==='interviewer-1'?[R(461,162,82,35),R(568,183,66,35)]:[R(1121,193,63,37),R(1207,181,80,34)];
  await add('Brow_R','Head/Brows',70,master,[browRegions[0]],{darkOnly:145});
  await add('Brow_L','Head/Brows',71,master,[browRegions[1]],{darkOnly:145});
  await add('Nose_Base','Head/Nose',75,master,[config.nose]);
  await add('Mouth_Inside','Head/Mouth',80,open,[config.openInside],{source:'mouth-open-source.png',exclude:[config.openTeeth],notes:'Reconstructed oral cavity source. Mesh closure and clipping not authored yet.'});
  await add('Teeth_Upper','Head/Mouth',81,open,[config.openTeeth],{source:'mouth-open-source.png'});
  await add('Mouth_Skin_Occlusion','Head/Mouth',82,faceClean,[config.mouthPatch],{source:'registered clean face skin',exclude:[config.mouthHole],reconstructed:true,notes:'Skin ring for neutral closure; rig opening/rounded forms in Editor. Not an SDK clipping mask.'});
  await add('UpperLip','Head/Mouth',83,master,[config.upperLip]);
  await add('LowerLip','Head/Mouth',84,master,[config.lowerLip]);
  if(config.frame) {
    const frameStroke=config.frame.replace('/>', ' fill="none" stroke="white" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>');
    await add('Glasses_Frame','Head/Glasses',90,master,[frameStroke],{darkOnly:140,exclude:config.eyes.map(e=>e.white),notes:'Dark original frame pixels within broad registered strokes; lenses remain transparent. Optical edges still need Editor verification.'});
  }
  for(const [index,name] of ['Hair_Side_R','Hair_Front_C','Hair_Side_L'].entries()) {
    await add(name,'Head/Hair',100+index,master,[config.hairBounds],{exclude:[config.visibleSkin,config.earL,config.earR,config.neck,...(config.earrings??[]),...config.hairCuts.filter((_,i)=>i!==index)],notes:'Source hair outside exposed-face boundary; deformation seams need Editor overlap/mesh verification.'});
  }
  if(config.earrings) for(const [index,shape] of config.earrings.entries()) await add(`Earring_${index?'L':'R'}`,'Head/Jewelry',110+index,master,[shape]);
  await add('Hand_L','Hands',120,master,[config.handL]);
  await add('Hand_R','Hands',121,master,[config.handR]);
  if(config.pen)await add('Pen','Hands',122,master,config.pen,{notes:'Exposed pen ends only; grip crossing remains partly in Hand_R. Independent pen gesture is not approved.'});
  await add('Approved_Master_Reference','Reference',200,master,[R(0,0,W,H)],{visible:false,role:'reference',notes:'Hidden original reference; excluded from Cubism import PSD.'});
  await add('Mouth_Open_Reference','Reference',201,open,[config.openLipRef],{visible:false,role:'reference',source:'mouth-open-source.png'});
  const manifest={version:1,speakerId:config.id,canvas:{width:W,height:H,dpi:72,colorMode:'RGB',bitsPerChannel:8,profile:'sRGB'},leftRightBasis:'character anatomical (viewer left = character right)',status:'parts-prepared-editor-import-unverified',userApproval:'Existing likeness accepted; four optional visual retouches skipped by user. This does not assert a completed rig.',layers};
  await fs.writeFile(path.join(partsDirectory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  const csvFields=['id','name','group','role','sideBasis','z','visible','x','y','path','source','reconstructed','notes'];
  const csv=csvFields.join(',')+'\n'+layers.map(l=>csvFields.map(k=>'"'+String(l[k]??'').replaceAll('"','""')+'"').join(',')).join('\n')+'\n';
  await fs.writeFile(path.join(directory,'layer_manifest.csv'),csv);
  const ordered=[...layers].filter(l=>l.visible).sort((a,b)=>a.z-b.z);
  await sharp({create:{width:W,height:H,channels:4,background:'#00000000'}}).composite(await Promise.all(ordered.map(async l=>({input:await fs.readFile(path.join(partsDirectory,l.path)),left:l.x,top:l.y})))).withIccProfile('srgb').png().toFile(path.join(directory,'parts-composite.png'));
  // Hide all eye/mouth/brow/glasses parts together to verify a clean underlying face.
  const clean=ordered.filter(l=>!/^Head\/(Eye_|Brows|Mouth|Glasses)/.test(l.group));
  await sharp({create:{width:W,height:H,channels:4,background:'#00000000'}}).composite(await Promise.all(clean.map(async l=>({input:await fs.readFile(path.join(partsDirectory,l.path)),left:l.x,top:l.y})))).png().toFile(path.join(directory,'face-base-isolation.png'));
  const sourceFiles=await Promise.all(['approved-master.png','underpaint.png','mouth-open-source.png'].map(async file=>({file,sha256:hash(await fs.readFile(path.join(sourceDirectory,file)))})));
  await fs.writeFile(path.join(directory,'parts-provenance.json'),JSON.stringify({sources:sourceFiles,sourceRegistrations,method:'Deterministic alpha masks; original-feature pixels and ImageGen occlusion underpaint; hidden sclera/reflection reconstruction as recorded per layer',layerCount:layers.length,artLayerCount:layers.filter(l=>l.role==='part').length,cubismRigCreated:false,photoshopOpened:false,cubismImportVerified:false},null,2)+'\n');
  console.log(`${config.id}: ${layers.length} independently saved PNG layers; PSD packaging still required.`);
}

for(const config of [male,female]) await prepare(config);
