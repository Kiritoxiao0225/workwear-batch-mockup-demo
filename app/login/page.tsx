import { LoginClient } from '@/components/login-client';
import { HOME_PAGE } from '@/lib/app-pages';

type LoginPageProps = { searchParams: Promise<{ next?: string; mode?: string; reason?: string }> };

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  // Only same-site paths are accepted so the redirect cannot be used to bounce elsewhere.
  const next = params.next && /^\/(?!\/)[^\\\s]*$/u.test(params.next) ? params.next : HOME_PAGE;
  const mode = params.mode === 'register' || params.mode === 'reset' || params.mode === 'setup' ? params.mode : 'login';
  return <LoginClient next={next} initialMode={mode} sessionExpired={params.reason === 'session-expired'} />;
}
