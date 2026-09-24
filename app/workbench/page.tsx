import { redirect } from 'next/navigation';

// Replaced by the batch workspace; the old local demo state is retired.
export default function WorkbenchPage() {
  redirect('/batch');
}
