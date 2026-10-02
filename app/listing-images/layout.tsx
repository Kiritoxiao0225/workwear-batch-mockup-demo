import { requirePage } from '@/lib/server/page-access';

export default async function Layout({ children }: { children: React.ReactNode }) {
  await requirePage('/listing-images');
  return children;
}
