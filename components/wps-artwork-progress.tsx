import Image from 'next/image';
import type { ArtworkTiming } from '@/lib/artwork-progress';

const labels: Record<string, string> = {
  clientQueue: '页面排队', snapshotCheck: '核对制作要求', inputImages: '读取素材',
  sourceQuality: '检查原图清晰度', generation: '生成图案（含排队）', cutout: '去除背景',
  resultQuality: '检查成品清晰度', fidelity: '修复原图', inspection: '检查能否重画',
  referenceColor: '读取参考图颜色', editVerification: '检查修改是否正确',
  filePersistence: '保存生成文件', layerUploads: '保存图层', layout: '排版',
  flattenedUpload: '上传排版图', save: '保存到任务',
};

export function WpsArtworkProgress({ preview, timings, failed, open }: {
  preview?: { url: string; label: string }; timings: ArtworkTiming[]; failed: boolean;
  open: (url: string, title: string) => void;
}) {
  const label = failed ? '这次做出的图 · 尚未保存成品' : preview?.label;
  return <>
    {preview && <div className="wps-artwork-current" style={{ marginTop: 12 }}>
      <button className="wps-artwork-preview" aria-label="放大查看这次做出的图" type="button" onClick={() => open(preview.url, label!)}>
        <Image src={preview.url} alt={label!} fill sizes="200px" unoptimized />
      </button>
      <small>{label}</small>
    </div>}
    {timings.length > 0 && <details className="wps-inline-records">
      <summary>本次制作耗时</summary>
      <small>有些步骤同时进行，总用时不能直接相加。保存图案后会更新衣服效果图。</small>
      <ul>{timings.map((timing, index) => <li key={index}>{labels[timing.stage] ?? '其他处理'}：{(timing.durationMs / 1000).toFixed(1)} 秒{timing.status === 'failed' ? ' · 未完成' : ''}</li>)}</ul>
    </details>}
  </>;
}
