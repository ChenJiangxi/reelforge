"use client";

// 分镜板:每拍 1-4 个镜头,点开一拍 = 实时预览(和渲染机同一套模板)+ 直接改字、换模板、
// 调切点、「换一个」、加减镜头。保存只重做剪辑;改过的拍素材阶段重跑也不会被覆盖。
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Player } from "@remotion/player";
import { Beat, type BeatProps, type ShotSpec } from "@/shots/Shot";
import { estimatedIndex, fromPositions, previewBeat } from "@/shots/timing.mjs";
import { TEMPLATES, TPL, type Field, type Shot } from "@/lib/shot-catalog";
import { IMAGE_STYLE_LABELS, THEME_LABELS } from "@/lib/stages";
import { findText } from "@/shots/page.mjs";

type Asset = { name: string; url: string; kind: string; file?: string };
/** 录好的产品页:切片图地址 + 每段字的位置(预览时塞给「产品页」镜头) */
type PageLayout = { cssW: number; cssH: number; viewportH: number; captured?: string; tiles: { src: string; y: number; h: number }[]; leaves: { t: string; y: number }[] };
type Pages = Record<string, PageLayout>;

/** 素材库里的产品页 → 页面数据(切片地址换成网页能直接读的) */
function usePages(assets: Asset[]): Pages {
  const [pages, setPages] = useState<Pages>({});
  useEffect(() => {
    const list = assets.filter((a) => a.kind === "page");
    if (!list.length) return;
    let alive = true;
    Promise.all(
      list.map(async (a) => {
        const doc = await fetch(a.url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        if (!doc?.tiles) return null;
        const tile = (f: string) => a.url.replace(/[^/?]+\.page\.json(\?.*)?$/, `${encodeURIComponent(f)}$1`);
        const layout: PageLayout = { ...doc, tiles: doc.tiles.map((t: { file: string; y: number; h: number }) => ({ src: tile(t.file), y: t.y, h: t.h })) };
        return [a.name, layout] as const;
      }),
    ).then((rows) => alive && setPages(Object.fromEntries(rows.filter((r): r is readonly [string, PageLayout] => !!r))));
    return () => {
      alive = false;
    };
  }, [assets]);
  return pages;
}
export type ShotBeat = { name: string; text: string; image?: string; shots: Shot[]; mine: boolean };

function sizeOf(aspect: string) {
  if (aspect === "16:9") return { W: 1920, H: 1080 };
  if (aspect === "3:4") return { W: 1080, H: 1440 };
  return { W: 1080, H: 1920 };
}

const labelOf = (s: Shot) => (s.asset ? "素材" : s.tpl === "page" ? `产品页${s.p?.page ? `·${brief(String(s.p.page), 6)}` : ""}` : TPL[s.tpl ?? ""]?.label ?? s.tpl ?? "?");
const brief = (s: string, n = 8) => ([...s].length > n ? `${[...s].slice(0, n).join("")}…` : s);

/** 这一拍在网页上怎么播:按字数估时长(还没按配音对时间) */
function beatProps(text: string, shots: Shot[], theme: string, aspect: string, assets: Asset[], pages: Pages = {}): BeatProps & { frames: number } {
  const { W, H } = sizeOf(aspect);
  const est = previewBeat(text, shots);
  const specs: ShotSpec[] = est.spans.map((sp: { i: number; fromFrame: number; frames: number; cues: (number | null)[] }) => {
    const s = shots[sp.i];
    const a = s.asset ? assets.find((x) => x.name === s.asset) : null;
    const page = s.tpl === "page" ? pages[String(s.p?.page ?? "")] : undefined;
    return {
      tpl: s.tpl ?? "",
      p: page ? { ...(s.p ?? {}), __page: page } : (s.p ?? {}),
      from: sp.fromFrame,
      frames: sp.frames,
      cues: sp.cues.map((c) => (c == null ? NaN : c)),
      asset: s.asset ? { src: a?.url ?? "", kind: a?.kind ?? "video" } : undefined,
    };
  });
  return { theme, W, H, shots: specs, frames: est.frames };
}

function BeatPlayer({ props, width, controls = true }: { props: BeatProps & { frames: number }; width: number; controls?: boolean }) {
  const { W, H, frames } = props;
  return (
    <Player
      component={Beat as unknown as React.FC<Record<string, unknown>>}
      inputProps={props as unknown as Record<string, unknown>}
      durationInFrames={Math.max(1, frames)}
      compositionWidth={W}
      compositionHeight={H}
      fps={30}
      loop
      autoPlay
      controls={controls}
      acknowledgeRemotionLicense
      style={{ width, height: (width * H) / W, borderRadius: 8, overflow: "hidden" }}
    />
  );
}

export function ShotBoard({
  projectId,
  aspect,
  beats,
  theme,
  themeMine,
  imageStyle = "photo",
  imageStyleMine = false,
}: {
  projectId: string;
  aspect: string;
  beats: ShotBeat[];
  theme: string;
  themeMine: boolean;
  imageStyle?: string;
  imageStyleMine?: boolean;
}) {
  const router = useRouter();
  const [sel, setSel] = useState<string | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [sceneOn, setSceneOn] = useState(false);
  useEffect(() => {
    fetch("/api/features")
      .then((r) => (r.ok ? r.json() : {}))
      .then((j: { sceneImages?: boolean }) => setSceneOn(!!j.sceneImages))
      .catch(() => {});
  }, []);
  useEffect(() => {
    fetch(`/api/project/${projectId}/assets?all=1`)
      .then((r) => (r.ok ? r.json() : []))
      .then((a) => setAssets(Array.isArray(a) ? a : []))
      .catch(() => {});
  }, [projectId]);

  const pages = usePages(assets);
  const total = beats.reduce((n, b) => n + b.shots.length, 0);
  const cur = beats.find((b) => b.name === sel) ?? null;

  async function setProject(set: Record<string, string>) {
    setBusy(true);
    const r = await fetch(`/api/project/${projectId}/override`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: set }),
    });
    const j = await r.json().catch(() => ({}));
    setMsg(j.summary ?? j.error ?? null);
    setBusy(false);
    router.refresh();
  }

  return (
    <div className="flex h-full min-h-[58vh] w-full min-w-0 flex-col lg:min-h-0">
      <div className="mb-2 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="font-medium text-foreground">分镜</span>
        <span className="text-muted-foreground">
          {beats.length} 拍 · {total} 个镜头 · 点一拍直接改
        </span>
        <label hidden={!sceneOn} className="ml-auto flex items-center gap-1.5 text-muted-foreground" title="画面镜头(AI 生成的图)用什么风格;换了会重做素材、把所有画面重新生成">
          配图
          <select
            value={imageStyle}
            disabled={busy}
            onChange={(e) => setProject({ imageStyle: e.target.value })}
            className="rounded border border-border bg-background px-1.5 py-0.5 text-foreground"
          >
            {Object.entries(IMAGE_STYLE_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          {imageStyleMine && <span className="text-[10px] text-accent">你定的</span>}
        </label>
        <label className={`${sceneOn ? "" : "ml-auto "}flex items-center gap-1.5 text-muted-foreground`}>
          配色
          <select
            value={theme}
            disabled={busy}
            onChange={(e) => setProject({ theme: e.target.value })}
            className="rounded border border-border bg-background px-1.5 py-0.5 text-foreground"
          >
            {Object.entries(THEME_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          {themeMine && <span className="text-[10px] text-accent">你定的</span>}
        </label>
      </div>
      {msg && <p className="mb-2 shrink-0 text-xs text-accent">{msg}</p>}
      <ol className="grid min-h-0 min-w-0 flex-1 auto-rows-min grid-cols-1 gap-1.5 overflow-y-auto pr-1 sm:grid-cols-2 2xl:grid-cols-3">
        {beats.map((b) => (
          <li key={b.name} className="min-w-0">
            <button
              onClick={() => setSel(b.name)}
              className={`flex h-full w-full min-w-0 items-start gap-2.5 rounded-md border p-1.5 text-left transition ${
                b.name === sel ? "border-accent/70 bg-accent/5" : "border-border hover:border-foreground/25"
              }`}
            >
              {b.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={b.image} alt="" loading="lazy" className="h-16 w-9 shrink-0 rounded-sm border border-border object-cover" />
              ) : (
                <span className="flex h-16 w-9 shrink-0 items-center justify-center rounded-sm border border-dashed border-border text-[9px] text-accent">素材</span>
              )}
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-1.5">
                  <span className="font-mono text-[11px] text-muted-foreground">{b.name}</span>
                  <span className="text-[11px] text-muted-foreground">{b.shots.length} 个镜头</span>
                  {b.mine && <span className="text-[10px] text-accent">你改过</span>}
                </span>
                <span className="mt-0.5 block text-xs leading-snug text-foreground">
                  {b.shots.map((s, k) => (
                    <span key={k}>
                      {k > 0 && <span className="text-muted-foreground"> → </span>}
                      <span className={s.asset ? "text-accent" : ""}>{labelOf(s)}</span>
                    </span>
                  ))}
                </span>
                <span className="mt-0.5 line-clamp-2 block text-[11px] leading-snug text-muted-foreground" title={b.text}>
                  {b.text}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ol>
      {cur && (
        <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/40 p-0 sm:items-center sm:p-6" onClick={() => setSel(null)}>
          <div className="flex max-h-full w-full max-w-5xl flex-col overflow-hidden bg-background shadow-xl sm:rounded-lg" onClick={(e) => e.stopPropagation()}>
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2 text-xs">
              <span className="font-medium text-foreground">改镜头 · {cur.name}</span>
              <span className="text-muted-foreground">保存后只重做剪辑;改过的拍以后不会被 AI 覆盖</span>
              <span className="ml-auto flex gap-1">
                {beats.map((b) => (
                  <button
                    key={b.name}
                    onClick={() => setSel(b.name)}
                    className={`h-5 min-w-5 rounded px-1 font-mono text-[10px] ${b.name === sel ? "bg-foreground text-background" : b.mine ? "text-accent hover:bg-muted" : "text-muted-foreground hover:bg-muted"}`}
                    title={b.text}
                  >
                    {b.name.replace(/^c0?/, "")}
                  </button>
                ))}
                <button onClick={() => setSel(null)} className="ml-2 px-1 text-base leading-none text-muted-foreground hover:text-foreground" title="关掉">
                  ×
                </button>
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <ShotEditor
                key={cur.name}
                projectId={projectId}
                aspect={aspect}
                beat={cur}
                theme={theme}
                assets={assets}
                pages={pages}
                sceneOn={sceneOn}
                onDone={(m) => {
                  setMsg(m);
                  setSel(null);
                  router.refresh();
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ShotEditor({
  projectId,
  aspect,
  beat,
  theme,
  assets,
  pages,
  sceneOn,
  onDone,
}: {
  projectId: string;
  aspect: string;
  beat: ShotBeat;
  theme: string;
  assets: Asset[];
  pages: Pages;
  sceneOn: boolean;
  onDone: (msg: string | null) => void;
}) {
  const [draft, setDraft] = useState<Shot[]>(() => structuredClone(beat.shots));
  const [open, setOpen] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [cands, setCands] = useState<{ index: number; options: Shot[] } | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(beat.shots);
  const props = useMemo(() => beatProps(beat.text, draft, theme, aspect, assets, pages), [beat.text, draft, theme, aspect, assets, pages]);
  const { W, H } = sizeOf(aspect);
  const pw = W > H ? 420 : 270;

  const update = (k: number, s: Shot) => setDraft((d) => d.map((x, i) => (i === k ? s : x)));
  const move = (k: number, dir: -1 | 1) =>
    setDraft((d) => {
      const j = k + dir;
      if (j < 0 || j >= d.length) return d;
      const n = [...d];
      [n[k], n[j]] = [n[j], n[k]];
      // 第一个镜头不需要切点:换到第一位的清掉,换下去的补一个
      n[0] = { ...n[0], from: "" };
      setOpen(j);
      return n;
    });

  async function suggest(k: number, tpl?: string, page?: string) {
    setBusy(tpl ? `fill-${k}` : `sug-${k}`);
    setErr(null);
    const r = await fetch(`/api/project/${projectId}/shots/suggest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ beat: beat.name, index: k, tpl, hint: page ? `用产品页「${page}」,focus 挑页面上和这句台词说的同一件事的字` : undefined }),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(null);
    if (!r.ok) return setErr(j.error ?? "没出来,再点一次");
    const options: Shot[] = (j.options ?? []).map((o: Shot) => ({ ...o, from: k ? draft[k]?.from ?? "" : "" }));
    if (tpl) {
      const pick = page ? options.find((o) => o.p?.page === page) : options[0];
      if (pick) update(k, pick);
      else if (page) setErr("AI 没挑出页面上的字,在下面的页面文字里点几段");
    } else setCands({ index: k, options });
  }

  async function regen(k: number) {
    const s = draft[k];
    setBusy(`img-${k}`);
    setErr(null);
    const r = await fetch(`/api/project/${projectId}/shots/image`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: s.p?.prompt ?? "", who: s.p?.who }),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(null);
    if (!r.ok) return setErr(j.error ?? "没生成出来");
    update(k, { ...s, p: { ...(s.p ?? {}), src: j.src, srcKey: j.srcKey } });
  }

  async function save(reset = false) {
    setBusy("save");
    setErr(null);
    const r = await fetch(`/api/project/${projectId}/shots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reset ? { beat: beat.name, reset: true } : { beat: beat.name, shots: draft }),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(null);
    if (!r.ok) return setErr(j.error ?? "没存上");
    onDone(j.summary ?? null);
  }

  const cleanText = (s: string) => [...s].filter((ch) => !/[\p{P}\p{S}\s]/u.test(ch)).join("");
  const fromOk = (s: string) => !s || cleanText(beat.text).includes(cleanText(s));
  // 切点要按台词先后:后一个镜头的切点在前一个前面,成片里会按均分放(不会乱,但不跟字走)
  const outOfOrder = useMemo(() => {
    const pos = fromPositions(draft, estimatedIndex(beat.text)).map((p: { pos: number | null }) => p.pos);
    let last = -1;
    const bad: number[] = [];
    pos.forEach((p: number | null, k: number) => {
      if (k === 0 || p == null) return;
      if (p <= last) bad.push(k);
      else last = p;
    });
    return bad;
  }, [draft, beat.text]);

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
      <div className="shrink-0 sm:sticky sm:top-0">
        <BeatPlayer props={props} width={pw} />
        <p className="mt-1 max-w-[270px] text-[10px] leading-snug text-muted-foreground">
          这里按字数估的时长;成片里每个镜头踩着配音的字切。
        </p>
      </div>
      <div className="min-w-0 flex-1 space-y-2 text-xs">
        <p className="leading-relaxed text-muted-foreground">
          <span className="font-mono">{beat.name}</span> {beat.text}
        </p>
        {draft.map((s, k) => (
          <div key={k} className={`rounded-md border ${open === k ? "border-accent/50" : "border-border"}`}>
            <div className="flex items-center gap-1.5 px-2 py-1.5">
              <button onClick={() => setOpen(open === k ? -1 : k)} className="min-w-0 flex-1 truncate text-left">
                <span className="text-muted-foreground">镜头 {k + 1} · </span>
                <span className="font-medium text-foreground">{labelOf(s)}</span>
                {k > 0 && (
                  <span className={`ml-1 text-[11px] ${fromOk(s.from ?? "") ? "text-muted-foreground" : "text-destructive"}`}>
                    {s.from ? `念到「${brief(s.from, 8)}」切` : "没设切点(均分)"}
                  </span>
                )}
              </button>
              <IconBtn onClick={() => move(k, -1)} disabled={k === 0} title="往前挪">↑</IconBtn>
              <IconBtn onClick={() => move(k, 1)} disabled={k === draft.length - 1} title="往后挪">↓</IconBtn>
              <IconBtn onClick={() => suggest(k)} disabled={!!busy} title="让 AI 出 3 个别的方案">
                {busy === `sug-${k}` ? "…" : "换一个"}
              </IconBtn>
              <IconBtn
                onClick={() => {
                  setDraft((d) => d.filter((_, i) => i !== k).map((x, i) => (i === 0 ? { ...x, from: "" } : x)));
                  setOpen(-1);
                }}
                disabled={draft.length <= 1}
                title="删掉这个镜头"
              >
                删
              </IconBtn>
            </div>
            {cands?.index === k && (
              <div className="border-t border-border/70 px-2 py-2">
                <div className="mb-1 flex items-center text-[11px] text-muted-foreground">
                  点一个替换(还没保存)
                  <button onClick={() => setCands(null)} className="ml-auto hover:text-foreground">
                    收起
                  </button>
                </div>
                <div className="flex gap-2 overflow-x-auto">
                  {cands.options.map((o, i) => (
                    <button
                      key={i}
                      onClick={() => {
                        update(k, { ...o, from: k ? s.from ?? "" : "" });
                        setCands(null);
                      }}
                      className="shrink-0 rounded-md border border-border p-1 hover:border-accent/60"
                    >
                      <BeatPlayer props={beatProps(beat.text, [{ ...o, from: "" }], theme, aspect, assets, pages)} width={W > H ? 160 : 96} controls={false} />
                      <span className="mt-0.5 block text-[10px] text-muted-foreground">{labelOf(o)}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {open === k && (
              <div className="space-y-2 border-t border-border/70 px-2 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-1 text-muted-foreground">
                    模板
                    <select
                      value={s.asset ? `asset:${s.asset}` : s.tpl === "page" ? `page:${s.p?.page ?? ""}` : s.tpl}
                      disabled={!!busy}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v.startsWith("asset:")) update(k, { asset: v.slice(6), from: s.from });
                        else if (v.startsWith("page:")) {
                          // 换成产品页:先放上页面,再让 AI 按这句台词挑要推近的字(挑不出来就自己在下面点)
                          const keep = s.tpl === "page" && Array.isArray(s.p?.focus) ? (s.p?.focus as string[]) : [];
                          update(k, { tpl: "page", from: s.from, p: { page: v.slice(5), focus: keep, mode: "phone" } });
                          if (!keep.length) suggest(k, "page", v.slice(5));
                        } else suggest(k, v); // 换了模板:让 AI 按新模板把内容填上,她再改
                      }}
                      className="rounded border border-border bg-background px-1 py-0.5 text-foreground"
                    >
                      {TEMPLATES.filter((t) => t.id !== "page" && (sceneOn || t.id !== "scene" || s.tpl === "scene")).map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.label}
                        </option>
                      ))}
                      {assets
                        .filter((a) => a.kind === "page")
                        .map((a) => (
                          <option key={`p-${a.name}`} value={`page:${a.name}`}>
                            产品页 · {brief(a.name, 14)}
                          </option>
                        ))}
                      {s.tpl === "page" && !assets.some((a) => a.kind === "page" && a.name === s.p?.page) && <option value={`page:${s.p?.page ?? ""}`}>产品页 · {String(s.p?.page ?? "")}(素材库里没有了)</option>}
                      {assets
                        .filter((a) => a.kind === "video" || a.kind === "image")
                        .map((a) => (
                          <option key={a.name} value={`asset:${a.name}`}>
                            素材 · {brief(a.name, 14)}
                          </option>
                        ))}
                    </select>
                  </label>
                  {busy === `fill-${k}` && <span className="text-accent">AI 在按新模板填内容…</span>}
                  {k > 0 && (
                    <label className="flex min-w-0 flex-1 items-center gap-1 text-muted-foreground">
                      念到
                      <input
                        value={s.from ?? ""}
                        onChange={(e) => update(k, { ...s, from: e.target.value })}
                        placeholder="台词里的几个字"
                        className={`min-w-0 flex-1 rounded border bg-background px-1.5 py-0.5 text-foreground ${
                          fromOk(s.from ?? "") ? "border-border" : "border-destructive"
                        }`}
                      />
                      切
                    </label>
                  )}
                </div>
                {k > 0 && !fromOk(s.from ?? "") && <p className="text-[11px] text-destructive">切点要从这拍台词里原样抄几个字,现在台词里找不到它</p>}
                {s.tpl && TPL[s.tpl] && (
                  <p className="text-[11px] leading-snug text-muted-foreground">{TPL[s.tpl].use}</p>
                )}
                {s.tpl === "scene" && (
                  <div className="flex items-start gap-2">
                    {typeof s.p?.src === "string" && s.p.src ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={String(s.p.src)} alt="" className="h-28 w-16 shrink-0 rounded border border-border object-cover" />
                    ) : (
                      <span className="flex h-28 w-16 shrink-0 items-center justify-center rounded border border-dashed border-border text-[10px] text-muted-foreground">还没图</span>
                    )}
                    <div className="space-y-1">
                      {!sceneOn && <p className="text-[11px] leading-snug text-accent">配图没开:这台服务器现在不生成新图(要花钱,等你定用哪家)。改描述不会换图。</p>}
                      <button
                        onClick={() => regen(k)}
                        hidden={!sceneOn}
                        disabled={!!busy}
                        className="rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:border-foreground/30 hover:text-foreground disabled:opacity-40"
                      >
                        {busy === `img-${k}` ? "生成中…(约 10 秒)" : "按下面的描述重新生成"}
                      </button>
                      {sceneOn && <p className="text-[10px] leading-snug text-muted-foreground">改了描述不点也行,保存时会自动生成。一张约 0.3 元。</p>}
                    </div>
                  </div>
                )}
                {s.tpl === "page" && (
                  <PagePicker
                    page={pages[String(s.p?.page ?? "")]}
                    focus={Array.isArray(s.p?.focus) ? (s.p?.focus as string[]) : []}
                    onChange={(focus) => update(k, { ...s, p: { ...(s.p ?? {}), focus } })}
                  />
                )}
                {s.tpl &&
                  TPL[s.tpl]?.fields
                    // 产品页镜头的「哪张页面」由上面的模板下拉选,不让手改名字(改错了就找不到页面)
                    .filter((f) => !(s.tpl === "page" && f.key === "page"))
                    .map((f) => (
                    <FieldInput key={f.key} f={f} v={s.p?.[f.key]} onChange={(v) => update(k, { ...s, p: { ...(s.p ?? {}), [f.key]: v } })} />
                  ))}
              </div>
            )}
          </div>
        ))}
        <button
          onClick={() => {
            const words = [...beat.text.replace(/[\p{P}\p{S}\s]/gu, "")];
            setDraft((d) => [...d, { tpl: "lines", from: words.slice(Math.floor(words.length * 0.7), Math.floor(words.length * 0.7) + 4).join(""), p: { lines: ["", ""] } }]);
            setOpen(draft.length);
          }}
          className="w-full rounded-md border border-dashed border-border py-1.5 text-muted-foreground hover:border-foreground/30 hover:text-foreground"
        >
          + 加一个镜头
        </button>
        {outOfOrder.length > 0 && (
          <p className="text-[11px] text-accent">
            镜头 {outOfOrder.map((k) => k + 1).join("、")} 的切点在前一个镜头的切点前面 —— 成片里会按均分放,不跟字走。按台词先后调一下顺序或切点。
          </p>
        )}
        {err && <p className="text-destructive">{err}</p>}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            onClick={() => save(false)}
            disabled={!dirty || !!busy || draft.some((s, k) => k > 0 && !fromOk(s.from ?? ""))}
            className="rounded-md bg-foreground px-3 py-1.5 text-background disabled:opacity-40"
          >
            {busy === "save" ? "保存中…" : "保存(只重做剪辑)"}
          </button>
          {dirty && (
            <button onClick={() => setDraft(structuredClone(beat.shots))} className="text-muted-foreground hover:text-foreground">
              放弃改动
            </button>
          )}
          {beat.mine && (
            <button onClick={() => save(true)} disabled={!!busy} className="ml-auto text-muted-foreground hover:text-foreground">
              恢复成 AI 排的
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** 产品页镜头:页面上的字列出来,点一下加进「推近划线」;已选的里面页面上找不到的标红 */
function PagePicker({ page, focus, onChange }: { page?: PageLayout; focus: string[]; onChange: (f: string[]) => void }) {
  const [q, setQ] = useState("");
  const items = useMemo(() => {
    if (!page) return [];
    const seen = new Set<string>();
    return [...page.leaves]
      .sort((a, b) => a.y - b.y)
      .map((l) => String(l.t).replace(/\s+/g, " ").trim())
      .filter((t) => t.length >= 2 && !seen.has(t) && (seen.add(t), true));
  }, [page]);
  if (!page) return <p className="text-[11px] text-destructive">这张产品页还没加载出来(或者素材库里没有了)</p>;
  const bad = focus.filter((f) => f.trim() && !findText(page, f)?.whole);
  const shown = items.filter((t) => !q || t.includes(q)).slice(0, 80);
  return (
    <div className="space-y-1">
      {bad.length > 0 && <p className="text-[11px] text-destructive">页面上找不到:{bad.join("、")} —— 从下面点,或者只留页面上原有的几个字</p>}
      <span className="flex items-center gap-2 text-muted-foreground">
        页面上的字(点一下加进推近,最多 3 个)
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜" className="w-24 rounded border border-border bg-background px-1.5 py-0.5 text-foreground" />
      </span>
      <div className="max-h-36 space-y-0.5 overflow-y-auto rounded border border-border/70 p-1">
        {shown.map((t) => (
          <button
            key={t}
            disabled={focus.length >= 3 && !focus.includes(t)}
            onClick={() => {
              const piece = [...t].slice(0, 20).join("");
              onChange(focus.includes(piece) ? focus.filter((x) => x !== piece) : [...focus.filter((x) => x.trim()), piece]);
            }}
            className={`block w-full truncate rounded px-1 text-left text-[11px] ${focus.includes([...t].slice(0, 20).join("")) ? "bg-accent/20 text-foreground" : "text-muted-foreground hover:bg-muted"} disabled:opacity-40`}
            title={t}
          >
            {t}
          </button>
        ))}
      </div>
    </div>
  );
}

function IconBtn({ children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...rest} className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:border-foreground/30 hover:text-foreground disabled:opacity-30">
      {children}
    </button>
  );
}

const inputCls = "w-full rounded border border-border bg-background px-1.5 py-1 text-foreground";

function Counter({ s, max }: { s: string; max?: number }) {
  if (!max) return null;
  const n = [...s].length;
  return <span className={`text-[10px] ${n > max ? "text-destructive" : "text-muted-foreground/70"}`}>{n}/{max}</span>;
}

function FieldInput({ f, v, onChange }: { f: Field; v: unknown; onChange: (v: unknown) => void }) {
  if (f.type === "hidden") return null;
  const head = (extra?: React.ReactNode) => (
    <span className="mb-0.5 flex items-baseline gap-1.5 text-muted-foreground">
      {f.label}
      {f.optional && <span className="text-[10px] text-muted-foreground/60">可不填</span>}
      <span className="ml-auto">{extra}</span>
    </span>
  );
  if (f.type === "text") {
    const s = String(v ?? "");
    return (
      <label className="block">
        {head(<Counter s={s} max={f.max} />)}
        <input value={s} onChange={(e) => onChange(e.target.value)} className={inputCls} />
      </label>
    );
  }
  if (f.type === "number") {
    return (
      <label className="block">
        {head()}
        <input type="number" value={v == null ? "" : String(v)} onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} className={inputCls} />
      </label>
    );
  }
  if (f.type === "select") {
    return (
      <label className="block">
        {head()}
        <select value={String(v ?? "")} onChange={(e) => onChange(e.target.value || undefined)} className={inputCls}>
          <option value="">(默认)</option>
          {f.options?.map((o) => (
            <option key={o} value={o}>
              {f.labels?.[o] ?? o}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (f.type === "list") {
    const arr = Array.isArray(v) ? (v as string[]) : [];
    return (
      <label className="block">
        {head(<span className="text-[10px] text-muted-foreground/70">一行一个,{f.min}-{f.max} 个,每个 ≤{f.itemMax} 字</span>)}
        <textarea value={arr.join("\n")} rows={Math.max(2, arr.length)} onChange={(e) => onChange(e.target.value.split("\n"))} className={inputCls} />
      </label>
    );
  }
  if (f.type === "side") {
    const o = (v ?? {}) as { title?: string; lines?: string[] };
    return (
      <div>
        {head()}
        <input value={o.title ?? ""} placeholder="标题" onChange={(e) => onChange({ ...o, title: e.target.value })} className={`${inputCls} mb-1`} />
        <textarea value={(o.lines ?? []).join("\n")} rows={2} placeholder="一行一句" onChange={(e) => onChange({ ...o, lines: e.target.value.split("\n") })} className={inputCls} />
      </div>
    );
  }
  if (f.type === "rows") {
    const rows = Array.isArray(v) ? (v as string[][]) : [];
    return (
      <label className="block">
        {head(<span className="text-[10px] text-muted-foreground/70">一行一行,格子之间用 | 隔开</span>)}
        <textarea
          value={rows.map((r) => r.join(" | ")).join("\n")}
          rows={Math.max(2, rows.length)}
          onChange={(e) => onChange(e.target.value.split("\n").map((l) => l.split("|").map((c) => c.trim())))}
          className={inputCls}
        />
      </label>
    );
  }
  if (f.type === "items") {
    const arr = Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
    const set = (i: number, key: string, val: unknown) => onChange(arr.map((x, j) => (j === i ? { ...x, [key]: val } : x)));
    return (
      <div>
        {head(<span className="text-[10px] text-muted-foreground/70">{f.min}-{f.max} 个</span>)}
        <div className="space-y-1">
          {arr.map((it, i) => (
            <div key={i} className="flex items-center gap-1">
              {(f.of ?? []).map((sub) => (
                <input
                  key={sub.key}
                  value={it[sub.key] == null ? "" : String(it[sub.key])}
                  placeholder={sub.label}
                  type={sub.type === "number" ? "number" : "text"}
                  onChange={(e) => set(i, sub.key, sub.type === "number" ? (e.target.value === "" ? undefined : Number(e.target.value)) : e.target.value)}
                  className={`${inputCls} ${sub.type === "number" ? "w-16 shrink-0" : "min-w-0 flex-1"}`}
                />
              ))}
              <button onClick={() => onChange(arr.filter((_, j) => j !== i))} className="shrink-0 px-1 text-muted-foreground hover:text-destructive" title="删掉这一项">
                ×
              </button>
            </div>
          ))}
          {arr.length < (f.max ?? 6) && (
            <button onClick={() => onChange([...arr, {}])} className="text-[11px] text-muted-foreground hover:text-foreground">
              + 加一项
            </button>
          )}
        </div>
      </div>
    );
  }
  return null;
}
