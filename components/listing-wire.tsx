"use client";
/**
 * A layout template drawn as boxes: where the title, the tags, the cards and the people go. Shown
 * next to each image on the plan and when a learned layout is checked, so the user sees what the
 * words will fill before anything is made.
 */
import type { Template, ZoneKind } from "@/lib/listing/templates";

const NAME: Record<ZoneKind, string> = { title: "标题", sub: "小字", tag: "标签", card: "格", icon: "图标", person: "人", garment: "衣服", swatch: "色块", badge: "工牌", band: "横条", fabric: "面料铺底" };

export function Wire({ template, ratio = 1, labels, active, width = 92 }: { template: Template; ratio?: number; labels?: Record<string, string>; active?: string; width?: number }) {
  return (
    <div className="lp-wire" style={{ width, aspectRatio: String(ratio) }} aria-hidden>
      {template.zones.map(z => (
        <span key={z.id} className={"z " + z.kind + (active === z.id ? " on" : "")} style={{ left: `${z.box[0]}%`, top: `${z.box[1]}%`, width: `${z.box[2]}%`, height: `${z.box[3]}%` }}>
          {labels?.[z.id] ?? (z.kind === "card" || z.kind === "icon" ? NAME[z.kind] + z.id.replace(/\D/g, "") : NAME[z.kind])}
        </span>))}
    </div>
  );
}

/**
 * One image's layout filled with its own words: the title bar, the tag pills, what each card shows
 * and how, the models and what they do. Bigger than the plain boxes; the zone the user is editing
 * on the right lights up.
 */
export function SlotPreview({ template, texts, active = [], width = 220, ratio = 1 }: {
  template: Template; texts: Record<string, { text: string; note?: string }>; active?: string[]; width?: number; ratio?: number;
}) {
  const height = width / ratio;
  return (
    <div className="lp-prev" style={{ width, aspectRatio: String(ratio) }}>
      {template.zones.map(z => {
        const t = texts[z.id], words = z.kind === "title" || z.kind === "sub" || z.kind === "tag";
        const text = t?.text || (words ? `${NAME[z.kind]}（空）` : z.kind === "card" || z.kind === "icon" ? NAME[z.kind] + z.id.replace(/\D/g, "") : NAME[z.kind]);
        // Words are sized to their zone the way the image will set them: one line if it fits, else two.
        const w = z.box[2] / 100 * width - 6, h = z.box[3] / 100 * height, chars = Math.max(1, [...text].length);
        // Small words and tags stay on one line, shrunk to fit; a title goes to two lines before it shrinks.
        const one = Math.min(h * 0.85, w / chars), size = !words ? undefined
          : z.kind === "title" && one < 8 ? Math.max(6, Math.min(h * 0.42, (w * 2) / chars)) : Math.max(5.5, Math.min(13, one));
        return (
          <span key={z.id} title={[text, t?.note].filter(Boolean).join(" · ")} className={"z " + z.kind + (active.includes(z.id) ? " on" : "") + (t?.text ? "" : " empty")}
            style={{ left: `${z.box[0]}%`, top: `${z.box[1]}%`, width: `${z.box[2]}%`, height: `${z.box[3]}%`, ...(size ? { fontSize: size } : {}) }}>
            <b>{text}</b>{!words && t?.note && <em>{t.note}</em>}
          </span>);
      })}
    </div>
  );
}
