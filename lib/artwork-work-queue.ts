export const ARTWORK_CONCURRENCY = 2;
export type ArtworkQueueJob = { id: string; status: 'queued' | 'running' | 'finishing'; progress: string };
export class ArtworkQueueCancelledError extends Error {}

/** A FIFO queue. Releasing a failed job starts the next job without retrying it. */
export class ArtworkWorkQueue {
  private jobs = new Map<string, ArtworkQueueJob>();
  private waiting: Array<{ id: string; start: () => void; cancel: () => void }> = [];
  private active = 0;
  private inFlight = 0;

  constructor(private concurrency = ARTWORK_CONCURRENCY, private changed: (jobs: ArtworkQueueJob[]) => void = () => {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('并发数必须为正整数');
  }

  has(id: string) { return this.jobs.has(id); }
  get size() { return this.jobs.size; }
  private publish() { this.changed([...this.jobs.values()].map(job => ({ ...job }))); }
  private pump() {
    // Allow postprocessing to overlap generation, while bounding total memory/work.
    while (this.active < this.concurrency && this.inFlight < this.concurrency * 2 && this.waiting.length) this.waiting.shift()!.start();
  }

  run<T>(id: string, task: (progress: (message: string) => void, finishGeneration: () => void) => Promise<T>): Promise<T> {
    if (this.has(id)) return Promise.reject(new Error('该图案已在制作队列中'));
    this.jobs.set(id, { id, status: 'queued', progress: '排队等待制作' });
    const result = new Promise<T>((resolve, reject) => {
      this.waiting.push({ id, cancel: () => reject(new ArtworkQueueCancelledError('已取消排队')), start: () => {
        this.active++;
        this.inFlight++;
        let released = false;
        let finished = false;
        this.jobs.set(id, { id, status: 'running', progress: '正在读取素材…' });
        this.publish();
        const progress = (message: string) => {
          if (finished) return;
          this.jobs.set(id, { id, status: released ? 'finishing' : 'running', progress: message });
          this.publish();
        };
        const finishGeneration = () => {
          if (released || finished) return;
          released = true;
          this.active--;
          this.jobs.set(id, { id, status: 'finishing', progress: this.jobs.get(id)!.progress });
          this.publish();
          this.pump();
        };
        const finish = () => {
          finished = true;
          if (!released) this.active--;
          this.inFlight--;
          this.jobs.delete(id);
          this.publish();
          this.pump();
        };
        Promise.resolve().then(() => task(progress, finishGeneration)).then(value => { finish(); resolve(value); }, error => { finish(); reject(error); });
      } });
    });
    this.publish();
    this.pump();
    return result;
  }

  cancel(id: string) {
    const index = this.waiting.findIndex(job => job.id === id);
    if (index < 0) return false;
    const [job] = this.waiting.splice(index, 1);
    this.jobs.delete(id);
    job.cancel();
    this.publish();
    return true;
  }
}
