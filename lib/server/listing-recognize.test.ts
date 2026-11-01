import { describe, expect, it } from 'vitest';
import { parseInsideBox } from './listing-recognize';

describe('the front panel inside an 一体 jacket (11-01)', () => {
  it('reads the box as fractions, kept inside the photo', () => {
    expect(parseInsideBox('{"found":true,"box":[20,25,15,60]}')).toEqual([0.2, 0.25, 0.15, 0.6]);
    expect(parseInsideBox('{"found":true,"box":[90,10,30,95]}')).toEqual([0.9, 0.1, 0.1, 0.9]);
  });
  it('gives none when not found, too small, or not JSON: the whole photo is sent', () => {
    expect(parseInsideBox('{"found":false}')).toBeNull();
    expect(parseInsideBox('{"found":true,"box":[10,10,3,50]}')).toBeNull();
    expect(parseInsideBox('{"found":true,"box":[10,10,30,10]}')).toBeNull();
    expect(parseInsideBox('not json')).toBeNull();
  });
});
