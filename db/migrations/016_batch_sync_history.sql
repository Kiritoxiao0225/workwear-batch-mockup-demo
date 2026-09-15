SET LOCAL search_path TO garment_catalog, public;
CREATE INDEX batch_queue_sync_history ON batch_queue(workspace,created_at DESC) WHERE kind='sync';
