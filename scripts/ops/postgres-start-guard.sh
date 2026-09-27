#!/bin/sh
# Production restore must prepare this cluster before service startup.
set -eu
expected=/var/lib/postgresql/pgdata
[ "${PGDATA:-}" = "$expected" ] || { echo 'FATAL: PGDATA does not point at the persistent cluster' >&2; exit 1; }
# Verify the containing mount, not a sibling anonymous /data volume.
awk -v target="$PGDATA" '
  ($5 == target || index(target,$5 "/") == 1) && length($5) > longest {longest=length($5); root=$4; mount=$5}
  END {exit !(mount == "/var/lib/postgresql" && root ~ "/pvc-[^/]+$")}
' /proc/self/mountinfo || { echo 'FATAL: PostgreSQL storage is not the expected persistent volume' >&2; exit 1; }
[ -s "$PGDATA/PG_VERSION" ] && [ "$(cat "$PGDATA/PG_VERSION")" = 17 ] || { echo 'FATAL: initialized PostgreSQL 17 cluster is missing; refusing empty initialization' >&2; exit 1; }
[ -n "${PG_EXPECTED_SYSTEM_IDENTIFIER:-}" ] || { echo 'FATAL: expected cluster identity missing' >&2; exit 1; }
actual=$(pg_controldata "$PGDATA" | awk -F': *' '/Database system identifier/ {print $2}')
[ "$actual" = "$PG_EXPECTED_SYSTEM_IDENTIFIER" ] || { echo 'FATAL: unexpected database cluster; restore requires explicit identity update' >&2; exit 1; }
[ "${PG_GUARD_CHECK_ONLY:-0}" != 1 ] || exit 0
cp /etc/pg-tls/server.key /tmp/pg-server.key
cp /etc/pg-tls/server.crt /tmp/pg-server.crt
chown postgres:postgres /tmp/pg-server.key /tmp/pg-server.crt
chmod 600 /tmp/pg-server.key
exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/pg-server.crt -c ssl_key_file=/tmp/pg-server.key -c max_connections=100 -c shared_buffers=128MB
