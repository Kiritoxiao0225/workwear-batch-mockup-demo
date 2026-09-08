import { describe, expect, it } from 'vitest';
import { cleanLogoWhiteBackground } from './logo-background';

const fixture = (w = 15, h = 15) => {
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  const put = (x: number, y: number, rgba: number[]) => data.set(rgba, (y * w + x) * 4);
  const read = (pixels: Uint8ClampedArray, x: number, y: number) => [...pixels.slice((y * w + x) * 4, (y * w + x) * 4 + 4)];
  return { data, put, read, clean: () => cleanLogoWhiteBackground(data, w, h) };
};

describe('one-button logo white matte cleanup', () => {
  it('clears off-white haze and converts gray antialiasing to translucent ink', () => {
    const f = fixture();
    f.put(0, 0, [254, 254, 254, 255]);
    f.put(7, 7, [0, 0, 0, 255]);
    f.put(6, 7, [230, 230, 230, 255]);
    const out = f.clean();
    expect(f.read(out, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(f.read(out, 6, 7)).toEqual([0, 0, 0, 25]);
    expect(f.read(out, 7, 7)).toEqual([0, 0, 0, 255]);
  });

  it('recovers a coloured edge without turning the logo black or changing its core', () => {
    const f = fixture();
    f.put(7, 7, [180, 30, 60, 255]);
    f.put(6, 7, [218, 143, 158, 255]);
    const out = f.clean();
    expect(f.read(out, 7, 7)).toEqual([180, 30, 60, 255]);
    expect(f.read(out, 6, 7).slice(0, 3)).toEqual([180, 30, 60]);
    expect(f.read(out, 6, 7)[3]).toBeCloseTo(127, 0);
  });

  it('preserves gray ink and a neighbouring different hue', () => {
    const f = fixture();
    f.put(7, 7, [80, 80, 80, 255]);
    f.put(6, 7, [168, 168, 168, 255]);
    f.put(8, 7, [20, 60, 180, 255]);
    const out = f.clean();
    expect(f.read(out, 7, 7)).toEqual([80, 80, 80, 255]);
    expect(f.read(out, 6, 7).slice(0, 3)).toEqual([80, 80, 80]);
    expect(f.read(out, 8, 7)).toEqual([20, 60, 180, 255]);
  });

  it('removes empty black and coloured character counters', () => {
    const f = fixture();
    for (const color of [[0, 0, 0, 255], [255, 190, 0, 255]]) {
      for (let y = 3; y <= 11; y++) for (let x = 3; x <= 11; x++) {
        if (x === 3 || x === 11 || y === 3 || y === 11) f.put(x, y, color);
      }
      expect(f.read(f.clean(), 7, 7)[3]).toBe(0);
    }
  });

  it('protects the whole badge interior while clearing nearby yellow lettering holes', () => {
    const f = badgeFixture();
    for (let y = 8; y <= 20; y++) for (let x = 8; x <= 20; x++) {
      if (x === 8 || x === 20 || y === 8 || y === 20) f.put(x, y, [255, 190, 0, 255]);
    }
    const out = f.clean();
    expect(f.read(out, 14, 14)[3]).toBe(0);
    for (let y = 24; y < 105; y++) for (let x = 24; x < 105; x++) {
      if (Math.hypot(x - 64, y - 64) < 39) expect(f.read(out, x, y)).toEqual(f.read(f.data, x, y));
    }
    expect(cleanLogoWhiteBackground(out, 128, 128)).toEqual(out);
  });

  it('does not protect an empty circular O or a broken badge frame', () => {
    const empty = badgeFixture(false);
    expect(empty.read(empty.clean(), 64, 64)[3]).toBe(0);
    const broken = badgeFixture();
    for (let x = 104; x <= 110; x++) broken.put(x, 64, [255, 255, 255, 255]);
    expect(broken.read(broken.clean(), 64, 64)[3]).toBe(0);
  });

  it('does not invent white backing in an already transparent circular logo', () => {
    const f = badgeFixture();
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
      if (f.read(f.data, x, y).slice(0, 3).every(v => v === 255)) f.put(x, y, [0, 0, 0, 0]);
    }
    const out = f.clean();
    expect(f.read(out, 64, 64)[3]).toBe(0);
    expect(f.read(out, 64, 32)[3]).toBe(0);
  });

  it('keeps a clean transparent logo and repeated processing stable', () => {
    const f = fixture();
    f.data.fill(0);
    f.put(7, 7, [20, 70, 160, 255]);
    f.put(6, 7, [20, 70, 160, 70]);
    const out = f.clean();
    expect(out).toEqual(f.data);
    expect(cleanLogoWhiteBackground(out, 15, 15)).toEqual(out);
  });

  it('does not erase a detached fine stroke or increase existing opacity', () => {
    const f = fixture();
    f.put(7, 7, [0, 0, 0, 120]);
    f.put(2, 2, [180, 180, 180, 255]);
    const out = f.clean();
    expect(f.read(out, 7, 7)[3]).toBe(120);
    expect(f.read(out, 2, 2)[3]).toBe(255);
  });
});

function badgeFixture(withArtwork = true) {
  const f = fixture(128, 128);
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    const r = Math.hypot(x - 64, y - 64);
    if ((r >= 42 && r <= 46) || (withArtwork && r <= 20)) f.put(x, y, [215, 20, 30, 255]);
  }
  if (withArtwork) for (let y = 59; y <= 69; y++) for (let x = 59; x <= 69; x++) f.put(x, y, [255, 255, 255, 255]);
  return f;
}
