"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useProjectSession } from "./project-session";
import { APP_PAGES, HOME_PAGE } from "@/lib/app-pages";
/** One 48px row on every page; logout lives in the account menu. */
export function AppHeader({ beforeLogout }: { beforeLogout?: () => Promise<boolean> } = {}) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !accountRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [menuOpen]);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const logout = async () => {
    if (loggingOut) return;
    setLoggingOut(true); setLogoutError("");
    try {
      if (beforeLogout && !(await beforeLogout())) throw new Error("作品尚未保存成功，暂未退出。请先重试保存。");
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error("退出登录失败，请重试。");
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- Clear all account-scoped client state after revoking the session.
      window.location.assign("/login?next=" + encodeURIComponent(pathname));
    } catch (error) {
      setLogoutError(error instanceof Error ? error.message : "退出登录失败，请重试。");
      setLoggingOut(false);
    }
  };
  const session = useProjectSession();
  const [account, setAccount] = useState<{
    user: { displayName: string; email?: string; role: string };
    balance: { balanceCents: number; heldCents: number };
    tenant: { internal: boolean };
    pages: string[];
    enteredBy: { displayName: string } | null;
  } | null>(null);
  const [returning, setReturning] = useState(false);
  const returnToAdmin = async () => {
    if (returning) return;
    setReturning(true); setLogoutError("");
    try {
      if (beforeLogout && !(await beforeLogout())) throw new Error("作品尚未保存成功，暂未返回。请先重试保存。");
      const response = await fetch("/api/auth/return-admin", { method: "POST" });
      if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? "返回管理员账号失败，请重试。");
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- Reload every account-scoped client state as the administrator.
      window.location.assign("/admin");
    } catch (error) {
      setLogoutError(error instanceof Error ? error.message : "返回管理员账号失败，请重试。");
      setReturning(false);
    }
  };
  useEffect(() => {
    let alive = true;
    const read = () =>
      fetch("/api/account", { cache: "no-store" })
        .then(async (r) => {
          if (r.ok) { const next = await r.json(); if (alive) setAccount(next); }
        })
        .catch(() => {});
    void read();
    const timer = setInterval(() => {
      if (!document.hidden) void read();
    }, 15000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return (
    <header className="product-header" aria-label="工作台顶部导航">
      <Link className="product-header__brand" href={HOME_PAGE} aria-label="工作服效果图首页">
        <span className="product-header__mark">衣</span>
        <strong>工作服效果图</strong>
      </Link>
      <div className="product-header__controls">
        <nav className="product-header__nav" aria-label="主导航">
          {[
            // Until the account loads every page shows; afterwards only the ones this account holds.
            ...APP_PAGES.filter(page => !account || account.pages.includes(page.href)).map(page => [page.href, page.label]),
            ["/account", "我的账户"],
            ...(account?.user.role === "admin" ? [["/admin", "管理后台"]] : []),
          ].map(([href, label]) => (
            <Link
              key={href}
              href={href}
              aria-current={pathname === href ? "page" : undefined}
              className={[
                pathname === href ? "active" : "",
              ].join(" ")}
            >
              {label}
            </Link>
          ))}
        </nav>
        {account?.enteredBy && (
          <div className="product-header__entered" role="status">
            <span>正在以「{account.user.displayName}」的身份操作</span>
            <button type="button" disabled={returning} onClick={() => void returnToAdmin()}>{returning ? "正在返回…" : "返回管理员"}</button>
          </div>
        )}
        <div className="product-header__credit">
          <span className="product-header__muted">积分</span>
          <b>
            {account
              ? account.tenant.internal
                ? "内部免计费"
                : account.balance.balanceCents.toLocaleString()
              : "—"}
          </b>
          {account && !account.tenant.internal && (
            <span className="product-header__held">冻结 {account.balance.heldCents}</span>
          )}
        </div>
        <div className="product-header__account" ref={accountRef}>
          <button type="button" className="product-header__account-button" aria-haspopup="menu" aria-expanded={menuOpen} disabled={!session.user} onClick={() => setMenuOpen(open => !open)}>
            <span className="product-header__avatar">
              {(account?.user.displayName || session.user?.displayName)?.slice(0, 2) || "…"}
            </span>
            <span className="product-header__name">{account?.user.displayName || session.user?.displayName || "正在连接"}</span>
            <svg className="product-header__caret" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
          </button>
          {menuOpen && session.user && (
            <div className="product-header__menu" role="menu">
              {account?.user.email && <span className="product-header__menu-email">{account.user.email}</span>}
              <Link role="menuitem" href="/account" onClick={() => setMenuOpen(false)}>我的账户</Link>
              {account?.enteredBy && <button type="button" role="menuitem" disabled={returning} onClick={() => void returnToAdmin()}>返回管理员账号（{account.enteredBy.displayName}）</button>}
              <button type="button" role="menuitem" className="product-header__logout" disabled={loggingOut} onClick={() => void logout()}>{loggingOut ? "正在退出…" : "退出登录"}</button>
            </div>
          )}
        </div>
      </div>
      {logoutError && <div className="product-header__error" role="alert">{logoutError}</div>}
      {session.error && <div className="product-header__error" role="alert">{session.error}<button type="button" disabled={session.busy} onClick={() => void session.refresh()}>重试连接</button></div>}
    </header>
  );
}
