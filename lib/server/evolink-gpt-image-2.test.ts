import { afterEach, describe, expect, it, vi } from 'vitest';

import { taskReviewFixture } from '@/lib/testing/task-review-fixture';
import { emptyWpsProductionState, importTaskReviews, updateProductionPlan } from '@/lib/wps-production';
import {
  buildGptImage2Request,
  createGptImage2Task,
  queryGptImage2Task,
} from '@/lib/server/evolink-gpt-image-2';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.EVOLINK_API_KEY;
  delete process.env.EVOLINK_PUBLIC_ASSET_BASE_URL;
});

function gptUnit() {
  const review = taskReviewFixture()[2];
  review.units[1] = { ...review.units[1], layoutNote: '字体与整体版式按照图2' };
  let state = importTaskReviews(emptyWpsProductionState(), [review]);
  state = updateProductionPlan(state, state.units[1].id, { route: 'gpt-image-2' });
  return { record: state.records[0], unit: state.units[1] };
}

describe('EvoLink GPT Image 2 adapter', () => {
  it('builds the fixed 1K Low transparent PNG contract and preserves exact text instructions', () => {
    process.env.EVOLINK_PUBLIC_ASSET_BASE_URL = 'https://assets.example.com';
    const { record, unit } = gptUnit();
    const request = buildGptImage2Request(record, unit);
    expect(request).toMatchObject({
      model: 'gpt-image-2',
      resolution: '1K',
      quality: 'low',
      background: 'transparent',
      n: 1,
    });
    expect(request.image_urls).toEqual([
      'https://assets.example.com/task-review-originals/row3-1.png',
      'https://assets.example.com/task-review-originals/row3-2.png',
    ]);
    expect(request.prompt).toContain('背景像素 alpha 必须为 0');
    expect(request.prompt).toContain('不要生成衣服、人物、模特、场景');
    expect(request.promptHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('rejects local-only input before any paid provider call', () => {
    const { record, unit } = gptUnit();
    expect(() => buildGptImage2Request(record, unit)).toThrow('EVOLINK_PUBLIC_ASSET_BASE_URL');
  });

  it('strictly parses create and query task responses without a real model call', async () => {
    process.env.EVOLINK_API_KEY = 'test-key';
    process.env.EVOLINK_PUBLIC_ASSET_BASE_URL = 'https://assets.example.com';
    const { record, unit } = gptUnit();
    const responses = [
      new Response(JSON.stringify({ id: 'task-unified-1-demo', status: 'pending', progress: 0, usage: { credits_reserved: 1.5 } }), { status: 200 }),
      new Response(JSON.stringify({ id: 'task-unified-1-demo', status: 'completed', progress: 100, results: ['https://cdn.example.com/result.png'] }), { status: 200 }),
    ];
    const fetchMock = vi.fn(async () => responses.shift()!);
    vi.stubGlobal('fetch', fetchMock);
    const created = await createGptImage2Task(buildGptImage2Request(record, unit));
    expect(created.id).toBe('task-unified-1-demo');
    expect(created.creditsReserved).toBe(1.5);
    const completed = await queryGptImage2Task(created.id);
    expect(completed.results).toEqual(['https://cdn.example.com/result.png']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
