import type { Metadata } from 'next';

import '@/app/globals.css';

export const metadata: Metadata = {
  title: '工作服批量效果图 Demo',
  description: '内部工作服 Logo 批量效果图制作台',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
