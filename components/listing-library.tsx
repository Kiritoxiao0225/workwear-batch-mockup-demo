"use client";
/* eslint-disable @next/next/no-img-element -- sample images are static files */
/**
 * 电商主图 母版库: the built-in masters, each with its five sample images (made by us with the same
 * garment), its font, colours and who it suits. Each product's master is picked by the AI from its
 * material; the plan can still switch.
 */
import type { LayoutCard } from "@/lib/listing/api-types";
import { masterInfo } from "@/lib/listing/scene";

const TASKS = ["首图", "店铺服务图", "功能", "细节", "收口"];

export function MasterLibrary({ layouts }: { layouts: LayoutCard[] }) {
  const masters = layouts.filter(l => !l.own);
  return (
    <section className="lp-mlib">
      <div className="lp-phead"><h1>母版库</h1><p>每套母版定好了风格、字体和每张图的排法。下面是同一款冲锋衣用不同母版出的效果。</p></div>
      <div className="lp-seg"><button type="button" className="on">冲锋衣<b>{masters.length}</b></button><button type="button" disabled>更多品类陆续上线</button></div>
      {masters.map(l => {
        const info = masterInfo(l.id);
        return (
          <article key={l.id} className="lp-card lp-lrow">
            <div className="info">
              <h2>{l.name}</h2>
              <p>{l.description}</p>
              <dl className="kv">
                <dt>字体</dt><dd>{info.font}</dd>
                <dt>色调</dt><dd><span className="pal">{info.palette.map(c => <i key={c} style={{ background: c }} />)}</span></dd>
                <dt>适合</dt><dd>{info.fit}</dd>
                <dt>首图</dt><dd>{info.cover === "实景" ? "实景，AI 按素材选在哪儿拍" : info.cover === "棚拍" ? "棚拍，不用选地点" : "不用模特，每张更便宜"}</dd>
              </dl>
            </div>
            <div className="strip">{l.samples.map((src, i) => <figure key={src}><img src={src} alt={`${l.name} ${TASKS[i]}`} loading="lazy" /><figcaption>{TASKS[i]}</figcaption></figure>)}</div>
          </article>
        );
      })}
      <p className="lp-muted lp-small">每一款由 AI 看素材挑母版和首图在哪儿拍，定方案时还能换。</p>
    </section>
  );
}
