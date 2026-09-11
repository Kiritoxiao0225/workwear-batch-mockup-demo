import sharp from 'sharp';

/** Retry only GET/body reads. This module has no provider submission capability. */
export async function downloadArtworkResult(url: string, label: string, options: { fetch?: typeof fetch; timeoutMs?: number; maxBytes?: number } = {}) {
  const request = options.fetch ?? fetch;
  const maximum = options.maxBytes ?? 20 * 1024 * 1024;
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await request(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 120_000) });
      if ([401, 403, 404, 410].includes(response.status)) throw new UnavailableResultError(`${label}的下载地址已失效或无权访问（HTTP ${response.status}）；原服务回执已保留，请恢复原任务地址，不要重复生图。`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const declared = Number(response.headers.get('content-length'));
      if (declared > maximum) throw new UnavailableResultError(`${label}超过 20MB 下载限制`);
      const reader = response.body?.getReader();
      if (!reader) throw new Error('下载没有返回文件内容');
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.length;
          if (length > maximum) throw new UnavailableResultError(`${label}超过 20MB 下载限制`);
          chunks.push(part.value);
        }
      } finally { await reader.cancel().catch(() => undefined); }
      if (!length || (declared > 0 && length !== declared)) throw new Error('图片未下载完整');
      const bytes = Buffer.concat(chunks);
      // Decode pixels, not only headers: truncated JPEG/PNG must not be saved as complete.
      await sharp(bytes, { failOn: 'warning', limitInputPixels: 80_000_000 }).stats();
      return bytes;
    } catch (error) {
      if (error instanceof UnavailableResultError) throw error;
      last = error;
    }
  }
  throw new Error(`${label}下载未完成（已尝试 3 次，仅重试下载，未重新调用生成或增强服务）：${last instanceof Error ? last.message : String(last)}`);
}
class UnavailableResultError extends Error {}
