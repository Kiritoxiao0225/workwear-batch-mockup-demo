import { ArtworkWorkQueue } from '@/lib/artwork-work-queue';

// Previews share a page-wide cap; requirement analysis uses its own queue.
const previews = new ArtworkWorkQueue(3);

export async function readProductionPreview(url: string, signal: AbortSignal): Promise<Blob> {
  signal.throwIfAborted();
  const id = crypto.randomUUID();
  const cancel = () => { previews.cancel(id); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    return await previews.run(id, async () => {
      signal.throwIfAborted();
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error(`Preview HTTP ${response.status}`);
      // Hold the slot until the body finishes downloading, not just the headers.
      return response.blob();
    });
  } finally { signal.removeEventListener('abort', cancel); }
}
