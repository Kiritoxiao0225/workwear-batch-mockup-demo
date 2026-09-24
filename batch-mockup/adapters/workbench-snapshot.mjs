// Every read checks current revisions in the database. Only unchanged document bytes
// are reused; this is not a TTL cache and never substitutes old data for a failed read.
const snapshots=new Map();
const roots=['manifest.json','supplements.json','qa-notes-v2.json','production-review.json','auto-flow.json'];
export async function readWorkbenchSnapshot(db,workspace){
 const key=JSON.stringify([process.env.CATALOG_DATABASE_URL,workspace]);
 const previous=snapshots.get(key)||new Map();
 const known=[...previous.values()].map(({path,revision,updated_at})=>({path,revision,updated_at}));
 const result=await db.query(`WITH known AS (
  SELECT * FROM jsonb_to_recordset($3::jsonb) AS k(path text,revision bigint,updated_at timestamptz)
 ) SELECT d.path,d.revision,d.updated_at::text AS updated_at,
  (k.path IS NOT NULL AND k.revision=d.revision AND k.updated_at=d.updated_at) AS unchanged,
  CASE WHEN k.path IS NULL OR k.revision<>d.revision OR k.updated_at IS DISTINCT FROM d.updated_at THEN d.content_json END AS content_json,
  CASE WHEN k.path IS NULL OR k.revision<>d.revision OR k.updated_at IS DISTINCT FROM d.updated_at THEN d.content_gzip END AS content_gzip
 FROM batch_documents d LEFT JOIN known k ON k.path=d.path
 WHERE d.workspace=$1 AND (d.path=ANY($2::text[]) OR starts_with(d.path,'requirements-state/') OR starts_with(d.path,'mockups/') OR d.path~'^production-jobs/[^/]+/(state|repair-state)\\.json$')`,[workspace,roots,known]);
 const next=new Map();
 for(const row of result.rows){
  const value=row.unchanged?previous.get(row.path):row;
  if(!value)throw Error('Workbench revision snapshot is incomplete');
  next.set(row.path,value);
 }
 // Bound retained tenant snapshots; eviction only causes a fresh full read.
 snapshots.delete(key);snapshots.set(key,next);
 while(snapshots.size>8)snapshots.delete(snapshots.keys().next().value);
 return [...next.values()];
}
