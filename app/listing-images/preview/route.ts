import { LISTING_PREVIEW_HTML } from '@/lib/listing-images/preview-html';
import { requirePage } from '@/lib/server/page-access';

// 电商主图的功能预览（静态演示页）。路由不经过 layout，所以这里自己检查页面权限；
// 地址不以 .html 结尾，没登录会先被送去登录。
export async function GET() {
  await requirePage('/listing-images');
  return new Response(LISTING_PREVIEW_HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, max-age=300' },
  });
}
