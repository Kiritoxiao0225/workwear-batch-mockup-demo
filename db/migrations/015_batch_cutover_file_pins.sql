SET LOCAL search_path TO garment_catalog, public;
-- Rolling deployments of the legacy cleanup code must recognize the new files.
CREATE FUNCTION pin_batch_asset_for_legacy_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pin_key text;
BEGIN
 pin_key := 'batch-assets-' || NEW.workspace;
 INSERT INTO production_states(state_key,revision,state_jsonb) VALUES(pin_key,0,'{"schemaVersion":1,"revision":0,"batchId":"batch-2026-09-13","budgetLimitCny":10,"records":[],"units":[],"mockupVersions":[],"updatedAt":"2026-09-13T20:16:54.922Z"}'::jsonb) ON CONFLICT DO NOTHING;
 INSERT INTO production_file_refs(state_key,ref_key,file_id) VALUES(pin_key,NEW.path,NEW.file_id) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER pin_batch_asset BEFORE INSERT ON batch_assets FOR EACH ROW EXECUTE FUNCTION pin_batch_asset_for_legacy_cleanup();
