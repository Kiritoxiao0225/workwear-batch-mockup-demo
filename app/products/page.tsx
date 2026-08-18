import { ProductsClient } from '@/components/products-client';

type ProductsPageProps = {
  searchParams: Promise<{ mode?: string; taskId?: string }>;
};

export default async function ProductsPage({ searchParams }: ProductsPageProps) {
  const params = await searchParams;
  return <ProductsClient mode={params.mode === 'replace' ? 'replace' : 'append'} taskId={params.taskId ?? null} />;
}
