// 镜头的配色。三套,和原来字卡的 dark / paper / gradient 一一对应(老项目的主题名照样能用)。
// ink 就是 ops-bilibili 灵伴片子用的深墨蓝 + 香槟金。
export type Theme = {
  id: "ink" | "paper" | "dusk";
  base: string; // 纯色底(边角、兜底)
  bg: string; // 背景(带暗角的渐变)
  text: string;
  sub: string;
  muted: string;
  faint: string;
  accent: string;
  accentHi: string;
  accentDim: string;
  accent2: string; // 第二强调色:对照里"另一边"、桃花这类
  card: string;
  cardHi: string;
  cardBorder: string;
  glow: string; // rgba,光晕
  glow2: string;
  onAccent: string; // 金底上的字
  sans: string;
  serif: string;
};

const SANS = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
const SERIF = '"Songti SC", "STSong", "Noto Serif CJK SC", "Source Han Serif SC", serif';

export const THEMES: Record<Theme["id"], Theme> = {
  ink: {
    id: "ink",
    base: "#0B1017",
    bg: "radial-gradient(120% 80% at 50% 38%, #172033 0%, #0D131D 48%, #07090D 100%)",
    text: "#EEF1F5",
    sub: "#C8D0DC",
    muted: "#7C8797",
    faint: "#2A3242",
    accent: "#D9B978",
    accentHi: "#F0D9A0",
    accentDim: "#8A7442",
    accent2: "#E0629B",
    card: "linear-gradient(180deg, #1B2130 0%, #121724 100%)",
    cardHi: "linear-gradient(180deg, #3A2A16 0%, #1A130C 100%)",
    cardBorder: "#2A3242",
    glow: "rgba(217,185,120,0.34)",
    glow2: "rgba(224,98,155,0.30)",
    onAccent: "#0B1017",
    sans: SANS,
    serif: SERIF,
  },
  paper: {
    id: "paper",
    base: "#F1E9DB",
    bg: "radial-gradient(120% 80% at 50% 36%, #FBF6EC 0%, #F1E8D8 55%, #E3D6C0 100%)",
    text: "#231C15",
    sub: "#4A3E31",
    muted: "#8A7B68",
    faint: "#D8C9B1",
    accent: "#B8452E",
    accentHi: "#C9502F",
    accentDim: "#D9A896",
    accent2: "#2F5D62",
    card: "linear-gradient(180deg, #FFFCF6 0%, #F6EFE3 100%)",
    cardHi: "linear-gradient(180deg, #FBE9DF 0%, #F4D9CB 100%)",
    cardBorder: "#DCCDB6",
    glow: "rgba(184,69,46,0.16)",
    glow2: "rgba(47,93,98,0.16)",
    onAccent: "#FFF8EE",
    sans: SANS,
    serif: SERIF,
  },
  dusk: {
    id: "dusk",
    base: "#1B1030",
    bg: "radial-gradient(120% 85% at 50% 30%, #4A1A4E 0%, #2A1238 50%, #140A22 100%)",
    text: "#FBF1FA",
    sub: "#E6D3EA",
    muted: "#A58FB0",
    faint: "#4A2F55",
    accent: "#FFB86B",
    accentHi: "#FFD6A0",
    accentDim: "#9A6A4A",
    accent2: "#FF6FA3",
    card: "linear-gradient(180deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.03) 100%)",
    cardHi: "linear-gradient(180deg, rgba(255,184,107,0.26) 0%, rgba(255,184,107,0.08) 100%)",
    cardBorder: "rgba(255,255,255,0.16)",
    glow: "rgba(255,184,107,0.30)",
    glow2: "rgba(255,111,163,0.30)",
    onAccent: "#2A1233",
    sans: SANS,
    serif: SERIF,
  },
};

// 老字卡的主题名 → 新配色
export function themeOf(id?: string | null): Theme {
  if (id === "paper") return THEMES.paper;
  if (id === "gradient" || id === "dusk") return THEMES.dusk;
  return THEMES.ink;
}
