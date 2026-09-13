"use client";
import { useProjectSession } from '@/components/project-session';
export default function WpsProductionPage() {
  const { user, initialized, error, busy, refresh } = useProjectSession();
  return <main style={{height:'100dvh',display:'flex',flexDirection:'column'}}>
    <nav aria-label="工作台导航" style={{display:'flex',gap:24,padding:'10px 24px',fontSize:13,background:'#eef4f0',borderBottom:'1px solid #d8e3dc'}}>
      <a href="/products">商品素材库</a><strong>批量效果图</strong><a href="/wps-production/legacy">旧版与历史记录</a>
    </nav>
    {user ? <iframe src="/api/batch/ui" title="批量效果图工作台" style={{width:'100%',flex:1,border:0,minHeight:0}} allow="clipboard-write" /> : <div style={{padding:32}} role="status">{initialized ? error || '工作台暂时无法读取' : '正在连接工作台…'}{initialized && <button disabled={busy} onClick={() => void refresh()}>重试连接</button>}</div>}
  </main>;
}
