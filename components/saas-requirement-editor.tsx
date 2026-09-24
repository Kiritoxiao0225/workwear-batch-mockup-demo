"use client";
import { useEffect, useRef, useState } from "react";
import {
  batchAPI,
  labels,
  type Case,
  type Draft,
} from "@/lib/client/saas-workbench";
export function splitPrompt(prompt: string) {
  const matches = [
    ...prompt.matchAll(/^(主体|文字|字体|颜色|排版|尺寸|输出)：/gmu),
  ];
  return {
    prefix: prompt.slice(0, matches[0]?.index ?? prompt.length),
    parts: matches.map((m, i) => {
      const raw = prompt.slice(
          m.index! + m[0].length,
          matches[i + 1]?.index ?? prompt.length,
        ),
        gap = raw.match(/(?:\r?\n)*$/u)![0];
      return { label: m[1], value: raw.slice(0, raw.length - gap.length), gap };
    }),
  };
}
export function RequirementEditor({
  item,
  onSaved,
  onPending,
}: {
  item: Case;
  onSaved: () => void;
  onPending: (pending: boolean) => void;
}) {
  const [draft, setDraft] = useState(item.draft!),
    [selected, setSelected] = useState(item.draft?.artworks[0]?.id),
    [status, setStatus] = useState("已保存");
  const current = useRef(item),
    latest = useRef(draft),
    dirty = useRef(false),
    flight = useRef<Promise<void> | null>(null),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!dirty.current && !flight.current) current.current = item;
  }, [item]);
  useEffect(() => {
    if (!dirty.current && !flight.current && item.draft) {
      latest.current = item.draft;
      setDraft(item.draft);
    }
  }, [item]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  async function save() {
    if (flight.current) {
      await flight.current;
      return;
    }
    if (!dirty.current) return;
    const sent = structuredClone(latest.current);
    let successful = false;
    dirty.current = false;
    setStatus("保存中…");
    flight.current = (async () => {
      try {
        const r = await batchAPI<{ revision: number }>(
          "/api/requirements/save",
          {
            caseId: item.caseId,
            revision: current.current.revision,
            supplementRevision: current.current.supplement.revision,
            draft: sent,
          },
        );
        current.current = {
          ...current.current,
          revision: r.revision,
          draft: sent,
        };
        successful = true;
        setStatus(dirty.current ? "待保存" : "已保存");
        if (!dirty.current) {
          onPending(false);
          onSaved();
        }
      } catch (e) {
        dirty.current = true;
        setStatus("保存失败：" + (e instanceof Error ? e.message : String(e)));
      } finally {
        flight.current = null;
      }
    })();
    await flight.current;
    if (dirty.current && successful) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void save(), 700);
    }
  }
  function change(next: Draft) {
    onPending(true);
    latest.current = next;
    dirty.current = true;
    setDraft(next);
    setStatus("待保存");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), 700);
  }
  const art =
    draft.artworks.find((a) => a.id === selected) || draft.artworks[0];
  if (!art) return <p className="muted">没有图稿，请核对识别结果。</p>;
  const parsed = splitPrompt(art.prompt),
    baseline = item.modelDraft?.artworks.find((a) => a.id === art.id);
  return (
    <>
      <div className="tabs-mini">
        {draft.artworks.map((a) => (
          <button
            key={a.id}
            aria-pressed={a.id === art.id}
            onClick={() => setSelected(a.id)}
          >
            {a.name}
          </button>
        ))}
      </div>
      <dl className="seven-view">
        {parsed.parts.map((p, i) => (
          <div key={p.label}>
            <dt>{p.label}</dt>
            <dd>
              <textarea
                aria-label={`${item.caseId} ${p.label}`}
                rows={p.label === "文字" ? 2 : 1}
                className={
                  baseline &&
                  splitPrompt(baseline.prompt).parts[i]?.value !== p.value
                    ? "edited"
                    : ""
                }
                value={p.value}
                onChange={(e) =>
                  change({
                    ...draft,
                    artworks: draft.artworks.map((a) =>
                      a.id === art.id
                        ? {
                            ...a,
                            prompt:
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
                          }
                        : a,
                    ),
                  })
                }
              />
            </dd>
          </div>
        ))}
      </dl>
      <label className="tiny muted">
        制作方式{" "}
        <select
          aria-label={`${item.caseId} 制作方式`}
          value={art.route}
          onChange={(e) =>
            change({
              ...draft,
              artworks: draft.artworks.map((a) =>
                a.id === art.id
                  ? { ...a, route: e.target.value as typeof art.route }
                  : a,
              ),
            })
          }
        >
          <option value="generate">生图</option>
          <option value="enhance">无损放大</option>
          <option value="reuse">直接复用</option>
        </select>
      </label>
      <p className="autosave" role="status">
        700ms 自动保存 · {status} · 红色加粗＝人工改过
      </p>
      {status.startsWith("保存失败") && (
        <button className="button sm" onClick={() => void save()}>
          重试保存
        </button>
      )}
      {draft.readingIssues.map((x, i) => (
        <p className="notice warn tiny" key={i}>
          {x.scope}：{x.issue}
        </p>
      ))}
    </>
  );
}
export function authoredPrompt(text: string, transparentBackground = false) {
  const background = transparentBackground
    ? "背景设置：输出透明背景 PNG，只保留主体，不保留外部场景背景。"
    : "背景设置：按制作要求保留背景或使用场景，不强制透明背景。";
  if (labels.every((label) => new RegExp("^" + label + "：", "m").test(text))) {
    // Replace only our own output defaults/settings; preserve authored details.
    const cleaned = text
      .replace(/\n背景设置：(输出透明背景 PNG，只保留主体，不保留外部场景背景。|按制作要求保留背景或使用场景，不强制透明背景。)/gu, "")
      .replace("输出：一张独立透明底 PNG 图稿，不包含服装或效果图模板。", "输出：一张 PNG 图片。");
    return (/^【[^\n]+】\r?\n/u.test(cleaned) ? cleaned : "【独立图稿】\n\n" + cleaned) + "\n" + background;
  }
  return (
    "【独立图稿】\n\n主体：" +
    text +
    "\n\n文字：按上述制作要求，未指定不新增文字\n\n字体：按上述制作要求，未指定沿用参考图\n\n颜色：按上述制作要求，未指定沿用参考图\n\n排版：按上述制作要求\n\n尺寸：客户未指定尺寸\n\n输出：一张 PNG 图片。\n" + background
  );
}
