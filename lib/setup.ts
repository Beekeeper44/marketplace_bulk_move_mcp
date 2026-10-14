// Setup check for the Setup tab (admins): env vars, Neon, Metabase, admin login, the move call.
// Read-only — nothing here writes to admin.
import { config } from "./config";
import { q } from "./db";
import { mb } from "./metabase";
import { openAdminSession, headers, url } from "./admin";
import { mmConfig } from "./market";

type Check = { name: string; ok: boolean; detail: string };
const REQUIRED = ["SESSION_SECRET", "METABASE_HOST", "METABASE_API_KEY", "SUPERTOKENS_CONNECTION_URI", "SUPERTOKENS_API_KEY", "ADMIN_SESSION_USER_ID", "DATABASE_URL"];
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

export async function setupCheck(adminUserId: string, itemId?: string) {
  const checks: Check[] = [];
  const missing = REQUIRED.filter((k) => !process.env[k]);
  checks.push({ name: "Vercel env vars", ok: !missing.length, detail: missing.length ? `Missing: ${missing.join(", ")}` : "All required vars are set" });

  try { await q("SELECT 1"); checks.push({ name: "Neon database", ok: true, detail: "Connected · tables ready" }); }
  catch (e) { checks.push({ name: "Neon database", ok: false, detail: errMsg(e) }); }

  try {
    const r = await mb(`/api/card/${config.metabaseCardId()}`);
    const j = r.ok ? await r.json() : null;
    checks.push({ name: `Metabase question ${config.metabaseCardId()}`, ok: r.ok, detail: r.ok ? `Reachable · “${j?.name ?? "?"}”` : `HTTP ${r.status} — check METABASE_HOST / METABASE_API_KEY` });
  } catch (e) { checks.push({ name: `Metabase question ${config.metabaseCardId()}`, ok: false, detail: errMsg(e) }); }

  let inWarehouse: boolean | null = null;
  try {
    const s = await openAdminSession(adminUserId);
    try {
      const r = await fetch(url("/admin/v1/repacks/warehouse?category=card&limit=1"), { headers: headers(s.accessToken) });
      checks.push({ name: "Admin login (repack warehouse)", ok: r.ok, detail: r.ok ? "Admin accepts your login for the repack warehouse" : `HTTP ${r.status} ${(await r.text()).slice(0, 120)}` });
      if (itemId) {
        const c = await fetch(url("/admin/v1/repacks/warehouse/card_{id}", itemId.trim()), { headers: headers(s.accessToken) });
        inWarehouse = c.ok ? true : c.status === 404 ? false : null;
        checks.push({ name: `Card ${itemId.trim()}`, ok: c.ok, detail: c.ok ? "In the repack warehouse — the bot can move it" : c.status === 404 ? "Not in the repack warehouse (already on the marketplace, or a different ID)" : `HTTP ${c.status}` });
      }
    } finally { await s.revoke(); }
  } catch (e) { checks.push({ name: "Admin login (repack warehouse)", ok: false, detail: errMsg(e) }); }

  const m = mmConfig();
  checks.push({ name: "Move call", ok: !!m.path, detail: `${m.method} ${url(m.path, itemId?.trim() || "<ITEM_ID>")}` });
  checks.push({ name: "Mode", ok: true, detail: config.dryRun() ? "DRY_RUN=true — moves are logged, nothing is sent. Set DRY_RUN=false to go live." : "LIVE — moves are sent to admin" });
  return { checks, in_warehouse: inWarehouse, ready: checks.every((c) => c.ok) };
}
