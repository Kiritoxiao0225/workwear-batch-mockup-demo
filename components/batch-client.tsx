"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppHeader } from "./app-header";
import { SaasEditors } from "./saas-editors";
import { RequirementEditor } from "./saas-requirement-editor";
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
  type Case,
  type Prices,
} from "@/lib/client/saas-workbench";
import "./saas-workbench.css";
type Target = { type: "artwork" | "mockup"; id: string };
function currentJobs(item: Case) {
  return (item.draft?.artworks || []).flatMap((art) => {
    const job = item.productions.filter((j) => j.artworkId === art.id).at(-1);
    return job ? [job] : [];
  });
}
function caseStatus(item: Case) {
  const jobs = currentJobs(item);
  if (item.analysis?.status === "running") return "识别中";
  if (item.needsReanalysis) return "待重新识别";
  if (jobs.some((j) => ["queued", "running"].includes(j.status)))
    return "制作中";
  if (
    item.analysis?.error ||
    jobs.some((j) => j.error) ||
    item.draft?.readingIssues.length
  )
    return "有提醒";
  if (
    jobs.length &&
    jobs.length === item.draft?.artworks.length &&
    jobs.every((j) => j.status === "returned" && j.revision === item.revision)
  )
    return "已完成";
  if (item.draft && jobs.length) return "待重新制作";
  return item.draft ? "待制作" : "草稿";
}
function CaseRow({
  item,
  prices,
  reload,
  open,
}: {
  item: Case;
  prices: Prices | null;
  reload: () => Promise<unknown>;
  open: (target: Target) => void;
}) {
  const [text, setText] = useState(item.sourceText),
    [notice, setNotice] = useState("已保存"),
    [busy, setBusy] = useState(false),
    [draftPending, setDraftPending] = useState(false);
  const latest = useRef(item),
    value = useRef(text),
    dirty = useRef(false),
    flight = useRef<Promise<boolean> | null>(null),
    input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!dirty.current && !flight.current) latest.current = item;
  }, [item]);
  useEffect(() => {
    if (!dirty.current && !flight.current) {
      setText(item.sourceText);
      value.current = item.sourceText;
    }
  }, [item.sourceText]);
  const save = useCallback(async () => {
    if (flight.current) await flight.current;
    if (!dirty.current) return true;
    const sent = value.current;
    dirty.current = false;
    setNotice("保存中…");
    flight.current = (async () => {
      try {
        const r = await batchAPI<{ sourceRevision: number }>(
          "/api/cases/update",
          {
            caseId: item.caseId,
            text: sent,
            sourceRevision: latest.current.sourceRevision || 0,
          },
        );
        latest.current = {
          ...latest.current,
          sourceRevision: r.sourceRevision,
        };
        setNotice(dirty.current ? "待保存" : "已保存");
        await reload();
        return true;
      } catch (e) {
        dirty.current = true;
        setNotice("保存失败：" + (e instanceof Error ? e.message : String(e)));
        return false;
      } finally {
        flight.current = null;
      }
    })();
    return flight.current;
  }, [item.caseId, reload]);
  useEffect(() => {
    if (!dirty.current) return;
    const timer = setTimeout(() => void save(), 700);
    return () => clearTimeout(timer);
  }, [text, save]);
  async function action(work: () => Promise<unknown>) {
    if (draftPending) {
      setNotice("制作要求尚未保存，请先完成保存");
      return;
    }
    setBusy(true);
    try {
      if (!(await save())) return;
      await work();
      await reload();
      setNotice("已保存");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function analyze() {
    const data = await batchAPI<{ cases: Case[] }>("/api/requirements"),
      c = data.cases.find((x) => x.caseId === item.caseId)!;
    await batchAPI("/api/requirements/analyze", {
      caseId: c.caseId,
      revision: c.revision,
      supplementRevision: c.supplement.revision,
      requestId: crypto.randomUUID(),
    });
  }
  const freshJobs = currentJobs(item);
  const state = caseStatus(item);
  async function addFiles(files: File[]) {
    if (!files.length) return;
    if (item.images.length + files.length > 10)
      throw new Error("最多 10 张素材图");
    const additions = await uploadImages(files);
    await batchAPI("/api/cases/update", {
      caseId: item.caseId,
      sourceRevision: latest.current.sourceRevision || 0,
      images: [
        ...item.images
          .filter((i) => i.source === "original")
          .map((i) => ({ imageId: i.id })),
        ...additions,
      ],
    });
  }
  return (
    <article
      className={"case " + (!item.draft ? "draft" : "")}
      data-case-id={item.caseId}
      data-unsaved={
        draftPending ||
        notice === "待保存" ||
        notice === "保存中…" ||
        notice.startsWith("保存失败")
      }
    >
      <div>
        <div className="spread">
          <b className="small">{item.caseId}</b>
          <span
            className={
              "tag " +
              (state === "已完成" ? "ok" : state === "制作中" ? "info" : "")
            }
          >
            {state}
          </span>
        </div>
        <textarea
          className="src-text"
          aria-label={`${item.caseId} 原始资料`}
          rows={5}
          value={text}
          onChange={(e) => {
            value.current = e.target.value;
            dirty.current = true;
            setText(e.target.value);
            setNotice("待保存");
          }}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files);
            if (files.length) {
              e.preventDefault();
              void action(() => addFiles(files));
            }
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void action(() => addFiles(Array.from(e.dataTransfer.files)));
          }}
        />
        <div className="src-imgs">
          {item.images.map((i) => (
            <a
              key={i.id}
              className="thumb"
              href={assetURL(i.asset)}
              target="_blank"
              rel="noreferrer"
            >
              <img src={assetURL(i.asset)} alt={i.label} />
              <span>{i.label}</span>
            </a>
          ))}
          <button
            className={"add " + (!item.images.length ? "wide" : "")}
            disabled={busy}
            onClick={() => input.current?.click()}
            aria-label={`${item.caseId} 添加素材`}
          >
            ＋ {!item.images.length && "拖入或粘贴素材图"}
          </button>
        </div>
        <input
          ref={input}
          hidden
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp"
          onChange={(e) => {
            const files = Array.from(e.target.files || []);
            e.target.value = "";
            void action(() => addFiles(files));
          }}
        />
        <p className="autosave" role="status">
          {notice} · 录入不花钱
        </p>
        {notice.startsWith("保存失败") && (
          <button className="button sm" onClick={() => void save()}>
            重试保存
          </button>
        )}
        {item.needsReanalysis && (
          <p className="notice warn tiny">
            原文或素材已变，旧稿保留，请重新识别。
          </p>
        )}
        <div className="row row-actions">
          <button
            className="button sm"
            disabled={busy || item.analysis?.status === "running"}
            onClick={() => void action(analyze)}
          >
            {item.draft ? "重新识别" : "识别这一行"}（
            {chargeLabel(prices, "analyze")}）
          </button>
          <button
            className="button sm danger"
            disabled={busy}
            onClick={() => {
              if (window.confirm("删除这一行？历史图稿会保留。"))
                void action(() =>
                  batchAPI("/api/cases/remove", { caseId: item.caseId }),
                );
            }}
          >
            删除
          </button>
        </div>
      </div>
      {!item.draft ? (
        <div className="todo">
          <div className="small muted">
            {item.analysis?.error ||
              "在左边填写需求并添加素材，点「识别这一行」后开始处理。"}
            <p className="tiny">
              录入免费；识别成功后会接续图稿制作，制作按所选路线另行冻结积分。
            </p>
          </div>
          {item.analysis?.status === "running" && (
            <span className="tag info">正在识别，关闭页面也会继续</span>
          )}
        </div>
      ) : (
        <>
          <div>
            <RequirementEditor
              item={item}
              onSaved={() => void reload()}
              onPending={setDraftPending}
            />
            {item.analysis?.proposedDraft && (
              <button
                className="button sm"
                onClick={() => {
                  if (window.confirm("采用新的识别结果替换当前编辑稿？"))
                    void action(() =>
                      batchAPI("/api/requirements/save", {
                        caseId: item.caseId,
                        revision: item.revision,
                        supplementRevision: item.supplement.revision,
                        analysisId: item.analysis!.id,
                        draft: item.analysis!.proposedDraft,
                      }),
                    );
                }}
              >
                采用新识别结果
              </button>
            )}
          </div>
          <div>
            {item.draft.artworks.map((art) => {
              const job = freshJobs
                  .filter((j) => j.artworkId === art.id)
                  .at(-1),
                file = resultFile(job);
              return (
                <div className="art-block" key={art.id}>
                  <div className="art">
                    <div className="thumb">
                      {file ? (
                        <img src={assetURL(file.asset)} alt={art.name} />
                      ) : (
                        statusText(job?.status)
                      )}
                    </div>
                    <div>
                      <b className="small">{art.name}</b>
                      <p className="tiny muted">{statusText(job?.status)}</p>
                      <div className="row">
                        {file && (
                          <>
                            <button
                              className="button sm"
                              onClick={() =>
                                open({ type: "artwork", id: job!.id })
                              }
                            >
                              修补
                            </button>
                            <a
                              className="button sm"
                              href={assetURL(file.asset)}
                              download={`${art.name}.png`}
                            >
                              下载
                            </a>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  {job?.error && <p className="tiny error">{job.error}</p>}
                  <button
                    className="button sm"
                    disabled={
                      busy ||
                      draftPending ||
                      item.needsReanalysis ||
                      ["queued", "running", "unknown"].includes(
                        job?.status || "",
                      )
                    }
                    onClick={() =>
                      void action(async () => {
                        const data = await batchAPI<{ cases: Case[] }>(
                            "/api/requirements",
                          ),
                          c = data.cases.find((x) => x.caseId === item.caseId)!;
                        await batchAPI("/api/production", {
                          requests: [
                            {
                              caseId: c.caseId,
                              revision: c.revision,
                              supplementRevision: c.supplement.revision,
                              artworkId: art.id,
                            },
                          ],
                        });
                      })
                    }
                  >
                    制作图稿（{chargeLabel(prices, art.route)}）
                  </button>
                </div>
              );
            })}
          </div>
          <div>
            {item.mockups.cards.length ? (
              item.mockups.cards.map((card) => (
                <div className="mk" key={card.id}>
                  <div className="thumb">
                    {card.render ? (
                      <img
                        src={assetURL(card.render.asset)}
                        alt={`${card.style} ${card.color} 效果图`}
                      />
                    ) : (
                      <span>请选择款色，图稿完成后合成</span>
                    )}
                  </div>
                  <div className="mk-foot">
                    <button
                      className="button sm"
                      onClick={() => open({ type: "mockup", id: item.caseId })}
                    >
                      调整位置
                    </button>
                    {card.render && (
                      <>
                        <button
                          className="button sm"
                          onClick={() =>
                            void copyImage(card.render!.asset)
                              .then(() => setNotice("图片已复制"))
                              .catch((e) => setNotice(e.message))
                          }
                        >
                          复制
                        </button>
                        <a
                          className="button sm"
                          href={assetURL(card.render.asset)}
                          download="效果图.png"
                        >
                          下载
                        </a>
                      </>
                    )}
                  </div>
                  {card.warnings?.map((w) => (
                    <p className="tiny warning" key={w}>
                      {w}
                    </p>
                  ))}
                </div>
              ))
            ) : (
              <div className="empty">
                <p>图稿完成后选择衣服款色</p>
                <button
                  className="button sm"
                  onClick={() => open({ type: "mockup", id: item.caseId })}
                >
                  选择款色与位置
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </article>
  );
}
function NewRow({ onSaved }: { onSaved: () => Promise<unknown> }) {
  const [text, setText] = useState(""),
    [files, setFiles] = useState<File[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null),
    requestId = useRef<string | null>(null),
    flight = useRef(false);
  const save = useCallback(async () => {
    if (!text.trim() || flight.current) return;
    flight.current = true;
    setBusy(true);
    setError("");
    try {
      requestId.current ||= crypto.randomUUID();
      const images = await uploadImages(files);
      await batchAPI("/api/cases", {
        text,
        images,
        requestId: requestId.current,
      });
      setText("");
      setFiles([]);
      requestId.current = null;
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      flight.current = false;
      setBusy(false);
    }
  }, [text, files, onSaved]);
  useEffect(() => {
    if (!text.trim() || error) return;
    const timer = setTimeout(() => void save(), 700);
    return () => clearTimeout(timer);
  }, [text, save, error]);
  return (
    <article className="case draft">
      <div>
        <div className="spread">
          <b className="small">新需求</b>
          <span className="tag">草稿</span>
        </div>
        <textarea
          className="src-text"
          rows={5}
          aria-label="新需求原文"
          placeholder="把客服原话、客户微信里的要求整段粘进来即可，不用整理成格式。"
          value={text}
          disabled={busy}
          onChange={(e) => {
            setText(e.target.value);
            setError("");
          }}
          onPaste={(e) => {
            if (e.clipboardData.files.length) {
              e.preventDefault();
              setFiles((v) =>
                [...v, ...Array.from(e.clipboardData.files)].slice(0, 10),
              );
            }
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            setFiles((v) =>
              [...v, ...Array.from(e.dataTransfer.files)].slice(0, 10),
            );
          }}
        />
        <div className="src-imgs">
          <button
            className="add wide"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            ＋ 添加素材（{files.length}/10）
          </button>
        </div>
        <input
          ref={input}
          hidden
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp"
          onChange={(e) =>
            setFiles((v) =>
              [...v, ...Array.from(e.target.files || [])].slice(0, 10),
            )
          }
        />
        {files.map((f, i) => (
          <p className="tiny" key={i}>
            图{i + 1} {f.name}
          </p>
        ))}
        <p className="autosave">
          {busy ? "保存中…" : error || "停止输入 700ms 自动存草稿，不花钱"}
        </p>
        {error && (
          <button className="button sm" onClick={() => void save()}>
            重试保存
          </button>
        )}
      </div>
      <div className="todo">
        <div className="small muted">
          左边填写原文和素材，保存后即可识别。
          <p className="tiny">单张图片 ≤15MB，最多 10 张；图号保存后固定。</p>
        </div>
      </div>
    </article>
  );
}
export function BatchClient() {
  const { data, error, reload } = useWorkbench(),
    prices = usePrices(),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all"),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [target, setTarget] = useState<Target | null>(null),
    [newRow, setNewRow] = useState(true);
  const close = useCallback(() => setTarget(null), []),
    saved = useCallback(() => {
      void reload();
    }, [reload]);
  const cases = (data?.cases || []).filter(
      (c) =>
        c.active !== false &&
        c.entry !== "studio" &&
        (c.entry === "batch" || c.sourceRecordId?.startsWith("upload:")),
    ),
    pending = cases.filter(
      (c) =>
        (!c.draft || c.needsReanalysis) && c.analysis?.status !== "running",
    );
  const filtered = cases
    .filter(
      (c) =>
        !query ||
        [
          c.sourceText,
          ...(c.draft?.artworks.map((a) => a.name + " " + a.prompt) || []),
        ]
          .join(" ")
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .filter(
      (c) =>
        filter === "all" ||
        (filter === "draft" &&
          ["草稿", "待制作", "待重新制作"].includes(caseStatus(c))) ||
        (filter === "running" &&
          ["识别中", "制作中"].includes(caseStatus(c))) ||
        (filter === "done" && caseStatus(c) === "已完成") ||
        (filter === "issue" &&
          ["有提醒", "待重新识别"].includes(caseStatus(c))),
    );
  async function analyzeAll() {
    if (document.querySelector('[data-unsaved="true"]')) {
      setNotice("有未保存的修改，请完成保存后再识别");
      return;
    }
    setBusy(true);
    let ok = 0;
    const errors: string[] = [];
    for (const c of pending) {
      try {
        await batchAPI("/api/requirements/analyze", {
          caseId: c.caseId,
          revision: c.revision,
          supplementRevision: c.supplement.revision,
          requestId: crypto.randomUUID(),
        });
        ok++;
      } catch (e) {
        errors.push(
          c.caseId + "：" + (e instanceof Error ? e.message : String(e)),
        );
      }
    }
    setNotice(
      `已提交 ${ok} 条${errors.length ? "；未提交 " + errors.join("；") : ""}`,
    );
    await reload();
    setBusy(false);
  }
  return (
    <div className="saas-app">
      <AppHeader />
      <main className="page batch-page">
        <div className="page-head">
          <div>
            <h1>批量效果图</h1>
            <p>
              一条需求 = 一段文字 +
              若干素材图。像表格一样直接在最左列写，写完点「加 1
              行」接着写下一条。录入全程不花钱，点识别才走 需求理解 → 图稿制作 →
              上衣效果图。
            </p>
          </div>
          <button
            className="button primary"
            disabled={busy || !pending.length}
            onClick={() => void analyzeAll()}
          >
            识别全部草稿（{pending.length} 条
            {prices && !prices.exempt
              ? ` · 识别冻结 ${pending.length * prices.analyze} 分`
              : ""}
            ）
          </button>
        </div>
        <section className="panel bar">
          <input
            className="grow"
            aria-label="搜索需求"
            placeholder="搜索需求原文、款号或图稿名"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            aria-label="筛选状态"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">全部状态</option>
            <option value="draft">草稿</option>
            <option value="running">制作中</option>
            <option value="done">已完成</option>
            <option value="issue">有提醒</option>
          </select>
          <span className="grow" />
          <span className="small muted">共 {cases.length} 条</span>
          <span className={"tag " + (data?.workerOnline ? "ok" : "warn")}>
            {data
              ? data.workerOnline
                ? "worker 正常"
                : "后台未在线"
              : "连接中"}
          </span>
          <button className="button sm" onClick={() => void reload()}>
            刷新
          </button>
        </section>
        {(error || notice) && (
          <p className="notice warn" role="status">
            {error || notice}
          </p>
        )}
        <div className="work">
          <div className="work-head">
            <div>原始资料（可直接改）</div>
            <div>需求理解（七项，可直接改）</div>
            <div>图稿制作</div>
            <div>上衣效果图</div>
          </div>
          {filtered.map((c) => (
            <CaseRow
              key={c.caseId}
              item={c}
              prices={prices}
              reload={reload}
              open={setTarget}
            />
          ))}
          {newRow && <NewRow onSaved={reload} />}
          <button
            className="add-row"
            onClick={() => {
              setNewRow(true);
              document
                .querySelector<HTMLTextAreaElement>('[aria-label="新需求原文"]')
                ?.focus();
            }}
          >
            ＋ 加 1 行{" "}
            <span className="tiny muted">在左侧直接录入，自动保存草稿</span>
          </button>
        </div>
      </main>
      <SaasEditors target={target} onClose={close} onSaved={saved} />
    </div>
  );
}
