import { describe, expect, it } from 'vitest';
import { taskReviewFixture } from '@/lib/testing/task-review-fixture';
import { confirmProductionPlan, emptyWpsProductionState, importTaskReviews, upsertTaskReviews } from '@/lib/wps-production';
import { canAnalyzeWpsTask, liveWpsProductionState, mergeWpsSourceOrder, orderWpsSourceRecords, pendingWpsAnalysisRecords, wpsSourceEvidence } from '@/lib/wps-source';

describe('live WPS production reconciliation', () => {
  it('retains work when WPS renews a signed URL but detects changed file identity or image options', () => {
    const source = taskReviewFixture()[0].source;
    const withUrl = (url: string, id = 'wps-file-1') => ({ ...source, materials: [{ id, url, previewUrl: url, name: 'logo.png', description: 'logo' }] });
    const old = withUrl('https://cdn.wps.cn/file.png?Expires=1&KSSAccessKeyId=old&Signature=old&response-cache-control=old');
    const renewed = withUrl('https://cdn.wps.cn/file.png?Expires=2&KSSAccessKeyId=new&Signature=new&response-cache-control=new');
    expect(wpsSourceEvidence(old)).toBe(wpsSourceEvidence(renewed));
    expect(wpsSourceEvidence(withUrl('https://cdn.wps.cn/other.png'))).not.toBe(wpsSourceEvidence(old));
    expect(wpsSourceEvidence(withUrl('https://cdn.wps.cn/file.png', 'wps-file-2'))).not.toBe(wpsSourceEvidence(old));
    expect(wpsSourceEvidence(withUrl('https://cdn.wps.cn/file.png?width=50'))).not.toBe(wpsSourceEvidence(old));
  });
  it('shows source rows before analysis while keeping historical test work untouched', () => {
    const existing = importTaskReviews(emptyWpsProductionState(), taskReviewFixture());
    const source = { ...taskReviewFixture()[0].source, recordId: 'real-file:sheet:record' };
    const visible = liveWpsProductionState(existing, [source]);
    expect(visible.records).toHaveLength(1);
    expect(visible.records[0].unitIds).toEqual([]);
    expect(visible.units).toEqual([]);
    expect(existing.units.length).toBeGreaterThan(0);
    expect(visible.revision).toBe(existing.revision);
  });
  it('places newly discovered rows first and keeps that order on later polls', () => {
    const source = taskReviewFixture()[0].source;
    const old = { ...source, recordId: 'existing' };
    const added = { ...source, recordId: 'new', requirementText: '' };
    const first = orderWpsSourceRecords([old.recordId], [old, added]);
    expect(first.map((record) => record.recordId)).toEqual(['new', 'existing']);
    const filled = { ...added, requirementText: '新需求' };
    const order = first.map(record => record.recordId);
    expect(orderWpsSourceRecords(order, [old, filled])).toEqual([filled, old]);
    expect(orderWpsSourceRecords(order, [old])).toEqual([old]);
    expect(liveWpsProductionState(emptyWpsProductionState(), [added]).records[0].summary).toContain('待完善');
  });
  it('initializes later WPS rows first and preserves history across filtering and source reordering', () => {
    const source = taskReviewFixture()[0].source;
    const rows = ['001', '007', '008'].map(recordId => ({ ...source, recordId }));
    const order = mergeWpsSourceOrder([], rows.map(row => row.recordId));
    expect(order).toEqual(['008', '007', '001']);
    expect(orderWpsSourceRecords(order, [rows[1], rows[0], rows[2]]).map(row => row.recordId)).toEqual(order);
    expect(mergeWpsSourceOrder(order, ['001'])).toEqual(order);
    expect(orderWpsSourceRecords(order, [rows[0], rows[2]]).map(row => row.recordId)).toEqual(['008', '001']);
    expect(mergeWpsSourceOrder(order, ['001', '007', '008', '009', '010'])).toEqual(['010', '009', ...order]);
  });
  it('status changes preserve confirmations, changed evidence invalidates them', () => {
    const review = taskReviewFixture()[0];
    const state = confirmProductionPlan(importTaskReviews(emptyWpsProductionState(), [review]), review.units[0].id, 'operator');
    const statusOnly = { ...review.source, wpsSource: { fileId: 'file', sheetId: 4, sheetName: '任务', statusFieldName: '状态', status: '设计中', statusOptions: [] } };
    expect(wpsSourceEvidence(statusOnly)).toBe(wpsSourceEvidence(review.source));
    expect(liveWpsProductionState(state, [statusOnly]).units[0].gateA).not.toBeNull();
    const changed = { ...review.source, requirementText: review.source.requirementText + ' 改为红色' };
    expect(liveWpsProductionState(state, [changed]).units).toEqual([]);
    expect(upsertTaskReviews(state, [{ ...review, source: changed }]).units[0].gateA).toBeNull();
  });
});

describe('WPS analysis scope', () => {
  it('only permits waiting and in-design states; completed, cancelled and unknown states stay excluded', () => {
    const source = taskReviewFixture()[0].source;
    const withStatus = (status: string) => ({ ...source, recordId: status, wpsSource: { fileId: 'file', sheetId: 1, sheetName: '任务', statusFieldName: '状态', status, statusOptions: [] } });
    const allowed = ['🔴待领取', '🟢设计中', '待领取', '设计中'].map(withStatus);
    const excluded = ['🔵待完善', '✔已完成', '⚫已取消', '', '未设计中', '待领取（已取消）'].map(withStatus);
    expect(allowed.every(canAnalyzeWpsTask)).toBe(true);
    expect(excluded.some(canAnalyzeWpsTask)).toBe(false);
    expect(canAnalyzeWpsTask({ ...source, wpsSource: undefined })).toBe(false);
    const state = liveWpsProductionState(emptyWpsProductionState(), [...allowed, ...excluded]);
    expect(pendingWpsAnalysisRecords(state.records).map((record) => record.source.recordId)).toEqual(allowed.map((record) => record.recordId));
    expect(state.records.find((record) => record.source.recordId === '✔已完成')?.summary).toContain('不参与分析');
  });

  it('skips blank and unchanged analyzed tasks, while changed active tasks re-enter the queue', () => {
    const review = taskReviewFixture()[0];
    const source = { ...review.source, wpsSource: { fileId: 'file', sheetId: 1, sheetName: '任务', statusFieldName: '状态', status: '🟢设计中', statusOptions: [] } };
    const saved = importTaskReviews(emptyWpsProductionState(), [{ ...review, source }]);
    expect(pendingWpsAnalysisRecords(liveWpsProductionState(saved, [source]).records)).toEqual([]);
    const changed = { ...source, requirementText: `${source.requirementText} 改为红色` };
    expect(pendingWpsAnalysisRecords(liveWpsProductionState(saved, [changed]).records)).toHaveLength(1);
    const completed = { ...changed, wpsSource: { ...source.wpsSource, status: '✔已完成' } };
    const blank = { ...source, recordId: 'blank', requirementText: '  ' };
    expect(pendingWpsAnalysisRecords(liveWpsProductionState(saved, [completed, blank]).records)).toEqual([]);
  });
});
