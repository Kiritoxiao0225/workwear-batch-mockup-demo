"use client";
/**
 * 店铺设置「SKU 图角标」(10-26): the short tag on the shop's SKU images, what it says and where it goes.
 * The top-left corner is the shop LOGO's place: a badge there takes it on the SKU images (the main
 * images keep their LOGO). A small sketch of the SKU image shows where it lands.
 */
import { useState } from "react";
import { SKU_BADGE_MAX, SKU_BADGE_PLACES, SKU_BADGE_PRESETS, type SkuBadge, type SkuBadgePlace } from "@/lib/listing/service";

const WHERE: Record<SkuBadgePlace, string> = {
  title: "标题下面，和以前一样",
  corner: "SKU 图左上角；这时 SKU 图不放店铺 LOGO，主图照样放",
  right: "SKU 图右上角，压在模特图上",
  off: "SKU 图上不放角标",
};

export function SkuBadgeSection({ badge, logo, onSave }: { badge: SkuBadge; logo: boolean; onSave: (badge: SkuBadge) => void }) {
  const [own, setOwn] = useState(badge.text && !SKU_BADGE_PRESETS.includes(badge.text) ? badge.text : "");
  const words = badge.text || "男女同款";
  const pick = (text: string) => { if (text !== badge.text) onSave({ ...badge, text }); };
  return (
    <section className="lp-ann" id="lp-s-badge">
      <div><h2>SKU 图角标</h2><p>SKU 图上一个黑底白字的小标签，比如「男女同款」「新品上市」。</p>
        <p className="lp-small">左上角是店铺 LOGO 的位置：角标放左上角，SKU 图就不放 LOGO，二选一。</p>
        <p className="lp-small">改了以后新出的 SKU 图就按新的来；已经出好的款，在看图页「更多操作」里点「按店铺设置重拼 SKU 图」，免费。</p></div>
      <div className="lp-card lp-pad lp-badge">
        <h3>放在哪</h3>
        <div className="lp-badge-places">{SKU_BADGE_PLACES.map(([id, name]) => (
          <button type="button" key={id} className={"lp-pick" + (badge.place === id ? " on" : "")} onClick={() => { if (badge.place !== id) onSave({ ...badge, place: id }); }}>
            <b>{name}</b><span>{WHERE[id]}</span>
          </button>))}</div>
        {badge.place !== "off" && <>
          <h3>写什么</h3>
          <div className="lp-badge-words">
            <button type="button" className={"lp-chip" + (!badge.text ? " on" : "")} onClick={() => pick("")}>自动：男女都有时写「男女同款」</button>
            {SKU_BADGE_PRESETS.map(t => <button type="button" key={t} className={"lp-chip" + (badge.text === t ? " on" : "")} onClick={() => pick(t)}>{t}</button>)}
          </div>
          <div className="lp-badge-own">
            <input value={own} maxLength={SKU_BADGE_MAX} placeholder={`自己写，最多 ${SKU_BADGE_MAX} 个字`} aria-label="自己写角标" onChange={e => setOwn(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && own.trim()) pick(own.trim()); }} />
            <button type="button" className="lp-btn sm" disabled={!own.trim() || own.trim() === badge.text} onClick={() => pick(own.trim())}>用这个</button>
          </div>
          <p className="lp-muted lp-small">{badge.text ? `每一款的 SKU 图都写「${badge.text}」。` : "只有素材里男女模特都有的款才放；别的款不放。"}</p>
        </>}
        <div className="lp-badge-sketch" aria-hidden="true">
          <div className="left">
            {badge.place === "corner" ? <span className="tag">{words}</span> : logo ? <span className="logo">店铺 LOGO</span> : <span className="logo blank" />}
            <i className="title" /><i className="title short" />
            {badge.place === "title" ? <span className="tag">{words}</span> : <i className="bar" />}
            <i className="row" /><i className="row" /><i className="card" />
          </div>
          <div className="photo">{badge.place === "right" && <span className="tag">{words}</span>}<span className="who">模特图</span></div>
        </div>
      </div>
    </section>
  );
}
