# Mockfits

工作服图稿与电商主图制作台。线上地址：https://mockfits.preview.aliyun-zeabur.cn

| 页面 | 路径 |
|---|---|
| 图稿生成 | `/artwork-studio` |
| 电商主图 | `/listing-images` |
| 我的账户 | `/account` |
| 管理后台 | `/admin`（仅管理员） |

2026-10-14 起，商品素材库、成衣效果图、批量生成、WPS 批量生成拆到离线仓库 `mockup-legacy`。旧地址会跳回首页，旧接口返回 410。这些功能在数据库里的表和数据都保留着。

## 本地运行

```bash
npm install
npm run local                 # 内嵌 PostgreSQL + 真实登录：http://127.0.0.1:3001
npm run listing:worker:local  # 另开一个终端：本地处理电商主图任务
```

本地账号和密码在 `data/catalog-local/credentials.json`。本地数据库与上传图片也放在 `data/catalog-local/`，删掉这个目录就能从空库重来。

注意：`.env.local` 里配的是线上数据库，所以不要在本地直接运行 `npm run artwork:worker` 或 `npm run dev`，它们会连到线上数据。

## 线上服务（Zeabur 项目 `mockfits-beijing`）

- `web`：`Dockerfile.web`。
- `main-worker`、`external-worker`：都用 `Dockerfile.artwork-worker` 构建，`BATCH_WORKER_SCOPE` 分别设为 `main` 和 `external`。
  - 负责图稿生成的「需求 → 方案 → 制作」队列（`batch-mockup/`）和电商主图任务。
  - main-worker 还负责每 6 小时把数据库备份上传到 R2。
  - WPS 自动同步已关闭。
- `postgresql`：PostgreSQL 17，数据目录、启动保护和事故经过见 `docs/incident-beijing-20260927.md`。
- 发布前检查：`npm run ops:preflight`。

数据库迁移要用迁移账号执行（读取 `.env.catalog-admin.local`）：`npm run catalog:migrate`。

## 检查

```bash
npm run check              # lint + typecheck + 单元测试
npm run test:requirements  # 图稿引擎：需求、制作、修补、编辑器
npm run test:auth          # 登录、租户、积分、文件权限（内嵌 PostgreSQL）
npm run test:listing       # 电商主图全流程（不调外部服务）
npm run test:batch-claim   # 后台领单与内存保护
npm run test:batch-cloud   # 云端存储与队列
```

## 目录

- `app/`、`components/`：页面与接口。
- `lib/server/`：服务端逻辑，包括登录、租户、积分、文件存储和电商主图。
- `lib/listing/`：电商主图共享模型。
- `batch-mockup/`：图稿生成背后的队列引擎。`experiments/workbench/` 里是 `/api/batch` 在运行时提供的编辑器文件，不是实验代码，不能删。
- `db/migrations/`：全部历史迁移，必须完整保留，线上会校验迁移哈希。
- `scripts/ops/`：线上检查与 Zeabur 操作。
- `services/image-store/`：图片加速服务。
- `docs/`：数据库、上线和事故记录。
