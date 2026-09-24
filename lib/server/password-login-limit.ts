import { catalogDatabase } from './catalog-database';
import { CatalogHttpError } from './catalog-auth';

/** Bound expensive password checks, including guesses for accounts which do not exist. */
export async function limitPasswordLogin(ip: string | null) {
  const start = new Date(Math.floor(Date.now() / 600000) * 600000).toISOString();
  const result = await catalogDatabase().query(`INSERT INTO email_quota(scope,window_seconds,window_start,used) VALUES($1,600,$2,1)
    ON CONFLICT(scope,window_seconds,window_start) DO UPDATE SET used=email_quota.used+1 WHERE email_quota.used<60 RETURNING used`, [`password-login:${ip || 'unknown'}`, start]);
  if (!result.rowCount) throw new CatalogHttpError(429, '登录尝试过于频繁，请 10 分钟后再试');
}
