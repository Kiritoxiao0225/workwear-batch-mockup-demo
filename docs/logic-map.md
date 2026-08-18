# 工作服批量效果图 Demo Logic Map

## Legend

- `CAP-*`: capability or product area
- `PAGE-*`: page, route, or view
- `UI-*`: user-facing control
- `ACT-*`: user or system action
- `FLOW-*`: multi-step workflow
- `API-*`: route or interface
- `STORE-*`: durable file or asset directory
- `RULE-*`: invariant or failure policy
- `TEST-*`: automated or manual verification

## Capabilities

| ID | Name | Purpose | Primary Nodes |
| --- | --- | --- | --- |
| `CAP-001` | 商品素材库 | 按型号查找并选择客户提供的衣服素材 | `PAGE-001`, `FLOW-001`, `STORE-001` |
| `CAP-002` | 批量任务工作台 | 并行管理多款衣服的 Logo 效果图任务 | `PAGE-002`, `FLOW-002`, `STORE-002` |
| `CAP-003` | Logo 定制画布 | 按位置上传、移动、缩放和去白底 | `UI-004`, `FLOW-003`, `STORE-003` |
| `CAP-004` | 效果图导出 | 按当前、已选或全部任务导出 PNG/ZIP | `UI-008`, `FLOW-004` |

## Core Flows

| ID | Name | Trigger | Steps | Ends In |
| --- | --- | --- | --- | --- |
| `FLOW-001` | 添加商品任务 | `ACT-001` | `PAGE-001` -> `UI-001` -> `API-001` -> `STORE-002` | 每款商品新增一条任务 |
| `FLOW-002` | 管理批量任务 | `ACT-002` | `PAGE-002` -> `UI-002/UI-003` -> `API-001` | 任务选择、替换或删除已保存 |
| `FLOW-003` | 配置 Logo | `ACT-003` | `UI-004` -> 本地 `API-002` / 线上浏览器存储 -> `STORE-003` -> `UI-005` -> 本地 `API-001` / 线上浏览器存储 | 画布实时预览并自动保存 |
| `FLOW-004` | 导出效果图 | `ACT-004` | `UI-008` -> 浏览器 Canvas 合成 -> PNG/ZIP 下载 -> `API-001` | 任务标记为已导出 |

## Node Cards

### `PAGE-001` 商品素材库

- Type: Page
- Route/path: `/products`
- Supports: `CAP-001`
- Key UI: `UI-001` 商品搜索与多选、加入当前批次
- Reads: `STORE-001`, `API-001`
- Writes: `STORE-002`
- Rules: 替换模式只允许选择一款；新增模式一款商品生成一条任务
- Tests: `TEST-001`, `TEST-003`

### `PAGE-002` 批量效果图工作台

- Type: Page
- Route/path: `/workbench`
- Supports: `CAP-002`, `CAP-003`, `CAP-004`
- Key UI: `UI-002` 任务列表、`UI-004` 位置槽、`UI-005` 画布、`UI-008` 导出
- Reads/Writes: 本地使用 `API-001`、`API-002`；托管 Demo 使用 `STORE-002`、`STORE-003` 的浏览器分支
- Rules: 当前画布只编辑一条任务；批量操作只作用于勾选任务
- Tests: `TEST-001`, `TEST-002`, `TEST-003`

### `UI-001` 商品选择

- Type: UI control
- Location: `PAGE-001`
- Triggers: `ACT-001`
- Reads/writes: `STORE-001`, `STORE-002`
- Rules: 原有任务与 Logo 设置不因新增商品而改变

### `UI-002` 任务列表

- Type: UI control
- Location: `PAGE-002` 左栏
- Triggers: 切换当前任务、勾选批量任务、单条删除
- Reads/writes: `STORE-002`
- Rules: 删除任务不删除商品素材；删除当前任务后切换到相邻任务

### `UI-004` Logo 位置槽

- Type: UI control
- Location: `PAGE-002` 右栏
- Triggers: `ACT-003`
- Calls: 本地调用 `API-002`、`API-001`；托管 Demo 直接写浏览器存储
- Rules: 左胸、后背、左袖、右袖独立绑定 Logo

### `UI-005` 实时画布

- Type: UI control
- Location: `PAGE-002` 中栏
- Reads: 商品原图与当前任务位置数据
- Writes: 拖动后的归一化偏移
- Rules: 预览即最终合成关系，不存在额外“生成”步骤

### `UI-008` 导出范围

- Type: UI control
- Location: `PAGE-002` 顶部
- Triggers: `ACT-004`
- Reads: 当前、已选或全部任务
- Rules: 无 Logo 的任务跳过并报告；修改已导出任务后恢复为可导出

### `API-001` Demo 状态接口

- Type: API
- Path: `GET/PUT /api/state`
- Reads/Writes: `STORE-002`
- Errors: 非法 JSON 或不符合任务契约时返回 400/500
- Rules: 原子替换 JSON 文件，不静默吞错

### `API-002` Logo 上传接口

- Type: API
- Path: `POST /api/logos`
- Writes: `STORE-003`
- Errors: 缺少文件、类型不支持或超过大小上限时返回 400
- Rules: 文件名由服务端生成，不信任原始文件名

### `STORE-001` 商品素材

- Type: Static files + TypeScript catalog
- Source: `public/products/`, `lib/products.ts`
- Read by: `PAGE-001`, `PAGE-002`, 导出逻辑
- Invariants: 商品 code 唯一；原图路径与尺寸真实存在

### `STORE-002` Demo 任务状态

- Type: 本地 JSON file / 托管 Demo 浏览器 IndexedDB
- Source: 本地首次运行自动创建且 Git 忽略的 `data/demo-state.json`；线上 IndexedDB `workwear-mockup-demo/demo`
- Written by: 本地 `API-001`；线上客户端存储适配器
- Read by: `PAGE-001`, `PAGE-002`
- Key fields: task id、productCode、placements、timestamps
- Invariants: 每个任务引用存在的商品；每个位置最多一张 Logo

### `STORE-003` Logo 文件

- Type: 本地 Project directory / 托管 Demo IndexedDB 状态内 Data URL
- Source: 本地 `public/uploads/logos/`；线上当前浏览器
- Written by: 本地 `API-002`；线上客户端上传适配器
- Read by: 预览与导出

### `RULE-003` Demo 存储环境边界

- Type: Rule
- Applies to: `FLOW-001`, `FLOW-002`, `FLOW-003`
- Statement: localhost 使用项目文件；非 localhost 托管环境使用当前浏览器 IndexedDB，不尝试写 Vercel 只读运行目录
- Failure behavior: 浏览器存储不可用或数据合同非法时显示保存错误
- Verified by: `TEST-001`, `TEST-003`

### `RULE-001` 一款一任务

- Type: Rule
- Applies to: `FLOW-001`, `FLOW-002`
- Statement: 一条任务只绑定一款商品，但可包含多个独立位置 Logo
- Failure behavior: 拒绝缺少 productCode 的任务
- Verified by: `TEST-001`

### `RULE-002` 实时保存与直接导出

- Type: Rule
- Applies to: `FLOW-003`, `FLOW-004`
- Statement: 调整立即保存；用户不需要执行额外生成操作
- Failure behavior: 保存失败时显示错误，不能宣称已保存
- Verified by: `TEST-002`, `TEST-003`

### `TEST-001` 数据契约测试

- Type: Automated test
- Coverage: 状态校验、状态推导、位置默认值、托管环境存储模式选择
- Command: `npm test`

### `TEST-002` 构建与静态检查

- Type: Automated test
- Coverage: Next.js 编译、TypeScript、ESLint
- Command: `npm run check && npm run build`

### `TEST-003` 浏览器主流程

- Type: Manual browser verification
- Coverage: 选择商品、创建任务、上传 Logo、调整、删除、批量应用与导出
- Command: 本地启动后使用 Playwright 验证 `/products` 与 `/workbench`

## Change Impact Checklist

- Target nodes: `CAP-001`–`CAP-004`, `PAGE-001`, `PAGE-002`, `API-001`, `API-002`, `STORE-002`, `STORE-003`, `RULE-003`
- Downstream impact: 商品选择会改变任务列表；Logo 设置会影响预览、状态和导出
- Rules that must remain true: `RULE-001`, `RULE-002`
- Data migration or compatibility concerns: Demo 无历史数据库；JSON 契约变化需同步初始文件；线上数据按浏览器隔离
- Automated tests: `TEST-001`, `TEST-002`
- Manual verification: `TEST-003`

## Open Questions

- 正式版是否将文件存储迁移到对象存储与数据库。
- 不同季节款式是否需要独立衣服物理宽度与默认锚点配置。
