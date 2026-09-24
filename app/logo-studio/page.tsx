import { redirect } from 'next/navigation';

// Replaced by the artwork studio, which runs through the shared production queue.
export default function LogoStudioPage() {
  redirect('/artwork-studio');
}
