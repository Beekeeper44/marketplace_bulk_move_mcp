// Setup check for the Setup tab (admins): env vars, Neon, Metabase, admin login, the move call.
// Read-only — nothing here writes to admin.
import { config } from "./config";
import { q } from "./db";
import { mb, queryCards } from "./metabase";
import { openAdminSession, headers, url } from "./admin";
import { mmConfig } from "./market";
import { watchCardId } from "./settings";

type Check = { name: string; ok: boolean; detail: string };
const REQUIRED = ["SESSION_SECRET", "METABASE_HOST", "METABASE_API_KEY", "SUPERTOKENS_CONNECTION_URI", "SUPERTOKENS_API_KEY", "ADMIN_SESSION_USER_ID", "DATABASE_URL"];
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

export async function setupCheck(adminUserId: string, tag?: string) {
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
  let sampleId: string | undefined;
  try {
    const s = await openAdminSession(adminUserId);
    try {
      const r = await fetch(url("/admin/v1/repacks/warehouse?category=card&limit=1"), { headers: headers(s.accessToken) });
      checks.push({ name: "Admin login (repack warehouse)", ok: r.ok, detail: r.ok ? "Admin accepts your login for the repack warehouse" : `HTTP ${r.status} ${(await r.text()).slice(0, 120)}` });
      // the Timebox (watch) warehouse — admin's own list call: /repacks/warehouse?category=watch
      const w = await fetch(url("/admin/v1/repacks/warehouse?category=watch&limit=1"), { headers: headers(s.accessToken) });
      checks.push({ name: "Admin login (Timebox watch warehouse)", ok: w.ok, detail: w.ok ? "Admin accepts your login for the watch warehouse" : `HTTP ${w.status} ${(await w.text()).slice(0, 120)}` });
      if (tag) {
        // the tag's cards from 4131, then the first few checked in admin's repack warehouse
        const rows = await queryCards({ tag: tag.trim() });
        const sample = rows.slice(0, 5);
        const hits = await Promise.all(sample.map(async (c) => (await fetch(url("/admin/v1/repacks/warehouse/card_{id}", c.item_id), { headers: headers(s.accessToken) })).ok));
        const inN = hits.filter(Boolean).length;
        inWarehouse = sample.length ? inN > 0 : null;
        checks.push({ name: `Tag ${tag.trim()}`, ok: rows.length > 0 && inN > 0,
          detail: !rows.length ? "No cards with this tag in 4131 — check the spelling" : `${rows.length} cards in 4131 · ${inN} of the first ${sample.length} are in the repack warehouse (the rest are already on the marketplace)` });
        sampleId = sample[0]?.item_id;
      }
    } finally { await s.revoke(); }
  } catch (e) { checks.push({ name: "Admin login (repack warehouse)", ok: false, detail: errMsg(e) }); }

  const wid = await watchCardId().catch(() => 0);
  if (!wid) checks.push({ name: "Watches question", ok: false, detail: "Not picked yet — use “Find the watches question” below" });
  else try {
    const r = await mb(`/api/card/${wid}`); const j = r.ok ? await r.json() : null;
    checks.push({ name: `Watches question ${wid}`, ok: r.ok, detail: r.ok ? `Reachable · “${j?.name ?? "?"}” · moves send ${mmConfig("watches").method} ${url(mmConfig("watches").path, "<WATCH_ID>")}` : `HTTP ${r.status}` });
  } catch (e) { checks.push({ name: `Watches question ${wid}`, ok: false, detail: errMsg(e) }); }
  const m = mmConfig();
  checks.push({ name: "Move call", ok: !!m.path, detail: `${m.method} ${url(m.path, sampleId || "<ITEM_ID>")}` });
  checks.push({ name: "Mode", ok: true, detail: config.dryRun() ? "DRY_RUN=true — moves are logged, nothing is sent. Set DRY_RUN=false to go live." : "LIVE — moves are sent to admin" });
  return { checks, in_warehouse: inWarehouse, ready: checks.every((c) => c.ok) };
}
