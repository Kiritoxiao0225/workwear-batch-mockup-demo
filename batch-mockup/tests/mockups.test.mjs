import test from 'node:test';
import {placementGeometry,requestedDimensions} from '../application/mockup-placement.mjs';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mockupGroups,matchGarment,garmentCanvas,renderMockups,saveMockupSelection,readMockupState,markMockupsPending,initialPlacement,hasManualSize,positionInfo,FRAME} from '../application/mockups.mjs';
import {annotationOverlay,annotationText,colorIssue} from '../application/mockup-checks.mjs';
import {missingGlyphs} from '../adapters/font-coverage.ts';
import {readFile} from 'node:fs/promises';
import {suggestedPlacement} from '../../lib/catalog-placement-suggestions.ts';
import {atomicFile,assetPath,hash,saveJSON} from '../adapters/a-files.mjs';
import {clearFaintSpecks} from '../adapters/production-images.mjs';
import {plausibleTorso} from '../../lib/sop-placement.ts';
const artwork=(id,apps)=>({id,name:id,applications:apps});
test('共享图稿只建立多个服装应用；同款色前后同框，候选版本不叠加',()=>{
 const c={caseId:'A',draft:{artworks:[artwork('logo',[{style:'S',color:'黑',position:'左胸'},{style:'S',color:'白',position:'左胸'}]),artwork('back',[{style:'S',color:'黑',position:'后背'},{style:'S',color:'白',position:'后背'}])]}};
 const groups=mockupGroups(c);assert.equal(groups.length,2);for(const g of groups)assert.deepEqual(g.selections,{'左胸':'logo','后背':'back'});
 c.draft.artworks.push(artwork('other',[{style:'S',color:'黑',position:'左胸'}]));const multi=mockupGroups(c).filter(g=>g.color==='黑');assert.equal(multi.length,2);assert.equal(multi[0].selections['后背'],'back');assert.equal(multi[1].selections['左胸'],'other');
 c.draft.artworks.push(artwork('back2',[{style:'S',color:'黑',position:'后背'}]));for(const g of mockupGroups(c).filter(g=>g.color==='黑'))assert.deepEqual(g.selections,{'左胸':null,'后背':null});
});
test('款色容忍色字和橙橘写法差异，但只接受唯一结果',()=>{const x={id:'1',colorName:'白色'},orange={id:'2',colorName:'橘色'},tangerine={id:'3',colorName:'橙色'};
 assert.equal(matchGarment([{styleCode:'A',colors:[x]}],'A','白色'),x);assert.equal(matchGarment([{styleCode:'A',colors:[x]}],'A','白'),x);assert.equal(matchGarment([{styleCode:'A',colors:[x,orange]}],'A','橙色'),orange);
 assert.equal(matchGarment([{styleCode:'A',colors:[x]},{styleCode:'A',colors:[x]}],'A','白色'),null);assert.equal(matchGarment([{styleCode:'A',colors:[orange,tangerine]}],'A','桔色'),null);assert.equal(matchGarment([{styleCode:'A',colors:[orange,tangerine]}],'A','橙色'),tangerine);
 assert.equal(matchGarment([{styleCode:'A',colors:[x]}],'B','白色'),null);assert.equal(matchGarment([{styleCode:'A',colors:[x]}],'A','黑色'),null);assert.equal(matchGarment([{styleCode:'A',colors:[x]}],'A',undefined),null);});
test('真实像素合成：正背面同框、可见Alpha边界、改位置不更改另一层、修补更新保留位置',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mockups-test-'));
 try{
  const png=async(w,h,color)=>sharp({create:{width:w,height:h,channels:4,background:color}}).png().toBuffer();
  const silhouette=Buffer.from('<svg width="200" height="200"><path fill="#ccc" d="M30 15H70L98 50L88 80L72 70V190H28V70L12 80L2 50ZM130 15H170L198 50L188 80L172 70V190H128V70L112 80L102 50Z"/></svg>');
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
test('未匹配款色写明原因，素材库补齐后自动匹配；宽高冲突按宽等比出图并保留提醒',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mockups-match-'));
 try{
  const png=async(w,h,color)=>sharp({create:{width:w,height:h,channels:4,background:color}}).png().toBuffer();
  const silhouette=Buffer.from('<svg width="200" height="200"><path fill="#ccc" d="M30 15H70L98 50L88 80L72 70V190H28V70L12 80L2 50ZM130 15H170L198 50L188 80L172 70V190H128V70L112 80L102 50Z"/></svg>');
  const garment=await sharp(silhouette).png().toBuffer(),frame=await png(FRAME.width,FRAME.height,'white');
  const detail={id:'22222222-2222-4222-8222-222222222222',assetVersionId:'asset1',styleCode:'S',colorName:'卡其色',sha256:hash(garment),width:200,height:200,views:[{face:'front',crop:{x:0,y:0,width:.5,height:1},history:[]},{face:'back',crop:{x:.5,y:0,width:.5,height:1},history:[]}]};
  const colors=[{id:'33333333-3333-4333-8333-333333333333',colorName:'黑'}],catalog={styles:async()=>[{styleCode:'S',colors}],detail:async()=>detail,bytes:async()=>garment,frame:async()=>frame};
  const logo=await png(20,10,'red'),file={asset:'production-results/logo.png',sha256:hash(logo)};await atomicFile(assetPath(root,file.asset),logo);
  const c={caseId:'B',revision:1,draft:{artworks:[{...artwork('logo',[{style:'S',color:'卡其',position:'左胸'}]),prompt:'尺寸：宽4厘米、高1厘米\n输出：透明'}]}};
  const jobs=[{id:'job',artworkId:'logo',revision:1,final:file}];
  let state=await renderMockups(root,c,jobs,catalog);assert.equal(state.cards[0].status,'needs_garment');assert.equal(state.cards[0].note,'S 没有「卡其」这个颜色，请选择颜色');
  colors.push({id:detail.id,colorName:'卡其色'});state=await renderMockups(root,c,jobs,catalog);
  const card=state.cards[0];assert.equal(card.variantId,detail.id);assert.equal(card.status,'preview');assert.ok(card.render);assert.deepEqual(card.layers[0].sizeConflict,{width:4,height:1});
  assert.deepEqual(card.warnings,['左胸：客户写的宽4×高1厘米与图稿比例不一致，已按宽4厘米等比放置（高约2厘米），请核对尺寸。']);
  // SOP 2.2: the customer's size is written on the mockup; both sides were given, so the height is stated too.
  assert.equal(card.layers[0].annotation.text,'Logo 最大宽度：4cm　最大高度：2cm');assert.ok(card.hints.some(h=>h.startsWith('左胸：领口下约9.5厘米')));
  // The note is off by default: the size is listed for the designer, the PNG stays clean until switched on.
  assert.ok(card.hints.includes('左胸：客户指定尺寸，Logo 最大宽度：4cm　最大高度：2cm（可在效果图上显示标注）'));
  await assert.rejects(()=>saveMockupSelection(root,c,{cardId:card.id,revision:state.revision,annotateSize:'yes'}),/尺寸标注开关无效/);
  const plain=card.render.sha256;let on=await saveMockupSelection(root,c,{cardId:card.id,revision:state.revision,annotateSize:true});assert.equal(on.cards[0].annotateSize,true);
  on=await renderMockups(root,c,jobs,catalog);assert.notEqual(on.cards[0].render.sha256,plain);assert.equal(on.cards[0].hints.some(h=>h.includes('客户指定尺寸')),false);
  const off=await renderMockups(root,c,jobs,catalog);assert.equal(off.revision,on.revision);
  assert.deepEqual(off.cards[0].warnings,card.warnings);
 }finally{await rm(root,{recursive:true,force:true});}
});

const face={x:0,y:0,width:900,height:1000,bodyWidth:550,bodyCenter:450,bodyBasis:'alpha-torso-v1',crop:{width:900,height:1000},trim:{left:0,top:0},scale:1};
test('SOP默认尺寸：胸标宽8厘米（高不超9厘米），后背宽26厘米（高不超22厘米），衣袖不作为衣身宽度',()=>{
 for(const ratio of [.25,1,2]){const p=placementGeometry(face,{key:'leftChest',face:'front'},ratio);assert.ok(p.sizeCm.width<=9.001&&p.sizeCm.height<=6.001);assert.ok(Math.abs(p.height/p.width-ratio)<1e-9);assert.ok(p.x-p.width/2>face.bodyCenter);}
 assert.deepEqual(placementGeometry(face,{key:'leftChest',face:'front'},.25).sizeCm,{width:9,height:2.25});
 const back=placementGeometry(face,{key:'backCenter',face:'back'},2);assert.equal(back.sizeCm.height,22);assert.equal(back.sizeCm.width,11);
 assert.equal(placementGeometry(face,{key:'backCenter',face:'back'},.3).sizeCm.width,26);
 assert.throws(()=>placementGeometry({...face,bodyWidth:null},{key:'leftChest',face:'front'},1),/衣身宽度/);
});
test('明确尺寸换算单位；宽高与图稿比例冲突时按宽等比放置，不悄悄缩小客户尺寸',()=>{
 assert.deepEqual(requestedDimensions('尺寸：宽70mm\n输出：透明'),{width:7,explicit:true});
 assert.equal(requestedDimensions('尺寸：原文未指定\n输出：透明'),null);
 const p=placementGeometry(face,{key:'leftChest',face:'front'},2,'尺寸：高6cm\n输出：透明');assert.deepEqual(p.sizeCm,{width:3,height:6});assert.equal(p.sizeConflict,null);
 const q=placementGeometry(face,{key:'leftChest',face:'front'},2,'尺寸：7×7cm');assert.deepEqual(q.sizeConflict,{width:7,height:7});assert.deepEqual(q.sizeCm,{width:7,height:14});assert.equal(q.height/q.width,2);
 assert.equal(placementGeometry(face,{key:'leftChest',face:'front'},.45,'尺寸：宽2.3厘米、高1厘米').sizeConflict,null);
 assert.throws(()=>placementGeometry(face,{key:'leftChest',face:'front'},1,'尺寸：宽40cm'),/超出可印区域/);assert.throws(()=>placementGeometry(face,{key:'leftChest',face:'front'},.3,'尺寸：宽21cm'),/超出可印区域/);
});
test('结构点决定位置，避让区（拉链）生效且只做最小移动',()=>{
 const px=face.bodyWidth/40,pt=(x,y)=>({x,y});
 const structure={structureType:'jacket',neck:pt(450,120),leftShoulder:pt(170,200),rightShoulder:pt(730,200),leftArmpit:pt(175,430),rightArmpit:pt(725,430),bodyWidth:550,center:450,bounds:{x:0,y:0,width:900,height:1000},exclusions:[{x:450-2.5*px,y:120,width:5*px,height:880}]};
 const p=placementGeometry({...face,structure,structureSource:'confirmed'},{key:'leftChest',face:'front'},.3);
 assert.equal(p.standard,true);assert.ok(Math.abs(p.y-(120+9.5*px))<1e-6);assert.ok(p.x-p.width/2>=450+2.5*px);
 // A 17 cm wide customer logo would touch the zipper; it moves outward instead of shrinking.
 const wide=placementGeometry({...face,structure,structureSource:'confirmed'},{key:'leftChest',face:'front'},.25,'尺寸：宽17厘米');
 assert.ok(Math.abs(wide.x-wide.width/2-(450+2.5*px))<.25*px+1e-6);assert.equal(wide.sizeCm.width,17);assert.deepEqual(wide.warnings,[]);
 const back=placementGeometry({...face,face:'back',structure,structureSource:'confirmed'},{key:'backCenter',face:'back'},.3);assert.ok(Math.abs(back.y-315)<1e-6);assert.equal(back.x,450);
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

test('位置写法：左前胸仍是胸标，袖子可合图，未写左右时提醒',()=>{
 assert.equal(positionInfo('左前胸').key,'leftChest');assert.equal(positionInfo('右前胸').key,'rightChest');assert.equal(positionInfo('正面左胸口').key,'leftChest');
 assert.equal(positionInfo('胸前居中').key,'frontCenter');assert.equal(positionInfo('正胸前').key,'frontCenter');
 assert.deepEqual([positionInfo('胸前').key,!!positionInfo('胸前').note],['leftChest',true]);
 assert.equal(positionInfo('左袖口').key,'leftSleeve');assert.equal(positionInfo('右袖').key,'rightSleeve');assert.deepEqual([positionInfo('袖子').key,!!positionInfo('袖子').note],['leftSleeve',true]);
 assert.equal(positionInfo('后领下方').key,'upperBack');assert.equal(positionInfo('后背').key,'backCenter');assert.equal(positionInfo('帽子'),null);
 for(const unsaid of ['','  ','未指定','原需求未指定位置'])assert.deepEqual([positionInfo(unsaid).key,positionInfo(unsaid).defaulted],['leftChest',true]);
});
test('尺寸标注文字可由效果图字体完整渲染',async()=>{
 const font=await readFile(new URL('../../public/fonts/DOUYINSANSBOLD.TTF',import.meta.url));
 for(const text of [annotationText({width:8,height:2.6},false),annotationText({width:7.25,height:6},true)])assert.deepEqual(missingGlyphs(font,text),[]);
 assert.equal(annotationText({width:7.25,height:6},true),'Logo 最大宽度：7.3cm　最大高度：6cm');
 const png=await annotationOverlay([{text:'Logo 宽度：8cm',withHeight:false,box:{left:100,top:100,w:200,h:60}}],600,400,{left:0,right:600,bottom:400});
 const {data,info}=await sharp(png).raw().toBuffer({resolveWithObject:true});let red=0;for(let i=0;i<data.length;i+=info.channels)if(data[i+3]>200&&data[i]>150&&data[i+1]<80)red++;assert.ok(red>200);
});
test('配色：深浅接近或高饱和撞色给出提醒，对比清楚时不提醒',async()=>{
 const solid=async(w,h,c)=>sharp({create:{width:w,height:h,channels:4,background:c}}).png().toBuffer();
 const base=async c=>sharp({create:{width:200,height:200,channels:3,background:c}}).raw().toBuffer({resolveWithObject:true});
 assert.match(await colorIssue(await solid(40,20,'#ffffff'),40,20,await base('#d8d8dc'),50,50),/深浅接近/);
 assert.match(await colorIssue(await solid(40,20,'#1f9d2a'),40,20,await base('#d81e1e'),50,50),/深浅接近|撞色/);
 assert.equal(await colorIssue(await solid(40,20,'#ffffff'),40,20,await base('#111111'),50,50),null);
 assert.equal(await colorIssue(await solid(40,20,'#a88550'),40,20,await base('#c8c8cc'),50,50),null);
});
test('同款只标一次：未确认颜色在轮廓一致时沿用同款已确认结构点，不写入素材库',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mockups-shared-'));
 try{
  const silhouette=Buffer.from('<svg width="200" height="200"><path fill="#ccc" d="M30 15H70L98 50L88 80L72 70V190H28V70L12 80L2 50ZM130 15H170L198 50L188 80L172 70V190H128V70L112 80L102 50Z"/></svg>');
  const garment=await sharp(silhouette).png().toBuffer(),frame=await sharp({create:{width:FRAME.width,height:FRAME.height,channels:4,background:'white'}}).png().toBuffer();
  const pt=(x,y)=>({x,y}),landmarks=[['neckCenter',pt(.5,.1)],['leftShoulder',pt(.2,.2)],['rightShoulder',pt(.8,.2)],['leftArmpit',pt(.28,.35)],['rightArmpit',pt(.72,.35)],['hemCenter',pt(.5,.95)]].map(([key,point])=>({key,label:key,point}));
  const spec={schemaVersion:1,structureType:'crewneck',garmentFrame:{x:0,y:0,width:1,height:1},measuredWidthCm:null,landmarks,positions:[],exclusions:[],note:''};
  const view=(face,x,confirmed)=>({id:face+x,face,crop:{x,y:0,width:.5,height:1},confirmedId:confirmed?'s-'+face:null,history:confirmed?[{id:'s-'+face,status:'confirmed',specification:spec}]:[]});
  const detail=(id,colorName,confirmed)=>({id,assetVersionId:'v'+id,styleCode:'S',colorName,layout:'front_back',imageUrl:'x',sha256:hash(garment),width:200,height:200,views:[view('front',0,confirmed),view('back',.5,confirmed)]});
  const a=detail('11111111-1111-4111-8111-00000000000a','白',true),b=detail('11111111-1111-4111-8111-00000000000b','黑',false);
  const faces=[{face:'front',status:'confirmed',confirmedId:'s-front'},{face:'back',status:'confirmed',confirmedId:'s-back'}];
  const catalog={styles:async()=>[{styleCode:'S',referenceVariantId:a.id,colors:[{id:a.id,colorName:'白',layout:'front_back',calibrationFaces:faces},{id:b.id,colorName:'黑',layout:'front_back',calibrationFaces:[]}]}],detail:async id=>id===a.id?a:b,bytes:async()=>garment,frame:async()=>frame};
  const logo=await sharp({create:{width:20,height:10,channels:4,background:'red'}}).png().toBuffer(),file={asset:'production-results/logo.png',sha256:hash(logo)};await atomicFile(assetPath(root,file.asset),logo);
  const c={caseId:'S',revision:1,draft:{artworks:[artwork('logo',[{style:'S',color:'黑',position:'左胸'},{style:'S',color:'白',position:'左胸'}])]}};
  const state=await renderMockups(root,c,[{id:'job',artworkId:'logo',revision:1,final:file}],catalog);
  const black=state.cards.find(x=>x.color==='黑'),white=state.cards.find(x=>x.color==='白');
  assert.ok(black.hints.includes('正面沿用同款「白」已确认的结构点（轮廓一致）'));assert.equal(white.hints.some(h=>h.includes('沿用')),false);
  assert.ok(Math.abs(black.layers[0].y-white.layers[0].y)<1e-9&&Math.abs(black.layers[0].x-white.layers[0].x)<1e-9);
  assert.equal(b.views[0].history.length,0);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('SOP 2.1：客户没写尺寸时按参考图比例定宽（不标注），超出可印范围退回默认并提醒',()=>{
 const p=placementGeometry(face,{key:'leftChest',face:'front'},.3,'尺寸：原需求未指定图稿尺寸。',{sizeReference:{imageId:'i',logoToBody:.22,note:'图2实拍左胸Logo约占衣身宽22%'}});
 assert.ok(Math.abs(p.sizeCm.width-8.8)<1e-9);assert.equal(p.referenced,true);assert.equal(p.requested,false);assert.match(p.rule,/^尺寸按参考图比例（图2实拍/);
 const big=placementGeometry(face,{key:'leftChest',face:'front'},.3,'',{sizeReference:{imageId:'i',logoToBody:.6,note:''}});
 assert.ok(Math.abs(big.sizeCm.width-(8+1/3))<1e-9,'退回默认尺寸（3.3:1 的图稿宽约 8.3 厘米）');assert.equal(big.referenced,false);assert.match(big.warnings[0],/超出该位置可印范围/);
 // A customer size always wins over the reference ratio.
 assert.equal(placementGeometry(face,{key:'leftChest',face:'front'},.3,'尺寸：宽7厘米',{sizeReference:{imageId:'i',logoToBody:.22,note:''}}).sizeCm.width,7);
});
test('只点了确认、结构点仍是模板原值的标准不当作校准：提醒重标并按轮廓估算',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mockups-template-'));
 try{
  const silhouette=Buffer.from('<svg width="200" height="200"><path fill="#ccc" d="M30 15H70L98 50L88 80L72 70V190H28V70L12 80L2 50ZM130 15H170L198 50L188 80L172 70V190H128V70L112 80L102 50Z"/></svg>');
  const garment=await sharp(silhouette).png().toBuffer(),frame=await sharp({create:{width:FRAME.width,height:FRAME.height,channels:4,background:'white'}}).png().toBuffer();
  const template=suggestedPlacement('crewneck','front',{x:0,y:0,width:1,height:1});
  const detail={id:'11111111-1111-4111-8111-00000000000c',assetVersionId:'v',styleCode:'S',colorName:'白',layout:'front_only',imageUrl:'x',sha256:hash(garment),width:200,height:200,views:[{id:'f',face:'front',crop:{x:0,y:0,width:.5,height:1},confirmedId:'t',history:[{id:'t',status:'confirmed',specification:template}]}]};
  const catalog={styles:async()=>[{styleCode:'S',colors:[{id:detail.id,colorName:'白',layout:'front_only',calibrationFaces:[{face:'front',status:'confirmed',confirmedId:'t'}]}]}],detail:async()=>detail,bytes:async()=>garment,frame:async()=>frame};
  const logo=await sharp({create:{width:20,height:10,channels:4,background:'red'}}).png().toBuffer(),file={asset:'production-results/logo.png',sha256:hash(logo)};await atomicFile(assetPath(root,file.asset),logo);
  const state=await renderMockups(root,{caseId:'T',revision:1,draft:{artworks:[artwork('logo',[{style:'S',color:'白',position:'左胸'}])]}},[{id:'job',artworkId:'logo',revision:1,final:file}],catalog);
  assert.ok(state.cards[0].warnings.some(w=>w.startsWith('正面：素材库确认的结构点仍是系统模板原值')));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('残留杂点：只清除远离图案、又淡又小的孤立像素，实心小点和贴着图案的柔光保留',()=>{
 const w=100,h=100,px=new Uint8Array(w*h*4),set=(x,y,a)=>{px[(y*w+x)*4+3]=a;},alpha=(x,y)=>px[(y*w+x)*4+3];
 for(let y=20;y<60;y++)for(let x=20;x<60;x++)set(x,y,255);
 for(let x=20;x<60;x++)set(x,60,30);// soft edge touching the design
 set(99,99,20);// the corner speck seen on a real cutout
 set(80,20,255);set(81,20,255);// a tiny but solid dot is design
 assert.equal(clearFaintSpecks(px,w,h),1);
 assert.equal(alpha(99,99),0);assert.equal(alpha(40,60),30);assert.equal(alpha(80,20),255);assert.equal(alpha(40,40),255);
});
test('长袖贴身时轮廓测宽等于整件宽度，不当作衣身；无袖款整件宽就是衣身',()=>{
 assert.equal(plausibleTorso('jacket',.742,.748),null);
 assert.equal(plausibleTorso('polo',.47,.786),.47);
 assert.equal(plausibleTorso('vest',.7,.72),.7);
});
const colorFixture=async root=>{
 const shape=(body,accent='')=>Buffer.from(`<svg width="200" height="200"><path fill="${body}" d="M30 15H70L98 50L88 80L72 70V190H28V70L12 80L2 50ZM130 15H170L198 50L188 80L172 70V190H128V70L112 80L102 50Z"/>${accent}</svg>`);
 const frame=await sharp({create:{width:FRAME.width,height:FRAME.height,channels:4,background:'white'}}).png().toBuffer();
 const garments={},styles=[];
 const add=async(id,colorName,svg)=>{const bytes=await sharp(svg).png().toBuffer();garments[id]={bytes,detail:{id,assetVersionId:'a'+id,styleCode:'S',colorName,sha256:hash(bytes),width:200,height:200,views:[{face:'front',crop:{x:0,y:0,width:.5,height:1},history:[]},{face:'back',crop:{x:.5,y:0,width:.5,height:1},history:[]}]}};styles.push({id,colorName});};
 await add('44444444-4444-4444-8444-444444444441','理想绿',shape('#2b4b48'));
 await add('44444444-4444-4444-8444-444444444442','白色',shape('#f4f4f4'));
 // 米白 body with wine sleeves on both faces: a two-tone garment.
 await add('44444444-4444-4444-8444-444444444443','米白酒红',shape('#efe6d2','<path fill="#7a1f2b" d="M30 15L2 50L12 80L28 70ZM70 15L98 50L88 80L72 70ZM130 15L102 50L112 80L128 70ZM170 15L198 50L188 80L172 70Z"/>'));
 const catalog={styles:async()=>[{styleCode:'S',colors:styles}],detail:async id=>garments[id].detail,bytes:async d=>garments[d.id].bytes,frame:async()=>frame};
 const logo=async color=>{const bytes=await sharp({create:{width:100,height:100,channels:4,background:'#0000'}}).composite([{input:await sharp({create:{width:60,height:40,channels:4,background:color}}).png().toBuffer(),left:20,top:30}]).png().toBuffer();const file={asset:`production-results/${color.slice(1)}.png`,sha256:hash(bytes),width:100,height:100};await atomicFile(assetPath(root,file.asset),bytes);return file;};
 const prompt=color=>`【后背图稿】\n\n主体：使用图1完整Logo。\n\n文字：沿用图1已有文字，不改写。\n\n字体：沿用图1。\n\n颜色：${color}\n\n排版：保持图1原有构图。\n\n尺寸：原需求未指定图稿尺寸。\n\n输出：一张独立平面图稿。`;
 const render=(caseId,colors,color,job,sourceText='')=>renderMockups(root,{caseId,revision:1,sourceText,draft:{artworks:[{...artwork('logo',colors.map(c=>({style:'S',color:c,position:'后背'}))),prompt:prompt(color)}]}},[job],catalog);
 const pixel=async(asset,x,y)=>{const {data,info}=await sharp(await readFile(assetPath(root,asset))).raw().toBuffer({resolveWithObject:true});const i=(Math.round(y)*info.width+Math.round(x))*info.channels;return [data[i],data[i+1],data[i+2]];};
 return {logo,render,pixel};
};
test('更新效果图先把卡片标成正在更新，合成结束后恢复并重新合成',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mockups-pending-'));
 try{
  const {logo,render}=await colorFixture(root),job={id:'b'.repeat(64),artworkId:'logo',revision:1,final:await logo('#031827')};
  const first=(await render('P1',['理想绿'],'沿用图1原有配色。',job)).cards[0];assert.ok(['ready','preview'].includes(first.status));
  const marked=await markMockupsPending(root,'P1');assert.equal(marked.cards[0].status,'pending');assert.equal((await readMockupState(root,'P1')).cards[0].status,'pending');
  const again=(await render('P1',['理想绿'],'沿用图1原有配色。',job)).cards[0];assert.equal(again.status,first.status);assert.notEqual(again.render.renderedAt,undefined);
  assert.equal((await markMockupsPending(root,'none')).cards.length,0);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('SOP 5 自动改色：深衣服上看不清的 Logo 改成白色，改色文件就是这个衣色的配色版本；客户指定颜色时不改',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mockups-color-'));
 try{
  const {logo,render,pixel}=await colorFixture(root),file=await logo('#031827'),job={id:'a'.repeat(64),artworkId:'logo',revision:1,final:file};
  let card=(await render('C1',['理想绿'],'沿用图1原有配色。',job)).cards[0];const layer=card.layers[0];
  assert.deepEqual(layer.colorResult,{color:'#ffffff',source:'auto',blocked:null,recommended:{color:'#ffffff',label:'白色'}});
  assert.deepEqual(await pixel(card.render.asset,layer.x*FRAME.width,layer.y*FRAME.height),[255,255,255]);
  // The recolored file is what the artwork column offers for this garment color; the artwork itself is untouched.
  assert.notEqual(layer.asset,layer.sourceAsset);assert.deepEqual(await pixel(layer.asset,5,5),[255,255,255]);assert.equal(job.repair,undefined);
  assert.ok(card.hints.some(h=>h.startsWith('后背：Logo 与衣服颜色深浅接近')&&h.includes('已按 SOP 改为白色')&&h.includes('图稿列有这个颜色的版本可下载')));assert.deepEqual(card.warnings,[]);
  const again=(await render('C1',['理想绿'],'沿用图1原有配色。',job)).cards[0];assert.equal(again.render.sha256,card.render.sha256);
  // The model describing the reference in the 颜色 line does not make it the customer's colour (Wc24f3e5c74eb).
  card=(await render('C1',['理想绿'],'文字使用藏蓝色，参考图1和图2的藏蓝色标识。',job,'货号:S-理想绿\n后背:图1\n颜色:')).cards[0];
  assert.equal(card.layers[0].colorResult.source,'auto');
  card=(await render('C1',['理想绿'],'Logo 保持藏蓝色，客户指定。',job,'货号:S-理想绿\n后背:图1，Logo 用藏蓝色')).cards[0];
  assert.equal(card.layers[0].colorResult.blocked,'customer');assert.equal(card.layers[0].asset,card.layers[0].sourceAsset);
  assert.ok(card.warnings.some(w=>w.includes('图稿写明了颜色要求，未自动改色；建议改为白色')));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('SOP 5 自动改色：设计师在编辑器设过颜色不改；一份图稿配不同衣色各自判断；撞色款取衣服第二多的颜色',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mockups-color-'));
 try{
  const {logo,render}=await colorFixture(root),navy=await logo('#031827');
  const edited='b'.repeat(64);await saveJSON(join(root,'production-jobs',edited,'edit-1.json'),{draft:{graphic:{recolor:{mode:'solid',color:'#031827'}},extraGraphics:[]}});
  const manual=(await render('C2',['理想绿'],'沿用图1原有配色。',{id:edited,artworkId:'logo',revision:1,final:navy,repair:{file:navy,draftRevision:1}})).cards[0];
  assert.equal(manual.layers[0].colorResult.source,'manual');assert.equal(manual.layers[0].asset,manual.layers[0].sourceAsset);assert.ok(manual.warnings.some(w=>w.includes('深浅接近')));

  const shared='c'.repeat(64),both=await render('C3',['理想绿','白色'],'沿用图1原有配色。',{id:shared,artworkId:'logo',revision:1,final:navy});
  const green=both.cards.find(c=>c.color==='理想绿'),white=both.cards.find(c=>c.color==='白色');
  assert.equal(green.layers[0].colorResult.color,'#ffffff');assert.equal(white.layers[0].colorResult.color,null);
  assert.deepEqual([...green.warnings,...white.warnings],[]);assert.equal(white.layers[0].asset,white.layers[0].sourceAsset);

  const pale=await logo('#d9d9d9'),twoTone=(await render('C4',['米白酒红'],'沿用图1原有配色。',{id:'d'.repeat(64),artworkId:'logo',revision:1,final:pale})).cards[0];
  assert.equal(twoTone.layers[0].colorResult.recommended.label,'衣服撞色');assert.ok(twoTone.hints.some(h=>/已按 SOP 改为衣服撞色 #7a[12][0-9a-f]2b/.test(h)));
 }finally{await rm(root,{recursive:true,force:true});}
});

test('货号写法不同也能匹配：大小写、全角、分隔符、字母与数字段顺序；近似号码和多个候选不猜', async () => {
  const { findStyles } = await import('../application/mockups.mjs');
  const color = code => ({ id: code, colorName: '藏青' });
  const styles = ['719SF', 'JSH-JSD33', 'CX8099NS', 'NS-2288', 'AB12', '12-AB'].map(code => ({ styleCode: code, colors: [color(code)] }));
  assert.equal(matchGarment(styles, 'SF-719', '藏青')?.id, '719SF');
  assert.equal(matchGarment(styles, 'ｊｓｈ ｊｓｄ33', '藏青')?.id, 'JSH-JSD33');
  assert.equal(matchGarment(styles, 'cx-8099-ns', '藏青')?.id, 'CX8099NS');
  assert.equal(findStyles(styles, '719SF').how, 'exact');
  assert.equal(findStyles(styles, 'SF-719').how, 'reordered');
  assert.equal(matchGarment(styles, '8800/NS', '藏青'), null, '不同号码不当成同一款');
  assert.equal(matchGarment(styles, 'CX8800NS', '藏青'), null);
  assert.equal(findStyles(styles, 'AB-12').named[0].styleCode, 'AB12', '更严格的一级先命中');
  assert.deepEqual(findStyles([...styles, { styleCode: 'AB-12', colors: [color('AB-12')] }], 'ab12').ambiguous, ['AB12', 'AB-12']);
});
