'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppHeader } from '@/components/app-header';
import { PageHeader, PageTabs } from '@/components/page-header';
import { APP_PAGES } from '@/lib/app-pages';
import { sizeText, storageLevel, UNLIMITED_BYTES } from '@/lib/storage-status';

type Role = 'admin' | 'editor' | 'viewer';
type Account = {
  id: string; displayName: string; email: string; identities: { kind: string; identifier: string }[];
  role: Role; disabled: boolean; createdAt: string; lastLoginAt: string | null;
  note: string; allowedPages: string[] | null; pages: string[];
  tenant: { id: string; name: string; internal: boolean; exempt: boolean; members: number };
  balanceCents: number; heldCents: number; spentCents: number; spendByPage: Record<string, number>;
  dailyCapCents: number | null;
  storage: { bytesUsed: number; storageQuotaBytes: number };
  artworkRoute: 'cliproxy' | 'evolink' | null;
};
type Price = { action: string; costMicroCents: number; multiplierMilli: number; effectiveFrom: string; uses30d: number };
type Dispute = { id: string; tenantId: string; kind: string; jobRef: string; amountCents: number; createdAt: string };
type Detail = {
  charges: { id: string; page: string; jobRef: string; state: string; exempt: boolean; heldCents: number; settledCents: number | null; createdAt: string }[];
  adjustments: { amountCents: number; balanceAfter: number; reason: string; operator: string | null; createdAt: string }[];
};

const TABS = [['spend', '账号明细'], ['access', '权限'], ['users', '用户管理'], ['prices', '价目表'], ['disputes', '待裁定']] as const;
type Tab = (typeof TABS)[number][0];
const RANGES = [['7d', '近 7 天'], ['30d', '近 30 天'], ['month', '本月'], ['all', '全部']] as const;
type Range = (typeof RANGES)[number][0];
const ROLES: [Role, string][] = [['admin', '管理员'], ['editor', '普通'], ['viewer', '只看']];
// 图稿生成's 出图通道 per account: '' leaves both on the page for the account to pick.
const ARTWORK_ROUTES = [['', '两个都给，自己选'], ['cliproxy', '只用新通道'], ['evolink', '只用原通道']] as const;
// Pages that can carry a charge; the rest never spend credits.
const SPEND_PAGES = [['/artwork-studio', '图稿生成'], ['/listing-images', '电商主图'], ['/garment-mockup', '成衣效果图（已下线）'], ['/batch', '批量生成（已下线）'], ['other', '其他']] as const;
// Columns for retired pages only show while the chosen period still has charges from them.
const RETIRED_SPEND = new Set<string>(['/garment-mockup', '/batch']);
const PAGE_LABEL: Record<string, string> = Object.fromEntries([...APP_PAGES.map(page => [page.href, page.label]), ['other', '其他']]);
// What each billed action is, where it happens and who supplies it.
const ACTIONS: { action: string; label: string; where: string; supplier: string; free?: boolean }[] = [
  { action: 'analyze', label: '理解需求', where: '批量生成 / 图稿生成', supplier: 'EvoLink gpt-6-sol' },
  { action: 'generate', label: '生成图稿', where: '批量生成 / 图稿生成', supplier: 'EvoLink Sunburst' },
  { action: 'enhance', label: '增强', where: '批量生成 / 图稿生成', supplier: 'MediaKit' },
  { action: 'cutout', label: '抠图·精细', where: '批量 / 图稿；成衣“图形”模式', supplier: '美图' },
  { action: 'cutout_standard', label: '抠图·标准', where: '成衣效果图', supplier: '火山显著性分割' },
  { action: 'back_reference', label: 'AI 背面参考', where: '成衣效果图', supplier: '火山 Seedream' },
  { action: 'recognize', label: '素材库识别', where: '商品素材库', supplier: '豆包 Seed Lite', free: true },
  { action: 'listing_plan', label: '读商品与策划（起步价，每张图另加 ¥0.0075 成本）', where: '电商主图', supplier: 'EvoLink gpt-6.1-sol' },
  { action: 'listing_image', label: '出一张图', where: '电商主图', supplier: 'EvoLink Sunburst' },
  { action: 'listing_image_multi', label: '出一张多色图', where: '电商主图', supplier: 'EvoLink Sunburst' },
  { action: 'listing_layout', label: '学一个新版式', where: '电商主图', supplier: 'EvoLink gpt-6.1-sol + Sunburst' },
];
const STATE_LABEL: Record<string, string> = { held: '冻结中', settled: '已扣', released: '已退回', disputed: '待裁定' };

const credits = (cents: number) => cents.toLocaleString('zh-CN');
const yuan = (cents: number) => `¥${(cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (value: string | null) => (value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—');
const loginName = (account: Account) =>
  account.identities.find(identity => identity.kind === 'phone')?.identifier
  ?? account.identities.find(identity => identity.kind === 'email')?.identifier ?? account.email;

function rangeStart(range: Range) {
  const now = new Date();
  if (range === '7d') return new Date(now.getTime() - 7 * 864e5);
  if (range === '30d') return new Date(now.getTime() - 30 * 864e5);
  if (range === 'month') return new Date(now.getFullYear(), now.getMonth(), 1);
  return new Date('2020-01-01T00:00:00Z');
}

type QueueStatus = { queued: number; running: number; oldestQueuedMinutes: number | null; externalWorkerSeenSecondsAgo: number | null; stuck: boolean };

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
  const [tab, setTab] = useState<Tab>('spend');
  const [range, setRange] = useState<Range>('30d');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [self, setSelf] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState<'all' | 'active' | 'disabled'>('all');
  const [spending, setSpending] = useState<'all' | 'spent' | 'none'>('all');
  const [setting, setSetting] = useState<Account | null>(null);
  const [sizing, setSizing] = useState<Account | null>(null);
  const [viewing, setViewing] = useState<{ account: Account; detail: Detail | null } | null>(null);
  const [prices, setPrices] = useState<Price[]>([]);
  const [costs, setCosts] = useState<Record<string, string>>({});
  const [multiplier, setMultiplier] = useState('2');
  const [queue, setQueue] = useState<QueueStatus | null>(null);

  const load = useCallback(async () => {
    const query = new URLSearchParams({ from: rangeStart(range).toISOString(), to: new Date().toISOString() });
    const response = await fetch(`/api/admin/accounts?${query}`, { cache: 'no-store' });
    const body = await response.json() as { self: string; accounts: Account[]; disputes: Dispute[]; error?: string };
    if (!response.ok) throw new Error(body.error ?? `读取失败（HTTP ${response.status}）`);
    setAccounts(body.accounts); setDisputes(body.disputes); setSelf(body.self); setError('');
    const priced = await fetch('/api/admin/prices', { cache: 'no-store' });
    const list = await priced.json() as { prices: Price[]; error?: string };
    if (!priced.ok) throw new Error(list.error ?? `读取价目表失败（HTTP ${priced.status}）`);
    setPrices(list.prices);
    // Edit in yuan; stored as micro-cents (¥1 = 100 000).
    setCosts(Object.fromEntries(list.prices.map(price => [price.action, String(price.costMicroCents / 100_000)])));
    setMultiplier(String((list.prices[0]?.multiplierMilli ?? 2000) / 1000));
  }, [range]);

  useEffect(() => {
    void (async () => {
      try { await load(); }
      catch (loadError) { setError(loadError instanceof Error ? loadError.message : String(loadError)); }
    })();
  }, [load]);

  // Customers' queue, refreshed every minute; a failed read leaves the rest of the page alone.
  useEffect(() => {
    const read = () => fetch('/api/admin/queue', { cache: 'no-store' })
      .then(response => response.ok ? response.json() as Promise<QueueStatus> : null).then(setQueue, () => setQueue(null));
    void read();
    const timer = setInterval(read, 60_000);
    return () => clearInterval(timer);
  }, []);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try { await action(); await load(); }
    catch (actionError) { setError(actionError instanceof Error ? actionError.message : String(actionError)); }
    finally { setBusy(false); }
  };

  const update = (account: Account, patch: Record<string, unknown>) =>
    run(() => postJson(`/api/admin/accounts/${account.id}`, patch));

  const shown = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    return accounts.filter(account =>
      (status === 'all' || (status === 'disabled') === account.disabled)
      && (spending === 'all' || (spending === 'spent') === account.spentCents > 0)
      && (!needle || [account.displayName, account.email, account.note, account.tenant.name, ...account.identities.map(identity => identity.identifier)]
        .some(text => text.toLowerCase().includes(needle))));
  }, [accounts, keyword, status, spending]);

  const openDetail = async (account: Account) => {
    setViewing({ account, detail: null });
    try {
      const response = await fetch(`/api/admin/accounts/${account.id}`, { cache: 'no-store' });
      const body = await response.json() as Detail & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `读取失败（HTTP ${response.status}）`);
      setViewing({ account, detail: body });
    } catch (detailError) {
      setViewing(null);
      setError(detailError instanceof Error ? detailError.message : String(detailError));
    }
  };

  // The browser becomes that account until "返回管理员" in the header; a full load drops admin state.
  // Not through run(): reloading the admin lists after the switch would already be refused.
  const enter = async (account: Account) => {
    setBusy(true);
    try {
      await postJson(`/api/admin/accounts/${account.id}/enter`, {});
      window.location.assign(account.pages[0] ?? '/account');
    } catch (enterError) {
      setError(enterError instanceof Error ? enterError.message : String(enterError));
      setBusy(false);
    }
  };
  const enterButton = (account: Account) => account.id !== self && !account.disabled && (
    <button className="button admin-enter" disabled={busy} title="以这个账号的身份打开工作台，看它生成过什么；页头可随时返回管理员" onClick={() => void enter(account)}>进入账号</button>
  );

  const togglePage = (account: Account, href: string) => {
    const next = account.pages.includes(href) ? account.pages.filter(page => page !== href) : [...account.pages, href];
    void update(account, { allowedPages: next });
  };

  const total = shown.reduce((sum, account) => sum + account.spentCents, 0);
  const spendColumns = SPEND_PAGES.filter(([key]) => !RETIRED_SPEND.has(key) || shown.some(account => account.spendByPage[key]));

  return (
    <main>
      <AppHeader />
      <div className="page-frame admin-page">
        <PageHeader title="管理后台" description="账号与积分、页面权限、价目表，以及需要人工裁定的扣费。">
          <PageTabs label="管理后台" value={tab} onChange={setTab}
            tabs={TABS.map(([key, label]) => [key, key === 'disputes' && disputes.length > 0 ? <>{label}<span className="admin-badge">{disputes.length}</span></> : label] as const)} />
        </PageHeader>
        {error && <p className="login-error" role="alert">{error}</p>}
        {queue && (
          <p className={queue.stuck ? 'admin-queue stuck' : 'admin-queue'} role={queue.stuck ? 'alert' : undefined}>
            客户任务队列：{queue.stuck ? `有 ${queue.queued} 个任务排队 ${queue.oldestQueuedMinutes} 分钟没人处理`
              : queue.queued || queue.running ? `处理中 ${queue.running} 个，排队 ${queue.queued} 个` : '空闲'}
            {(queue.externalWorkerSeenSecondsAgo ?? Infinity) > 60 ? '；外部 worker 没有心跳' : ''}
          </p>
        )}

        {tab !== 'disputes' && tab !== 'prices' && (
          <div className="admin-filters">
            <input type="search" placeholder="搜索名字、手机号、邮箱或备注" value={keyword} onChange={event => setKeyword(event.target.value)} />
            <select value={status} onChange={event => setStatus(event.target.value as typeof status)} aria-label="状态">
              <option value="all">全部状态</option><option value="active">正常</option><option value="disabled">已停用</option>
            </select>
            <select value={spending} onChange={event => setSpending(event.target.value as typeof spending)} aria-label="花费">
              <option value="all">全部账号</option><option value="spent">有花费</option><option value="none">没有花费</option>
            </select>
            {tab === 'spend' && (
              <select value={range} onChange={event => setRange(event.target.value as Range)} aria-label="时间范围">
                {RANGES.map(([key, label]) => <option key={key} value={key}>花费统计：{label}</option>)}
              </select>
            )}
            <span className="muted-note">共 {shown.length} 个账号</span>
          </div>
        )}

        {tab === 'spend' && (
          <section className="admin-card">
            <h2>每个账号花了多少（{RANGES.find(([key]) => key === range)?.[1]}，合计 {credits(total)} 积分 ≈ {yuan(total)}）</h2>
            <p className="muted-note">1 积分 = ¥0.01。只统计已经实际扣掉的积分；冻结中的还没结算。</p>
            <table>
              <thead>
                <tr>
                  <th>账号</th><th className="right">余额</th><th className="right">冻结</th><th className="right">存储</th><th className="right">花费</th>
                  {spendColumns.map(([key, label]) => <th key={key} className="right">{label}</th>)}
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {shown.map(account => (
                  <tr key={account.id}>
                    <td>
                      <b>{account.displayName}</b>
                      <small>{loginName(account)}{account.note && ` · ${account.note}`}</small>
                    </td>
                    <td className="right">
                      {account.tenant.exempt ? '内部免计费' : <>{credits(account.balanceCents)}<small>{yuan(account.balanceCents)}</small><small>每日上限 {account.dailyCapCents === null ? '不限' : credits(account.dailyCapCents)}</small></>}
                    </td>
                    <td className="right held">{account.heldCents ? credits(account.heldCents) : '—'}</td>
                    <td className="right">
                      {account.storage.storageQuotaBytes >= UNLIMITED_BYTES ? <>{sizeText(account.storage.bytesUsed)}<small>不限</small></>
                        : <><span className={`admin-storage ${storageLevel(account.storage)}`}>{sizeText(account.storage.bytesUsed)}</span><small>共 {sizeText(account.storage.storageQuotaBytes)}</small></>}
                    </td>
                    <td className="right"><b>{credits(account.spentCents)}</b><small>{yuan(account.spentCents)}</small></td>
                    {spendColumns.map(([key]) => <td key={key} className="right">{account.spendByPage[key] ? credits(account.spendByPage[key]) : '—'}</td>)}
                    <td className="nowrap">
                      {!account.tenant.exempt && <button className="button" disabled={busy} onClick={() => setSetting(account)}>设置积分</button>}
                      {account.storage.storageQuotaBytes < UNLIMITED_BYTES && <button className="button" disabled={busy} onClick={() => setSizing(account)}>设置空间</button>}
                      <button className="button" onClick={() => void openDetail(account)}>明细</button>
                      {enterButton(account)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {tab === 'access' && (
          <section className="admin-card">
            <h2>每个账号能看到哪些页面</h2>
            <p className="muted-note">勾选后立即生效。新注册账号默认全部开通（WPS 只给内部账号）；管理员始终全部可见。“我的账户”所有人都能进。图稿通道：选了“只用”某个通道，这个账号的图稿生成页就不再显示通道切换，出图都走它。</p>
            <table>
              <thead>
                <tr><th>账号</th><th>角色</th>{APP_PAGES.map(page => <th key={page.href} className="center">{page.label}</th>)}<th>图稿通道</th><th /></tr>
              </thead>
              <tbody>
                {shown.map(account => (
                  <tr key={account.id}>
                    <td><b>{account.displayName}</b><small>{loginName(account)}</small></td>
                    <td>
                      <select value={account.role} disabled={busy || account.id === self} onChange={event => void update(account, { role: event.target.value })}>
                        {ROLES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                      </select>
                    </td>
                    {APP_PAGES.map(page => (
                      <td key={page.href} className="center">
                        <input type="checkbox" aria-label={`${account.displayName} ${page.label}`}
                          checked={account.pages.includes(page.href)} disabled={busy || account.role === 'admin'}
                          onChange={() => togglePage(account, page.href)} />
                      </td>
                    ))}
                    <td>
                      <select aria-label={`${account.displayName} 图稿通道`} value={account.artworkRoute ?? ''} disabled={busy}
                        onChange={event => void update(account, { artworkRoute: event.target.value || null })}>
                        {ARTWORK_ROUTES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                      </select>
                    </td>
                    <td className="nowrap">
                      {account.allowedPages !== null && account.role !== 'admin' && (
                        <button className="button" disabled={busy} onClick={() => void update(account, { allowedPages: null })}>恢复默认</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {tab === 'users' && (
          <section className="admin-card">
            <h2>所有注册用户</h2>
            <p className="muted-note">备注只有管理员能看到，输入后点别处自动保存。停用后该账号会立即被退出登录。</p>
            <table>
              <thead>
                <tr><th>账号</th><th>登录方式</th><th>注册时间</th><th>最近登录</th><th>状态</th><th>备注</th><th /></tr>
              </thead>
              <tbody>
                {shown.map(account => (
                  <tr key={account.id}>
                    <td>
                      <b>{account.displayName}</b>
                      <small>{account.tenant.internal ? '内部工作区' : account.tenant.name}{account.tenant.members > 1 && ` · ${account.tenant.members} 人共用钱包`}</small>
                    </td>
                    <td>{account.identities.map(identity => (
                      <small key={identity.kind + identity.identifier}>{identity.kind === 'phone' ? '手机' : identity.kind === 'email' ? '邮箱' : identity.kind} {identity.identifier}</small>
                    ))}</td>
                    <td className="nowrap">{when(account.createdAt)}</td>
                    <td className="nowrap">{when(account.lastLoginAt)}</td>
                    <td>{account.disabled ? <span className="admin-status off">已停用</span> : <span className="admin-status">正常</span>}</td>
                    <td>
                      <input className="admin-note" key={account.note} defaultValue={account.note} maxLength={500} placeholder="添加备注"
                        onBlur={event => { if (event.target.value.trim() !== account.note) void update(account, { note: event.target.value }); }} />
                    </td>
                    <td className="nowrap">
                      {enterButton(account)}
                      {account.id !== self && (
                        <button className="button" disabled={busy} onClick={() => {
                          if (account.disabled || window.confirm(`确定停用「${account.displayName}」？对方会立即被退出登录。`)) void update(account, { disabled: !account.disabled });
                        }}>{account.disabled ? '启用' : '停用'}</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {tab === 'prices' && (
          <section className="admin-card">
            <h2>价目表</h2>
            <p className="muted-note">
              用户价 = 真实成本 × 倍率，1 积分 = ¥0.01。保存后立即生效，只影响之后开工的任务；已经冻结的任务按开工时的价格结算，历史账不变。
            </p>
            <div className="admin-filters">
              <label className="admin-inline">统一倍率 ×
                <input inputMode="decimal" value={multiplier} onChange={event => setMultiplier(event.target.value.replace(/[^\d.]/gu, ''))} />
              </label>
            </div>
            <table>
              <thead>
                <tr><th>动作</th><th>在哪个页面</th><th>供应商</th><th className="right">真实成本（元）</th><th className="right">用户价（积分）</th><th className="right">近 30 天次数</th><th>当前价格生效于</th></tr>
              </thead>
              <tbody>
                {ACTIONS.map(item => {
                  const current = prices.find(price => price.action === item.action);
                  const cost = Number(costs[item.action]);
                  const userCredits = Number.isFinite(cost) ? Math.round(cost * Number(multiplier) * 1000) / 10 : NaN;
                  return (
                    <tr key={item.action}>
                      <td><b>{item.label}</b>{item.free && <small>目前不向用户收费</small>}</td>
                      <td>{item.where}</td>
                      <td>{item.supplier}</td>
                      <td className="right">
                        <input className="admin-cost" inputMode="decimal" value={costs[item.action] ?? ''}
                          onChange={event => setCosts(previous => ({ ...previous, [item.action]: event.target.value.replace(/[^\d.]/gu, '') }))} />
                      </td>
                      <td className="right"><b>{Number.isFinite(userCredits) ? userCredits : '—'}</b></td>
                      <td className="right">{current?.uses30d ?? 0}</td>
                      <td className="nowrap">{when(current?.effectiveFrom ?? null)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="admin-modal-actions">
              <button className="button primary" disabled={busy || !(Number(multiplier) >= 1 && Number(multiplier) <= 10)
                || ACTIONS.some(item => !(Number(costs[item.action]) >= 0) || costs[item.action] === '')}
                onClick={() => {
                  if (!window.confirm(`按 × ${multiplier} 保存新价格？立即对之后开工的任务生效。`)) return;
                  void run(() => postJson('/api/admin/prices', {
                    multiplierMilli: Math.round(Number(multiplier) * 1000),
                    costs: Object.fromEntries(ACTIONS.map(item => [item.action, Math.round(Number(costs[item.action]) * 100_000)])),
                  }));
                }}>保存为新价格</button>
            </div>
          </section>
        )}

        {tab === 'disputes' && (
          <section className="admin-card">
            <h2>待裁定（{disputes.length}）</h2>
            <p className="muted-note">
              请求已发出但没收到确定回执。系统<b>不自动退也不自动扣</b>；请先核对供应商侧，再决定收费或退回。
            </p>
            {disputes.length === 0 ? <p className="muted-note">当前没有待裁定的冻结。</p> : (
              <table>
                <thead><tr><th>发生时间</th><th>账号</th><th>任务</th><th>类型</th><th className="right">冻结</th><th>裁定</th></tr></thead>
                <tbody>
                  {disputes.map(dispute => (
                    <tr key={dispute.id}>
                      <td>{when(dispute.createdAt)}</td>
                      <td>{accounts.filter(account => account.tenant.id === dispute.tenantId).map(account => account.displayName).join('、') || '—'}</td>
                      <td>{dispute.jobRef}</td>
                      <td>{dispute.kind}</td>
                      <td className="right">{dispute.amountCents}</td>
                      <td>
                        <button className="button" disabled={busy} onClick={() => void run(() => postJson('/api/admin/adjudicate', { holdId: dispute.id, tenantId: dispute.tenantId, decision: 'charge' }))}>收费</button>
                        <button className="button" disabled={busy} onClick={() => void run(() => postJson('/api/admin/adjudicate', { holdId: dispute.id, tenantId: dispute.tenantId, decision: 'refund' }))}>退回</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        )}

        {setting && (
          <SetBalance account={setting} busy={busy} onClose={() => setSetting(null)}
            onSubmit={(balanceCents, reason, dailyCapCents) => run(async () => {
              if (balanceCents !== setting.balanceCents) await postJson('/api/admin/balance', { tenantId: setting.tenant.id, balanceCents, reason });
              if (dailyCapCents !== setting.dailyCapCents) await postJson(`/api/admin/accounts/${setting.id}`, { dailyCapCents });
              setSetting(null);
            })} />
        )}

        {sizing && (
          <SetStorage account={sizing} busy={busy} onClose={() => setSizing(null)}
            onSubmit={storageQuotaBytes => run(async () => {
              await postJson(`/api/admin/accounts/${sizing.id}`, { storageQuotaBytes });
              setSizing(null);
            })} />
        )}

        {viewing && (
          <div className="admin-modal" role="dialog" aria-modal="true" onClick={event => { if (event.target === event.currentTarget) setViewing(null); }}>
            <div className="admin-modal-wide">
              <h2>{viewing.account.displayName} 的积分明细</h2>
              {!viewing.detail ? <p className="muted-note">正在读取…</p> : (
                <>
                  <h3>人工调整</h3>
                  {viewing.detail.adjustments.length === 0 ? <p className="muted-note">没有人工调整记录。</p> : (
                    <table>
                      <thead><tr><th>时间</th><th className="right">变动</th><th className="right">调整后</th><th>原因</th><th>操作人</th></tr></thead>
                      <tbody>{viewing.detail.adjustments.map(item => (
                        <tr key={item.createdAt + item.amountCents}>
                          <td className="nowrap">{when(item.createdAt)}</td>
                          <td className="right">{item.amountCents > 0 ? '+' : ''}{credits(item.amountCents)}</td>
                          <td className="right">{credits(item.balanceAfter)}</td>
                          <td>{item.reason}</td><td>{item.operator ?? '—'}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                  )}
                  <h3>使用扣费（最近 200 笔）</h3>
                  {viewing.detail.charges.length === 0 ? <p className="muted-note">还没有扣费记录。</p> : (
                    <table>
                      <thead><tr><th>时间</th><th>页面</th><th>任务</th><th>状态</th><th className="right">实扣</th></tr></thead>
                      <tbody>{viewing.detail.charges.map(charge => (
                        <tr key={charge.id}>
                          <td className="nowrap">{when(charge.createdAt)}</td>
                          <td>{PAGE_LABEL[charge.page] ?? charge.page}</td>
                          <td><small>{charge.jobRef}</small></td>
                          <td>{charge.exempt ? '免计费' : STATE_LABEL[charge.state] ?? charge.state}</td>
                          <td className="right">{charge.exempt ? '—' : charge.settledCents ?? `冻结 ${charge.heldCents}`}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                  )}
                </>
              )}
              <div className="admin-modal-actions"><button className="button" onClick={() => setViewing(null)}>关闭</button></div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

// Storage is set in GB (1 GB = 1024³ bytes, as the 存储空间 page counts).
function SetStorage({ account, busy, onClose, onSubmit }: {
  account: Account; busy: boolean; onClose: () => void; onSubmit: (storageQuotaBytes: number) => Promise<void>;
}) {
  const [value, setValue] = useState(String(Math.round(account.storage.storageQuotaBytes / 1024 ** 3 * 10) / 10));
  const number = Number(value);
  const bytes = value.trim() && Number.isFinite(number) && number >= 0.1 && number <= 10240 ? Math.round(number * 1024 ** 3) : null;
  return (
    <div className="admin-modal" role="dialog" aria-modal="true">
      <div>
        <h2>设置存储空间</h2>
        <p className="muted-note">
          <b>{account.displayName}</b> 已用 {sizeText(account.storage.bytesUsed)}，现在共 {sizeText(account.storage.storageQuotaBytes)}
          {account.tenant.members > 1 && `。注意：这份空间由 ${account.tenant.members} 人共用`}
        </p>
        <label className="login-field">
          <span>空间改为（GB）</span>
          <input inputMode="decimal" value={value} onChange={event => setValue(event.target.value.replace(/[^\d.]/gu, ''))} />
        </label>
        <p className="muted-note">
          {bytes === null ? '填 0.1 到 10240 之间的数。'
            : bytes < account.storage.bytesUsed ? `比已用的 ${sizeText(account.storage.bytesUsed)} 还小：改完后这个账号传不了新图、出不了新图，直到删掉一些。`
              : `改完马上生效，还剩 ${sizeText(bytes - account.storage.bytesUsed)} 可用。`}
        </p>
        <div className="admin-modal-actions">
          <button className="button" onClick={onClose}>取消</button>
          <button className="button primary" disabled={busy || bytes === null || bytes === account.storage.storageQuotaBytes} onClick={() => void onSubmit(bytes!)}>确认</button>
        </div>
      </div>
    </div>
  );
}

function SetBalance({ account, busy, onClose, onSubmit }: {
  account: Account; busy: boolean; onClose: () => void; onSubmit: (balanceCents: number, reason: string, dailyCapCents: number | null) => Promise<void>;
}) {
  const [cap, setCap] = useState(account.dailyCapCents === null ? '' : String(account.dailyCapCents));
  const capCents = cap.trim() ? Number(cap) : null;
  const capChanged = capCents !== account.dailyCapCents;
  const [unit, setUnit] = useState<'yuan' | 'credits'>('yuan');
  const [value, setValue] = useState('50');
  const [reason, setReason] = useState('测试额度');
  const number = Number(value);
  const target = value.trim() && Number.isFinite(number) && number >= 0 ? Math.round(unit === 'yuan' ? number * 100 : number) : null;
  const delta = target === null ? 0 : target - account.balanceCents;
  return (
    <div className="admin-modal" role="dialog" aria-modal="true">
      <div>
        <h2>设置积分</h2>
        <p className="muted-note">
          <b>{account.displayName}</b> 当前余额 {credits(account.balanceCents)} 积分（{yuan(account.balanceCents)}）
          {account.heldCents > 0 && `，另有 ${credits(account.heldCents)} 积分冻结中，不受影响`}
          {account.tenant.members > 1 && `。注意：该钱包由 ${account.tenant.members} 人共用`}
        </p>
        <div className="admin-unit" role="radiogroup">
          <button type="button" className={unit === 'yuan' ? 'active' : ''} onClick={() => setUnit('yuan')}>按金额（元）</button>
          <button type="button" className={unit === 'credits' ? 'active' : ''} onClick={() => setUnit('credits')}>按积分</button>
        </div>
        <label className="login-field">
          <span>余额改为</span>
          <input inputMode="decimal" value={value} onChange={event => setValue(event.target.value.replace(unit === 'yuan' ? /[^\d.]/gu : /\D/gu, ''))} />
        </label>
        {target !== null && (
          <p className="muted-note">
            = <b>{credits(target)} 积分</b>（{yuan(target)}）。
            {delta === 0 ? '和现在一样。' : `相当于${delta > 0 ? '增加' : '减少'} ${credits(Math.abs(delta))} 积分。`}
          </p>
        )}
        <label className="login-field">
          <span>原因（写入流水）</span>
          <input value={reason} onChange={event => setReason(event.target.value)} />
        </label>
        <label className="login-field">
          <span>每日消费上限（积分，留空 = 不限）</span>
          <input inputMode="numeric" value={cap} placeholder="不限" onChange={event => setCap(event.target.value.replace(/\D/gu, ''))} />
        </label>
        <p className="muted-note">按北京时间每天 0 点重置。{capCents !== null && `${credits(capCents)} 积分 ≈ ${yuan(capCents)}/天。`}</p>
        <div className="admin-modal-actions">
          <button className="button" onClick={onClose}>取消</button>
          <button className="button primary" disabled={busy || target === null || (delta === 0 && !capChanged) || (delta !== 0 && !reason.trim())} onClick={() => void onSubmit(target!, reason, capCents)}>确认</button>
        </div>
      </div>
    </div>
  );
}
