import { ProductsClient } from '@/components/products-client';
import { CatalogLibraryClient } from '@/components/catalog-library-client';

type ProductsPageProps = {
  searchParams: Promise<{ mode?: string; taskId?: string }>;
};

export default async function ProductsPage({ searchParams }: ProductsPageProps) {
  const params = await searchParams;
  if (params.mode !== 'replace' && params.mode !== 'append') return <CatalogLibraryClient />;
  return <ProductsClient mode={params.mode === 'replace' ? 'replace' : 'append'} taskId={params.taskId ?? null} />;
}
