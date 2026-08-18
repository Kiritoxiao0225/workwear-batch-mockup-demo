import { describe, expect, it } from 'vitest';

import { storageModeForHostname } from '@/lib/client/browser-demo-store';

describe('demo storage mode', () => {
  it('keeps project-file storage for local development', () => {
    expect(storageModeForHostname('localhost')).toBe('project-files');
    expect(storageModeForHostname('127.0.0.1')).toBe('project-files');
  });

  it('uses browser storage for hosted demos', () => {
    expect(storageModeForHostname('workwear-demo.vercel.app')).toBe('browser');
  });
});
