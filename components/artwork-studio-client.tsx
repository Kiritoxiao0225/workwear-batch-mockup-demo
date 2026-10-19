"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppHeader } from "./app-header";
import { PageHeader } from "./page-header";
import { OUTPUT_RATIOS, OUTPUT_RESOLUTIONS, outputSize, type OutputRatio, type OutputResolution, type Size } from "@/lib/artwork-output-size";
import { SaasEditors } from "./saas-editors";
import { authoredPrompt, splitPrompt } from "./saas-requirement-editor";
import {
  assetURL,
  batchAPI,
  chargeLabel,
  copyImage,
  previewURL,
  resultFile,
  statusText,
  uploadImages,
  usePrices,
  useWorkbench,
  type Artwork,
  type Case,
  type Job,
  type ArtworkOutput,
  type ImageProvider,
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
  /** The file's SHA-256, so a picture the server already holds is named instead of sent again. */
  sha256?: string;
};
type Stage = "checker" | "white" | "dark";
// What AI read from the request: one entry per picture, waiting for the author to confirm.
type Plan = { caseId: string; items: { key: string; name: string; text: string }[] };
type Submit = { name: string; prompt: string; route: Artwork["route"]; transparentBackground: boolean; output?: ArtworkOutput; provider?: ImageProvider };
// 出图通道, so authors can compare the Codex relay with EvoLink while the relay is on trial.
const PROVIDERS = [
  ["cliproxy", "新通道"],
  ["evolink", "原通道"],
] as const;
const PROVIDER_KEY = "mockfits.studio.provider";
const providerOf = (j?: Job) => {
  if (j?.route !== "generate") return null;
  const p = j.provider ?? j.policy?.generation?.provider;
  return p === "cliproxy" || p === "evolink" ? p : null;
};
/** Which route drew the picture and how long the drawing itself took. */
function channelText(j?: Job) {
  const p = providerOf(j);
  if (!p) return "";
  const drawn = [...(j?.steps || [])].reverse().find((s) => s.name === "generate" && s.status === "returned");
  return PROVIDERS.find(([key]) => key === p)![1] + (drawn?.elapsedMs ? ` · 出图 ${Math.round(drawn.elapsedMs / 1000)} 秒` : "");
}
const specLabel = (o: ArtworkOutput) => `${o.ratio === "original" ? "原比例" : o.ratio} · ${o.resolution}`;
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
const ENHANCE_TEXT = "使用图1完整图稿，只提升清晰度，保持原有图形、文字、字体、配色和布局。";
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
    [picked, setProvider] = useState<ImageProvider>("cliproxy"),
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
    [ratio, setRatio] = useState<OutputRatio>("original"),
    [resolution, setResolution] = useState<OutputResolution>("1K"),
    [firstRefSize, setFirstRefSize] = useState<Size | null>(null),
    [stage, setStage] = useState<Stage>("checker"),
    [handoff, setHandoff] = useState<ArtworkHandoff | null>(null);
  // An administrator may hold this account to one route: then that one is used and there is no choice.
  const locked = data?.imageRoute ?? null,
    provider = locked ?? picked;
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
  // The route last picked on this browser.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(PROVIDER_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage exists only after mount.
      if (saved === "cliproxy" || saved === "evolink") setProvider(saved);
    } catch { /* first visit or storage blocked */ }
  }, []);
  const pickProvider = (next: ImageProvider) => {
    setProvider(next);
    try { localStorage.setItem(PROVIDER_KEY, next); } catch { /* optional */ }
  };
  const retarget = (ownerId: string | null, placement?: MockupPlacement) => {
    if (!handoff) return;
    const next = retargetHandoff(handoff, ownerId, placement);
    setHandoff(next);
    writeArtworkHandoff(next);
  };
  const handoffOwner = handoff?.products.find((p) => p.id === handoff.ownerId);
  const firstRefUrl = refs.find((r) => r.index === 1)?.url;
  useEffect(() => {
    if (!firstRefUrl) return;
    let alive = true;
    const img = new Image();
    img.onload = () => alive && setFirstRefSize({ width: img.naturalWidth, height: img.naturalHeight });
    img.src = firstRefUrl;
    return () => {
      alive = false;
    };
  }, [firstRefUrl]);
  const output = outputSize(ratio, resolution, firstRefUrl ? firstRefSize : null);
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
    const added = files.map((f, i) => ({
      key: crypto.randomUUID(),
      index: max + i + 1,
      name: f.name,
      url: URL.createObjectURL(f),
      file: f,
    }));
    setRefs((v) => [...v, ...added]);
    for (const r of added)
      void r.file
        .arrayBuffer()
        .then((bytes) => crypto.subtle.digest("SHA-256", bytes))
        .then((digest) => {
          const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
          setRefs((v) => v.map((x) => (x.key === r.key ? { ...x, sha256 } : x)));
        })
        .catch(() => {});
    setNotice("");
  }
  function selectCase(c: Case) {
    const art = c.draft?.artworks[0],
      // A request AI split into several pictures is shown as it was written.
      split = c.analysis?.mode === "plan",
      // Written as one paragraph and never edited item by item: reopen it as that paragraph,
      // not as the seven items it was expanded into when it was made.
      plain =
        !!art && !sevenFields(c.sourceText) && art.prompt === authoredPrompt(c.sourceText, !!art.transparentBackground),
      prompt = (split || plain ? c.sourceText : art?.prompt) || c.sourceText,
      next = c.images.map((i) => ({
        key: i.id,
        index: i.index,
        name: i.label,
        url: assetURL(i.asset),
        sha256: i.sha256,
      }));
    setSelected(c.caseId);
    setText(prompt);
    setMode(sevenFields(prompt) ? "seven" : "text");
    setRoute(art?.route || "generate");
    setRatio(art?.output?.ratio ?? "original");
    setResolution(art?.output?.resolution ?? "1K");
    if (art?.provider) setProvider(art.provider);
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
    setRatio("original");
    setResolution("1K");
    setPlan(null);
    setPick(null);
    request.current = null;
    organized.current = null;
    setNotice("已新建空白制作要求");
  }
  // Pictures the server already holds: those on any request, plus what this page has uploaded.
  const uploaded = useRef(new Set<string>());
  async function createStudioCase(caseText: string, list: Reference[], requestId: string) {
    const held = new Set([...(data?.cases ?? []).flatMap((c) => c.images.map((i) => i.sha256)), ...uploaded.current]);
    const send = async (reuse: boolean) => {
      const known = (r: Reference) => reuse && !!r.sha256 && held.has(r.sha256);
      const fresh = list.filter((r) => !known(r));
      const uploads = fresh.length ? await uploadImages(await refFiles(fresh)) : [];
      let n = 0;
      const images = list.map((r) => (known(r) ? { sha256: r.sha256, name: r.name } : uploads[n++]));
      const created = await batchAPI<{ caseId: string }>("/api/cases", { text: caseText, images, entry: "studio", requestId });
      for (const r of fresh) if (r.sha256) uploaded.current.add(r.sha256);
      return created.caseId;
    };
    try {
      return await send(true);
    } catch (e) {
      // The server no longer has one of them: send everything in full.
      if (e instanceof Error && e.message.includes("需要重新上传")) return await send(false);
      throw e;
    }
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
      let c = await readCase(await createStudioCase(text, refs, crypto.randomUUID()));
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
        ...(a.output ? { output: a.output } : {}),
        ...(a.provider ? { provider: a.provider } : {}),
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
          output: route === "generate" ? { ratio, resolution } : null,
          provider: route === "generate" ? provider : null,
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
      if (!c) c = await readCase(await createStudioCase(text, refs, request.current.id));
      setSelected(c.caseId);
      setPick(null);
      // An uncertain submit is read back, never turned into a second paid request.
      const prior = c.productions.at(-1);
      if (prior) {
        setNotice("已回读此前提交的任务：" + statusText(prior.status));
        await reload();
        return;
      }
      const single: Submit = { name: "独立图稿", prompt, route, transparentBackground, ...(route === "generate" ? { output: { ratio, resolution }, provider } : {}) };
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
          output: { ratio, resolution },
          provider,
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
      const body = splitPrompt(art.prompt).parts.find((p) => p.label === "主体")?.value.trim(),
        c = await readCase(
          await createStudioCase(
            body || art.prompt,
            active.images.map((i) => ({ key: i.id, index: i.index, name: i.label, url: assetURL(i.asset), sha256: i.sha256 })),
            crypto.randomUUID(),
          ),
        );
      setSelected(c.caseId);
      await submit(c, [
        { name: art.name, prompt: art.prompt, route: art.route, transparentBackground: !!art.transparentBackground, ...(art.output ? { output: art.output } : {}),
          ...(art.route === "generate" ? { provider: locked ?? art.provider ?? provider } : {}) },
      ]);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      running.current = false;
    }
  }
  // 放大到 2K/4K: the picture on screen enlarged as a record of its own, charged as 无损放大. The
  // server copies the result file itself, so nothing is downloaded or uploaded here.
  async function upscaleResult(resolution: "2K" | "4K") {
    if (!file || !job || running.current) return;
    running.current = true;
    setBusy(true);
    setNotice("");
    try {
      const created = await batchAPI<{ caseId: string }>("/api/cases", {
        text: ENHANCE_TEXT,
        images: [{ result: file.asset, sha256: file.sha256, name: `${job.name}.png` }],
        entry: "studio",
        requestId: crypto.randomUUID(),
      });
      const c = await readCase(created.caseId);
      setSelected(c.caseId);
      await submit(c, [
        {
          name: `${job.name} · ${resolution}`,
          prompt: authoredPrompt(ENHANCE_TEXT, !!job.transparentBackground),
          route: "enhance",
          transparentBackground: !!job.transparentBackground,
          output: { ratio: "original", resolution },
        },
      ]);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      running.current = false;
    }
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
  const working = busy || organizing;
  const splitting = split && route === "generate" && mode === "text";
  // A 2K/4K picture shows its 1K drawing, blurred, while the Volcengine upscaler works on it; the
  // download and edit tools wait for the finished picture.
  const jobPending = !!job && pending(job),
    hd = job?.output && job.output.resolution !== "1K" ? job.output.resolution : null,
    upscaling = jobPending && !!file && !!hd,
    longEdge = file?.width && file?.height ? Math.max(file.width, file.height) : 0,
    hdSize =
      upscaling && file?.width && file?.height
        ? (() => {
            const k = (hd === "2K" ? 2048 : 4096) / Math.max(file.width, file.height);
            return { width: Math.round(file.width * k), height: Math.round(file.height * k) };
          })()
        : null;
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
          description="传参考图、写要求，生成 Logo 或图案；做好的图稿可以局部修补、放大到 2K / 4K，下载 PNG。"
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
        <div className="studio">
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
              {route === "generate" && (
                <>
                  {!locked && (
                    <>
                      <div className="field-label">
                        <span>出图通道</span>
                      </div>
                      <div className="seg full" role="group" aria-label="出图通道">
                        {PROVIDERS.map(([key, label]) => (
                          <button key={key} aria-pressed={provider === key} disabled={working} onClick={() => pickProvider(key)}>
                            {label}
                          </button>
                        ))}
                      </div>
                      <p className="sub">
                        {provider === "cliproxy"
                          ? "新通道正在试用，结果旁会显示出图用了几秒；慢或出错时可换原通道再试。"
                          : "原来一直在用的通道。"}
                      </p>
                    </>
                  )}
                  <div className="field-label">
                    <span>输出规格</span>
                  </div>
                  <div className="seg full ratio-seg" role="group" aria-label="比例">
                    {OUTPUT_RATIOS.map(([key, label]) => (
                      <button key={key} aria-pressed={ratio === key} disabled={working} onClick={() => setRatio(key)}>
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="seg full size-seg" role="group" aria-label="像素">
                    {OUTPUT_RESOLUTIONS.map((key) => (
                      <button key={key} aria-pressed={resolution === key} disabled={working} onClick={() => setResolution(key)}>
                        {key}
                      </button>
                    ))}
                  </div>
                  <p className="sub output-size">
                    {output ? (
                      <>
                        将输出 <b>{output.width} × {output.height}</b> px
                        {resolution !== "1K" && "，先出 1K 再用火山高清放大，试用期按 1K 收费"}
                      </>
                    ) : (
                      "没有参考图时比例由模型决定；加了参考图会按图1的比例出。"
                    )}
                  </p>
                </>
              )}
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
                    ? `${file.width} × ${file.height}${hdSize ? ` → ${hdSize.width} × ${hdSize.height}` : ""}${job?.transparentBackground ? " · 透明 PNG" : ""}${channelText(job) ? ` · ${channelText(job)}` : ""}`
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
                    <>
                      <img src={previewURL(file.asset)} alt="制作结果" className={upscaling ? "pending-hd" : undefined} />
                      {upscaling && hdSize && (
                        <div className="stage-wait" role="status">
                          <div>
                            <i className="spin" aria-hidden="true" />
                            <b>正在高清放大到 {hd}</b>
                            <span>
                              {hdSize.width} × {hdSize.height}，约 20–60 秒，好了自动换上
                            </span>
                          </div>
                        </div>
                      )}
                    </>
                  ) : jobPending ? (
                    <div className="empty" role="status">
                      <i className="spin big" aria-hidden="true" />
                      <h3>正在生成</h3>
                      <p>{hd ? `先出图，再高清放大到 ${hd}，一般 1–2 分钟` : "一般 30–60 秒"}；关掉页面也会继续。</p>
                    </div>
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
                            <img src={previewURL(f.asset)} alt={`第 ${n + 1} 张`} />
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
            {!plan && !job?.error && job?.warning && <p className="notice warn tiny">{job.warning}</p>}
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
                disabled={!file || jobPending}
                onClick={() => setTarget({ type: "artwork", id: job.id })}
              >
                局部修补
              </button>
              {(["2K", "4K"] as const).map((r) => (
                <button
                  key={r}
                  className="button sm"
                  title={`高清放大，长边 ${r === "2K" ? 2048 : 4096} px；另算一次无损放大（${chargeLabel(prices, "enhance")}）`}
                  disabled={!file || working || jobPending || longEdge >= (r === "2K" ? 2048 : 4096)}
                  onClick={() => void upscaleResult(r)}
                >
                  放大到 {r}
                </button>
              ))}
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
                disabled={!file || jobPending}
                onClick={() =>
                  void copyImage(file!.asset)
                    .then(() => setNotice("图片已复制"))
                    .catch((e) => setNotice(e.message))
                }
              >
                复制
              </button>
              {file && !jobPending ? (
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
                        <img src={previewURL(f.asset)} alt="" loading="lazy" />
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
                        {j?.output && <span>{specLabel(j.output)}</span>}
                        {j?.transparentBackground && <span>透明</span>}
                        {channelText(j) && <span>{channelText(j)}</span>}
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
              {!shown.length && (
                <p className="small muted">{data ? "做好的图稿会出现在这里，点一条就能接着改。" : "正在读取…"}</p>
              )}
            </div>
          </section>
        </div>
      </main>
      <SaasEditors target={target} onClose={close} onSaved={saved} />
    </div>
  );
}
