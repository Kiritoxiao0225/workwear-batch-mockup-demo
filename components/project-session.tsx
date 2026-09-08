'use client';

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
  openLogin: () => void;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
};
const SessionContext = createContext<ProjectSession | null>(null);
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

async function readSessionResponse(response: Response) {
  const body: unknown = await response.json();
  if (!response.ok) {
    const parsed = z.object({ error: z.string() }).parse(body);
    throw new Error(parsed.error);
  }
  return sessionSchema.parse(body);
}

export function ProjectSessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<{ user: CatalogUser | null; localStorage: boolean }>({ user: null, localStorage: false });
  const [initialized, setInitialized] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginError, setLoginError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const requestVersion = useRef(0);
  const authenticating = useRef(false);
  const refreshing = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshing.current || authenticating.current) return;
    refreshing.current = true;
    const version = ++requestVersion.current;
    try {
      const response = await fetch('/api/catalog/session', { method: 'PATCH', cache: 'no-store' });
      if (response.status === 401) {
        if (version === requestVersion.current) { setSession({ user: null, localStorage: false }); setError(''); }
        return;
      }
      const next = await readSessionResponse(response);
      if (version === requestVersion.current) {
        setSession(current => JSON.stringify(current) === JSON.stringify(next) ? current : next);
        setError('');
      }
    } catch (error) { if (version === requestVersion.current) setError(errorMessage(error)); }
    finally { refreshing.current = false; if (version === requestVersion.current) setInitialized(true); }
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

  useEffect(() => {
    if (loginOpen) dialog.current?.showModal();
    else dialog.current?.close();
  }, [loginOpen]);

  async function login(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    authenticating.current = true; ++requestVersion.current;
    setBusy(true); setLoginError('');
    try {
      const response = await fetch('/api/catalog/session', { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: fields.get('password') }) });
      setSession(await readSessionResponse(response));
      setInitialized(true); setError(''); setLoginOpen(false); form.reset();
    } catch (error) { setLoginError(errorMessage(error)); }
    finally { authenticating.current = false; setBusy(false); }
  }

  async function logout() {
    authenticating.current = true; ++requestVersion.current;
    setBusy(true);
    try {
      const response = await fetch('/api/catalog/session', { method: 'DELETE', cache: 'no-store' });
      if (!response.ok) throw new Error(z.object({ error: z.string() }).parse(await response.json()).error);
      z.object({ ok: z.literal(true) }).parse(await response.json());
      setSession({ user: null, localStorage: false }); setError(''); setInitialized(true);
    } catch (error) { setError(errorMessage(error)); }
    finally { authenticating.current = false; setBusy(false); }
  }

  return <SessionContext.Provider value={{ ...session, initialized, error, busy, refresh, logout, openLogin: () => { setLoginError(''); setLoginOpen(true); } }}>
    {children}
    <dialog className="project-login-dialog" ref={dialog} onCancel={event => { if (busy) event.preventDefault(); else setLoginOpen(false); }}>
      <form className="catalog-login" onSubmit={event => void login(event)} aria-labelledby="project-login-title">
        <h2 id="project-login-title">登录工作台</h2>
        <p>输入工作台密码即可使用商品素材库与批量效果图。登录后自动保持，连续 30 天未使用才需重新登录。</p>
        <label className="cal-field">密码<input name="password" type="password" autoComplete="current-password" required maxLength={256} /></label>
        {loginError && <div className="error-banner" role="alert">{loginError}</div>}
        <div className="catalog-upload-actions"><button className="button" type="button" disabled={busy} onClick={() => setLoginOpen(false)}>取消</button><button type="submit" className="button primary" disabled={busy}>{busy ? '正在登录…' : '登录并保持'}</button></div>
      </form>
    </dialog>
  </SessionContext.Provider>;
}

export function useProjectSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error('工作台页面缺少 ProjectSessionProvider');
  return session;
}
