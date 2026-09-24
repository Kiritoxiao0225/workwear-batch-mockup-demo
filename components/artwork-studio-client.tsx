"use client";
import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { AppHeader } from "./app-header";
import { SaasEditors } from "./saas-editors";
import { authoredPrompt, splitPrompt } from "./saas-requirement-editor";
import {
  assetURL,
  batchAPI,
  chargeLabel,
  copyImage,
  resultFile,
  statusText,
  uploadImages,
  usePrices,
  useWorkbench,
  type Artwork,
  type Case,
  type Job,
} from "@/lib/client/saas-workbench";
import "./saas-workbench.css";
type Reference = {
  key: string;
  index: number;
  name: string;
  url: string;
  file?: File;
};
export function ArtworkStudioClient() {
  const { data, error, reload } = useWorkbench(),
    prices = usePrices();
  const [text, setText] = useState(""),
    [refs, setRefs] = useState<Reference[]>([]),
    [route, setRoute] = useState<Artwork["route"]>("generate"),
    [transparentBackground, setTransparentBackground] = useState(false),
    [mode, setMode] = useState<"text" | "seven">("text"),
    [selected, setSelected] = useState<string | null>(null),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [target, setTarget] = useState<{ type: "artwork"; id: string } | null>(
      null,
    ),
    [allHistory, setAllHistory] = useState(false);
  const input = useRef<HTMLInputElement>(null),
    request = useRef<{ snapshot: string; id: string } | null>(null),
    running = useRef(false);
  const cases = (data?.cases || [])
      .filter((c) => c.entry === "studio" && c.active !== false)
      .slice()
      .reverse(),
    active = cases.find((c) => c.caseId === selected),
    job = active?.productions.at(-1),
    file = resultFile(job);
  const close = useCallback(() => setTarget(null), []),
    saved = useCallback(() => {
      void reload();
    }, [reload]);
  function addFiles(files: File[]) {
    if (refs.length + files.length > 10) {
      setNotice("最多 10 张素材图");
      return;
    }
    if (
      files.some(
        (f) =>
          !["image/png", "image/jpeg", "image/webp"].includes(f.type) ||
          !f.size ||
          f.size > 15 * 1024 * 1024,
      )
    ) {
      setNotice("请使用单张不超过 15MB 的 PNG、JPG 或 WebP 图片");
      return;
    }
    const max = Math.max(0, ...refs.map((r) => r.index));
    setRefs((v) => [
      ...v,
      ...files.map((f, i) => ({
        key: crypto.randomUUID(),
        index: max + i + 1,
        name: f.name,
        url: URL.createObjectURL(f),
        file: f,
      })),
    ]);
    setNotice("");
  }
  function selectCase(c: Case) {
    setSelected(c.caseId);
    setText(c.draft?.artworks[0]?.prompt || c.sourceText);
    setRoute(c.draft?.artworks[0]?.route || "generate");
    setTransparentBackground(c.draft?.artworks[0]?.transparentBackground ?? true);
    setRefs(
      c.images.map((i) => ({
        key: i.id,
        index: i.index,
        name: i.label,
        url: assetURL(i.asset),
      })),
    );
    setNotice("");
  }
  async function begin() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setNotice("");
    try {
      if (!text.trim()) throw new Error("请填写制作要求");
      if (refs.some((r, i) => r.index !== i + 1))
        throw new Error(
          "素材图号存在空缺，请恢复缺失素材或新建一份需求；不会自动更改原图号",
        );
      if (route !== "generate" && refs.length !== 1)
        throw new Error("无损放大或直接复用需要一张明确的内容原图");
      const prompt = authoredPrompt(text, transparentBackground),
        snapshot = JSON.stringify({
          prompt,
          route,
          transparentBackground,
          refs: refs.map((r) => r.key),
        });
      if (request.current?.snapshot !== snapshot)
        request.current = { snapshot, id: crypto.randomUUID() };
      const files: File[] = [];
      for (const r of refs) {
        if (r.file) files.push(r.file);
        else {
          const response = await fetch(r.url);
          if (!response.ok) throw new Error("参考图读取失败");
          files.push(
            new File([await response.blob()], r.name + ".png", {
              type: "image/png",
            }),
          );
        }
      }
      const images = await uploadImages(files),
        created = await batchAPI<{ caseId: string }>("/api/cases", {
          text,
          images,
          entry: "studio",
          requestId: request.current.id,
        });
      setSelected(created.caseId);
      const live = await batchAPI<{ cases: Case[] }>("/api/requirements"),
        c = live.cases.find((x) => x.caseId === created.caseId)!;
      // An uncertain submit is read back, never turned into a second paid request.
      const prior = c.productions.at(-1);
      if (prior) {
        setNotice("已回读此前提交的任务：" + statusText(prior.status));
        await reload();
        return;
      }
      const draft = {
        artworks: [
          {
            id: "artwork",
            name: "独立图稿",
            route,
            transparentBackground,
            prompt,
            imageIds: c.images.map((i) => i.id),
            applications: [],
          },
        ],
        readingIssues: [],
      };
      const prepared = await batchAPI<{ revision: number }>(
        "/api/studio/prepare",
        { caseId: c.caseId, revision: c.revision, draft },
      );
      const result = await batchAPI<{ jobs: Job[] }>("/api/production", {
        requests: [
          {
            caseId: c.caseId,
            revision: prepared.revision,
            supplementRevision: c.supplement.revision,
          },
        ],
      });
      setNotice(
        result.jobs.some((j) => j.status === "blocked")
          ? result.jobs.map((j) => j.error).join("；")
          : "已提交，关闭页面后后台继续制作。",
      );
      await reload();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      running.current = false;
    }
  }
  async function reprocess() {
    if (!file) return;
    const response = await fetch(assetURL(file.asset));
    if (!response.ok) {
      setNotice("当前结果读取失败");
      return;
    }
    const f = new File([await response.blob()], "当前结果.png", {
      type: "image/png",
    });
    setRefs([
      {
        key: crypto.randomUUID(),
        index: 1,
        name: f.name,
        url: URL.createObjectURL(f),
        file: f,
      },
    ]);
    setRoute("enhance");
    setText(
      "使用图1完整图稿，只提升清晰度，保持原有图形、文字、字体、配色和布局。",
    );
    setMode("text");
    setNotice("输入已切换为当前结果；点击右侧「开始制作」才会提交新任务。");
  }
  const parsed = splitPrompt(authoredPrompt(text, transparentBackground));
  return (
    <div className="saas-app">
      <AppHeader />
      <main className="page">
        <div className="page-head">
          <div>
            <h1>图稿生成</h1>
            <p>
              传参考图 +
              写需求，生成图片或场景图；勾选「透明背景 PNG」可制作透明图稿。可无损放大、去背景、局部修补。
              <b>这一页不贴衣服</b>——要出穿着效果图请用「批量效果图」。
            </p>
          </div>
          <button
            className="button sm"
            onClick={() => {
              setSelected(null);
              setText("");
              setRefs([]);
              setRoute("generate");
              setTransparentBackground(false);
              setMode("text");
              request.current = null;
              setNotice("已新建空白制作要求");
            }}
          >
            新建图稿
          </button>
        </div>
        {(error || notice) && (
          <p className="notice warn" role="status">
            {error || notice}
          </p>
        )}
        <div className="studio">
          <section className="col col-left">
            <div className="col-head">
              <h3>参考素材与需求</h3>
              <span className="tiny muted">素材 {refs.length} / 10</span>
            </div>
            <div
              className="col-body"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                addFiles(Array.from(e.dataTransfer.files));
              }}
            >
              <div className="mat-row">
                {refs.map((r) => (
                  <div className="ref thumb" key={r.key}>
                    <img src={r.url} alt={`图${r.index}`} />
                    <span className="idx">图{r.index}</span>
                    <button
                      className="del"
                      aria-label={`移除图${r.index}`}
                      onClick={() =>
                        setRefs((v) => v.filter((x) => x.key !== r.key))
                      }
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  className="add-tile"
                  onClick={() => input.current?.click()}
                  disabled={busy || refs.length >= 10}
                >
                  <b>＋</b>
                  <span>添加</span>
                </button>
              </div>
              <input
                ref={input}
                type="file"
                hidden
                multiple
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => {
                  addFiles(Array.from(e.target.files || []));
                  e.target.value = "";
                }}
              />
              <p className="sub">
                PNG / JPG / WebP，单张 ≤ 15MB。图号固定后不可变。
              </p>
              <div className="req-label">
                <span>制作要求</span>
                <div className="seg">
                  <button
                    aria-pressed={mode === "text"}
                    onClick={() => setMode("text")}
                  >
                    整段写
                  </button>
                  <button
                    aria-pressed={mode === "seven"}
                    onClick={() => {
                      setText(authoredPrompt(text, transparentBackground));
                      setMode("seven");
                    }}
                  >
                    七项细化
                  </button>
                </div>
              </div>
              {mode === "text" ? (
                <textarea
                  aria-label="制作要求"
                  rows={9}
                  placeholder="写清要保留的图形、文字、字体、颜色和布局；引用图片请使用图1、图2…"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onPaste={(e) => {
                    if (e.clipboardData.files.length) {
                      e.preventDefault();
                      addFiles(Array.from(e.clipboardData.files));
                    }
                  }}
                />
              ) : (
                <dl className="seven-view">
                  {parsed.parts.map((p) => (
                    <div key={p.label}>
                      <dt>{p.label}</dt>
                      <dd>
                        <textarea
                          aria-label={`${p.label}要求`}
                          rows={2}
                          value={p.value}
                          onChange={(e) =>
                            setText(
                              parsed.prefix +
                                parsed.parts
                                  .map(
                                    (part) =>
                                      part.label +
                                      "：" +
                                      (part.label === p.label
                                        ? e.target.value
                                        : part.value) +
                                      part.gap,
                                  )
                                  .join(""),
                            )
                          }
                        />
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              <p className="sub">
                七项细化保留原文供你核对，不额外调用识图模型。
              </p>
            </div>
            <div
              className="col-foot studio-output-settings"
              role="group"
              aria-labelledby="studio-output-heading"
            >
              <h4 id="studio-output-heading">输出设置</h4>
              <label className="row">
                <input
                  type="checkbox"
                  checked={transparentBackground}
                  disabled={busy}
                  aria-describedby="studio-output-hint"
                  onChange={(e) => setTransparentBackground(e.target.checked)}
                />
                <b>透明背景 PNG</b>
              </label>
              <p className="sub" id="studio-output-hint">
                {transparentBackground
                  ? "去除背景，仅保留主体，输出透明 PNG。"
                  : "保留背景或使用场景，不自动抠图。"}
              </p>
            </div>
          </section>
          <section className="col col-mid">
            <div className="col-head">
              <div className="row">
                <h3>制作结果</h3>
                <span
                  className={"tag " + (job?.status === "returned" ? "ok" : "")}
                >
                  {job ? statusText(job.status) : "待制作"}
                </span>
              </div>
              <span className="tiny muted">
                {file?.width && file?.height
                  ? `${file.width} × ${file.height}`
                  : ""}
              </span>
            </div>
            <div className="preview">
              <div className="thumb">
                {file ? (
                  <img src={assetURL(file.asset)} alt="制作结果" />
                ) : (
                  <div className="empty">
                    <h3>{job ? statusText(job.status) : "图稿将在这里显示"}</h3>
                    <p>
                      {job?.error ||
                        "添加参考图、填写要求，在右侧选择本次制作方式。"}
                    </p>
                  </div>
                )}
              </div>
            </div>
            {job?.error && <p className="notice warn tiny">{job.error}</p>}
            <div className="col-foot result-tools">
              <button
                className="button sm"
                disabled={!file}
                onClick={() => setTarget({ type: "artwork", id: job!.id })}
              >
                局部修补
              </button>
              <button
                className="button sm"
                disabled={!file || busy}
                onClick={() => void reprocess()}
              >
                再加工 →
              </button>
              {file && <a className="button sm" href={"/garment-mockup?artwork=" + encodeURIComponent(assetURL(file.asset))}>用于成衣效果图</a>}
              <span className="grow" />
              <span className="tiny muted">以下不消耗积分</span>
              <button
                className="button sm"
                disabled={!file}
                onClick={() =>
                  void copyImage(file!.asset)
                    .then(() => setNotice("图片已复制"))
                    .catch((e) => setNotice(e.message))
                }
              >
                复制
              </button>
              {file ? (
                <a
                  className="button sm"
                  href={assetURL(file.asset)}
                  download="独立图稿.png"
                >
                  下载 PNG
                </a>
              ) : (
                <button className="button sm" disabled>
                  下载 PNG
                </button>
              )}
              <button
                className="button sm"
                disabled={!file || busy}
                onClick={() =>
                  void (async () => {
                    setBusy(true);
                    try {
                      const r = await fetch(assetURL(file!.asset));
                      if (!r.ok) throw new Error("结果读取失败");
                      const images = await uploadImages([
                        new File([await r.blob()], "图稿.png", {
                          type: "image/png",
                        }),
                      ]);
                      await batchAPI("/api/cases", {
                        text: "使用图1完整图稿制作上衣效果图，请填写款式、颜色和印花位置。",
                        images,
                        requestId: crypto.randomUUID(),
                      });
                      setNotice("已加入批量生成草稿，补充款色与位置后再识别。");
                    } catch (e) {
                      setNotice(e instanceof Error ? e.message : String(e));
                    } finally {
                      setBusy(false);
                    }
                  })()
                }
              >
                用它做效果图
              </button>
            </div>
          </section>
          <section className="col col-right">
            <div className="col-head">
              <h3>本次制作</h3>
              <span className="tag warn">
                {prices?.exempt ? "内部免计费" : "消耗积分"}
              </span>
            </div>
            <div className="col-body">
              <div className="source-row">
                <span className="tiny muted">输入</span>
                <b className="small">
                  {refs.length
                    ? `参考素材 ${refs.map((r) => "图" + r.index).join("、")}`
                    : "文字要求"}
                </b>
              </div>
              <div className="routes">
                {(
                  [
                    ["generate", "生图", "按需求生成或修改图片"],
                    ["enhance", "无损放大", "已有图，只提清晰度"],
                    ["reuse", "直接复用", "使用原图，可勾选去背景"],
                  ] as const
                ).map(([key, title, hint]) => (
                  <button
                    key={key}
                    aria-pressed={route === key}
                    onClick={() => setRoute(key)}
                  >
                    <b>{title}</b>
                    <small>{hint}</small>
                  </button>
                ))}
              </div>
            </div>
            <div className="col-foot">
              <div className="cost-row">
                <span>预计冻结</span>
                <b>{chargeLabel(prices, route)}</b>
              </div>
              <p className="tiny muted cost-note">
                按上限冻结，跑完按实际动作结算，多余退回。结果未知时保留冻结，等待核对。
              </p>
              <button
                className="button primary"
                disabled={busy || !text.trim() || !prices}
                onClick={() => void begin()}
              >
                {busy ? "正在提交…" : "开始制作"}
              </button>
            </div>
          </section>
        </div>
        <section className="col recent">
          <div className="col-head">
            <h3>最近制作</h3>
            <button
              className="button sm"
              onClick={() => setAllHistory((v) => !v)}
            >
              {allHistory ? "收起历史" : "全部历史"}
            </button>
          </div>
          <div className="recent-list">
            {(allHistory ? cases : cases.slice(0, 12)).map((c) => {
              const j = c.productions.at(-1),
                f = resultFile(j);
              return (
                <button
                  className={
                    "hist " + (c.caseId === active?.caseId ? "active" : "")
                  }
                  key={c.caseId}
                  onClick={() => selectCase(c)}
                >
                  <div className="thumb">
                    {f ? (
                      <img src={assetURL(f.asset)} alt="历史图稿" />
                    ) : (
                      statusText(j?.status)
                    )}
                  </div>
                  <div>
                    <div className="t">{c.sourceText.slice(0, 40)}</div>
                    <div className="s">{statusText(j?.status)}</div>
                  </div>
                </button>
              );
            })}
            {!cases.length && (
              <p className="small muted">
                还没有制作记录，完成后会保存在这里。
              </p>
            )}
          </div>
        </section>
        {notice.includes("已加入批量") && (
          <Link className="button" href="/batch">
            前往批量生成
          </Link>
        )}
      </main>
      <SaasEditors target={target} onClose={close} onSaved={saved} />
    </div>
  );
}
