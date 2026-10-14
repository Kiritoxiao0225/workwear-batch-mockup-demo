"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppHeader } from "./app-header";
import { PageHeader } from "./page-header";
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
import {
  readArtworkHandoff,
  retargetHandoff,
  writeArtworkHandoff,
  type ArtworkHandoff,
} from "@/lib/garment-editor/artwork-handoff";
import {
  MOCKUP_PLACEMENT_LABELS,
  placementsForProductFace,
} from "@/lib/garment-editor/mockup-element-relations";
import type { MockupPlacement } from "@/lib/garment-editor/mockup-types";
import "./saas-workbench.css";
type Reference = {
  key: string;
  index: number;
  name: string;
  url: string;
  file?: File;
};
type Stage = "checker" | "white" | "dark";
// What AI read from the request: one entry per picture, waiting for the author to confirm.
type Plan = { caseId: string; items: { key: string; name: string; text: string }[] };
type Submit = { name: string; prompt: string; route: Artwork["route"]; transparentBackground: boolean };
const ROUTES = [
  ["generate", "生图", "按要求生成或修改图片。"],
  ["enhance", "无损放大", "已有清晰原图，只提高清晰度。"],
  ["reuse", "用原图", "不重画，直接用参考图；勾上透明背景就只去掉底色。"],
] as const;
const PHRASES = [
  ["保留参考图形", "保留参考图中的主要图形"],
  ["修改文字为…", "文字改为："],
  ["调整配色为…", "配色改为："],
  ["调整布局", "调整图形与文字的布局："],
] as const;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const refsKey = (refs: Reference[]) => refs.map((r) => r.key).join("|");
const sevenFields = (text: string) => /^主体：/m.test(text) && /^输出：/m.test(text);
// A seven-field prompt is listed by its 主体, not by its 【图稿】 header.
const caseTitle = (c: Case) =>
  (sevenFields(c.sourceText)
    ? splitPrompt(c.sourceText).parts.find((p) => p.label === "主体")?.value.trim() || c.sourceText
    : c.sourceText
  ).slice(0, 40);
// One 开始制作 can make several pictures; they share the revision they were made from.
const roundOf = (c?: Case) => {
  const last = c?.productions.at(-1);
  return last ? c!.productions.filter((j) => j.revision === last.revision) : [];
};
const pending = (j: Job) => ["queued", "running"].includes(j.status);
const when = (value?: string) =>
  value
    ? new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "";
async function refFiles(refs: Reference[]) {
  const files: File[] = [];
  for (const r of refs) {
    if (r.file) files.push(r.file);
    else {
      const response = await fetch(r.url);
      if (!response.ok) throw new Error("参考图读取失败");
      files.push(new File([await response.blob()], r.name + ".png", { type: "image/png" }));
    }
  }
  return files;
}
async function readCase(caseId: string) {
  const live = await batchAPI<{ cases: Case[] }>("/api/requirements"),
    c = live.cases.find((x) => x.caseId === caseId);
  if (!c) throw new Error("图稿记录读取失败，请刷新后在「我的图稿」里查看");
  return c;
}
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
    [organizing, setOrganizing] = useState(false),
    [planning, setPlanning] = useState(false),
    [plan, setPlan] = useState<Plan | null>(null),
    [pick, setPick] = useState<string | null>(null),
    [target, setTarget] = useState<{ type: "artwork"; id: string } | null>(
      null,
    ),
    [allHistory, setAllHistory] = useState(false),
    [split, setSplit] = useState(false),
    [stage, setStage] = useState<Stage>("checker"),
    [handoff, setHandoff] = useState<ArtworkHandoff | null>(null);
  const input = useRef<HTMLInputElement>(null),
    textarea = useRef<HTMLTextAreaElement>(null),
    request = useRef<{ snapshot: string; id: string } | null>(null),
    // A case that "AI 整理" created and nobody has produced from yet; 开始制作 continues it.
    organized = useRef<{ caseId: string; refs: string } | null>(null),
    running = useRef(false);
  const cases = (data?.cases || [])
      .filter((c) => c.entry === "studio" && c.active !== false)
      .slice()
      .reverse(),
    active = cases.find((c) => c.caseId === selected),
    round = roundOf(active),
    job = round.find((j) => j.id === pick) || round[0],
    file = resultFile(job);
  // Arriving from the garment editor: show where the result will land, default to a
  // transparent logo, and start from the logo being replaced.
  useEffect(() => {
    if (new URLSearchParams(location.search).get("from") !== "garment") return;
    const arrived = readArtworkHandoff();
    if (!arrived) return;
    /* eslint-disable react-hooks/set-state-in-effect -- sessionStorage exists only after mount. */
    setHandoff(arrived);
    setTransparentBackground(true);
    if (arrived.replace)
      setRefs([{ key: "garment-logo", index: 1, name: arrived.replace.label, url: arrived.replace.refUrl }]);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);
  const retarget = (ownerId: string | null, placement?: MockupPlacement) => {
    if (!handoff) return;
    const next = retargetHandoff(handoff, ownerId, placement);
    setHandoff(next);
    writeArtworkHandoff(next);
  };
  const handoffOwner = handoff?.products.find((p) => p.id === handoff.ownerId);
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
    const art = c.draft?.artworks[0],
      // A request AI split into several pictures is shown as it was written.
      split = c.analysis?.mode === "plan",
      prompt = (split ? c.sourceText : art?.prompt) || c.sourceText,
      next = c.images.map((i) => ({
        key: i.id,
        index: i.index,
        name: i.label,
        url: assetURL(i.asset),
      }));
    setSelected(c.caseId);
    setText(prompt);
    setMode(sevenFields(prompt) ? "seven" : "text");
    setRoute(art?.route || "generate");
    // A request still waiting for its pictures to be confirmed starts like a new one.
    setTransparentBackground(art?.transparentBackground ?? (split ? !!handoff : true));
    setRefs(next);
    request.current = null;
    organized.current = c.productions.length ? null : { caseId: c.caseId, refs: refsKey(next) };
    const items = !c.productions.length && c.analysis?.status === "returned" ? c.analysis.plan : null;
    setPlan(items && items.length > 1 ? { caseId: c.caseId, items: items.map((i) => ({ key: crypto.randomUUID(), ...i })) } : null);
    setPick(null);
    setNotice("");
  }
  function startBlank() {
    setSelected(null);
    setText("");
    setRefs([]);
    setRoute("generate");
    setTransparentBackground(!!handoff);
    setMode("text");
    setPlan(null);
    setPick(null);
    request.current = null;
    organized.current = null;
    setNotice("已新建空白制作要求");
  }
  function checkInput() {
    if (!text.trim()) throw new Error("请先写制作要求");
    if (refs.some((r, i) => r.index !== i + 1))
      throw new Error(
        "素材图号存在空缺，请恢复缺失素材或新建一份需求；不会自动更改原图号",
      );
  }
  // Same reading as 批量生成「识别」: the model splits the requirement into the seven
  // fields; nothing is produced until the author reviews them and starts production.
  async function organize() {
    if (running.current) return;
    running.current = true;
    setOrganizing(true);
    setNotice("");
    try {
      checkInput();
      const images = await uploadImages(await refFiles(refs)),
        created = await batchAPI<{ caseId: string }>("/api/cases", {
          text,
          images,
          entry: "studio",
          requestId: crypto.randomUUID(),
        });
      let c = await readCase(created.caseId);
      setSelected(c.caseId);
      setPlan(null);
      c = await analyze(c, "AI 整理还没返回。结果会留在右侧「我的图稿」里，稍后点开这条即可，不会重复扣费。");
      const art = c.draft?.artworks[0];
      if (c.analysis?.status !== "returned" || !art)
        throw new Error(c.analysis?.error || "AI 没有整理出图稿，请补充要求后重试");
      setText(art.prompt);
      setMode("seven");
      setRoute(art.route);
      organized.current = { caseId: c.caseId, refs: refsKey(refs) };
      const issues = c.draft!.readingIssues.map((i) => i.issue),
        extra = c.draft!.artworks.length > 1 ? `识别出 ${c.draft!.artworks.length} 份图稿，已填入第 1 份。` : "";
      setNotice(
        "AI 已整理成七项，可逐项修改后点「开始制作」。" + extra + (issues.length ? "需要核对：" + issues.join("；") : ""),
      );
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setOrganizing(false);
      running.current = false;
    }
  }
  async function analyze(c: Case, slow: string, mode?: "plan") {
    const started = await batchAPI<{ id: string; status: string }>(
      "/api/requirements/analyze",
      {
        caseId: c.caseId,
        revision: c.revision,
        supplementRevision: c.supplement.revision,
        requestId: crypto.randomUUID(),
        ...(mode ? { mode } : {}),
      },
    );
    await reload();
    // About three minutes of polling, one read every 1.5 seconds.
    for (let tries = 0; c.analysis?.id !== started.id || c.analysis.status === "running"; tries++) {
      if (tries >= 120) throw new Error(slow);
      await sleep(1500);
      c = await readCase(c.caseId);
    }
    await reload();
    return c;
  }
  // Every picture of one confirmation goes in as one draft, so they are made side by side.
  async function submit(c: Case, list: Submit[]) {
    const draft = {
      artworks: list.map((a, n) => ({
        id: list.length > 1 ? `a${n + 1}` : "artwork",
        name: a.name,
        route: a.route,
        transparentBackground: a.transparentBackground,
        prompt: a.prompt,
        imageIds: c.images.map((i) => i.id),
        applications: [],
      })),
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
    // Accepted: the next 开始制作 is a new request even with the same text and pictures, so a
    // failed or unknown picture can be made again without refreshing the page.
    request.current = null;
    organized.current = null;
    setPlan(null);
    setPick(null);
    setNotice(
      result.jobs.some((j) => j.status === "blocked")
        ? result.jobs.map((j) => j.error).filter(Boolean).join("；")
        : (list.length > 1 ? `已提交 ${list.length} 张，同时制作；` : "已提交，") + "关闭页面后后台继续制作。",
    );
    await reload();
  }
  // multiple: only when asked, AI first reads how many pictures the request wants (a paid reading).
  async function begin(multiple = false) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setNotice("");
    setPlan(null);
    try {
      checkInput();
      if (route !== "generate" && refs.length !== 1)
        throw new Error("无损放大或用原图需要一张明确的内容原图");
      const prompt = authoredPrompt(text, transparentBackground),
        snapshot = JSON.stringify({
          prompt,
          route,
          transparentBackground,
          refs: refs.map((r) => r.key),
        }),
        split = multiple && route === "generate" && mode === "text";
      if (request.current?.snapshot !== snapshot)
        request.current = { snapshot, id: crypto.randomUUID() };
      const reuse =
        organized.current?.refs === refsKey(refs) ? organized.current.caseId : null;
      let c = reuse ? await readCase(reuse) : null;
      // The count is read from the record's own text, so edited text needs a new record.
      if (c && split && c.sourceText !== text) c = null;
      if (!c) {
        const images = await uploadImages(await refFiles(refs));
        c = await readCase(
          (
            await batchAPI<{ caseId: string }>("/api/cases", {
              text,
              images,
              entry: "studio",
              requestId: request.current.id,
            })
          ).caseId,
        );
      }
      setSelected(c.caseId);
      setPick(null);
      // An uncertain submit is read back, never turned into a second paid request.
      const prior = c.productions.at(-1);
      if (prior) {
        setNotice("已回读此前提交的任务：" + statusText(prior.status));
        await reload();
        return;
      }
      const single = { name: "独立图稿", prompt, route, transparentBackground };
      if (!split) return await submit(c, [single]);
      organized.current = { caseId: c.caseId, refs: refsKey(refs) };
      if (!(c.analysis?.mode === "plan" && c.analysis.status === "returned")) {
        setPlanning(true);
        c = await analyze(c, "AI 还在看要求。结果会留在右侧「我的图稿」里，稍后点开这条确认即可，不会重复扣费。", "plan");
      }
      const items = c.analysis?.status === "returned" ? c.analysis.plan : null;
      if (!items?.length)
        throw new Error(c.analysis?.error || "AI 没看出要出几张，请把要求写具体些再试");
      // One picture: send the author's own words, not AI's restatement.
      if (items.length === 1) return await submit(c, [single]);
      setPlan({ caseId: c.caseId, items: items.map((i) => ({ key: crypto.randomUUID(), ...i })) });
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setPlanning(false);
      running.current = false;
    }
  }
  async function confirmPlan() {
    if (!plan || running.current) return;
    running.current = true;
    setBusy(true);
    setNotice("");
    try {
      const items = plan.items.filter((i) => i.text.trim());
      if (!items.length) throw new Error("至少留一张");
      const c = await readCase(plan.caseId);
      const prior = c.productions.at(-1);
      if (prior) {
        setPlan(null);
        setNotice("已回读此前提交的任务：" + statusText(prior.status));
        await reload();
        return;
      }
      await submit(
        c,
        items.map((i) => ({
          name: i.name.trim() || "独立图稿",
          prompt: authoredPrompt(i.text.trim(), transparentBackground),
          route: "generate",
          transparentBackground,
        })),
      );
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      running.current = false;
    }
  }
  // 再来一张: the picture on screen once more, as its own record and charge.
  async function again() {
    const art = active?.draft?.artworks.find((a) => a.id === job?.artworkId);
    if (!active || !art || running.current) return;
    running.current = true;
    setBusy(true);
    setNotice("");
    try {
      const files = await refFiles(
          active.images.map((i) => ({ key: i.id, index: i.index, name: i.label, url: assetURL(i.asset) })),
        ),
        body = splitPrompt(art.prompt).parts.find((p) => p.label === "主体")?.value.trim(),
        c = await readCase(
          (
            await batchAPI<{ caseId: string }>("/api/cases", {
              text: body || art.prompt,
              images: await uploadImages(files),
              entry: "studio",
              requestId: crypto.randomUUID(),
            })
          ).caseId,
        );
      setSelected(c.caseId);
      await submit(c, [
        { name: art.name, prompt: art.prompt, route: art.route, transparentBackground: !!art.transparentBackground },
      ]);
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
    setSelected(null);
    request.current = null;
    organized.current = null;
    setNotice("输入已切换为当前结果；点击左下「开始制作」才会提交新任务。");
  }
  function insertPhrase(phrase: string) {
    const el = textarea.current,
      start = el?.selectionStart ?? text.length,
      end = el?.selectionEnd ?? start,
      before = text.slice(0, start),
      separator = before && !/[\s，。；：]$/u.test(before) ? "；" : "",
      cursor = before.length + separator.length + phrase.length;
    setText(before + separator + phrase + text.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(cursor, cursor);
    });
  }
  const parsed = splitPrompt(authoredPrompt(text, transparentBackground));
  const shown = cases,
    visible = allHistory ? shown : shown.slice(0, 30);
  // The history column only appears once there is something in it.
  const hasHistory = !data || cases.length > 0;
  const working = busy || organizing;
  const splitting = split && route === "generate" && mode === "text";
  const historyStatus = (c: Case) => {
    const r = roundOf(c),
      done = r.filter((j) => j.status === "returned").length;
    if (r.length > 1)
      return r.some(pending) ? `制作中 ${done}/${r.length}` : `已出 ${done}/${r.length} 张`;
    if (r[0]) return statusText(r[0].status);
    const split = c.analysis?.mode === "plan";
    if (c.analysis?.status === "running") return split ? "AI 看要求中" : "AI 整理中";
    if (c.analysis?.status === "returned")
      return split ? `待确认 ${c.analysis.plan?.length || 0} 张` : "已整理，待制作";
    if (c.analysis) return "整理未完成";
    return "草稿";
  };
  return (
    <div className="saas-app studio-app">
      <AppHeader />
      <main className="page studio-page">
        <PageHeader
          compact
          title="图稿生成"
          description="传参考图、写要求，生成 Logo 或图案；做好的图稿可以局部修补、变清晰，下载透明 PNG。"
          actions={<button className="button sm" onClick={startBlank}>新建图稿</button>}
        />
        {handoff && (
          <div className="studio-handoff" role="group" aria-label="来自成衣效果图">
            <span className="dot" aria-hidden="true" />
            <span className="grow">
              来自成衣效果图《{handoff.projectName}》· 做好后
              {handoff.replace ? (
                <>替换 <b>{handoff.replace.label}</b>，位置和大小不变</>
              ) : (
                <>
                  放到
                  <select
                    aria-label="放到哪件衣服"
                    value={handoff.ownerId ?? ""}
                    onChange={(e) => retarget(e.target.value || null)}
                  >
                    <option value="">未指定衣服</option>
                    {handoff.products.map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </select>
                  {handoffOwner && (
                    <select
                      aria-label="放到哪个位置"
                      value={handoff.placement}
                      onChange={(e) => retarget(handoffOwner.id, e.target.value as MockupPlacement)}
                    >
                      {placementsForProductFace(handoffOwner.face)
                        .filter((p) => p !== "custom")
                        .map((p) => (
                          <option key={p} value={p}>{MOCKUP_PLACEMENT_LABELS[p]}</option>
                        ))}
                    </select>
                  )}
                  {!handoffOwner && <span className="tiny muted">（选一件衣服，否则放在画布中间）</span>}
                </>
              )}
            </span>
            <Link href="/garment-mockup">← 返回成衣效果图</Link>
          </div>
        )}
        {(error || notice) && (
          <p className="notice warn" role="status">
            {error || notice}
          </p>
        )}
        <div className={hasHistory ? "studio" : "studio no-history"}>
          <section className="col col-left" aria-label="输入">
            <div className="col-head">
              <h3>输入</h3>
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
              <div className="field-label">
                <span>参考图</span>
                <small>可粘贴、拖入 · PNG/JPG/WebP ≤ 15MB</small>
              </div>
              <div className="mat-row">
                {refs.map((r) => (
                  <div className="ref thumb" key={r.key}>
                    <img src={r.url} alt={`图${r.index}`} />
                    <span className="idx">图{r.index}</span>
                    <button
                      className="del"
                      aria-label={`移除图${r.index}`}
                      disabled={working}
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
                  disabled={working || refs.length >= 10}
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
              <div className="field-label">
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
                <>
                  <textarea
                    ref={textarea}
                    aria-label="制作要求"
                    rows={7}
                    disabled={organizing}
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
                  <div className="phrases" aria-label="快捷短语">
                    {PHRASES.map(([label, phrase]) => (
                      <button
                        key={label}
                        type="button"
                        disabled={organizing || text.includes(phrase)}
                        onClick={() => insertPhrase(phrase)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <>
                <div className="organize">
                  <button
                    className="button sm"
                    disabled={working || !text.trim() || !prices}
                    onClick={() => void organize()}
                  >
                    {organizing ? "AI 正在填…" : "AI 帮我填这七项"}
                  </button>
                  <small>
                    {organizing
                      ? "一般 10 秒左右；关掉页面也会在后台填完。"
                      : `看参考图和要求，分别填进下面七项，填完可逐项改。${prices && !prices.exempt ? chargeLabel(prices, "analyze") : ""}`}
                  </small>
                </div>
                <dl className="seven-view">
                  {parsed.parts.map((p) => (
                    <div key={p.label}>
                      <dt>{p.label}</dt>
                      <dd>
                        <textarea
                          aria-label={`${p.label}要求`}
                          rows={2}
                          disabled={organizing}
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
                </>
              )}
              <div className="field-label">
                <span>制作方式</span>
              </div>
              <div className="seg full" role="group" aria-label="制作方式">
                {ROUTES.map(([key, title]) => (
                  <button
                    key={key}
                    aria-pressed={route === key}
                    disabled={working}
                    onClick={() => setRoute(key)}
                  >
                    {title}
                  </button>
                ))}
              </div>
              <p className="sub">{ROUTES.find(([key]) => key === route)?.[2]}</p>
              <label className="row output-check">
                <input
                  type="checkbox"
                  checked={transparentBackground}
                  disabled={working}
                  aria-describedby="studio-output-hint"
                  onChange={(e) => setTransparentBackground(e.target.checked)}
                />
                <b>透明背景 PNG</b>
              </label>
              <p className="sub" id="studio-output-hint">
                {transparentBackground
                  ? "会去掉底色，只留图案；要印到衣服上建议勾上。"
                  : "勾上会自动去掉底色，只留图案。"}
              </p>
            </div>
            <div className="col-foot start-foot">
              {route === "generate" && mode === "text" && (
                <label className="row split-check">
                  <input type="checkbox" checked={split} disabled={working} onChange={(e) => setSplit(e.target.checked)} />
                  <span>要分开出几张图：AI 先列清单，确认后一起出</span>
                </label>
              )}
              <div className="cost-row">
                <span>预计冻结</span>
                <b>{chargeLabel(prices, splitting ? "analyze" : route)}</b>
              </div>
              <div className="start-row">
                <button
                  className="button primary"
                  disabled={working || !text.trim() || !prices}
                  onClick={() => void begin(splitting)}
                >
                  {planning ? "AI 正在拆…" : busy ? "正在提交…" : splitting ? "让 AI 拆分" : "开始制作"}
                </button>
              </div>
              {prices && !prices.exempt && (
                <p className="tiny muted">按上限冻结，跑完按实际结算，多余退回。</p>
              )}
            </div>
          </section>
          <section className="col col-mid" aria-label="结果">
            <div className="col-head">
              <div className="row">
                <h3>结果</h3>
                <span
                  className={"tag " + (job?.status === "returned" ? "ok" : "")}
                >
                  {plan ? "待确认" : job ? statusText(job.status) : active ? historyStatus(active) : "待制作"}
                </span>
                {round.length > 1 && job && (
                  <span className="tiny muted">
                    第 {round.indexOf(job) + 1} / {round.length} 张 · {job.name}
                  </span>
                )}
                <span className="tiny muted">
                  {file?.width && file?.height
                    ? `${file.width} × ${file.height}${job?.transparentBackground ? " · 透明 PNG" : ""}`
                    : ""}
                </span>
              </div>
              <div className="stage-switch" role="group" aria-label="预览背景">
                {([
                  ["checker", "棋盘格"],
                  ["white", "白底"],
                  ["dark", "深色底"],
                ] as const).map(([key, label]) => (
                  <button
                    key={key}
                    className={"sw " + key}
                    aria-pressed={stage === key}
                    aria-label={label}
                    title={label}
                    onClick={() => setStage(key)}
                  />
                ))}
              </div>
            </div>
            {plan ? (
              <div className="plan" aria-label="确认要出的图">
                <p className="plan-head">
                  AI 看了要求，这次出 <b>{plan.items.length}</b> 张。每张的要求可以改，不要的删掉，确认后一起出。
                </p>
                <ol className="plan-list">
                  {plan.items.map((item, n) => {
                    const edit = (patch: Partial<typeof item>) =>
                      setPlan((p) => p && { ...p, items: p.items.map((x) => (x.key === item.key ? { ...x, ...patch } : x)) });
                    return (
                      <li key={item.key}>
                        <div className="plan-row">
                          <span className="plan-no">{n + 1}</span>
                          <input
                            aria-label={`第 ${n + 1} 张的名字`}
                            value={item.name}
                            maxLength={20}
                            disabled={busy}
                            onChange={(e) => edit({ name: e.target.value })}
                          />
                          <button
                            className="button sm"
                            disabled={busy || plan.items.length === 1}
                            onClick={() =>
                              setPlan((p) => p && { ...p, items: p.items.filter((x) => x.key !== item.key) })
                            }
                          >
                            移除
                          </button>
                        </div>
                        <textarea
                          aria-label={`第 ${n + 1} 张的要求`}
                          rows={3}
                          value={item.text}
                          disabled={busy}
                          onChange={(e) => edit({ text: e.target.value })}
                        />
                      </li>
                    );
                  })}
                </ol>
              </div>
            ) : (
              <div className={"preview" + (round.length > 1 ? " has-strip" : "")}>
                <div className={"thumb stage-" + stage}>
                  {file ? (
                    <img src={assetURL(file.asset)} alt="制作结果" />
                  ) : (
                    <div className="empty">
                      <h3>{job ? statusText(job.status) : "图稿将在这里显示"}</h3>
                      <p>
                        {job?.error ||
                          "添加参考图、写好要求，点左下「开始制作」。"}
                      </p>
                    </div>
                  )}
                </div>
                {round.length > 1 && (
                  <div className="strip" role="group" aria-label="这次出的图">
                    {round.map((j, n) => {
                      const f = resultFile(j);
                      return (
                        <button
                          key={j.id}
                          className={"thumb stage-" + stage}
                          aria-pressed={j.id === job?.id}
                          title={`${n + 1}. ${j.name} · ${statusText(j.status)}`}
                          onClick={() => setPick(j.id)}
                        >
                          {f ? (
                            <img src={assetURL(f.asset)} alt={`第 ${n + 1} 张`} />
                          ) : pending(j) ? (
                            <i className="spin" aria-hidden="true" />
                          ) : (
                            <span className="tiny">未出</span>
                          )}
                          <span className="idx">{n + 1}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            {!plan && job?.error && <p className="notice warn tiny">{job.error}</p>}
            {plan ? (
              <div className="col-foot result-tools">
                <button
                  className="button sm primary"
                  disabled={busy || !prices}
                  onClick={() => void confirmPlan()}
                >
                  {busy ? "正在提交…" : `出这 ${plan.items.length} 张`}
                </button>
                <button className="button sm" disabled={busy} onClick={() => setPlan(null)}>
                  先不出
                </button>
                <span className="grow" />
                <span className="tiny muted">
                  {prices?.exempt ? "内部免计费" : prices ? `最多 ${prices.generate * plan.items.length} 积分` : ""}
                </span>
              </div>
            ) : job ? (
            <div className="col-foot result-tools">
              <button
                className="button sm"
                disabled={!file}
                onClick={() => setTarget({ type: "artwork", id: job.id })}
              >
                局部修补
              </button>
              <button
                className="button sm"
                title="把这张当原图，切到无损放大；点「开始制作」才会提交"
                disabled={!file || working}
                onClick={() => void reprocess()}
              >
                变清晰
              </button>
              <button
                className="button sm"
                title="这张的要求再做一张，另算一次制作"
                disabled={!active || !job || working || !prices}
                onClick={() => void again()}
              >
                再来一张
              </button>
              <span className="grow" />
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
                  download={round.length > 1 ? `独立图稿-${round.indexOf(job) + 1}.png` : "独立图稿.png"}
                >
                  下载 PNG
                </a>
              ) : (
                <button className="button sm" disabled>
                  下载 PNG
                </button>
              )}
            </div>
            ) : null}
          </section>
          {hasHistory && (
          <section className="col col-right" aria-label="我的图稿">
            <div className="col-head">
              <h3>我的图稿</h3>
              <span className="tiny muted">{cases.length ? `${cases.length} 个` : ""}</span>
            </div>
            <div className="col-body hist-list">
              {visible.map((c) => {
                const r = roundOf(c),
                  j = r[0],
                  f = resultFile(r.find((x) => resultFile(x))),
                  busyCase = j ? r.some(pending) : c.analysis?.status === "running";
                return (
                  <button
                    className={
                      "hist " + (c.caseId === active?.caseId ? "active" : "")
                    }
                    key={c.caseId}
                    disabled={working}
                    onClick={() => selectCase(c)}
                  >
                    <div className="thumb">
                      {f ? (
                        <img src={assetURL(f.asset)} alt="" loading="lazy" />
                      ) : busyCase ? (
                        <i className="spin" aria-hidden="true" />
                      ) : (
                        "—"
                      )}
                    </div>
                    <div>
                      <div className="t">{caseTitle(c)}</div>
                      <div className="s">
                        <span className={"state " + (busyCase ? "run" : j?.status === "returned" ? "ok" : "")}>
                          {historyStatus(c)}
                        </span>
                        {j?.transparentBackground && <span>透明</span>}
                        <span>{when(j?.createdAt)}</span>
                      </div>
                    </div>
                  </button>
                );
              })}
              {shown.length > visible.length && (
                <button className="button sm full" onClick={() => setAllHistory(true)}>
                  显示更早的 {shown.length - visible.length} 条
                </button>
              )}
              {!shown.length && <p className="small muted">正在读取…</p>}
            </div>
          </section>
          )}
        </div>
      </main>
      <SaasEditors target={target} onClose={close} onSaved={saved} />
    </div>
  );
}
