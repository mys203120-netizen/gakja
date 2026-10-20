import test from 'node:test';
import assert from 'node:assert/strict';
import {schoolLogoBounds,schoolLogoFit} from '../apps/web/src/lib/school-logo-fit.ts';

test('a padded emblem is enlarged and centred without stretching its actual mark',()=>{
 const pixels=new Uint8ClampedArray(100*100*4).fill(255);
 for(let y=35;y<65;y++)for(let x=40;x<60;x++){const i=(y*100+x)*4;pixels[i]=20;pixels[i+1]=75;pixels[i+2]=130;}
 const bounds=schoolLogoBounds(pixels,100,100)!;const fit=schoolLogoFit(bounds,100,100,34,34)!;
 assert.ok(fit.width>80);assert.equal(fit.width,fit.height);
 const centreX=fit.left+(bounds.left+bounds.right)*100/2*(fit.width/100),centreY=fit.top+(bounds.top+bounds.bottom)*100/2*(fit.height/100);
 assert.ok(Math.abs(centreX-17)<.001&&Math.abs(centreY-17)<.001);
 assert.ok((bounds.bottom-bounds.top)*fit.height<=34);
});
test('full size logos, transparent canvas, empty images and invalid measurements remain usable',()=>{
 const empty=new Uint8ClampedArray(40*40*4).fill(255);assert.equal(schoolLogoBounds(empty,40,40),null);
 const transparent=new Uint8ClampedArray(40*40*4);assert.equal(schoolLogoBounds(transparent,40,40),null);
 assert.equal(schoolLogoBounds(empty,0,40),null);assert.equal(schoolLogoBounds([],40,40),null);
 assert.equal(schoolLogoFit({left:0,top:0,right:1,bottom:1},40,40,34,34),null);
 assert.equal(schoolLogoFit(null,40,40,34,34),null);assert.equal(schoolLogoFit({left:0,top:0,right:0,bottom:0},40,40,34,34),null);
});
test('asymmetric whitespace is offset and wide artwork preserves its proportions',()=>{
 const fit=schoolLogoFit({left:.05,top:.4,right:.5,bottom:.6},200,100,34,34)!;
 assert.equal(fit.width/fit.height,2);assert.ok(fit.left<0);assert.ok(fit.top<0);
 const maxFit=schoolLogoFit({left:.5,top:.5,right:.501,bottom:.501},100,100,34,34)!;assert.ok(maxFit.width<=170.0001);
});
