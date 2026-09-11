ALTER TABLE garment_catalog.files DROP CONSTRAINT files_backend_check;
ALTER TABLE garment_catalog.files ADD CONSTRAINT files_backend_check CHECK (backend IN ('oss','local','zeabur'));
