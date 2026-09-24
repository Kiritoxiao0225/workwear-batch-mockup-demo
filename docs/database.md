# 数据库使用方式

本项目**只有一个当前生产数据库**，已于 2026-09-21 切到阿里云北京。腾讯旧库是只读回退副本，暂时保留，不能当成可随时删除的测试库。

本次发布回执见 [北京上线记录](上线-北京-20260921.md)。
本文件说明每个数据库的用途、连接来源，以及什么操作允许作用在哪一个上。

---

## 一、四个数据库，各自的位置

| # | 用途 | 位置 | 连接来源 | 可否删除 |
|---|---|---|---|---|
| 1 | **生产** | 阿里云北京 Zeabur PostgreSQL，数据库 `mockfits`，`garment_catalog` schema | `.env.local` 的 `CATALOG_DATABASE_URL` | ❌ 绝不 |
| 2 | **生产·迁移账号** | 同 1，换一个高权限角色 | `.env.catalog-admin.local` 的 `CATALOG_DATABASE_MIGRATION_URL` | ❌ 同上 |
| 3 | **本地试用** | 内嵌 PostgreSQL，`127.0.0.1:55439` | `scripts/catalog-local.ts` 自动创建 | ✅ 删 `data/catalog-local/` 即可 |
| 4 | **测试** | 每次运行新建的临时实例，随机端口 | 各集成测试脚本自动创建 | ✅ 跑完自动删 |

**1 和 2 是同一个数据库**，区别只在账号权限：

- `mockup_app`（1）：只有业务表的读写权限，Web 和 worker 用它
- `postgres`（2，北京专用库管理员）：能建表改表，**只有 `catalog:migrate` 和 `catalog:restore` 用它**

`.env.catalog-admin.local` 不被普通 Web 进程加载，就是为了让日常运行拿不到建表权限。

---

## 二、本地试用为什么是独立数据库

`npm run local` 起的是 3 号，不是生产库。三个原因：

1. **生产已执行到 021**，本地试用仍需要独立数据，避免调试污染正式租户。
2. **本地点一点就会写数据**。注册个测试手机号 = 生产库多一个租户；传张测试图 = 多一个款式。
3. **客户正在用**。生产库承载真实交付。

本地库的凭据、对象文件、随机管理员密码都在 `data/catalog-local/`（0600，Git 忽略）。

### 本地默认不连的外部服务

`.env.local` 是生产配置文件，里面有真实凭据。`scripts/catalog-local.ts` 启动前会**显式清空**这些，避免本地随手一点就打到线上：

| 清掉的 | 为什么 |
|---|---|
| `CATALOG_DATABASE_CA_CERT` | 内嵌库不走 TLS，留着会导致连不上 |
| `WPS_AIRSCRIPT_WEBHOOK` / `_TOKEN` / `WPS_SOURCE_URL` | 同步会拉取客户全部真实记录；工作台的状态切换会写回客户任务 |

需要在本地调 WPS 真实行为时，显式开启并接受后果：

```bash
CATALOG_LOCAL_AUTH=1 CATALOG_LOCAL_PORT=3001 CATALOG_LOCAL_WPS=1 npx tsx scripts/catalog-local.ts
```

> 付费模型凭据（CLIProxy / 火山 / 美图）本地未清空，但 `npm run local` **不启动 worker**，所以不会自动发生付费调用。
> 一旦手动跑 `npm run artwork:worker`，识别和生图就是真花钱。

---

## 三、迁移

```bash
npm run catalog:migrate
```

- 读 `db/migrations/*.sql`，按文件名排序执行
- **内容哈希校验**：已执行的文件内容再变动会直接报错，不会静默重跑
- **单事务**：任一条失败整体回滚，不会留下半截状态
- 自动切到迁移账号（2 号连接）

### 当前状态

| 环境 | 已执行到 |
|---|---|
| 北京生产 | **023**（2026-09-22 新增成衣效果图独立表，原业务目录/标准/资产校验一致） |
| 腾讯旧库 | 016，只读回退保留，旧 worker 已暂停 |
| 本地 / 测试 | 按 `db/migrations` 更新到 023 |

### 017–020 的不可逆点

`019` 会 `DROP` 并重建唯一约束：

```
garment_styles: (source_namespace, style_code) → (tenant_id, source_namespace, style_code)
import_batches: (manifest_hash)                → (tenant_id, manifest_hash)
```

执行之后，**回滚代码也恢复不了行为**——旧 `importCatalogAsset` 用的 `ON CONFLICT` 目标已不存在。
所以 019 必须与对应的代码改动**同一次发布**。

---

## 四、备份与恢复

```bash
# 导出（只读，不改任何东西）
npm run catalog:backup -- /绝对路径/backup.json

# 校验对象存储里的文件字节
npm run catalog:verify

# 恢复（仅限独立的、已执行相同迁移、且没有业务数据的目标库）
npm run catalog:restore -- /绝对路径/backup.json
```

**备份包含**：全部业务表 + 迁移版本 + 一致性事务快照。运行 15 分钟语句超时（默认超时会在大表中途掐断）。
**备份不包含**：图片字节。图在对象存储里，恢复演练必须同时验证对象存储。

**恢复的前置条件**（三条都要满足，否则直接拒绝）：

1. 目标库已执行**完全相同**的迁移版本
2. 目标库除迁移预置的种子行外为空
3. 备份 SHA-256 校验通过

> 迁移会预置内部租户和初始单价表。恢复逻辑认得这些种子行，不会因此判定"目标库非空"。

---

## 五、什么操作允许作用在哪一个上

| 操作 | 生产 | 本地 | 测试 |
|---|---|---|---|
| 读业务数据 | ✅ | ✅ | ✅ |
| 写业务数据 | ⚠️ 只经由应用 | ✅ | ✅ |
| `catalog:migrate` | ⚠️ **先备份 + 走回归清单** | ✅ | ✅ 自动 |
| `catalog:restore` | ❌ **绝不**（要求空库，会拒绝） | ✅ | ✅ |
| 手工 `DELETE` / `DROP` | ❌ | ✅ | ✅ |
| 删掉整个数据目录 | ❌ | ✅ | ✅ 自动 |

---

## 六、对生产库执行迁移的完整顺序

参见 [WPS 交付回归检查清单](../output/saas-plan-20260920/WPS交付回归检查清单.md)。摘要：

1. 采集基线：`npx tsx scripts/migration-baseline.ts output/<日期>/before.json`
2. 备份并保留：`npm run catalog:backup -- <绝对路径>`
3. 执行迁移：`npm run catalog:migrate`
4. 再次采集：`... after.json`
5. **逐项比对** before / after：计数与四项内容指纹
6. 不一致 → 立即回滚，不带伤上线

其中第 5 步的四项指纹里，`catalog` 这一项**必须完全相同**——
019 只给 `garment_styles` 加列、不改数据，变了就说明迁移写错了。

### 022 邮箱注册与密码登录（2026-09-21）

新增一次性邮箱设密凭据、验证码用途与用户密码版本。原有用户 ID、租户、角色与密码哈希保持不变；用户完成首次设密或重置密码时才更新密码并撤销该用户旧会话。验证码和设密凭据均只存哈希。此类短期认证凭据不进入业务备份，完整 PostgreSQL 备份包含它们。

### 023 成衣效果图独立副本（2026-09-22）

新增六张 `garment_mockup_*` 表与文件回收引用保护，不导入或连接 CatalogHub 数据。前五张业务表纳入应用备份，worker 心跳不恢复。完整 PostgreSQL 备份与迁移回读见 `output/garment-editor-20260922/`；功能、模型与发布边界见 [成衣效果图交付说明](garment-editor-delivery.md)。
