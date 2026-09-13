import type { Metadata } from 'next';
import '../ui/workspace.css';
export const metadata: Metadata = { title: '批量效果图 · 新工作台', description: '独立框架本地验收' };
export default function Layout({ children }: {
    children: React.ReactNode;
}) { return <html lang="zh-CN"><body>{children}</body></html>; }
