import Image from 'next/image';
import type { ArtworkTiming } from '@/lib/artwork-progress';

const labels: Record<string, string> = {
  clientQueue: '页面排队', snapshotCheck: '核对制作要求', inputImages: '读取素材',
  sourceQuality: '原图评分', generation: '模型生图（含服务排队）', cutout: '抠图',
  resultQuality: '成品评分', fidelity: '保真处理', inspection: '检查重绘条件',
  filePersistence: '保存生成文件', layerUploads: '保存图层', layout: '排版',
  flattenedUpload: '上传排版图', save: '保存到任务',
};

export function WpsArtworkProgress({ preview, timings, failed, open }: {
  preview?: { url: string; label: string }; timings: ArtworkTiming[]; failed: boolean;
  open: (url: string, title: string) => void;
}) {
  const label = failed ? '本次候选 · 操作未完成，尚未保存' : preview?.label;
  return <>
    {preview && <div className="wps-artwork-current" style={{ marginTop: 12 }}>
      <button className="wps-artwork-preview" aria-label="查看本次候选预览" type="button" onClick={() => open(preview.url, label!)}>
        <Image src={preview.url} alt={label!} fill sizes="200px" unoptimized />
      </button>
      <small>{label}</small>
    </div>}
    {timings.length > 0 && <details className="wps-inline-records">
      <summary>本次制作耗时</summary>
      <small>并行步骤的耗时不累加；客户效果图在保存后更新。</small>
      <ul>{timings.map((timing, index) => <li key={index}>{labels[timing.stage] ?? timing.stage}：{(timing.durationMs / 1000).toFixed(1)} 秒{timing.status === 'failed' ? ' · 未完成' : ''}</li>)}</ul>
    </details>}
  </>;
}
