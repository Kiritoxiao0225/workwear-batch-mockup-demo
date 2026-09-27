import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contract, validateDatabase } from './production-preflight.mjs';
function baseline() {
 const d = contract.database;
 return { spec: { source: { image: d.image, command: d.command, args: d.args }, volumes: [d.volume] }, image: { reference: d.image },
  variables: [{ key: 'PGDATA', value: d.dataDirectory }, { key: 'PG_EXPECTED_SYSTEM_IDENTIFIER', value: d.systemIdentifier }], configInfo: { content: 'guard', envsubst: false } };
}
test('rejects the original PG18 specification and PG17 runtime mismatch', () => {
 const s = baseline(); validateDatabase(s, 'guard'); s.spec.source.image = 'postgres:18-bookworm';
 assert.throws(() => validateDatabase(s, 'guard'), /specification image drift/);
});
test('rejects anonymous-volume PGDATA and missing startup guard', () => {
 const s = baseline(); s.variables[0].value = '/var/lib/postgresql/data';
 assert.throws(() => validateDatabase(s, 'guard'), /PGDATA drift/);
 const without = baseline(); without.spec.source.args = ['postgres'];
 assert.throws(() => validateDatabase(without, 'guard'), /startup arguments drift/);
});
