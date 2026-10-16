import { rootCertificates, type ConnectionOptions } from 'node:tls';
import { describe, expect, it } from 'vitest';
import { catalogDatabaseConfig } from './catalog-database';
import { catalogObjectPrefix } from './catalog-files';

describe('cloud catalog connection boundaries', () => {
  it('requires verified encryption for a remote database', () => {
    expect(() => catalogDatabaseConfig({ CATALOG_DATABASE_URL: 'postgresql://app:secret@db.example/mockup' })).toThrow('必须配置 CA');
    expect(() => catalogDatabaseConfig({ CATALOG_DATABASE_URL: 'postgresql://app:secret@db.example/mockup?sslmode=require' })).toThrow('必须配置 CA');
    expect(catalogDatabaseConfig({ CATALOG_DATABASE_URL: 'postgresql://app:secret@db.example/mockup?sslmode=verify-full' }).connectionString).toContain('verify-full');
    expect(catalogDatabaseConfig({ CATALOG_DATABASE_URL: 'postgresql://app:secret@127.0.0.1:55439/postgres' }).ssl).toBeUndefined();
  });

  it('pins the configured database hostname and prevents URL options overriding the CA', () => {
    const environment = { CATALOG_DATABASE_URL: 'postgresql://app:secret@47.237.69.195/mockup', CATALOG_DATABASE_CA_CERT: rootCertificates[0].replaceAll('\n', '\\n') };
    const ssl = catalogDatabaseConfig(environment).ssl as ConnectionOptions;
    expect(ssl.ca).toBe(rootCertificates[0].trim());
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.checkServerIdentity?.('localhost', { subjectaltname: 'IP Address:47.237.69.195' } as Parameters<NonNullable<typeof ssl.checkServerIdentity>>[1])).toBeUndefined();
    expect(ssl.checkServerIdentity?.('47.237.69.195', { subjectaltname: 'DNS:attacker.example' } as Parameters<NonNullable<typeof ssl.checkServerIdentity>>[1])).toBeInstanceOf(Error);
    expect(() => catalogDatabaseConfig({ ...environment, CATALOG_DATABASE_URL: `${environment.CATALOG_DATABASE_URL}?sslmode=disable` })).toThrow('不能同时指定 sslmode');
  });

  it('does not expose connection credentials in malformed URL errors', () => {
    expect(() => catalogDatabaseConfig({ CATALOG_DATABASE_URL: 'private-credential' })).toThrow('不是有效的数据库连接地址');
  });

  it('rejects OSS prefixes that escape or ambiguously change the project directory', () => {
    expect(catalogObjectPrefix('workwear-mockup/prod')).toBe('workwear-mockup/prod');
    for (const prefix of ['', '../other', '/other', 'other/', 'other//folder', 'other?folder']) expect(() => catalogObjectPrefix(prefix)).toThrow('CATALOG_OSS_PREFIX');
  });
});

describe('database pool size', () => {
  it('gives a long-running server room for pages, pictures and the health probe, keeps serverless small', () => {
    const local = { CATALOG_DATABASE_URL: 'postgresql://app:secret@127.0.0.1:5432/mockup' };
    expect(catalogDatabaseConfig(local).max).toBe(10);
    expect(catalogDatabaseConfig({ ...local, VERCEL: '1' }).max).toBe(5);
    expect(catalogDatabaseConfig({ ...local, CATALOG_DATABASE_POOL_MAX: '16' }).max).toBe(16);
    expect(catalogDatabaseConfig({ ...local, CATALOG_DATABASE_POOL_MAX: 'lots' }).max).toBe(10);
  });
});
