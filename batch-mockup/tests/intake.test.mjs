import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createCase, updateCase, removeCase, ensureWorkspace } from '../application/intake.mjs';
import { jsonFile, hash, atomicFile } from '../adapters/a-files.mjs';
import { requirementImages } from '../application/requirements.mjs';

const png = (r) => sharp({ create: { width: 32, height: 16, channels: 3, background: { r, g: 90, b: 120 } } }).png().toBuffer();
const b64 = async (r) => (await png(r)).toString('base64');

test('手动录入产出与 WPS 完全一致的 case 结构', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'intake-'));
  try {
    await ensureWorkspace(root);
    const manifest = await jsonFile(path.resolve(root, 'manifest.json'));
    // Analysis refuses to start without the prompt file and its recorded digest.
    assert.ok(manifest.run.promptSHA256, 'manifest.run.promptSHA256 必须存在');
    const prompt = await readFile(path.resolve(root, 'prompt.txt'), 'utf8');
    assert.equal(hash(prompt), manifest.run.promptSHA256, 'promptSHA256 必须与 prompt.txt 一致');
    assert.ok(await jsonFile(path.resolve(root, 'scope.json')), 'scope.json 必须存在');

    const created = await createCase(root, {
      text: '左胸用图1的圆形徽标，后背大字「安全生产」',
      images: [{ base64: await b64(20), name: 'logo.png' }, { base64: await b64(200), name: 'font.png' }],
    });
    assert.equal(created.imageCount, 2);

    const saved = (await jsonFile(path.resolve(root, 'manifest.json'))).cases[0];
    assert.equal(saved.sourceTextSHA256, hash(saved.sourceText), '原文摘要必须与正文一致');
    assert.equal(saved.active, true);
    for (const [index, image] of saved.images.entries()) {
      // The freeze check compares these exact names; sha256/bytes would fail inside a paid job.
      assert.ok(image.originalSHA256, '必须是 originalSHA256，不是 sha256');
      assert.ok(image.originalBytes > 0, '必须是 originalBytes，不是 bytes');
      assert.equal(image.index, index + 1, '图号必须连续');
      assert.equal(image.imageId, `${saved.caseId}-${index + 1}`);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('改原文或换图会标记重新识别并保留历史', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'intake-'));
  try {
    const { caseId } = await createCase(root, { text: '初版需求', images: [{ base64: await b64(10) }] });
    const unchanged = await updateCase(root, { caseId, text: '初版需求' });
    assert.equal(unchanged.changed, false, '内容没变就不该标记失效');

    const changed = await updateCase(root, { caseId, text: '改过的需求' });
    assert.equal(changed.changed, true);
    const saved = (await jsonFile(path.resolve(root, 'manifest.json'))).cases[0];
    assert.equal(saved.needsReanalysis, true, '源变化后必须重新识别，不能拿旧解读跑付费任务');
    assert.equal(saved.sourceText, '改过的需求');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('删图保留原图号，不将图3悄悄改成图2', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'intake-'));
  try {
    const { caseId } = await createCase(root, {
      text: '三张图', images: [{ base64: await b64(10) }, { base64: await b64(120) }, { base64: await b64(230) }],
    });
    const before = (await jsonFile(path.resolve(root, 'manifest.json'))).cases[0].images;
    await updateCase(root, { caseId, images: [{ imageId: before[0].imageId }, { imageId: before[2].imageId }] });
    const after = (await jsonFile(path.resolve(root, 'manifest.json'))).cases[0].images;
    assert.deepEqual(after.map(i => i.index), [1, 3], '图号固定后不可重排');
    assert.equal(after[1].imageId,before[2].imageId);
    assert.equal(after[1].originalSHA256, before[2].originalSHA256, '保留的图内容不变');
    const images=await requirementImages(root,{images:after},{items:[{id:'supplement',asset:'supplements/example.png'}]});
    assert.deepEqual(images.map(i=>i.index),[1,3,4],'补图不能复用被保留的图3编号');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('软删后不可继续操作，历史保留', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'intake-'));
  try {
    const { caseId } = await createCase(root, { text: '待删除', images: [] });
    await removeCase(root, { caseId });
    const saved = (await jsonFile(path.resolve(root, 'manifest.json'))).cases[0];
    assert.equal(saved.active, false, '软删只置标记，保留记录');
    const scope = await jsonFile(path.resolve(root, 'scope.json'));
    assert.equal(scope.cases[caseId].stage, 'status_excluded');
    await assert.rejects(() => updateCase(root, { caseId, text: '还想改' }), /已删除/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('拒绝空原文、超量图片和损坏图片', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'intake-'));
  try {
    await assert.rejects(() => createCase(root, { text: '   ', images: [] }), /需求原文/);
    await assert.rejects(() => createCase(root, { text: 'ok', images: Array.from({ length: 11 }, () => ({ base64: 'AA==' })) }), /最多/);
    await assert.rejects(() => createCase(root, { text: 'ok', images: [{ base64: Buffer.from('not an image').toString('base64') }] }), /无法读取/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('已有的素材图按指纹复用，不再上传；没有的指纹要求重新上传', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'intake-reuse-'));
  try {
    const bytes = await png(60);
    const first = await createCase(root, { text: '图稿一', entry: 'studio', images: [{ base64: bytes.toString('base64'), name: 'logo.png' }] });
    const sha = hash(bytes);
    const second = await createCase(root, { text: '图稿二', entry: 'studio', requestId: crypto.randomUUID(),
      images: [{ sha256: sha, name: '再用一次.png' }, { base64: await b64(220), name: 'new.png' }] });
    const cases = (await jsonFile(path.resolve(root, 'manifest.json'))).cases;
    const [a, b] = [first, second].map(c => cases.find(x => x.caseId === c.caseId));
    assert.equal(b.images.length, 2);
    assert.equal(b.images[0].asset, a.images[0].asset, '同一份图片文件');
    assert.equal(b.images[0].originalSHA256, sha);
    assert.equal(b.images[0].imageId, `${b.caseId}-1`);
    assert.equal(b.images[0].sourceFileName, '再用一次.png');
    assert.equal(b.images[1].index, 2);
    await assert.rejects(createCase(root, { text: '图稿三', entry: 'studio', images: [{ sha256: 'f'.repeat(64), name: 'x.png' }] }), /需要重新上传/);
    await assert.rejects(createCase(root, { text: '图稿四', entry: 'studio', images: [{ sha256: '../../etc', name: 'x.png' }] }), /需要重新上传/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('放大到 2K/4K：按结果文件在服务器上复制成新需求的图1；路径或指纹不对就拒绝', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'intake-result-'));
  try {
    await ensureWorkspace(root);
    const bytes = await png(90), sha = hash(bytes), result = `production-results/${'a'.repeat(64)}/final-2048.png`;
    await atomicFile(path.resolve(root, 'public', result), bytes);
    const created = await createCase(root, { text: '放大', entry: 'studio', images: [{ result, sha256: sha, name: '图稿.png' }] });
    const saved = (await jsonFile(path.resolve(root, 'manifest.json'))).cases.find(c => c.caseId === created.caseId);
    assert.equal(saved.images[0].originalSHA256, sha);
    assert.match(saved.images[0].asset, /^wps-assets\//u);
    await assert.rejects(createCase(root, { text: '放大', images: [{ result: '../manifest.json', sha256: sha }] }), /图稿结果无效/);
    await assert.rejects(createCase(root, { text: '放大', images: [{ result, sha256: 'b'.repeat(64) }] }), /已变化/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
