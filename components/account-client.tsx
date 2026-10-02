'use client';

import { useEffect, useState } from 'react';
import { AppHeader } from '@/components/app-header';
import { APP_PAGES } from '@/lib/app-pages';

type Account = {
  user: { displayName: string; role: string; email: string; hasPassword: boolean };
  tenant: { name: string; plan: 'free' | 'pro' | 'internal'; internal: boolean };
  balance: { balanceCents: number; heldCents: number };
  quota: { styleCount: number; styleQuota: number; bytesUsed: number; storageQuotaBytes: number };
  ledger: { kind: string; amountCents: number; balanceAfter: number; reason: string; createdAt: string }[];
  disputed: { id: string; jobRef: string; amountCents: number; confirmedCents: number; unknownCents: number; disputedAt: string }[];
};

const KIND_LABELS: Record<string, string> = {
  grant: '发放', hold: '冻结', settle: '结算', release: '退回', adjust: '调整',
};

// Ledger reasons are written for operators ("冻结：production W12/a1"); say what was done instead.
const workLabel = (kind: string, ref: string) =>
  ref.startsWith('garment:cutout:') ? '成衣去背景'
    : ref.startsWith('garment:back:') ? 'AI 背面参考'
      : ref.startsWith('garment:') ? '成衣 AI 处理'
        : kind === 'analysis' ? `理解需求 ${ref}` : `制作图稿 ${ref.split('/')[0]}`;
function plainReason(reason: string) {
  const hold = reason.match(/^冻结：(\S+) (.+)$/u);
  if (hold) return `${workLabel(hold[1], hold[2])}：开工前先冻结`;
  const settle = reason.match(/^结算：(\S+) (.+)$/u);
  if (settle) return `${workLabel(settle[1], settle[2])}：按实际用量结算，多余的退回`;
  return reason;
}

const gib = (bytes: number) => (bytes / 1024 ** 3).toFixed(2);
const yuan = (cents: number) => (cents / 100).toFixed(2);

export function AccountClient({ deniedPage }: { deniedPage?: string }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [error, setError] = useState('');
  // Sent here by a page this account has not been given.
  const denied = APP_PAGES.find(item => item.href === deniedPage)?.label ?? '';

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch('/api/account', { cache: 'no-store' });
        const body = await response.json() as Account & { error?: string };
        if (!response.ok) throw new Error(body.error ?? `读取失败（HTTP ${response.status}）`);
        setAccount(body);
      } catch (loadError) { setError(loadError instanceof Error ? loadError.message : String(loadError)); }
    })();
  }, []);

  const styleRatio = account ? Math.min(100, (account.quota.styleCount / Math.max(1, account.quota.styleQuota)) * 100) : 0;
  const bytesRatio = account ? Math.min(100, (account.quota.bytesUsed / Math.max(1, account.quota.storageQuotaBytes)) * 100) : 0;

  return (
    <main>
      <AppHeader />
      <div className="account-page">
        <h1>我的账户</h1>
        {denied && <p className="account-denied" role="alert">当前账号没有开通「{denied}」页面，如需使用请联系管理员。</p>}
        {error && <p className="login-error" role="alert">{error}</p>}
        {!account && !error && <p className="muted-note" role="status">正在读取账户…</p>}

        {account && (
          <>
            <section className="account-security"><div><h2>账号安全</h2><p>{account.user.email}</p></div><a href={account.user.hasPassword ? "/login?mode=reset" : "/login?mode=setup"}>{account.user.hasPassword ? "通过邮箱重置密码" : "设置登录密码"}</a></section>
            <section className="account-balance">
              <div>
                <span>可用积分</span>
                <b>{account.balance.balanceCents.toLocaleString('zh-CN')}</b>
                <small>≈ ¥{yuan(account.balance.balanceCents)}</small>
              </div>
              <div>
                <span>冻结中</span>
                <b className="held">{account.balance.heldCents.toLocaleString('zh-CN')}</b>
                <small>按上限冻结，跑完按实际结算</small>
              </div>
              <div>
                <span>套餐</span>
                <b className="plan">{account.tenant.plan === 'internal' ? '内部' : account.tenant.plan === 'pro' ? '付费版' : '免费版'}</b>
                <small>{account.tenant.internal ? '免计费，仅记录成本' : '积分由管理员发放'}</small>
              </div>
            </section>

            <section className="account-quota">
              <div>
                <div className="quota-head"><span>款式</span><span>{account.quota.styleCount} / {account.quota.styleQuota}</span></div>
                <div className="quota-bar"><i style={{ width: `${styleRatio}%` }} /></div>
              </div>
              <div>
                <div className="quota-head"><span>存储</span><span>{gib(account.quota.bytesUsed)} / {gib(account.quota.storageQuotaBytes)} GiB</span></div>
                <div className="quota-bar"><i style={{ width: `${bytesRatio}%` }} /></div>
              </div>
            </section>

            {account.disputed.length > 0 && (
              <section className="account-disputed">
                <h2>待裁定（{account.disputed.length}）</h2>
                <p>
                  请求已发出但没收到确定回执。系统<b>不自动退也不自动扣</b>，避免重复付费；
                  管理员核对供应商侧后会给出结论。
                </p>
                <ul>
                  {account.disputed.map(hold => (
                    <li key={hold.id}>
                      <b>{hold.jobRef}</b>
                      <span>冻结 {hold.amountCents} 积分 · 已确认 {hold.confirmedCents} · 未知 {hold.unknownCents}</span>
                      <small>{new Date(hold.disputedAt).toLocaleString('zh-CN')}</small>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="account-ledger">
              <h2>消耗明细</h2>
              {account.ledger.length === 0 ? <p className="muted-note">还没有任何消耗记录。</p> : (
                <table>
                  <thead><tr><th>时间</th><th>说明</th><th>类型</th><th className="right">积分</th><th className="right">余额</th></tr></thead>
                  <tbody>
                    {account.ledger.map((entry, index) => (
                      <tr key={`${entry.createdAt}-${index}`}>
                        <td>{new Date(entry.createdAt).toLocaleString('zh-CN')}</td>
                        <td>{plainReason(entry.reason)}</td>
                        <td>{KIND_LABELS[entry.kind] ?? entry.kind}</td>
                        <td className={`right ${entry.amountCents < 0 ? 'minus' : 'plus'}`}>
                          {entry.amountCents > 0 ? '+' : ''}{entry.amountCents}
                        </td>
                        <td className="right">{entry.balanceAfter}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="muted-note">明细只显示积分。1 积分 = ¥0.01。</p>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
