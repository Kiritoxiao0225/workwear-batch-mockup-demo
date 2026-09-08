import { afterEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { exportTasks } from '@/lib/client/export';
import { createTask } from '@/lib/mockup';
import { garmentFixture } from '@/lib/testing/production-garment-fixture';

function installCanvas() {
  const loaded: string[] = [];
  const downloads: Array<{ name: string; blob: Blob }> = [];
  const blobs = new Map<string, Blob>();
  class Image {
    naturalWidth = 1000; naturalHeight = 500;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(url: string) {
      loaded.push(url);
      if (url.includes('logo')) { this.naturalWidth = 400; this.naturalHeight = 160; }
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal('Image', Image);
  vi.stubGlobal('FileReader', class {
    onload: ((event: { target: { result: ArrayBuffer } }) => void) | null = null;
    readAsArrayBuffer(blob: Blob) { void blob.arrayBuffer().then(result => this.onload?.({ target: { result } })); }
  });
  vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { const id = `blob:test-${blobs.size}`; blobs.set(id, blob as Blob); return id; });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.stubGlobal('document', { createElement: (kind: string) => kind === 'canvas' ? {
    width: 0, height: 0,
    getContext: () => ({ drawImage() {}, save() {}, translate() {}, rotate() {}, restore() {} }),
    toBlob: (callback: (blob: Blob) => void) => callback(new Blob(['rendered-test-png'], {type:'image/png'})),
  } : { href: '', download: '', click() { downloads.push({ name: this.download, blob: blobs.get(this.href)! }); } } });
  return { loaded, downloads };
}
function fixture(color = '活力黑') {
  const task = { ...createTask('B01SD'), garment: garmentFixture() };
  task.garment.colorName = color;
  task.placements.leftChest = { logoUrl: '/uploads/logos/test-logo.png', logoName: 'test-logo.png', widthCm: 7, offsetX: 0, offsetY: 0, rotation: 0 };
  return task;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('simple batch exporter', () => {
  it('exports an uncalibrated garment using defaults and authenticated image bytes', async () => {
    const env = installCanvas(); const task = fixture();
    task.garment.views.forEach(view => { view.standard = null; });
    const result = await exportTasks([task]);
    expect(result.exportedTaskIds).toEqual([task.id]);
    expect(env.loaded[0]).toContain('/api/production-files/');
    expect(env.downloads[0].name).toContain('B01SD-活力黑');
  });
  it('packages two colors independently and skips a task without a logo', async () => {
    const env = installCanvas(); const one = fixture(); const two = fixture('月牙白');
    const result = await exportTasks([one, two, createTask('1101')]);
    expect(result).toMatchObject({ exportedTaskIds: [one.id, two.id], skipped: 1, failures: [] });
    const zip = await JSZip.loadAsync(await env.downloads[0].blob.arrayBuffer());
    expect(Object.keys(zip.files)).toHaveLength(2);
    expect(Object.keys(zip.files).some(name => name.includes('月牙白'))).toBe(true);
  });
  it('keeps valid exports when another task is missing its actual back image', async () => {
    const env = installCanvas(); const one = fixture(); const two = fixture('缺背面');
    two.placements.back = two.placements.leftChest;
    two.garment.views = two.garment.views.filter(view => view.face === 'front');
    const result = await exportTasks([one, two]);
    expect(result.exportedTaskIds).toEqual([one.id]);
    expect(result.failures[0]).toContain('缺少背面底图');
    const zip = await JSZip.loadAsync(await env.downloads[0].blob.arrayBuffer());
    expect(zip.file('未导出任务.txt')).not.toBeNull();
  });
});
