import type { Metadata } from 'next';
import { ListingImagesClient } from '@/components/listing-images-client';

export const metadata: Metadata = { title: '电商主图' };

export default function ListingImagesPage() {
  return <ListingImagesClient />;
}
