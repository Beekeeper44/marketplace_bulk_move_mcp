// Move cards to the marketplace in admin — the same call admin's own "move to marketplace" makes.
// The call is set in Vercel env (captured from admin's network tab), so it can be fixed without a code change:
//   MM_METHOD  default DELETE               (captured from admin 10/14: 204 No Content, no body)
//   MM_PATH    default /admin/v1/repacks/warehouse/card_{id}   ({id} = the card's ITEM_ID)
//   MM_BODY    JSON template                (optional) — placeholders: "{id}", "{ids}", "{ev}", "{ev_cents}"
// A body with "{ids}" is a bulk call: one request per batch of MM_BATCH cards. Otherwise one request per card.
// No estimated-value writes, no approve step.
import { randomBytes } from "crypto";
import { config } from "./config";
import { openAdminSession, headers, url, type AdminSession } from "./admin";
import type { Actor } from "./users";
import { q } from "./db";

export type MoveItem = { item_id: string; ev?: number | null; label?: string | null };
export type Category = "cards" | "watches";
export type MoveResult = { item_id: string; ok: boolean; status: number; error?: string };

const ID_RE = /^[0-9a-f-]{36}$/i;

// watches use the same admin call with watch_ in place of card_ (MM_WATCH_PATH to change it)
export const mmConfig = (cat: Category = "cards") => ({
  method: (process.env.MM_METHOD || "DELETE").toUpperCase(),
  path: cat === "watches" ? process.env.MM_WATCH_PATH || "/admin/v1/repacks/warehouse/watch_{id}" : process.env.MM_PATH || "/admin/v1/repacks/warehouse/card_{id}",
  body: process.env.MM_BODY || "",
  batch: Math.max(1, Number(process.env.MM_BATCH) || 50),
});

/** Fills the placeholders in the body template. */
function fill(t: unknown, v: { id?: string; ids?: string[]; ev?: number | null }): unknown {
  if (typeof t === "string") {
    if (t === "{ids}") return v.ids ?? [];
    if (t === "{ev}") return v.ev ?? null;
    if (t === "{ev_cents}") return v.ev == null ? null : Math.round(v.ev * 100);
    return t.replace(/\{id\}/g, v.id ?? "");
  }
  if (Array.isArray(t)) return t.map((x) => fill(x, v));
  if (t && typeof t === "object") return Object.fromEntries(Object.entries(t).map(([k, x]) => [k, fill(x, v)]));
  return t;
}

export function buildCalls(items: MoveItem[], cat: Category = "cards") {
  const c = mmConfig(cat);
  if (!c.path) throw new Error("Move to Marketplace isn't wired yet: set MM_PATH (and MM_METHOD / MM_BODY) in Vercel from admin's network call.");
  let tpl: unknown = undefined;
  if (c.body) {
    try { tpl = JSON.parse(c.body); } catch { throw new Error("MM_BODY isn't valid JSON."); }
  }
  const bulk = !!c.body && c.body.includes('"{ids}"');
  if (bulk) {
    const out: { method: string; url: string; body: unknown; ids: string[] }[] = [];
    for (let i = 0; i < items.length; i += c.batch) {
      const ids = items.slice(i, i + c.batch).map((x) => x.item_id);
      out.push({ method: c.method, url: url(c.path, ids[0]), body: fill(tpl, { ids }), ids });
    }
    return out;
  }
  return items.map((x) => ({ method: c.method, url: url(c.path, x.item_id), body: tpl === undefined ? undefined : fill(tpl, { id: x.item_id, ev: x.ev }), ids: [x.item_id] }));
}

async function send(session: AdminSession, call: { method: string; url: string; body: unknown }) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const h = headers(session.accessToken);
      if (call.body === undefined) delete h["Content-Type"]; // DELETE with no body, like admin
      const res = await fetch(call.url, { method: call.method, headers: h, body: call.body === undefined ? undefined : JSON.stringify(call.body) });
      if (res.ok) return { ok: true, status: res.status };
      if (res.status === 404) return { ok: false, status: 404, error: "Not in the repack warehouse (already on the marketplace?)" };
      if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 500 * attempt)); continue; }
      return { ok: false, status: res.status, error: (await res.text()).slice(0, 300) };
    } catch (e) {
      if (attempt === 3) return { ok: false, status: 0, error: String(e) };
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  return { ok: false, status: 0, error: "exhausted retries" };
}

/** Moves the cards. Dry run = builds the calls and logs them, sends nothing. */
export async function moveCards(input: { items: MoveItem[]; actor: Actor; dry_run?: boolean; category?: Category }) {
  const cat: Category = input.category === "watches" ? "watches" : "cards";
  const items = [...new Map(input.items.filter((x) => ID_RE.test(x.item_id)).map((x) => [x.item_id, x])).values()];
  if (!items.length) throw new Error(cat === "watches" ? "Select at least one watch." : "Select at least one card.");
  if (items.length > config.maxItemsPerRun()) throw new Error(`Max ${config.maxItemsPerRun()} cards per request (the screen batches bigger jobs).`);
  const dry = config.dryRun() || input.dry_run === true;
  const calls = buildCalls(items, cat);
  const run_id = (cat === "watches" ? "mw_" : "mm_") + randomBytes(5).toString("hex");
  const results: MoveResult[] = [];

  if (dry) {
    for (const c of calls) for (const id of c.ids) results.push({ item_id: id, ok: true, status: 0 });
  } else {
    const session = await openAdminSession(input.actor.session_user_id);
    try {
      let i = 0;
      await Promise.all(Array.from({ length: Math.min(config.writeConcurrency(), calls.length) }, async () => {
        while (i < calls.length) {
          const c = calls[i++];
          const r = await send(session, c);
          for (const id of c.ids) results.push({ item_id: id, ...r });
        }
      }));
    } finally {
      await session.revoke();
    }
  }

  const label = new Map(items.map((x) => [x.item_id, x.label ?? null]));
  await q(
    `INSERT INTO mm_moves (run_id, item_id, label, ok, http_status, error, dry_run, by_name, by_id)
     SELECT $1, x.item_id, x.label, x.ok, x.status, x.error, $2, $3, $4
     FROM jsonb_to_recordset($5::jsonb) AS x(item_id text, label text, ok boolean, status int, error text)`,
    [run_id, dry, input.actor.name, input.actor.id, JSON.stringify(results.map((r) => ({ ...r, label: label.get(r.item_id) })))]
  );
  const failed = results.filter((r) => !r.ok);
  return {
    run_id, dry_run: dry,
    moved: results.filter((r) => r.ok).length, failed: failed.length,
    failures: failed.map((r) => ({ item_id: r.item_id, status: r.status, error: r.error })),
    moved_ids: results.filter((r) => r.ok).map((r) => r.item_id),
    sample_call: calls[0] ? { method: calls[0].method, url: calls[0].url, body: calls[0].body } : null,
  };
}

/** Latest live move (not dry run) per card in the last 7 days — marked on the tiles. */
export async function recentMoves(ids: string[]) {
  const m = new Map<string, { at: string; by: string }>();
  if (!ids.length) return m;
  const rows = await q<{ item_id: string; at: string; by_name: string }>(
    `SELECT DISTINCT ON (item_id) item_id, created_at AS at, by_name FROM mm_moves
     WHERE item_id = ANY($1) AND ok AND NOT dry_run AND created_at > now() - interval '7 days'
     ORDER BY item_id, created_at DESC`, [ids]);
  for (const r of rows) m.set(r.item_id, { at: r.at, by: r.by_name });
  return m;
}

export const listMoveRuns = (n = 25) =>
  q(`SELECT run_id, bool_or(dry_run) AS dry_run, max(by_name) AS by, min(created_at) AS at,
       count(*) FILTER (WHERE ok)::int AS moved, count(*) FILTER (WHERE NOT ok)::int AS failed
     FROM mm_moves GROUP BY run_id ORDER BY min(created_at) DESC LIMIT $1`, [n]);

/** Setup check (no write): what one card's move call would look like. */
export const probeMove = (itemId: string, ev?: number | null) => {
  const c = mmConfig();
  return { configured: !!c.path, mm_method: c.method, mm_path: c.path || "(not set)", mm_body: c.body || "(none)", dry_run: config.dryRun(),
    would_send: c.path ? buildCalls([{ item_id: itemId, ev }])[0] : null };
};
