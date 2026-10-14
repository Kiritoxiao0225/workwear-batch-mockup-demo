import { gunzipSync } from 'node:zlib';
import { pagesFor, type AppPage } from '@/lib/app-pages';
import { CatalogHttpError, INTERNAL_TENANT_ID } from './catalog-auth';
import { catalogDatabase, catalogTransaction } from './catalog-database';

/**
 * Where a charge came from. 成衣效果图 and 批量生成 moved to the offline app but their past charges
 * still count. 'other' covers holds whose origin can no longer be told.
 */
export type SpendPage = AppPage | '/garment-mockup' | '/batch' | 'other';

type Row = Record<string, unknown>;

/**
 * Requirement → page. Batch and artwork-studio share one queue; the requirement itself
 * remembers which page created it, so old charges can be attributed without a schema change.
 */
async function caseEntries(workspaces: string[]) {
  const entries = new Map<string, Map<string, string>>();
  if (!workspaces.length) return entries;
  const rows = await catalogDatabase().query(
    `SELECT workspace, content_json, content_gzip FROM batch_documents WHERE path='manifest.json' AND workspace = ANY($1)`,
    [workspaces]);
  for (const row of rows.rows) {
    const manifest = (row.content_gzip ? JSON.parse(gunzipSync(row.content_gzip as Buffer).toString('utf8')) : row.content_json) as
      { cases?: { caseId?: string; entry?: string }[] } | null;
    entries.set(row.workspace as string, new Map((manifest?.cases ?? []).map(item => [String(item.caseId), item.entry ?? 'batch'])));
  }
  return entries;
}

function pageOf(kind: string, jobRef: string, entries: Map<string, string> | undefined): SpendPage {
  if (jobRef.startsWith('garment:')) return '/garment-mockup';
  if (jobRef.startsWith('listing:')) return '/listing-images';
  if (kind === 'analysis' || kind === 'production') {
    return entries?.get(jobRef.split('/')[0]) === 'studio' ? '/artwork-studio' : '/batch';
  }
  return 'other';
}

const iso = (value: unknown) => (value ? (value as Date).toISOString() : null);

export async function listAccounts(range: { from: Date; to: Date }) {
  const [users, spend] = await Promise.all([
    catalogDatabase().query(
      `SELECT u.id, u.email, u.display_name, u.role, u.disabled, u.created_at, u.admin_note, u.allowed_pages,
              u.tenant_id, t.name AS tenant_name, t.workspace, t.billing_mode, t.disabled AS tenant_disabled, t.daily_spend_cap_cents,
              c.balance_cents, c.held_cents,
              (SELECT count(*)::int FROM users x WHERE x.tenant_id = u.tenant_id) AS members,
              (SELECT max(s.created_at) FROM sessions s WHERE s.user_id = u.id) AS last_login,
              (SELECT coalesce(json_agg(json_build_object('kind', i.kind, 'identifier', i.identifier) ORDER BY i.created_at), '[]'::json)
                 FROM user_identities i WHERE i.user_id = u.id) AS identities
         FROM users u JOIN tenants t ON t.id = u.tenant_id
         LEFT JOIN credit_accounts c ON c.tenant_id = u.tenant_id
        ORDER BY u.created_at DESC`),
    catalogDatabase().query(
      `SELECT h.tenant_id, t.workspace, h.kind, h.job_ref, h.settled_cents
         FROM credit_holds h JOIN tenants t ON t.id = h.tenant_id
        WHERE h.state = 'settled' AND h.billing_mode = 'charge' AND h.resolved_at >= $1 AND h.resolved_at < $2`,
      [range.from, range.to]),
  ]);

  const entries = await caseEntries([...new Set(spend.rows.filter(row => !/^(garment|listing):/.test(String(row.job_ref))).map(row => row.workspace as string))]);
  const byTenant = new Map<string, Partial<Record<SpendPage, number>>>();
  for (const row of spend.rows) {
    const page = pageOf(row.kind as string, row.job_ref as string, entries.get(row.workspace as string));
    const pages = byTenant.get(row.tenant_id as string) ?? {};
    pages[page] = (pages[page] ?? 0) + Number(row.settled_cents);
    byTenant.set(row.tenant_id as string, pages);
  }

  return users.rows.map(row => {
    const internal = row.tenant_id === INTERNAL_TENANT_ID;
    const spendByPage = byTenant.get(row.tenant_id as string) ?? {};
    return {
      id: row.id as string,
      displayName: row.display_name as string,
      email: row.email as string,
      identities: row.identities as { kind: string; identifier: string }[],
      role: row.role as 'admin' | 'editor' | 'viewer',
      disabled: Boolean(row.disabled) || Boolean(row.tenant_disabled),
      createdAt: iso(row.created_at),
      lastLoginAt: iso(row.last_login),
      note: row.admin_note as string,
      allowedPages: row.allowed_pages as string[] | null,
      pages: pagesFor({ role: row.role as string, internal, allowed: row.allowed_pages as string[] | null }),
      tenant: {
        id: row.tenant_id as string, name: row.tenant_name as string, internal,
        exempt: row.billing_mode === 'exempt', members: Number(row.members),
      },
      dailyCapCents: row.daily_spend_cap_cents === null ? null : Number(row.daily_spend_cap_cents),
      balanceCents: Number(row.balance_cents ?? 0),
      heldCents: Number(row.held_cents ?? 0),
      spentCents: Object.values(spendByPage).reduce((sum, cents) => sum + (cents ?? 0), 0),
      spendByPage,
    };
  });
}

/** One account's recent charges and every manual balance change, newest first. */
export async function accountDetail(userId: string) {
  const user = await catalogDatabase().query(
    'SELECT u.tenant_id, t.workspace FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1', [userId]);
  if (!user.rowCount) throw new CatalogHttpError(404, '账号不存在');
  const { tenant_id: tenantId, workspace } = user.rows[0] as { tenant_id: string; workspace: string };
  const [holds, adjustments, entries] = await Promise.all([
    catalogDatabase().query(
      `SELECT id, kind, job_ref, state, billing_mode, amount_cents, settled_cents, created_at, resolved_at
         FROM credit_holds WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 200`, [tenantId]),
    catalogDatabase().query(
      `SELECT l.kind, l.amount_cents, l.balance_after, l.reason, l.created_at, o.display_name AS operator
         FROM credit_ledger l LEFT JOIN users o ON o.id = l.operator_id
        WHERE l.tenant_id = $1 AND l.kind IN ('grant', 'adjust') ORDER BY l.created_at DESC LIMIT 100`, [tenantId]),
    caseEntries([workspace]),
  ]);
  return {
    charges: holds.rows.map((row: Row) => ({
      id: row.id as string,
      page: pageOf(row.kind as string, row.job_ref as string, entries.get(workspace)),
      jobRef: row.job_ref as string,
      state: row.state as 'held' | 'settled' | 'released' | 'disputed',
      exempt: row.billing_mode === 'exempt',
      heldCents: Number(row.amount_cents),
      settledCents: row.settled_cents === null ? null : Number(row.settled_cents),
      createdAt: iso(row.created_at),
    })),
    adjustments: adjustments.rows.map((row: Row) => ({
      amountCents: Number(row.amount_cents), balanceAfter: Number(row.balance_after),
      reason: row.reason as string, operator: (row.operator as string | null) ?? null, createdAt: iso(row.created_at),
    })),
  };
}

export type AccountPatch = {
  note?: string;
  allowedPages?: AppPage[] | null;
  role?: 'admin' | 'editor' | 'viewer';
  disabled?: boolean;
  /** Spend cap per Beijing day for the account's wallet; null removes the cap. */
  dailyCapCents?: number | null;
};

export async function updateAccount(userId: string, patch: AccountPatch, operatorId: string) {
  if (userId === operatorId && (patch.role !== undefined || patch.disabled !== undefined)) {
    throw new CatalogHttpError(400, '不能修改自己的角色或停用自己');
  }
  return catalogTransaction(async client => {
    const found = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (!found.rowCount) throw new CatalogHttpError(404, '账号不存在');
    if (patch.note !== undefined) await client.query('UPDATE users SET admin_note = $2 WHERE id = $1', [userId, patch.note.trim()]);
    if (patch.allowedPages !== undefined) await client.query('UPDATE users SET allowed_pages = $2 WHERE id = $1', [userId, patch.allowedPages]);
    if (patch.role !== undefined) await client.query('UPDATE users SET role = $2 WHERE id = $1', [userId, patch.role]);
    if (patch.dailyCapCents !== undefined) {
      await client.query('UPDATE tenants SET daily_spend_cap_cents = $2 WHERE id = (SELECT tenant_id FROM users WHERE id = $1)', [userId, patch.dailyCapCents]);
    }
    if (patch.disabled !== undefined) {
      await client.query('UPDATE users SET disabled = $2 WHERE id = $1', [userId, patch.disabled]);
      // A disabled account is signed out everywhere at once rather than at its next request.
      if (patch.disabled) await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    }
    return { ok: true };
  });
}
