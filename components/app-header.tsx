"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useProjectSession } from "./project-session";
/** `compact` keeps editor pages to one 48px row, so the canvas gets the height. */
export function AppHeader({ beforeLogout, compact = false }: { beforeLogout?: () => Promise<boolean>; compact?: boolean } = {}) {
  const pathname = usePathname();
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
    user: { displayName: string };
    balance: { balanceCents: number; heldCents: number };
    tenant: { internal: boolean };
  } | null>(null);
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
    <header className={compact ? "product-header product-header--compact" : "product-header"} aria-label="工作台顶部导航">
      <Link className="product-header__brand" href="/products" aria-label="工作服效果图首页">
        <span className="product-header__mark">衣</span>
        <span>
          <strong>工作服效果图</strong>
          <small>批量制作台</small>
        </span>
      </Link>
      <div className="product-header__controls">
        <nav className="product-header__nav" aria-label="主导航">
          {[
            ["/products", "商品素材库"],
            ["/artwork-studio", "图稿生成"],
            ["/garment-mockup", "成衣效果图"],
            ["/batch", "批量生成"],
            ["/wps-production", "WPS 批量生成"],
            ["/account", "我的账户"],
          ].map(([href, label]) => (
            <Link
              key={href}
              href={href}
              aria-current={pathname === href ? "page" : undefined}
              className={[
                pathname === href ? "active" : "",
                href === "/wps-production" ? "wps" : "",
              ].join(" ")}
            >
              {label}
            </Link>
          ))}
        </nav>
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
        <div className="product-header__account">
          <span className="product-header__avatar">
            {(account?.user.displayName || session.user?.displayName)?.slice(0, 2) || "…"}
          </span>
          <span className="product-header__name">{account?.user.displayName || session.user?.displayName || "正在连接"}</span>
          {session.user && <button type="button" className="product-header__logout" disabled={loggingOut} onClick={() => void logout()}>{loggingOut ? "正在退出…" : "退出登录"}</button>}
        </div>
      </div>
      {logoutError && <div className="product-header__error" role="alert">{logoutError}</div>}
      {session.error && <div className="product-header__error" role="alert">{session.error}<button type="button" disabled={session.busy} onClick={() => void session.refresh()}>重试连接</button></div>}
    </header>
  );
}
