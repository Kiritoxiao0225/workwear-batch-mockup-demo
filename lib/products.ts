import type { Product } from '@/lib/types';

export const PRODUCTS: Product[] = [
  { code: '011HYX', name: '卡其马甲', color: '卡其', originalUrl: '/products/originals/011hyx-khaki.png', thumbnailUrl: '/products/thumbs/011hyx-khaki.png', width: 4143, height: 2412, garmentWidthCm: 50 },
  { code: '1101', name: '软壳内胆 JSH', color: '深灰', originalUrl: '/products/originals/1101-softshell-liner.png', thumbnailUrl: '/products/thumbs/1101-softshell-liner.png', width: 3961, height: 2455, garmentWidthCm: 50 },
  { code: '1866', name: '银狐绒 CYJD', color: '豆绿', originalUrl: '/products/originals/1866-mint-fleece.png', thumbnailUrl: '/products/thumbs/1866-mint-fleece.png', width: 3794, height: 2518, garmentWidthCm: 50 },
  { code: '1906DC', name: '藏青色外套', color: '藏青', originalUrl: '/products/originals/1906dc-navy.png', thumbnailUrl: '/products/thumbs/1906dc-navy.png', width: 3727, height: 2242, garmentWidthCm: 50 },
  { code: '2208', name: '新款 Polo', color: '茶绿', originalUrl: '/products/originals/2208-tea-green-polo.png', thumbnailUrl: '/products/thumbs/2208-tea-green-polo.png', width: 4462, height: 2556, garmentWidthCm: 50 },
  { code: '2402', name: '立领 JSH 外套', color: '墨黑', originalUrl: '/products/originals/2402-black-jacket.png', thumbnailUrl: '/products/thumbs/2402-black-jacket.png', width: 4059, height: 2518, garmentWidthCm: 50 },
  { code: '2509', name: 'MSHJ 长袖', color: '黑拼红', originalUrl: '/products/originals/2509-black-red.png', thumbnailUrl: '/products/thumbs/2509-black-red.png', width: 3784, height: 2419, garmentWidthCm: 50 },
  { code: '2599DC', name: '灰色外套', color: '灰色', originalUrl: '/products/originals/2599dc-gray.png', thumbnailUrl: '/products/thumbs/2599dc-gray.png', width: 4531, height: 2523, garmentWidthCm: 50 },
  { code: '301SRX', name: '冰川灰 Polo', color: '冰川灰', originalUrl: '/products/originals/301srx-ice-gray.png', thumbnailUrl: '/products/thumbs/301srx-ice-gray.png', width: 4328, height: 2605, garmentWidthCm: 50 },
  { code: '388', name: '速干 Polo', color: '藏青', originalUrl: '/products/originals/388-quick-dry-navy.png', thumbnailUrl: '/products/thumbs/388-quick-dry-navy.png', width: 4397, height: 2613, garmentWidthCm: 50 },
];

export function productByCode(code: string) {
  return PRODUCTS.find((product) => product.code === code) ?? null;
}
