import { AccountClient } from '@/components/account-client';

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ denied?: string }> }) {
  return <AccountClient deniedPage={(await searchParams).denied} />;
}
