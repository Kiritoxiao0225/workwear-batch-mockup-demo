# A模块：全量真实需求改写与独立审阅入口

**当前：补图重新识别、人工确认历史及原样交给B已接通。** [使用页面](http://127.0.0.1:3206/) · [验收报告](../../../output/a-module-closeout-20260913/验收报告.md) · [唯一进度表](../../PLAN.md)。沿用最新10例原结果，本次只新增1次真实补图API验证。

```sh
# 启动不会调用模型；页面中明确点击重新识别才会调用现有API
A_REVIEW_OUTPUT=output/a-module-closeout-20260913/workspace A_REVIEW_PORT=3206 node batch-mockup/experiments/standardize-36/serve.mjs
npm run test:a
```

接口：`POST /api/reanalyze`返回已记录的请求ID，`GET /api/a-state`回读进度；`POST /api/adopt-analysis`仅返回待编辑候选；`POST /api/reviews`保存；`POST /api/confirm`原子保存确认和B回执；`GET /api/b-input?caseId=...&confirmationId=...`读取已确认的输入。所有写入仅限本机同源；文件操作/推理API失败不覆盖原始结果，不自动重发未知付费请求。

`a-state/`保留识别记录和确认/接收回执，`analysis-evidence/`保存不含凭据的真实输入及响应，`public/confirmed-assets/`保存固定图片。不要清理在用目录；API密钥仅由服务端从现有环境文件读取，不复制进输出目录。并行打开同一案例支持冲突提示，同目录不允许两个服务同时写入。

以下为历史批次，当时的“未完成”描述不代表当前进度。


**上一轮：10条新旧提示词真实对照已完成。** [新旧对照页](http://127.0.0.1:3205/) · [新版审阅与修改](http://127.0.0.1:3205/new.html) · [本轮报告](../../../output/a-prompt-comparison-10-20260913-v5/对照测试报告.md)。当前[prompt.txt](prompt.txt)已按用户确认的全文定稿，直接输出“应用服装＋具体图稿”，不二次摘要或扩写；运行SHA-256：`b108f6da1ec6705ab8a8ab595ab5be63548ad5cf71aac4dcedf2642b193a68f3`。

同一10条冻结原文、15张完整原图，CLIProxy / gpt-5.6-sol / low，新旧各10次实际新调用全部返回。新版正文总字符减少52.9%，单次均时旧15.0秒、新10.0秒；仅此样本测量，不是稳定性能或准确率结论。新版初审5条未发现明显问题，N02/D24共2条明确差异，D04/D13/D06共3条需核对；原始答案未修改。两版请求体SHA重建、输入配对、旧387文件未变、9项测试、ESLint、HTML正文及原图读回均通过。正式A确认及原样生图交接仍未实现；没有提交、推送、部署或写回WPS。

当前对照服务（不调用模型）：

```sh
A_REVIEW_OUTPUT=output/a-prompt-comparison-10-20260913-v5 A_REVIEW_PORT=3205 node batch-mockup/experiments/standardize-36/serve.mjs
```

下面为既有批次记录，旧页面和冻结提示词保持原样。

[既有36条全量审阅页](http://127.0.0.1:3201/) · [本轮初审报告](../../../output/a-standardization-full-20260913-v3/A初审报告.md) · [唯一进度表](../../PLAN.md)。原文/原图在左、模型改写在右，四块说明保留，Codex初审与人工修改分开存储。

本轮实时读取WPS“效果图任务管理”全表647条，只取“待领取／未领取”，不按修改次数筛选。符合条件36条（待领取36、未领取0），原图44张；以前样本中的19条与新增17条全部重新调用。结束时只读回查集合未变化。

**36次真实调用全部返回，Codex初审30条暂未发现明显问题，6条需修正，A最终验收尚未通过。** 问题为N02/N07转录原图错字、D04删标点并过度固定参考、D24胸背和配色版本错分、D13/N17虚构衣服件数。D24还缺实际Logo，补图入口可用，但补图后再次识别尚未接入。所有原模型返回保持不变。

实际API：`POST https://cpa-xf-6a9ea78b.zeabur.app/v1/chat/completions`。使用配置的`cliproxy / gpt-5.6-sol / low`，图片`detail: high`；无tools或案例答案。平均11.61秒/条，总调用经过约3分45秒（并发2），不是图片制作耗时。代理内部映射无法仅凭返回标识证明。

以上36条实际调用的冻结提示词SHA-256：`cb14aab449005b64de40ba4be48091faacf2b285c9ba80d1cd5347bcdbc746bb`。本轮没有改变已确认提示词，没有重试或复用旧答案。

**后续使用决定：** 用户查看N02的medium单例后选择继续`gpt-5.6-sol / low`，由设计师逐条核对并修改、确认。模型检查提醒只辅助，不以100%自动识别正确为前提；已知错误与两次原始输出保留，下一步做正式人审确认及同版本交接。最新目标和任务见PRD与唯一进度表；该次仅确定继续low，之后的实际调用见各批记录。

**服装尺码专项已实测：** 按PRD v1.7排除服装尺码，保留款号/衣色、图稿尺寸/定位，以及实际要印制的文字。该轮冻结提示词运行SHA-256为`68271ea197896b2d9852c8995d1d1c66bd4e8fc7af4fa644726428534967b770`；已单独调用涉及服装尺码的17条（24张原图），17条全部返回且改写均排除服装尺码；N02的字形清晰度提醒仍供人审核对。[新版17条审阅](http://127.0.0.1:3203/)及[专项报告](../../../output/a-standardization-size-17-20260913-v4/尺码专项复跑报告.md)。3201页及原始输入/输出保持原样，其余19条未调用。

## 当前运行入口

尺码专项17条服务（不调用模型）：

```sh
A_REVIEW_OUTPUT=output/a-standardization-size-17-20260913-v4 A_REVIEW_PORT=3203 node batch-mockup/experiments/standardize-36/serve.mjs
```


```sh
# 全新批次：用一个尚不存在的独立输出路径；读取WPS和下载附件，不写回
A_REVIEW_OUTPUT=output/<新批次目录> node batch-mockup/experiments/standardize-36/prepare-live.mjs
# 真实付费调用：只用于明确授权的新批次；当前v3没有待调用案例
A_REVIEW_OUTPUT=output/<新批次目录> node batch-mockup/experiments/standardize-36/run.mjs run
# 当前页面服务：不调用模型
A_REVIEW_OUTPUT=output/a-standardization-full-20260913-v3 A_REVIEW_PORT=3201 node batch-mockup/experiments/standardize-36/serve.mjs
# 更新本地页面：不调用模型
A_REVIEW_OUTPUT=output/a-standardization-full-20260913-v3 node batch-mockup/experiments/standardize-36/run.mjs publish
node --test batch-mockup/experiments/standardize-36/experiment.test.mjs
node_modules/.bin/eslint batch-mockup/experiments/standardize-36/*.mjs
```

`prepare-live`检查全量清单ID、读取数量和顺序，不设36条上限；逐条保留原文与所有实际附件。原图和输入均有SHA，附件失败不调用该条模型。旧案例ID保留，新案例为N01–N17；只用于审阅定位，不进入模型提示词。已有设计师补图时停止，以免新批次静默忽略补图。

本轮证据位于`output/a-standardization-full-20260913-v3/`：`source-receipt.json`、`manifest.json`、`inputs/`、`requests/`、`responses/`、`results/`、`qa-audit.json`、`qa-notes.json`以及`evidence/`。36个实际请求SHA重建、44张图片SHA、输出与页面逐条一致已核验。相关8项测试、ESLint、页面筛选与原图预览通过；未验证生产集成、完整A交接或图像制作。旧批次没有覆盖，未提交、推送、部署或写回WPS。

## 历史批次保留

- [v2页面3199](http://127.0.0.1:3199/) 对应 `output/a-standardization-36-20260913-v2/`：历史36例/52张原图，共28次调用返回，8条提交前停止；其中19条属于当前状态。已返回的9条范围外结果单独保留，不计入当前全量。
- [更早页面3197](http://127.0.0.1:3197/) 对应 `output/a-standardization-36-20260913-originals/`：首次36次调用后恢复9张历史裁图，重新调用相关7条，共43次调用。历史提示词SHA为 `a5bbc35063671120e497f49ff587743121eba68d3d505e09156f862a1eff506a`。
- 两个历史目录的原文、原图、请求、响应、审阅与补图记录继续保留；本轮没有覆盖。原12条保留案例已经参加历史实验，不再宣称严格盲测。

## 设计师修改与补图边界

当前3203页：点击右侧“修改图稿要求”，可修改整段说明，点击同处“保存修改”；底部“保存修改与审阅”同时保存文字、备注及所选审阅状态。“收起编辑”只切换预览，不保存；保存文字不会自动变为已核对。刷新后优先显示已保存修改，原回答仍在“查看模型原始返回与运行记录”中。编辑、保存、刷新、旧页面冲突均已在隔离副本实测，证据位于新版17条目录的 `evidence/designer-edit/`；真实案例未被测试标记为已审阅。正式前台确认与A→B交接仍待实现。

原始输出不改写；用户编辑保存在本批 `reviews.json`，补图身份/用途保存在 `supplements.json`，原始补图文件位于`public/supplements/`。支持静态PNG/JPG/WebP、单张15MB；上传后为“已补图，待重新识别”。当前尚未实现补图后的再次真实识别及正式A→B确认，不能将上传成功视为问题已解决。

本地保存校验同源及版本；旧版本返回409，补图使用稳定上传ID支持不明结果读回/重试，不覆盖客服附件。移除仅退出当前使用，保留历史文件。用户审阅和补图均不写回WPS、R2或订单数据库。
