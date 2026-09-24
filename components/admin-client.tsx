'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppHeader } from '@/components/app-header';

type Tenant = {
  id: string; name: string; plan: 'free' | 'pro' | 'internal'; billingMode: 'charge' | 'exempt';
  disabled: boolean; workspace: string; createdAt: string;
  styleCount: number; styleQuota: number; bytesUsed: number; storageQuotaBytes: number;
  balanceCents: number; heldCents: number; memberCount: number; spent30dCents: number;
};
type Dispute = { id: string; tenantId: string; kind: string; jobRef: string; amountCents: number; createdAt: string };

const gib = (bytes: number) => (bytes / 1024 ** 3).toFixed(2);

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), cache: 'no-store',
  });
  const parsed = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof parsed.error === 'string' ? parsed.error : `请求失败（HTTP ${response.status}）`);
  return parsed;
}

export function AdminClient() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [granting, setGranting] = useState<Tenant | null>(null);
  const [amount, setAmount] = useState('2000');
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    const response = await fetch('/api/admin/tenants', { cache: 'no-store' });
    const body = await response.json() as { tenants: Tenant[]; disputes: Dispute[]; error?: string };
    if (!response.ok) throw new Error(body.error ?? `读取失败（HTTP ${response.status}）`);
    setTenants(body.tenants); setDisputes(body.disputes); setError('');
  }, []);

  useEffect(() => {
    void (async () => {
      try { await load(); }
      catch (loadError) { setError(loadError instanceof Error ? loadError.message : String(loadError)); }
    })();
  }, [load]);

  const grant = async () => {
    if (!granting) return;
    setBusy(true);
    try {
      await postJson('/api/admin/grant', { tenantId: granting.id, amountCents: Number(amount), reason });
      setGranting(null); setReason(''); await load();
    } catch (grantError) { setError(grantError instanceof Error ? grantError.message : String(grantError)); }
    finally { setBusy(false); }
  };

  const rule = async (dispute: Dispute, decision: 'charge' | 'refund') => {
    setBusy(true);
    try {
      await postJson('/api/admin/adjudicate', { holdId: dispute.id, tenantId: dispute.tenantId, decision });
      await load();
    } catch (ruleError) { setError(ruleError instanceof Error ? ruleError.message : String(ruleError)); }
    finally { setBusy(false); }
  };

  return (
    <main>
      <AppHeader />
      <div className="admin-page">
        <h1>管理后台</h1>
        {error && <p className="login-error" role="alert">{error}</p>}

        <section className="admin-card">
          <h2>待裁定（{disputes.length}）</h2>
          <p className="muted-note">
            请求已发出但没收到确定回执。系统<b>不自动退也不自动扣</b>；请先核对供应商侧，再决定收费或退回。
          </p>
          {disputes.length === 0 ? <p className="muted-note">当前没有待裁定的冻结。</p> : (
            <table>
              <thead><tr><th>发生时间</th><th>任务</th><th>类型</th><th className="right">冻结</th><th>裁定</th></tr></thead>
              <tbody>
                {disputes.map(dispute => (
                  <tr key={dispute.id}>
                    <td>{new Date(dispute.createdAt).toLocaleString('zh-CN')}</td>
                    <td>{dispute.jobRef}</td>
                    <td>{dispute.kind}</td>
                    <td className="right">{dispute.amountCents}</td>
                    <td>
                      <button className="button" disabled={busy} onClick={() => void rule(dispute, 'charge')}>收费</button>
                      <button className="button" disabled={busy} onClick={() => void rule(dispute, 'refund')}>退回</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="admin-card">
          <h2>租户（{tenants.length}）</h2>
          <table>
            <thead>
              <tr><th>租户</th><th>套餐</th><th>款式</th><th>存储</th><th className="right">余额</th><th className="right">冻结</th><th className="right">近 30 天</th><th>操作</th></tr>
            </thead>
            <tbody>
              {tenants.map(tenant => (
                <tr key={tenant.id}>
                  <td>
                    <b>{tenant.name}</b>
                    <small>{tenant.workspace} · {tenant.memberCount} 人</small>
                  </td>
                  <td>
                    {tenant.plan === 'internal' ? '内部' : tenant.plan === 'pro' ? '付费' : '免费'}
                    {tenant.billingMode === 'exempt' && <small>免计费</small>}
                  </td>
                  <td>{tenant.styleCount} / {tenant.styleQuota}</td>
                  <td>{gib(tenant.bytesUsed)} / {gib(tenant.storageQuotaBytes)}</td>
                  <td className="right">{tenant.billingMode === 'exempt' ? '—' : tenant.balanceCents}</td>
                  <td className="right held">{tenant.heldCents || '—'}</td>
                  <td className="right">{tenant.spent30dCents}</td>
                  <td><button className="button" onClick={() => { setGranting(tenant); setAmount('2000'); }}>发放</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted-note">
            新注册账号余额为 0，任何付费动作都会被拒绝，必须在这里发放后才能使用——这是免费内测期防止被刷的主闸门。
          </p>
        </section>

        {granting && (
          <div className="admin-modal" role="dialog" aria-modal="true">
            <div>
              <h2>发放积分</h2>
              <p className="muted-note">租户 <b>{granting.name}</b> · 当前余额 {granting.balanceCents}</p>
              <label className="login-field">
                <span>发放数量（分，负数为扣减）</span>
                <input inputMode="numeric" value={amount} onChange={event => setAmount(event.target.value.replace(/[^\d-]/gu, ''))} />
              </label>
              <label className="login-field">
                <span>原因（写入流水，必填）</span>
                <input value={reason} onChange={event => setReason(event.target.value)} placeholder="例：内测额度" />
              </label>
              <div className="admin-modal-actions">
                <button className="button" onClick={() => setGranting(null)}>取消</button>
                <button className="button primary" disabled={busy || !reason.trim() || !amount} onClick={() => void grant()}>确认发放</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
