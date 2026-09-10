import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WpsAnalysisStatusNotice } from './wps-analysis-status';
import { taskReviewFixture } from '@/lib/testing/task-review-fixture';
import type { WpsAnalysisStatus } from '@/hooks/use-wps-automatic-analysis';

const source = { ...taskReviewFixture()[0].source, wpsSource: { fileId: 'file', sheetId: 1, sheetName: '任务', statusFieldName: '状态', status: '🔴待领取', statusOptions: [] } };
const render = (status?: WpsAnalysisStatus, enabled = true) => renderToStaticMarkup(createElement(WpsAnalysisStatusNotice, { source, status, enabled, retry: () => {} }));

describe('per-task analysis feedback', () => {
  it('shows the actual failure and a row retry instead of promising automatic analysis', () => {
    const html = render({ phase: 'failed', error: '模型处理超时（120 秒）' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('模型处理超时（120 秒）');
    expect(html).toContain('重试解析');
    expect(html).not.toContain('自动解析队列');
    expect(render({ phase: 'failed', error: '保存冲突', parsed: true })).toContain('重试保存');
    expect(render({ phase: 'failed', error: '保存冲突' }, false)).toContain('disabled');
  });
  it('distinguishes queued, analyzing, saving and unavailable states', () => {
    expect(render()).toContain('等待解析');
    expect(render({ phase: 'analyzing' })).toContain('正在解析需求');
    expect(render({ phase: 'saving' })).toContain('解析已完成，正在保存');
    expect(render(undefined, false)).toContain('等待自动解析恢复');
  });
  it('shows the actual model stage and failed duration with a trace number', () => {
    expect(render({ phase: 'analyzing', stage: 'images' })).toContain('读取图案素材');
    const html = render({ phase: 'failed', stage: 'model', error: '模型处理超时', requestId: 'request-1', timings: [{ stage: 'model', durationMs: 180000, status: 'failed' }] });
    expect(html).toContain('等待模型解析结果'); expect(html).toContain('180.0'); expect(html).toContain('未完成'); expect(html).toContain('request-1');
  });
});
