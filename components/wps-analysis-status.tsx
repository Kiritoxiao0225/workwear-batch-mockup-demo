import type { SourceTaskRecord } from '@/lib/batch-task-review';
import type { WpsAnalysisStatus } from '@/hooks/use-wps-automatic-analysis';
import { canAnalyzeWpsTask } from '@/lib/wps-source';

export function WpsAnalysisStatusNotice({ source, status, enabled, retry }: {
  source: SourceTaskRecord;
  status?: WpsAnalysisStatus;
  enabled: boolean;
  retry: () => void;
}) {
  if (!source.requirementText.trim()) return <div><strong>待完善</strong><p>在 WPS 填写需求后自动解析。</p></div>;
  if (!canAnalyzeWpsTask(source)) return <div><strong>当前状态不参与解析</strong><p>仅待领取和设计中的任务参与解析。</p></div>;
  if (status?.phase === 'failed') return <div className="wps-production-row-error" role="alert">
    <strong>{status.parsed ? '解析已完成，保存失败' : '解析失败'}</strong>
    <p>{status.error}</p>
    <button className="button secondary" type="button" disabled={!enabled} onClick={retry}>{status.parsed ? '重试保存' : '重试解析'}</button>
  </div>;
  if (status?.phase === 'analyzing') return <div role="status"><strong>正在解析需求…</strong><p>完成后自动显示服装方案与印花位置。</p></div>;
  if (status?.phase === 'saving') return <div role="status"><strong>解析已完成，正在保存…</strong></div>;
  if (!enabled) return <div role="status"><strong>等待自动解析恢复</strong><p>当前连接或账号尚不能启动解析。</p></div>;
  return <div role="status"><strong>等待解析</strong><p>已加入自动解析队列。</p></div>;
}
