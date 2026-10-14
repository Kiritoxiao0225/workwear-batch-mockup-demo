import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ListingImagesClient } from '@/components/listing-images-client';

export const metadata: Metadata = { title: '电商主图 · 本地演示' };

/** The 电商主图 page on fixed demo data, for trying the pages locally; it does not exist in production. */
export default function ListingDemoPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <ListingImagesClient demo />;
}
