"use client";
import { useCallback, useEffect, useRef, useState } from "react";
export type ArtworkOutput = { ratio: import("../artwork-output-size").OutputRatio; resolution: import("../artwork-output-size").OutputResolution };
/** 出图通道: cliproxy is 新通道 (Codex relay), evolink 原通道. */
export type ImageProvider = "cliproxy" | "evolink";
export type Artwork = {
  id: string;
  name: string;
  route: "generate" | "enhance" | "reuse";
  transparentBackground?: boolean;
  /** 输出规格; absent on artworks made before it existed (the model chose the size). */
  output?: ArtworkOutput;
  /** Absent: the configured default route. */
  provider?: ImageProvider;
  prompt: string;
  imageIds: string[];
  applications: { style: string; color: string; position: string }[];
};
export type Draft = {
  artworks: Artwork[];
  readingIssues: { scope: string; issue: string }[];
};
export type ResultFile = {
  asset: string;
  sha256: string;
  bytes?: number;
  width?: number;
  height?: number;
};
export type Job = {
  id: string;
  revision: number;
  artworkId: string;
  name: string;
  route: Artwork["route"];
  transparentBackground?: boolean;
  status: string;
  error?: string;
  createdAt: string;
  final?: ResultFile;
  raw?: ResultFile;
  repair?: { file: ResultFile };
  output?: ArtworkOutput;
  warning?: string;
  provider?: ImageProvider;
  /** Jobs made before 出图通道 existed record their route only here. */
  policy?: { generation?: { provider?: string } };
  steps?: { name: string; status: string; elapsedMs?: number }[];
};
export type Case = {
  caseId: string;
  sourceRecordId?: string;
  entry?: string;
  sourceText: string;
  sourceRevision?: number;
  active: boolean;
  needsReanalysis: boolean;
  revision: number;
  images: {
    id: string;
    index: number;
    label: string;
    asset: string;
    source: string;
    sha256?: string;
  }[];
  supplement: { revision: number };
  draft: Draft | null;
  modelDraft: Draft | null;
  analysis: {
    id: string;
    status: string;
    error?: string;
    proposedDraft?: Draft;
    /** 图稿生成: how many pictures the request asks for, decided before any is made. */
    mode?: "plan";
    plan?: { name: string; text: string }[] | null;
  } | null;
  productions: Job[];
  cost?: CaseCost | null;
  mockups: {
    revision: number;
    cards: {
      id: string;
      status: string;
      style: string;
      color: string;
      render?: ResultFile;
      warnings?: string[];
      garment?: { style: string; color: string };
    }[];
  };
};
export type CostStep = { name: string; cny: number; credits?: number; provider: string; method: string };
export type CostAnalysis = { cny: number; credits?: number; provider: string; model?: string; promptTokens?: number; completionTokens?: number };
/** Supplier cost; the server includes it for internal workspaces only. */
export type CaseCost = {
  analysisCNY: number;
  analyses: CostAnalysis[];
  artworks: Record<string, { name: string; cny: number; runs: number; steps: CostStep[] }>;
  productionCNY: number;
  totalCNY: number;
  pending: boolean;
};
export type Workbench = { cases: Case[]; workerOnline: boolean; costSummary?: { day: string; todayCNY: number; todayCases: number } };

// Same wording as the WPS workbench: muted text, breakdown in the tooltip.
export const yuan = (v: number) => "¥" + (v < 0.1 ? v.toFixed(3) : v.toFixed(2));
const stepName: Record<string, string> = { generate: "生图", cutout: "抠图", enhance: "放大" };
const costLine = (x: { provider: string; method?: string; cny: number; credits?: number }) =>
  x.provider === "codex" ? "Codex 不计费" : x.method === "receipt_pending" ? "计费中" :
    yuan(x.cny) + (x.credits != null ? `（${x.credits} cr）` : x.method === "unit_price" ? "（按单价）" : "");
export type CostLabel = { text: string; title: string } | null;
export function analysisCost(c: Case): CostLabel {
  const list = c.cost?.analyses || [];
  if (!list.length) return null;
  const sum = list.reduce((t, x) => t + x.cny, 0);
  return {
    text: list.every((x) => x.provider === "codex") ? "Codex 不计费" : `理解 ${yuan(sum)}` + (list.length > 1 ? `（识别 ${list.length} 次）` : ""),
    title: list.map((x, i) => `第 ${i + 1} 次理解 · ${x.model || ""} · ${costLine(x)}` + (x.promptTokens ? ` · ${x.promptTokens}/${x.completionTokens} token` : "")).join("\n"),
  };
}
export function artworkCost(c: Case, artworkId: string, job?: Job): CostLabel {
  const art = c.cost?.artworks[artworkId];
  if (!art) return c.cost !== undefined && job?.status === "failed" ? { text: "失败未扣费", title: "供应商明确拒绝，不收费" } : null;
  const pending = art.steps.some((x) => x.method === "receipt_pending");
  return {
    text: pending ? "计费中…" : art.steps.every((x) => x.provider === "codex") ? "Codex 不计费" : yuan(art.cny) + (art.runs > 1 ? `（制作 ${art.runs} 次）` : ""),
    title: art.steps.map((x) => `${stepName[x.name] || x.name} · ${costLine(x)}`).join("\n"),
  };
}
export function totalCost(c: Case): CostLabel {
  const k = c.cost;
  if (!k) return null;
  return {
    text: "本条 " + (k.pending ? "计费中…" : yuan(k.totalCNY)),
    title: [`理解 ${yuan(k.analysisCNY)}`, ...Object.values(k.artworks).map((a) => `${a.name} ${yuan(a.cny)}`), `合计 ${yuan(k.totalCNY)}`].join("\n"),
  };
}
export type Prices = {
  analyze: number;
  generate: number;
  enhance: number;
  reuse: number;
  exempt: boolean;
};
export const labels = [
  "主体",
  "文字",
  "字体",
  "颜色",
  "排版",
  "尺寸",
  "输出",
] as const;
export const assetURL = (asset: string) => "/api/batch/" + asset;
/** A display copy (at most 1600 px) for showing results; download and editing use assetURL. */
export const previewURL = (asset: string) => assetURL(asset) + "?preview=1";
export async function batchAPI<T = Record<string, unknown>>(
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(
    "/api/batch" + path,
    body === undefined
      ? { cache: "no-store" }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "操作失败，请重试");
  return data;
}
/** Something is still being read or made, so its status is worth checking often. */
const inProgress = (w: Workbench | null) =>
  !!w?.cases.some(
    (c) => c.analysis?.status === "running" || c.productions.some((j) => j.status === "queued" || j.status === "running"),
  );
// Every 5 seconds while something is in progress; otherwise every 30 seconds, plus right away
// when the tab comes back or the page itself started something (reload).
const BUSY_POLL_MS = 5000,
  IDLE_POLL_MS = 30000;
export function useWorkbench() {
  const [data, setData] = useState<Workbench | null>(null),
    [error, setError] = useState("");
  const latest = useRef<Workbench | null>(null),
    reschedule = useRef<() => void>(() => {});
  const reload = useCallback(async () => {
    try {
      const next = await batchAPI<Workbench>("/api/requirements");
      latest.current = next;
      setData(next);
      setError("");
      reschedule.current();
      return next;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, []);
  useEffect(() => {
    let alive = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (alive) timer = setTimeout(() => void read(), inProgress(latest.current) ? BUSY_POLL_MS : IDLE_POLL_MS);
    };
    const read = async () => {
      if (!document.hidden) {
        try {
          const next = await batchAPI<Workbench>("/api/requirements");
          latest.current = next;
          if (alive) {
            setData(next);
            setError("");
          }
        } catch (e) {
          if (alive) setError(e instanceof Error ? e.message : String(e));
        }
      }
      schedule();
    };
    const visible = () => {
      if (!document.hidden) {
        clearTimeout(timer);
        void read();
      }
    };
    reschedule.current = schedule;
    void read();
    document.addEventListener("visibilitychange", visible);
    return () => {
      alive = false;
      clearTimeout(timer);
      reschedule.current = () => {};
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  return { data, error, reload };
}
export function usePrices() {
  const [prices, setPrices] = useState<Prices | null>(null);
  useEffect(() => {
    let alive = true;
    void batchAPI<Prices>("/api/prices")
      .then((p) => {
        if (alive) setPrices(p);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return prices;
}
export const chargeLabel = (
  prices: Prices | null,
  kind: keyof Omit<Prices, "exempt">,
) =>
  prices
    ? prices.exempt
      ? "内部免计费"
      : `最多 ${prices[kind]} 积分`
    : "读取计价中";
export async function uploadImages(files: File[]) {
  if (files.length > 10) throw new Error("最多 10 张素材图");
  const results: { uploadId: string; chunkCount: number; name: string }[] = [];
  for (const file of files) {
    if (file.size === 0 || file.size > 15 * 1024 * 1024)
      throw new Error(`${file.name} 必须在 1B–15MB 之间`);
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
      throw new Error("请使用 PNG、JPG 或 WebP 图片");
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = () => reject(new Error("图片读取失败"));
      reader.readAsDataURL(file);
    });
    const uploadId = crypto.randomUUID(),
      size = 1400000,
      chunkCount = Math.ceil(base64.length / size);
    // Chunks are stored by index, so three go up at a time instead of one after another.
    let next = 0;
    const send = async () => {
      for (let index = next++; index < chunkCount; index = next++)
        await batchAPI("/api/cases/image", {
          id: uploadId,
          index,
          count: chunkCount,
          base64: base64.slice(index * size, (index + 1) * size),
        });
    };
    await Promise.all(Array.from({ length: Math.min(3, chunkCount) }, send));
    results.push({ uploadId, chunkCount, name: file.name });
  }
  return results;
}
export const resultFile = (job?: Job) =>
  job?.repair?.file || job?.final || job?.raw;
export const statusText = (status?: string) =>
  ({
    returned: "已完成",
    queued: "排队中",
    running: "制作中",
    blocked: "已阻塞",
    failed: "失败",
    partial: "部分完成",
    unknown: "结果未知",
    invalid_output: "识别结果待核对",
  })[status || ""] || "草稿";
export async function copyImage(asset: string) {
  const r = await fetch(assetURL(asset));
  if (!r.ok) throw new Error("图片读取失败");
  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": await r.blob() }),
  ]);
}
