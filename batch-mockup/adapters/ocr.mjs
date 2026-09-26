import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../ocr/read_text.py', import.meta.url));

/**
 * The text in the source images, read by RapidOCR with the interpreter OCR_PYTHON names, before the
 * requirement model sees them. Unset, no text is read and recognition runs as before.
 * Returns a reader: [{ bytes, ext }] → [[{ text, score }]] in the same order.
 */
export function configuredTextReader(env = process.env) {
  const python = env.OCR_PYTHON?.trim();
  if (!python) return null;
  return async images => {
    const dir = await mkdtemp(join(tmpdir(), 'ocr-'));
    try {
      const paths = await Promise.all(images.map(async (image, n) => { const path = join(dir, `${n}${image.ext}`); await writeFile(path, image.bytes); return path; }));
      const stdout = await new Promise((done, failed) => execFile(python, [SCRIPT, ...paths], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (error, out) => error ? failed(error) : done(out)));
      const lines = JSON.parse(stdout.trim().split('\n').at(-1));
      if (!Array.isArray(lines) || lines.length !== images.length) throw new Error('OCR 输出与图片数量不一致');
      return lines;
    } finally { await rm(dir, { recursive: true, force: true }); }
  };
}

/** The reference the requirement model receives: each image's confident lines, or that none were read. */
export const textReference = text => '素材文字识别参考（OCR，机器识别，只列高置信度结果，可能漏字或错字）：\n' +
  Object.entries(text).map(([label, lines]) => `${label}：${lines.length ? lines.map(x => `「${x.text}」`).join(' ') : '未识别到文字'}`).join('\n');
