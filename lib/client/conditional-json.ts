import { fetchApi } from '@/lib/client/api-response';
type Saved = { body: string; etag: string | null; status: number };
/** Per-consumer cache, with request coalescing and a fence for mutations. */
export class ConditionalJsonReader {
  private saved: Saved | null = null;
  private generation = 0;
  private flight: { signal?: AbortSignal; generation: number; work: Promise<Saved> } | null = null;
  constructor(private url: string) {}
  invalidate() { this.generation++; this.flight = null; this.saved = null; }
  async read(signal?: AbortSignal) {
    const generation = this.generation;
    if (!this.flight || this.flight.generation !== generation || this.flight.signal !== signal) {
      const saved = this.saved;
      const work = (async () => {
        const response = await fetchApi(this.url, { cache: 'no-store', signal, headers: saved?.etag ? { 'If-None-Match': saved.etag } : {} });
        if (response.status === 304) {
          if (!saved) throw new Error('状态缓存丢失，请重试读取');
          return saved;
        }
        const result = { body: await response.text(), etag: response.headers.get('etag'), status: response.status };
        if (response.ok && generation === this.generation && !signal?.aborted) this.saved = result;
        if (response.status === 401 || response.status === 403) this.saved = null;
        return result;
      })();
      const flight = { signal, generation, work };
      this.flight = flight;
      void work.finally(() => { if (this.flight === flight) this.flight = null; }).catch(() => {});
    }
    const result = await this.flight.work;
    return new Response(result.body, { status: result.status, headers: { 'Content-Type': 'application/json' } });
  }
}
