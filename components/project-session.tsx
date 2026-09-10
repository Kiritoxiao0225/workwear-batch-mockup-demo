'use client';
import { fetchApi, readApiJson } from '@/lib/client/api-response';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { CatalogUser } from '@/lib/catalog';

const sessionSchema = z.object({
  user: z.object({ id: z.uuid(), email: z.email(), displayName: z.string().min(1), role: z.enum(['admin', 'editor', 'viewer']) }),
  localStorage: z.boolean(),
});
type ProjectSession = {
  user: CatalogUser | null;
  initialized: boolean;
  localStorage: boolean;
  error: string;
  busy: boolean;
  refresh: () => Promise<void>;
};
const SessionContext = createContext<ProjectSession | null>(null);
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

async function readSessionResponse(response: Response) {
  const body: unknown = await readApiJson(response, '读取工作台登录状态失败');
  return sessionSchema.parse(body);
}

export function ProjectSessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<{ user: CatalogUser | null; localStorage: boolean }>({ user: null, localStorage: false });
  const [initialized, setInitialized] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refreshing = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    setBusy(true);
    try {
      const response = await fetchApi('/api/catalog/session', { cache: 'no-store' });
      const next = await readSessionResponse(response);
      setSession(current => JSON.stringify(current) === JSON.stringify(next) ? current : next);
      setError('');
    } catch (error) { setSession({ user: null, localStorage: false }); setError(errorMessage(error)); }
    finally { refreshing.current = false; setBusy(false); setInitialized(true); }
  }, []);

  useEffect(() => {
    const whenVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    const initial = setTimeout(whenVisible, 0);
    const interval = setInterval(whenVisible, 60 * 60 * 1000);
    window.addEventListener('focus', whenVisible);
    window.addEventListener('online', whenVisible);
    document.addEventListener('visibilitychange', whenVisible);
    return () => {
      clearTimeout(initial); clearInterval(interval);
      window.removeEventListener('focus', whenVisible);
      window.removeEventListener('online', whenVisible);
      document.removeEventListener('visibilitychange', whenVisible);
    };
  }, [refresh]);

  return <SessionContext.Provider value={{ ...session, initialized, error, busy, refresh }}>
    {children}
  </SessionContext.Provider>;
}

export function useProjectSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error('工作台页面缺少 ProjectSessionProvider');
  return session;
}
