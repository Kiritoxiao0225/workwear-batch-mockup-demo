# 工作服批量效果图 Demo

2026-09-14 新版入口 `/wps-production`：需求理解 → 图稿制作/修补 → 上衣效果图。正式状态由 PostgreSQL 与 R2 保存，WPS 读取待领取/未领取，长任务在 Zeabur worker 执行。旧工作台及历史保留在 `/wps-production/legacy`。当前规则以 [新版 PRD](batch-mockup/PRD.md) 与 [进度表](batch-mockup/PLAN.md) 为准；下文旧生产台说明仅适用于 legacy。

基于 Next.js 的批量效果图项目。商品素材库使用 PostgreSQL 保存款式、颜色、底图版本和位置标准，使用 OSS 保存文件；本地验收可显式使用独立 PostgreSQL 与本地对象目录。WPS 的同步、AI 理解、素材处理、方案确认、效果图制作和导出集中在一张生产表中，云模式将任务状态保存到 PostgreSQL、图片保存到私有 OSS。工作台界面固定浅色，避免系统暗夜模式影响文字和预览可读性。

## 商品素材库与位置标准

- `/products`：需要内部账号的真实素材库。一款一张卡片，卡片内切换颜色，每页 24 款；颜色搜索保留整款并标出匹配数量。支持上传及换版、正反面同屏校准、草稿/人工确认和历史版本查看。
- `/products?mode=append`：保留旧版 10 款商品选款入口，兼容既有任务；旧商品与新目录尚未做身份合并。
- PostgreSQL 使用 Zeabur 现有服务内的独立 `mockup` 数据库、`garment_catalog` schema，与 CatalogHub 的 `zeabur` 库分离。运行账号 `mockup_app` 只有业务表读写权限，`mockup_owner` 负责迁移。`npm run catalog:migrate` 执行带内容 hash 校验的迁移；管理连接只放在 `.env.catalog-admin.local`，普通 Web 进程不加载它。
- `.env.local` 保存 `CATALOG_DATABASE_URL`、`CATALOG_DATABASE_CA_CERT` 和 `CATALOG_OSS_*`。数据库采用 postgres.js、已连接的 IPv4 socket，同一进程共用最多 5 个连接，事务固定同一连接；Vercel 下驱动 5 秒回收空闲连接，连续空闲 6 秒且无活跃操作时安全关闭旧池，数据库侧 60 秒事务外空闲超时兜底。应用账号连接额度为 100，整库仍为 100 并保留 3 条管理员连接，额度不是每个实例的连接池大小。远程连接必须验证 TLS 证书和主机身份。私有 CA 的 PEM 可用转义换行保存；连接字符串不能再指定会覆盖 CA 的 SSL 参数。
- OSS 使用 `oss-bucket-mockfits` 的 `workwear-mockup/prod/objects/` 内容哈希路径，由 `CATALOG_OSS_PREFIX` 限定项目范围。独立 RAM 账号 `workwear-mockup` 绑定 `WorkwearMockupStorage` 策略，只能列举、读取及写入 `workwear-mockup/prod/`，没有删除对象、管理 Bucket 或读取 CatalogHub 目录的权限。上传显式设置私有权限、禁止覆盖，重试已有对象须读回验证哈希；文件访问生成 15 分钟签名地址。本次未配置 Bucket 版本控制，换图依靠不可覆盖的新哈希对象保留历史。
- 工作台使用 `CATALOG_AUTH_MODE=open` 免密码访问，打开链接即可查看和操作。`CATALOG_LOGIN_EMAIL` 指定已有工作台账号，所有访问者共用该账号的角色和操作记录；停用账号或设为 viewer 仍会阻止相应操作。
- 页面不再显示登录弹窗或退出按钮，也不依赖浏览器 cookie。现有账号和历史素材、任务、确认记录保持不变。新环境需先用 `CATALOG_USER_PASSWORD` 与 `npm run catalog:user -- <邮箱> <姓名>` 创建真实账号；初始化密码不用于页面访问。
- 反向代理部署设置 `CATALOG_APP_ORIGIN` 为浏览器访问的准确 origin；写接口继续校验来源。底层保留密码会话接口供兼容测试使用，未设置 open 时 API 仍要求原会话，但当前页面不再提供密码登录入口。

印花位置：点击卡片“查看印花位置”直接打开正反面标记，可切换印花/结构图层并拖动调整。已有标记原样读取；本批 21 款未保存的面按已核对参考类型生成建议，并分别对齐各面透明轮廓。未知款式先选择结构类型，无透明轮廓时先手动调整衣服边界。建议不自动保存或确认；核对当前面并确认后，才可“应用到同款其他颜色”。

同款颜色共用标准：选一个代表颜色，在校准弹窗确认正面/背面所需位置，点击“检查并共用到同款颜色”。系统读取真实图片，比较透明轮廓并展示对齐后的套用结果；符合轮廓条件的颜色默认勾选，差异图和不透明场景图需要人工核对后选择。领口、门襟、口袋等内部结构仍由用户核对。确认后只保存来源标准版本引用与每色对齐参数；已有草稿或标准保留，来源以后修改不会改写已引用的版本，目标换图后需重新检查。继承不算新增人工训练真值。可在弹窗点“添加同款颜色”，新图自动归入原款式。

已有数据库运行 `npm run catalog:migrate` 应用 `002_style_standard_reuse.sql`；迁移保留图片及人工版本。备份与恢复同时包含复用检查、标准来源和对齐参数。

整批导入：

```bash
npm run catalog:manifest -- '/Users/xiaofeng/Desktop/底图汇总' 'output/catalog/garment-import-manifest.json'
npm run catalog:import -- output/catalog/garment-import-manifest.json
npm run catalog:verify
```

清单保留原颜色名、完整款号、尺寸、内容哈希和原图来源候选。布局按本批已经确认的规范输出规则识别；来源候选的正反面角色不冒充人工已复核。多款号图会归入待处理，0 字节原文件登记为缺失。重复执行不重复建款色或底图版本，也不会把当前底图回退到旧版。失败逐条记录，可再次执行同一清单重试。后续匹配到的原图可补充关联并留审计记录。

启动已配置云存储的素材库：

```bash
npm run catalog:dev
```

网页在 `http://127.0.0.1:3177/products` 运行，数据和图片直接读写 Zeabur / OSS；启动前检查数据库 TLS 和素材表，不自动迁移或创建演示数据。

离线验收（不需要 Docker，不连接云数据库）：

```bash
npm run catalog:dev:local -- output/catalog/garment-import-manifest.json
```

启动真实 PostgreSQL 于 `127.0.0.1:55439`、独立 Next.js 于 `http://127.0.0.1:3177/products`。仅监听本机；图片、数据库、随机初始化账号保存在 Git 忽略的 `data/catalog-local/`，登录信息在该目录的 `credentials.json`（权限 0600）。后续启动省略清单参数即可。生产环境拒绝本地对象目录，不会在 OSS 配置缺失时静默降级。用 Ctrl-C 停止会保留数据。

备份与恢复：

```bash
npm run catalog:backup -- /absolute/path/catalog-backup.json
# 仅对独立、已经执行迁移且没有业务数据的目标库执行：
npm run catalog:restore -- /absolute/path/catalog-backup.json
npm run catalog:verify
```

备份使用一致性事务快照，包含版本、确认人、审计、用户密码摘要与文件引用，文件权限 0600；它不包含图片字节。需同时保留 OSS 对象及被引用的版本，本地则备份对象目录。不要将仍被历史任务或标准引用的对象加入自动清理。生产需配置数据库自动备份及对象版本保留；当前脚本不自动创建云资源或设定云端备份策略。

`npm run test:catalog` 使用临时真实 PostgreSQL，验收重复导入、单条失败、登录权限、并发 CAS、确认版本、换图失效、读回 hash 和独立空库恢复。不会读取真实云凭据或调用付费模型。

## 上线试用的接通顺序

2026-09-05，素材库已切到云端：21 款、260 色、816 个文件（3,296,506,820 字节）；所有对象上传后逐个读回验证 SHA-256，13 张业务表在停止本机库前逐项比对，保留 ID、草稿、来源和审计记录。本地数据库与图片保留为迁移备份，当前不再作为在线素材库数据源。切换快照另存 OSS 私有 `workwear-mockup/prod/backups/` 并读回验证；独立 RAM 账号已通过真实上传、哈希读回、签名访问、匿名访问 403、外部目录列举 403 和禁止覆盖验收，凭据只保存在服务端环境配置中。

WPS 制作任务现已支持选择真实款色，并把底图和已确认位置标准的具体版本保存到任务。泛称颜色在该款同色系中唯一时自动匹配，多种时暂选并允许修改，所有颜色均可下拉切换；未校准衣服需先在素材库确认位置。WPS 云模式已接入共享数据库/OSS，并使用素材库账号保护制作、源任务和 Logo 处理接口；本地文件模式仍不支持多实例生产。静态原型里的训练数量和 AI 预标注不会进入真实数据。

数据库 TLS 证书到期日为 2027-10-07，需到期前更新；CA 私钥、证书、迁移前后快照和逐文件回执保存在忽略目录 `output/catalog/cloud-migration-20260905/`（敏感文件 0600），服务器私钥仅在 PostgreSQL 持久化数据目录。云数据库定时备份与恢复演练仍需在正式部署时落实。

## 本地运行

```bash
npm install
npm run dev
```

打开：

- `http://localhost:3000/products`：商品素材库。
- `http://localhost:3000/logo-studio`：Logo 智能处理。
- `http://localhost:3000/wps-production`：直接同步 WPS，并在同一张表内完成 AI 理解、素材制作、门 A / 门 B、正反面合成和 ZIP 交付。

## WPS 真实表接入

当前链接为多维表格「【测试】效果图任务管理系统v3.5」。`/wps-production` 进入时自动同步，页面可见且未编辑时每 30 秒检查，切回页面时立即检查；新增记录自动置顶并保留顺序，即使尚未填写需求也显示待完善，后续补填或上传图片会更新同一行。读取原始任务、公式状态及全部任务素材附件，图片下载到本机后用于大图预览和模型输入。首次接入不再显示历史测试批次。原文或图片变化的记录使旧拆解结果失效，单纯状态变化保留已确认的制作结果。AI 理解由“分析待领取 / 设计中（条数）”单独启动，只选择这两种状态中有需求、尚无有效拆解结果的记录，每条成功后立即保存。已完成、已取消、待完善及未知状态不参与分析；服务端调用模型前重新读取原表状态和证据，状态不允许、记录缺失或原文/素材已变化时明确拒绝，不调用模型。旧 `/task-review` 入口同样限定这两种状态。

表格上方可按原表任务状态筛选：全部、待完善、待领取、设计中、已完成、已取消，选项显示各状态记录数，同时显示当前匹配数/总数；原表出现其他状态也会自动加入选项。自动同步保留已选状态，符合筛选的新增任务自动置顶，无匹配时可清除筛选。筛选只控制表格显示，分析固定覆盖待领取和设计中两种状态里的新增/变化任务，按钮按此范围显示待分析数；导出仍处理全部已确认成品。

默认采用 `WPS_CONNECTION_MODE=airscript`，不依赖客户之前提供的应用 ID/密钥。打开 `/wps-connect` 获取安装步骤和 `public/integrations/wps-task-bridge.txt`：原表有编辑权限的账号在表内保存脚本，复制该脚本 Webhook 与账号脚本令牌，分别配置服务端 `WPS_AIRSCRIPT_WEBHOOK`、`WPS_AIRSCRIPT_TOKEN`。令牌绑定个人账号，并非本项目专属；按 WPS 要求由本人完成实名认证和令牌管理，不发送到浏览器。

脚本固定连接数据表“效果图任务管理”，实际 sheet ID 由原表返回，不沿用未验证的 ID 4。服务端只向 `https://www.kdocs.cn` 或 `https://365.kdocs.cn` 的脚本同步执行接口发送令牌，禁止重定向。Webhook 文件标识必须等于原表链接标识或显式配置的数字文件 ID；此原表实际复制的 Webhook 使用 `cj5Qvp0WVtjz`，数据表 ID 为 1。先读取记录 ID 集合，再按 ID 分批读取，避免排序变化导致读取错行；字段变化、重复 ID 或未知响应明确报错。状态列不唯一时，在脚本顶部 `STATUS_FIELD_NAME` 和服务端 `WPS_STATUS_FIELD_NAME` 填写同一实际列名。

状态读取保留原表公式。客户表“任务状态”由“领取任务”“交付效果图成品”“异常标签”等计算：仅当公式与已核验规则一致时，允许在“🔴待领取/🟢设计中”之间切换，写入原有“领取任务”复选框；已完成或已取消的记录只读，不覆盖公式、不伪造交付。普通单选状态仅使用原有选项。服务端和脚本均检查需求、素材和旧状态，写后只针对目标记录独立回读；没有 WPS 原子 CAS 保证，仍存在外部并发窗口。素材以 6 条记录为一组缓存；单行错误明确列出，全部行失败时接口返回失败。

2026-09-05 已通过 Computer Use 保存原表接入脚本、复制真实 Webhook，令牌和链接配置在 `.env.local`（0600），不需要旧应用 ID/密钥。全表真实验收：1,445 条记录、1,658 张任务素材，导入错误 0；页面已显示原文、状态与真实缩略图。首次完整导入约 200 秒，后续增量检查实测约 0.5 秒。

每次同步通过官方 `Application.Record.GetRecords` 分页检查全部记录的原始字段和附件上传 ID，指纹变化才重新读取；同名图片替换也会触发更新。`data/wps-airscript-cache.json`（0600）保存按原表身份与字段定义区分的缓存，进程重启后复用；远端清单读取失败仍报错，不用缓存冒充在线状态。图片缓存缺失/下载失败会让对应记录失效，在下一次同步重新解析下载链接。并发同步请求合并，状态写入前后强制读原表，不复用旧记录缓存。

验证：133 项测试通过，覆盖新增空行、同名素材替换、保持置顶顺序、状态公式保护和独立回读；真实状态接口以保持当前状态的请求完成校验与回读，没有修改客户现有任务的业务状态。未向客户表添加验收用假任务；新增记录检测由自动化测试验证，真实页面的定时同步另行观察。AirScript 1.0 的数据读取使用普通循环，并保留附件 DBCellValue 对象访问 `.Value`，不整体 JSON 序列化该对象。

旧 OAuth 适配器仅在显式设置 `WPS_CONNECTION_MODE=oauth` 时使用，需要原有应用权限、文件权限及回调配置。客户提供的应用可获取应用 token，但读取此表仍返回 403；修复 callback 不代表这组凭据能访问该表。默认脚本连接失败时不会退回这一路径。

## 存储位置

- 商品原图：`public/products/originals/`
- 商品缩略图：`public/products/thumbs/`
- 上传 Logo：`public/uploads/logos/`
- 任务状态：`data/demo-state.json`（首次运行自动创建，Git 忽略）
- 云端 WPS 生产状态：PostgreSQL `garment_catalog.production_states`，关联图层与文件引用在 `production_file_refs`。设置 `WPS_PRODUCTION_STORAGE=cloud` 后不再写本地 JSON。
- 云端 WPS 图片：私有 OSS `oss-bucket-mockfits/workwear-mockup/prod/production/objects/<SHA 前两位>/<SHA>`；相同内容复用文件身份，新效果图替换数据库中的当前引用。图层参数留在数据库，透明 PNG 与客户效果 PNG 都在 OSS。
- 本地迁移回滚副本：`data/wps-production-state.json` 与原 `public/uploads/` 文件保留，不再决定云端当前制作状态；旧 Demo 上传和任务仍使用上述本地位置。
- `npm run production:dev` 只启动 Web。保存提交成功后，用 Next.js `after()` 更新效果图；新图就绪才切换当前入口，再删除没有任何当前引用的旧制作图。普通编辑保存不需要常驻 worker 或 Cron。开启云端制作队列后，生图任务由独立后台执行，见下方配置。
- 删除失败保留补删记录，后续保存、打开生产台或预览时重试，不阻塞保存。隐藏图层、蒙版、其他任务与商品素材引用受保护；同图继续复用。
- 服务端配置 `PRODUCTION_DELETE_ACCESS_KEY_ID` / `PRODUCTION_DELETE_ACCESS_KEY_SECRET`，复用原来已授权的独立账号。权限范围见 `docs/production-delete-policy.json`，仅限新制作目录。
- 保存、上传、预览、下载和人工确认不调用也不要求画质评分；只有主动点击“画质参考”才评分。文件损坏、素材缺失和确定的制作未完成项仍会提示。
- 迁移与验证详情：`docs/production-cloud-storage-design.md`。本机已切换云端存储；这不代表另一个托管 Web 环境也已部署。


## 云端图案制作队列

设置 `ARTWORK_DURABLE_JOBS=1` 后，`/wps-production` 将制作请求提交到 `/api/wps-production/jobs`。任务、失败图片及步骤回执保存在数据库和 OSS，切页、关闭网页或另一电脑打开同一工作台均可恢复。批量按钮只提交当前筛选内尚无图案、要求完整的图案位置，单次 API 最多 100 项，更多项目分批提交。

常驻后台运行 `npm run artwork:worker`，部署文件为 `Dockerfile.artwork-worker`。同库后台共享生图 6、抠图 2、评分 1 的空位；评分每次结束后至少间隔 1 秒。内容核对与其他处理各 2。已完成步骤复用原始字节；源评分不阻塞已生成图片进入抠图。后台负责最终排版、PNG 校验和带任务快照的保存，内容不合格保留候选，已变更要求禁止覆盖。

发布顺序：
1. 用现有迁移账号执行 `010_artwork_jobs.sql`（`npm run catalog:migrate`）；普通运行账号不授予建表权限。
2. 独立后台沿用当前 Web 的 `WPS_PRODUCTION_STORAGE=cloud`、`WPS_PRODUCTION_STATE_KEY`、数据库 TLS、OSS 读写与图像服务配置，另设 `ARTWORK_DURABLE_JOBS=1`。不注入迁移账号；`VERCEL` 不设为 `1`。后台可设为 1 个实例，增加实例不会扩大生图并发上限。
3. 确认数据库 `artwork_workers.heartbeat_at` 持续更新，再发布 Web 并开启相同开关。网页明确显示后台离线状态；离线时已提交任务仍保留，恢复后继续。
4. 验收独立测试任务的批量入队、离开页面后保存、另一客户端读取相同任务及失败续做。`npm run test:artwork-jobs` 使用临时 PostgreSQL 和本地对象目录，禁止真实网络调用；不以模拟调度数据宣称供应商实际提速。

生图提交后断线且没有确定回执时标记“结果不确定”，不会自动重复扣费；需要先核对原供应商任务。明确处理失败可从未完成步骤继续；内容不合格需修改要求后重新制作。后台收到停止信号会停止取新任务并等待正在处理的任务。回退前先排空队列，再关闭开关，保留数据库表与对象以便恢复。

## GPT Image 2（可选）

- `EVOLINK_API_KEY`：EvoLink 服务端 Key；未配置时付费提交会在调用前明确阻塞。
- `EVOLINK_PUBLIC_ASSET_BASE_URL`：将本地素材路径转换为 EvoLink 可下载的公网 HTTPS URL。
- `EVOLINK_CALLBACK_URL`：可选 HTTPS 回调地址；当前页面即使不配置回调，也可按已保存的 task ID 主动查询。

接口固定使用 `gpt-image-2 / 1K / low / transparent / n=1`。本地测试不会真实调用该服务。

Demo 文件存储只适合本地体验，不适合作为多实例生产部署方案。

## Vercel Demo 存储边界

- Vercel 线上任务与 Logo 只保存在当前浏览器中，不会同步到其他电脑或其他浏览器。
- 清理浏览器网站数据会清空线上 Demo 任务。
- 新商品素材库已连接 Zeabur / OSS；部署 Web 时仍须注入服务端环境变量并设置正式 origin。旧任务与 Logo 尚未迁移到共享存储。
- `/wps-production` 云端模式的持久状态和制作图片已共享。部署新 Web 实例时需配置相同数据库/OSS，保存后的处理随请求运行，无需另开进程。WPS 源附件直接保存到 OSS；处理回执保存在 `artwork_run_records`，审计图片使用非替换对象目录。Vercel 的可重建 AirScript 增量缓存使用临时目录，不作为任务真源。

## 2026-09-08 发布配置

- GitHub：`Kiritoxiao0225/workwear-batch-mockup-demo`，生产分支 `main`；沿用同名 Vercel 项目和 `https://workwear-batch-mockup-demo.vercel.app`。
- 服务端环境变量参照 `.env.example`；生产启用 `WPS_PRODUCTION_STORAGE=cloud`、现有 AirScript 接入和正式 `CATALOG_APP_ORIGIN`。不上传本机环境文件、构建缓存、运行数据或验收输出。
- 本次新增 `009_artwork_run_records.sql`；发布前执行 `npm run catalog:migrate`。历史本机处理报告及模型回执已导入同一状态空间，本地审计图片保留。备份包含抠图任务与处理回执。
- Meitu 官方 CLI 的动态依赖显式纳入函数打包，避免构建通过但线上缺少运行文件。
- 发布检查：`npm run check`、`npm run test:catalog`、`npm run test:production-storage`、`npm run build`。完整生图涉及付费服务，发布检查不自动提交真实模型任务。

### 解析恢复与存储优化（2026-09-10，本地实现）

在共用图稿实现上增加订单快照校验、后台解析、抠图文件引用、展示缩略图、短上传事务和 ETag/空闲轮询。人工确认、已定稿保护和原有图案处理路线保留。没有新增准确率评测集。

启用前执行 `npm run catalog:migrate` 应用 `012_production_reliability.sql`，部署新的 Web 和常驻 worker，再在两端设置 `WPS_DURABLE_ANALYSIS=1`、`ARTWORK_CUTOUT_FILE_STORAGE=oss`。worker 沿用 WPS 和解析模型配置，每 30 秒发现新任务；未完成、状态未知的解析不会因刷新页面反复调用模型。结果已返回但保存失败时，显式重试只继续保存。升级前打开的旧页面需要刷新才能提交带快照的解析结果。

历史抠图回执使用 `npm run production:migrate-cutout` 只读盘点；`npm run production:migrate-cutout -- --apply --limit=10` 按批次迁移，保留精确字节和原供应商任务号，可重复执行直到 remaining 为 0。先备份；混合格式可双读。开启文件引用之后，回滚代码也必须保留该读取适配器。生产发布和历史数据迁移没有包含在本地测试结果中。

验证入口：`npm run check`、`npm run test:reliability`、`npm run test:shared-artwork`、`npm run test:artwork-jobs`、`npm run test:production-storage`、`npm run test:catalog`。这些集成测试使用独立临时数据库与 PNG，不调用真实付费模型。
