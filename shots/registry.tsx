import type React from "react";
import { Stomp, Ask, Lines, Quote, Glyph } from "./tpl/type";
import { BigNumber, Gauge, Bars, Timeline } from "./tpl/data";
import { List, Evidence, Compare, Diagram, Pillars, Table } from "./tpl/struct";
import { Scene } from "./tpl/scene";

// 模板 id → 组件。字段说明、什么时候用,在 catalog.json 里(规划提示词和网页编辑器都读它)
export const TEMPLATES: Record<string, React.FC<{ p: never }>> = {
  scene: Scene,
  stomp: Stomp,
  ask: Ask,
  lines: Lines,
  quote: Quote,
  glyph: Glyph,
  number: BigNumber,
  gauge: Gauge,
  bars: Bars,
  timeline: Timeline,
  list: List,
  evidence: Evidence,
  compare: Compare,
  diagram: Diagram,
  pillars: Pillars,
  table: Table,
} as unknown as Record<string, React.FC<{ p: never }>>;
