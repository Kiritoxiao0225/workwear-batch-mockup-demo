import { hash, fail } from '../adapters/a-files.mjs';

// B's input boundary only. It neither plans production nor rewrites A's text.
export async function receiveConfirmedRequirement(envelope, readAsset) {
  if (envelope?.schema !== 'a-confirmed-v1' || !envelope.confirmationId || !envelope.confirmedAt || !envelope.confirmedBy ||
      !envelope.text?.trim() || hash(envelope.text) !== envelope.textSHA256 || !Array.isArray(envelope.images)) throw fail('B只接收完整的人工确认记录', 409);
  const labels = new Set();
  for (const image of envelope.images) {
    if (!image.id || !image.label || labels.has(image.label)) throw fail('B收到的图片编号重复或缺失', 409);
    labels.add(image.label);
    const bytes = await readAsset(image.asset);
    if (hash(bytes) !== image.sha256 || bytes.length !== image.bytes) throw fail('B收到的图片与确认版本不一致', 409);
  }
  for (const match of envelope.text.matchAll(/图\s*([0-9０-９]+|[一二三四五六七八九十])/gu)) {
    const raw = match[1].replace(/[０-９]/gu, c => String(c.charCodeAt(0) - 65296));
    const index = /^[0-9]+$/u.test(raw) ? Number(raw) : '一二三四五六七八九十'.indexOf(raw) + 1;
    if (!labels.has(`图${index}`)) throw fail(`正文引用的图${index}没有对应附件，请核对后再确认`, 409);
  }
  const input = structuredClone(envelope);
  return { status: 'received', receivedAt: new Date().toISOString(), inputSHA256: hash(JSON.stringify(input)), input };
}
