import sharp from 'sharp';
import { resolve } from 'node:path';
import { jsonFile,saveJSON,atomicFile,hash,fail } from '../adapters/a-files.mjs';
export async function saveSupplement(root, body, caseIds) {
  if (!body || !caseIds.has(body.caseId) || !Number.isInteger(body.revision) || !['upload', 'remove'].includes(body.action)) throw fail('补图请求格式不正确');
  const scope = await jsonFile(resolve(root, 'scope.json'), null);
  if (scope && scope.cases[body.caseId]?.stage !== 'first_generation') throw fail('本轮只处理首次制作，当前案例已移出', 409);
  const all = await jsonFile(resolve(root, 'supplements.json'), {});
  const current = all[body.caseId] || { revision: 0, items: [] };
  if (body.action === 'upload') {
    if (typeof body.id !== 'string' || !/^[a-f0-9-]{36}$/u.test(body.id) || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 240 || typeof body.target !== 'string' || !body.target.trim() || body.target.length > 200 || typeof body.base64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(body.base64)) throw fail('请选择图片并填写素材用途');
    const bytes = Buffer.from(body.base64, 'base64');
    if (bytes.length > 15 * 1024 * 1024) throw fail('单张图片不能超过15MB', 413);
    if (bytes.toString('base64') !== body.base64) throw fail('图片编码不完整');
    const sha256 = hash(bytes), existing = current.items.find(x => x.id === body.id);
    if (existing) {
      if (existing.sha256 !== sha256 || existing.target !== body.target.trim() || existing.name !== body.name) throw fail('上传标识已用于其他内容', 409);
      return current; // Retry an uncertain upload without duplicating the attachment.
    }
    if (body.revision !== current.revision) throw fail('素材已在其他页面更新，请刷新后再操作', 409);
    if (current.items.filter(x => !x.removedAt).length >= 10) throw fail('每条最多补充10张图片');
    let metadata;
    try {
      const decoder = sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'warning' });
      metadata = await decoder.metadata();
      if (!['png', 'jpeg', 'webp'].includes(metadata.format) || (metadata.pages || 1) !== 1) throw new Error();
      await decoder.stats(); // Decode the complete image, not only its header.
    } catch { throw fail('无法读取图片，请使用完整的PNG、JPG或WebP静态图片（不超过4000万像素）'); }
    const asset = `supplements/${body.caseId}/${body.id}.${metadata.format === 'jpeg' ? 'jpg' : metadata.format}`;
    await atomicFile(resolve(root, 'public', asset), bytes);
    current.items.push({ id: body.id, name: body.name, target: body.target.trim(), sha256, bytes: bytes.length, width: metadata.width, height: metadata.height, asset, uploadedAt: new Date().toISOString(), source: 'designer_upload' });
  } else {
    if (body.revision !== current.revision) throw fail('素材已在其他页面更新，请刷新后再操作', 409);
    const item = current.items.find(x => x.id === body.id && !x.removedAt);
    if (!item) throw fail('未找到这张补图', 404);
    item.removedAt = new Date().toISOString(); // Retain bytes and audit history; original attachments are never altered.
  }
  current.revision += 1;
  current.updatedAt = new Date().toISOString();
  current.status = current.items.some(x => !x.removedAt) ? 'pending_reanalysis' : 'no_active_supplements';
  all[body.caseId] = current;
  await saveJSON(resolve(root, 'supplements.json'), all);
  return current;
}
