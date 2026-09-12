import { cookies } from "next/headers";
import { createHash } from "crypto";

// Same token formula as middleware.ts / api/login — layout uses it to decide
// whether the sidebar may show the project list (never render it on /login
// for unauthenticated visitors).
export async function isAuthed(): Promise<boolean> {
  const code = process.env.ACCESS_CODE;
  if (!code) return true; // gate disabled (local dev)
  const want = createHash("sha256").update(`reelforge:${code}`).digest("hex");
  const store = await cookies();
  return store.get("rf_auth")?.value === want;
}
