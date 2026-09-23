// 镜头模板目录(shots/catalog.json)的类型和查表。网页(客户端组件)和服务端都用,所以这里不许碰数据库。
import catalog from "@/shots/catalog.json";

export type Field = {
  key: string;
  label: string;
  type: "text" | "number" | "select" | "list" | "items" | "side" | "rows" | "hidden";
  max?: number;
  min?: number;
  itemMax?: number;
  optional?: boolean;
  options?: string[];
  /** 选项的中文名 */
  labels?: Record<string, string>;
  of?: Field[];
};
export type Template = { id: string; label: string; use: string; cues: string; fields: Field[]; example: Record<string, unknown> };
export type Shot = { tpl?: string; asset?: string; from?: string; p?: Record<string, unknown> };

export const TEMPLATES = (catalog as { templates: Template[] }).templates;
export const TPL = Object.fromEntries(TEMPLATES.map((t) => [t.id, t]));

