import Image from 'next/image';

import { PRODUCTS } from '@/lib/products';

type ProductGridProps = {
  selectedCodes: Set<string>;
  countsByCode: Record<string, number>;
  onToggle: (code: string) => void;
  search: string;
};

export function ProductGrid({ selectedCodes, countsByCode, onToggle, search }: ProductGridProps) {
  const query = search.trim().toLocaleLowerCase('zh-CN');
  const products = PRODUCTS.filter((product) =>
    `${product.code} ${product.name} ${product.color}`.toLocaleLowerCase('zh-CN').includes(query),
  );
  if (products.length === 0) return <div className="empty-state compact">没有找到匹配的商品。</div>;
  return (
    <div className="product-grid">
      {products.map((product, index) => {
        const selected = selectedCodes.has(product.code);
        const taskCount = countsByCode[product.code] ?? 0;
        return (
          <button
            className="product-card"
            aria-pressed={selected}
            key={product.code}
            onClick={() => onToggle(product.code)}
            type="button"
          >
            <span className="product-image">
              <Image
                alt={`${product.code} ${product.name}`}
                fill
                priority={index < 5}
                sizes="(max-width: 680px) 50vw, (max-width: 1100px) 33vw, 20vw"
                src={product.thumbnailUrl}
              />
              <span className="select-indicator" aria-hidden="true">{selected ? '✓' : ''}</span>
            </span>
            <strong>{product.code}</strong>
            <span>{product.name} · {product.color}</span>
            {taskCount > 0 && <small>当前批次已有 {taskCount} 条</small>}
          </button>
        );
      })}
    </div>
  );
}
