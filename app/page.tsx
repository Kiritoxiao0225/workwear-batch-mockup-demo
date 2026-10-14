import { redirect } from 'next/navigation';
import { HOME_PAGE } from '@/lib/app-pages';

export default function HomePage() {
  redirect(HOME_PAGE);
}
