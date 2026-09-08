# 云端保存与替换

当前约定：同一效果图入口只展示当前成品。新图成功后替换，失败保留旧图；相同内容不重复上传。

## 保存顺序

1. 无修改直接关闭；仅图层名称等参数变化时只保存参数。已有图层及相同内容 PNG 复用云端文件。
2. 新内容按 SHA 去重并协调上传；图片上传完成且可读取后，事务提交图层、透明 PNG 和引用。
3. 图层与 PNG 提交完成即可返回。Next.js `after()` 在本次请求响应后更新对应效果图，无需本机常驻脚本或 Vercel Cron。
4. 新效果图就绪后复核它仍对应最新输入，再替换当前成品；迟到的旧结果不能覆盖新图。重复预览、下载复用已有成品。
5. 本次替换解除引用的旧图立即进入后台删除，不再固定保留 24 小时。图片仍被其他任务、隐藏图层、蒙版或商品素材引用时保留。
6. 删除失败留下补删记录；后续保存、打开生产台或预览时重试。删除不会延长保存响应。无后续请求时，失败项保留至下次使用。

保存不调用云端评分，人工确认也不以评分为前提。只有主动点击“画质参考”才评分。文件格式、引用和并发冲突检查仍保留，防止保存坏图或覆盖别人的新修改。

## 存储

- 状态与图层参数：PostgreSQL `garment_catalog.production_states`，文件关联在 `production_file_refs`。
- 图片：私有 OSS `oss-bucket-mockfits/workwear-mockup/prod/production/objects/<SHA 前两位>/<SHA>`。
- `production_renders` 保存各版本当前效果图；`production_render_cache` 复用相同输入成品；`production_operations` 协调上传、合成及失败补删；`production_save_receipts` 合并保存重试。
- 替换事务同时登记旧文件，后台删除前锁定文件并检查全部引用；正在删除的文件不能被新引用。删除后核对云端对象已不存在。
- 原商品目录不在删除范围内。复用原已授权的目录限定账号，服务端环境变量为 `PRODUCTION_DELETE_ACCESS_KEY_ID` / `PRODUCTION_DELETE_ACCESS_KEY_SECRET`；权限见 `docs/production-delete-policy.json`。
- 迁移时保留的本地 JSON 与旧图片仅作回滚副本，不再决定云端当前状态；本次不清理这些用户数据。
- 已执行的数据库迁移保持不变，其中历史 `retain_until` 字段不再参与旧图删除规则。

## 运行与验证边界

`npm run production:dev` 只启动 Web。删除了每 5 秒扫描、每小时回收的 `production-worker.ts` 和全库定时回收入口。替换清理只处理本次释放或已登记补删的文件。

本地已使用云库与 OSS。Vercel 部署需注入相同数据库、OSS 和限定删除凭据；`after()` 受单次函数时长限制，超时后预览可重新取得最新成品，补删随下次请求继续。2026-09-08 已补齐 Vercel 适配：源附件直接保存到 OSS；AirScript 增量缓存使用临时目录；处理报告、生成回执在 PostgreSQL `artwork_run_records`，审计图片放在非替换对象目录，避免跨实例读取本机文件。

旧迁移及验收记录保留在 `output/production-cloud-20260907/`，本次替换验收保存在 `output/production-replace-20260907/`。
