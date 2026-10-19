SET LOCAL search_path TO garment_catalog, public;
-- 图稿生成's 出图通道 for one account, set by an administrator: 'cliproxy' (新通道) or 'evolink'
-- (原通道) only. NULL shows both on the page and lets the account pick, as every account did before.
ALTER TABLE users ADD COLUMN artwork_route text CHECK (artwork_route IN ('cliproxy', 'evolink'));
