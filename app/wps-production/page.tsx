"use client";
import { useRef } from 'react';
import { BatchArtworkEditorHost } from '@/components/batch-artwork-editor-host';
import { AppHeader } from '@/components/app-header';
import { useProjectSession } from '@/components/project-session';
export default function WpsProductionPage() {
  const frame = useRef<HTMLIFrameElement>(null);
  const { user, initialized, error, busy, refresh } = useProjectSession();
  return <main style={{height:'100dvh',display:'flex',flexDirection:'column',overflow:'hidden'}}>
    <AppHeader />
    {user ? <iframe ref={frame} src="/api/wps-workbench/ui" title="批量效果图工作台" style={{width:'100%',flex:1,border:0,minHeight:0}} allow="clipboard-write" /> : <div style={{padding:32}} role="status">{initialized ? error || '工作台暂时无法读取' : '正在连接工作台…'}{initialized && <button disabled={busy} onClick={() => void refresh()}>重试连接</button>}</div>}
    {user && <BatchArtworkEditorHost frame={frame} apiBase="/api/wps-workbench" />}
  </main>;
}
