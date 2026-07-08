import path from "path";

// A media artifact is either an absolute filesystem path (produced by a real
// pipeline run on the machine that rendered it) or a bundled public asset
// referenced as "/seed/…". Bundled assets live under public/ and must be
// resolved to a real fs path before streaming or zipping them.
export function resolveMediaPath(p?: string): string | undefined {
  if (!p) return p;
  if (p.startsWith("/seed/")) return path.join(process.cwd(), "public", p);
  return p;
}
