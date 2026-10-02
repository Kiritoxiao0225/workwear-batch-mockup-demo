import type { Metadata } from 'next';
import { AppHeader } from '@/components/app-header';

export const metadata: Metadata = { title: '电商主图' };

// 功能还在开发：先在全站导航下嵌入流程预览，接好后端后换成正式页面。
export default function ListingImagesPage() {
  return (
    <>
      <AppHeader />
      <iframe src="/listing-images/preview" title="电商主图" style={{ display: 'block', width: '100%', height: 'calc(100vh - 48px)', border: 0 }} />
    </>
  );
}
