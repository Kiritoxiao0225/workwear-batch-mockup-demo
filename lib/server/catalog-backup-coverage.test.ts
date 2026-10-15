import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATALOG_BACKUP_EXCLUDED_TABLES, CATALOG_BACKUP_TABLES } from './catalog-backup';

// The offsite backup refuses to run when the database has a table it neither saves nor excludes
// (migration 036 added listing_plan_parts and every backup failed for a day). Catch it here instead.
describe('backup table coverage', () => {
  it('saves or deliberately skips every table the migrations create', () => {
    const dir = path.join(process.cwd(), 'db/migrations');
    const sql = readdirSync(dir).filter(name => name.endsWith('.sql')).map(name => readFileSync(path.join(dir, name), 'utf8')).join('\n');
    const name = (m: RegExpMatchArray) => m[1].replace(/^garment_catalog\./u, '');
    const dropped = new Set([...sql.matchAll(/drop table (?:if exists )?([a-z_.]+)/giu)].map(name));
    const created = [...new Set([...sql.matchAll(/create table (?:if not exists )?([a-z_.]+)/giu)].map(name))]
      .filter(table => !dropped.has(table) && table !== 'schema_migrations');
    const covered = new Set<string>([...CATALOG_BACKUP_TABLES, ...CATALOG_BACKUP_EXCLUDED_TABLES]);
    expect(created.filter(table => !covered.has(table))).toEqual([]);
  });
});
