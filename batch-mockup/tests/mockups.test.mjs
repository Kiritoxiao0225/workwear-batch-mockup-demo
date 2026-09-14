import test from 'node:test';
import {placementGeometry,requestedDimensions} from '../application/mockup-placement.mjs';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mockupGroups,exactGarment,garmentCanvas,renderMockups,saveMockupSelection,readMockupState,initialPlacement,hasManualSize,FRAME} from '../application/mockups.mjs';
import {atomicFile,assetPath,hash,saveJSON} from '../adapters/a-files.mjs';
const artwork=(id,apps)=>({id,name:id,applications:apps});
test('共享图稿只建立多个服装应用；同款色前后同框，候选版本不叠加',()=>{
 const c={caseId:'A',draft:{artworks:[artwork('logo',[{style:'S',color:'黑',position:'左胸'},{style:'S',color:'白',position:'左胸'}]),artwork('back',[{style:'S',color:'黑',position:'后背'},{style:'S',color:'白',position:'后背'}])]}};
 const groups=mockupGroups(c);assert.equal(groups.length,2);for(const g of groups)assert.deepEqual(g.selections,{'左胸':'logo','后背':'back'});
 c.draft.artworks.push(artwork('other',[{style:'S',color:'黑',position:'左胸'}]));const multi=mockupGroups(c).filter(g=>g.color==='黑');assert.equal(multi.length,2);assert.equal(multi[0].selections['后背'],'back');assert.equal(multi[1].selections['左胸'],'other');
 c.draft.artworks.push(artwork('back2',[{style:'S',color:'黑',position:'后背'}]));for(const g of mockupGroups(c).filter(g=>g.color==='黑'))assert.deepEqual(g.selections,{'左胸':null,'后背':null});
});
test('款色必须唯一精确匹配，不猜缺省颜色',()=>{const x={id:'1',colorName:'白色'};assert.equal(exactGarment([{styleCode:'A',colors:[x]}],'A','白色'),x);assert.equal(exactGarment([{styleCode:'A',colors:[x]}],'A','白'),null);assert.equal(exactGarment([{styleCode:'A',colors:[x]},{styleCode:'A',colors:[x]}],'A','白色'),null);});
test('真实像素合成：正背面同框、可见Alpha边界、改位置不更改另一层、修补更新保留位置',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mockups-test-'));
 try{
  const png=async(w,h,color)=>sharp({create:{width:w,height:h,channels:4,background:color}}).png().toBuffer();
  const silhouette=Buffer.from('<svg width="200" height="200"><path fill="#ccc" d="M30 15H70L95 60L80 75L72 60V190H28V60L20 75L5 60ZM130 15H170L195 60L180 75L172 60V190H128V60L120 75L105 60Z"/></svg>');
  const garment=await sharp(silhouette).png().toBuffer(),frame=await png(FRAME.width,FRAME.height,'white');
  const detail={id:'11111111-1111-4111-8111-111111111111',assetVersionId:'asset1',styleCode:'S',colorName:'黑',sha256:hash(garment),width:200,height:200,views:[{face:'front',crop:{x:0,y:0,width:.5,height:1},history:[]},{face:'back',crop:{x:.5,y:0,width:.5,height:1},history:[]}]};
  const catalog={styles:async()=>[{styleCode:'S',colors:[{id:detail.id,colorName:'黑'}]}],detail:async()=>detail,bytes:async()=>garment,frame:async()=>frame};
  const logo=await sharp({create:{width:100,height:100,channels:4,background:'#0000'}}).composite([{input:await png(20,10,'red'),left:40,top:45}]).png().toBuffer();
  const file={asset:'production-results/logo.png',sha256:hash(logo)};await atomicFile(assetPath(root,file.asset),logo);
  const c={caseId:'A',revision:1,draft:{artworks:[artwork('logo',[{style:'S',color:'黑',position:'左胸'},{style:'S',color:'黑',position:'后背'}])]}};
  const jobs=[{id:'job',artworkId:'logo',revision:1,final:file}];let state=await renderMockups(root,c,jobs,catalog);
  assert.equal(state.cards.length,1);const card=state.cards[0];assert.equal(card.layers.length,2);assert.equal(card.layers[0].ratio,.5);assert.equal(card.render.width,3252);assert.equal(card.render.height,2301);assert.equal(card.status,'ready');
  const oldBack=structuredClone(card.layers[1]);const layers=card.layers.map((l,n)=>({id:l.id,x:n===0?l.x+.03:l.x,y:l.y,width:l.width}));
  state=await saveMockupSelection(root,c,{cardId:card.id,revision:state.revision,layers});await assert.rejects(()=>saveMockupSelection(root,c,{cardId:card.id,revision:0,layers}),/更新/);
  state=await renderMockups(root,c,jobs,catalog);assert.equal(state.cards[0].layers[1].x,oldBack.x);assert.equal(state.cards[0].layers[1].manual,false);assert.equal(state.cards[0].layers[0].positionManual,true);assert.equal(state.cards[0].layers[0].sizeManual,false);const moved=state.cards[0].layers[0].x;
  const repaired=await png(20,10,'blue');const repairFile={asset:'production-results/repaired.png',sha256:hash(repaired)};await atomicFile(assetPath(root,repairFile.asset),repaired);jobs[0].repair={file:repairFile};state=await renderMockups(root,c,jobs,catalog);
  assert.equal(state.cards[0].layers[0].x,moved);assert.ok(state.cards[0].layers.every(l=>l.sourceSHA256===repairFile.sha256));assert.equal((await readMockupState(root,'A')).cards[0].render.sha256,state.cards[0].render.sha256);
  assert.equal((await garmentCanvas(detail,garment,frame)).faces.length,2);
 }finally{await rm(root,{recursive:true,force:true});}
});

const face={x:0,y:0,width:900,height:1000,bodyWidth:550,bodyCenter:450,bodyBasis:'alpha-torso-v1',crop:{width:900,height:1000},trim:{left:0,top:0},scale:1};
test('胸标完整可见内容同时受7厘米宽高限制，衣袖不作为衣身宽度',()=>{
 for(const ratio of [.25,1,2]){const p=placementGeometry(face,{key:'leftChest',face:'front'},ratio);assert.ok(p.sizeCm.width<=7.001&&p.sizeCm.height<=7.001);assert.equal(p.height/p.width,ratio);assert.ok(p.x-p.width/2>face.bodyCenter);}
 const back=placementGeometry(face,{key:'backCenter',face:'back'},2);assert.equal(back.sizeCm.height,30);assert.equal(back.sizeCm.width,15);
 assert.throws(()=>placementGeometry({...face,bodyWidth:null},{key:'leftChest',face:'front'},1),/衣身宽度/);
});
test('明确尺寸换算单位；不猜宽高冲突，也不悄悄缩小客户尺寸',()=>{
 assert.deepEqual(requestedDimensions('尺寸：宽70mm\n输出：透明'),{width:7,explicit:true});
 assert.equal(requestedDimensions('尺寸：原文未指定\n输出：透明'),null);
 const p=placementGeometry(face,{key:'leftChest',face:'front'},2,'尺寸：高6cm\n输出：透明');assert.deepEqual(p.sizeCm,{width:3,height:6});
 assert.throws(()=>placementGeometry(face,{key:'leftChest',face:'front'},2,'尺寸：7×7cm'),/比例不一致/);
 assert.throws(()=>placementGeometry(face,{key:'leftChest',face:'front'},1,'尺寸：宽40cm'),/超出可印区域/);
});
test('已确认位置和排除区域生效，默认图案不压拉链',()=>{
 const standard={garmentFrame:{x:0,y:0,width:1,height:1},positions:[{key:'leftChest',anchor:{x:.55,y:.35},printableArea:{x:.5,y:.2,width:.3,height:.4}}],exclusions:[{area:{x:.5,y:.2,width:.08,height:.4}}]};
 const p=placementGeometry({...face,standard},{key:'leftChest',face:'front'},1);assert.ok(p.x-p.width/2>=.58*face.width);assert.ok(p.x+p.width/2<=.8*face.width);assert.equal(p.standard,true);
});

test('未标定衣身保留可调预览但不冒充厘米准确；明确厘米需求必须校准',()=>{
 const p=initialPlacement({...face,bodyWidth:null},{key:'leftChest',face:'front'},2);assert.equal(p.sizeCm,null);assert.equal(p.basis,'unconfirmed-preview');assert.throws(()=>initialPlacement({...face,bodyWidth:null},{key:'leftChest',face:'front'},2,'尺寸：高7cm'),/标定衣身/);
});

test('旧版拖动误标manual不锁死默认大尺寸；真实人工缩放保持不变',()=>{
 const info={key:'leftChest',width:.2};const width=Math.round(face.width*.2)/FRAME.width;
 assert.equal(hasManualSize({manual:true,width},face,info),false);
 assert.equal(hasManualSize({manual:true,width:width+.01},face,info),true);
 assert.equal(hasManualSize({manual:true,sizeManual:true,width},face,info),true);
});

test('保存旧版仅移动图层不把历史manual升级成手动缩放',async()=>{
 const root=await mkdtemp(join(tmpdir(),'legacy-drag-'));
 try{const c={caseId:'A',draft:{artworks:[artwork('logo',[{style:'S',color:'黑',position:'左胸'}])]}};
 const g=mockupGroups(c)[0],layer={id:'L',x:.3,y:.4,width:.07,manual:true};
 await saveJSON(join(root,'mockups/A.json'),{revision:1,cards:[{...g,layers:[layer]}]});
 let s=await saveMockupSelection(root,c,{revision:1,cardId:g.id,layers:[{...layer,x:.35}]});
 assert.equal(s.cards[0].layers[0].sizeManual,undefined);assert.equal(s.cards[0].layers[0].positionManual,true);
 s=await saveMockupSelection(root,c,{revision:s.revision,cardId:g.id,layers:[{...layer,x:.35,width:.06}]});assert.equal(s.cards[0].layers[0].sizeManual,true);
 }finally{await rm(root,{recursive:true,force:true});}
});
