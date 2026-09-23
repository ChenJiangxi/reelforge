// 产品页镜头:录下来的真实页面,在手机样机里(或铺满画面)按念到的时刻滚动、推近、划金线、光标双击。
// 这是她点名认可的「手机里放产品、光标像敲黑板一样展示」(ops-bilibili lingban-shadow-4angles)。
import React from "react";
import { Img, staticFile } from "remotion";
import { useF, useShot, ramp, clamp01 } from "../kit";
import { phoneGeom, pageGeom, planPage } from "../page.mjs";

type Tile = { src: string; y: number; h: number };
type Layout = { cssW: number; cssH: number; viewportH: number; tiles: Tile[]; leaves: unknown[] };
type P = { page?: string; mode?: "phone" | "page"; focus?: string[]; __page?: Layout };

const GOLD = "#F0D9A0";
const srcOf = (s: string) => (/^(\/|https?:|data:|blob:)/.test(s) ? s : staticFile(s));

export const PageShot: React.FC<{ p: P }> = ({ p }) => {
  const f = useF();
  const { stage, dur, cues, th } = useShot();
  const layout = p.__page;
  const W = stage.W;
  const H = stage.H;
  if (!layout?.tiles?.length) {
    return (
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: th.muted, fontFamily: th.sans, fontSize: 36 }}>
        产品页「{p.page ?? "?"}」还没录
      </div>
    );
  }
  const phone = p.mode !== "page";
  const g = phone ? phoneGeom(W, H, layout) : pageGeom(W, H, layout);
  const plan = planPage(layout as never, p, dur, cues, g, stage);
  const t = plan.track(f);
  const Z = phone ? 1.85 : 1.55;
  const zt = clamp01((t.z - 1) / (Z - 1));
  // 页面坐标 → 舞台坐标
  const toStage = (x: number, y: number) => ({ x: g.left + x * g.s, y: g.top + (y - t.scrollY) * g.s });
  // 推近时横向尽量留住整屏宽度(字在左边也别把右边的分数推出画),屏幕比画面宽了才跟着字走
  const visCss = W / (t.z * g.s);
  const fxC = visCss >= layout.cssW ? layout.cssW / 2 : Math.max(visCss / 2, Math.min(layout.cssW - visCss / 2, t.fx));
  const focus = toStage(fxC, t.fy);
  const screenCy = g.top + g.screenH / 2;
  const anchorY = screenCy + (H * 0.4 - screenCy) * zt;
  const cam = (x: number, y: number) => ({ x: (x - focus.x) * t.z + W / 2, y: (y - focus.y) * t.z + anchorY });
  const camT = `translate(${W / 2 - focus.x * t.z}px, ${anchorY - focus.y * t.z}px) scale(${t.z})`;

  // 只画看得见的切片
  const visTop = t.scrollY - 400;
  const visBot = t.scrollY + g.vpH + 400;
  const tiles = layout.tiles.filter((tl) => tl.y + tl.h > visTop && tl.y < visBot);

  const pageLayer = (
    <div style={{ position: "absolute", left: 0, top: 0, width: layout.cssW * g.s, height: layout.cssH * g.s, transform: `translateY(${-t.scrollY * g.s}px)` }}>
      {tiles.map((tl) => (
        <Img key={tl.src} src={srcOf(tl.src)} style={{ position: "absolute", left: 0, top: tl.y * g.s, width: layout.cssW * g.s, height: tl.h * g.s }} />
      ))}
      {/* 金色下划线:念到哪条划哪条,跟着页面滚动和推近 */}
      {plan.marks.map((m, k) => {
        const k2 = ramp(f, m.at, m.at + 10);
        if (k2 <= 0) return null;
        return m.rects.map((r: { x: number; y: number; w: number; h: number }, j: number) => (
          <div
            key={`${k}-${j}`}
            style={{
              position: "absolute",
              left: r.x * g.s,
              top: (r.y + r.h) * g.s + 1,
              width: r.w * g.s * k2,
              height: Math.max(3, 2.2 * g.s),
              borderRadius: 3,
              background: GOLD,
              boxShadow: `0 0 ${6 * g.s}px ${GOLD}`,
            }}
          />
        ));
      })}
    </div>
  );

  // 光标:画在镜头之后(大小不随推近乱变),停在点击点上
  const tapsDone = plan.taps.filter((tp) => f >= tp.at - 20);
  const next = plan.taps.find((tp) => f < tp.at + 2) ?? plan.taps[plan.taps.length - 1];
  let cursor = null;
  if (phone && next) {
    const prev = [...plan.taps].reverse().find((tp) => tp.at <= f) ?? null;
    const from = prev ?? { x: layout.cssW * 0.72, y: t.scrollY + g.vpH * 0.72 };
    const moveK = ramp(f, next.at - 18, next.at - 2);
    const px = from.x + (next.x - from.x) * moveK;
    const py = from.y + (next.y - from.y) * moveK;
    const sp = toStage(px, py);
    const c = cam(sp.x, sp.y);
    const press = plan.taps.some((tp) => f >= tp.at && f < tp.at + 6) ? 0.82 : 1;
    const show = ramp(f, 4, 14);
    cursor = (
      <svg width={56} height={72} viewBox="0 0 28 36" style={{ position: "absolute", left: c.x - 6, top: c.y - 4, opacity: show, transform: `scale(${press})`, transformOrigin: "6px 4px", filter: "drop-shadow(0 4px 8px rgba(0,0,0,.6))" }}>
        <path d="M3 2 L3 28 L10 21 L15 33 L20 31 L15 19 L25 19 Z" fill="#FFFFFF" stroke="#0B1017" strokeWidth={2} strokeLinejoin="round" />
      </svg>
    );
  }
  const ripples = tapsDone.map((tp, k) => {
    const age = f - tp.at;
    if (age < 0 || age > 16) return null;
    const sp = toStage(tp.x, tp.y);
    const c = cam(sp.x, sp.y);
    const r = 10 + (62 * age) / 16;
    return <div key={k} style={{ position: "absolute", left: c.x - r, top: c.y - r, width: r * 2, height: r * 2, borderRadius: "50%", border: `${Math.max(2, 5 - age / 4)}px solid ${GOLD}`, opacity: 1 - age / 16 }} />;
  });

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <div style={{ position: "absolute", inset: 0, transform: camT, transformOrigin: "0 0" }}>
        {phone ? (
          <>
            {/* 手机壳 */}
            <div
              style={{
                position: "absolute",
                left: g.left - g.bezel,
                top: g.top - g.bezel,
                width: g.screenW + g.bezel * 2,
                height: g.screenH + g.bezel * 2,
                borderRadius: g.screenW * 0.14,
                background: "linear-gradient(160deg, #3A3F4A 0%, #15181E 55%, #2A2E36 100%)",
                boxShadow: "0 40px 90px rgba(0,0,0,.55)",
              }}
            />
            <div style={{ position: "absolute", left: g.left, top: g.top, width: g.screenW, height: g.screenH, borderRadius: g.screenW * 0.115, overflow: "hidden", background: "#000" }}>
              {pageLayer}
              {/* 灵动岛 */}
              <div style={{ position: "absolute", left: g.screenW / 2 - g.screenW * 0.135, top: g.screenW * 0.025, width: g.screenW * 0.27, height: g.screenW * 0.06, borderRadius: 99, background: "#000" }} />
            </div>
          </>
        ) : (
          <div style={{ position: "absolute", left: 0, top: 0, width: W, height: H, overflow: "hidden" }}>{pageLayer}</div>
        )}
      </div>
      {ripples}
      {cursor}
    </div>
  );
};
