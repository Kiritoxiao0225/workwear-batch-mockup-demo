import { describe, expect, it } from 'vitest';

import { logoTextGuideLines } from '@/lib/logo-text-guide';

describe('Logo text structure guide', () => {
  it('keeps every target character in one line for the complete Logo flow', () => {
    expect(logoTextGuideLines('汉方嘉铁永坊店')).toEqual(['汉方嘉铁永坊店']);
  });

  it('fails fast when target text is empty', () => {
    expect(() => logoTextGuideLines('  ')).toThrow('目标文字不能为空');
  });
});
