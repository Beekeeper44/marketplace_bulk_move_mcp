// Watches: the warehouse-watches Metabase question (WATCH_CARD_ID), pulled fresh every search and filtered here.
// Search: "tag vookum", "brand rolex", "model datejust", "ref 16030", "movement automatic", "dial blue",
// "po 4439", "order 20890796", "ac 4229801" — or plain words (each word must match some field).
import { config } from "./config";
import { mb } from "./metabase";
import { watchCardId } from "./settings";

export type WatchRow = {
  item_id: string; ac: string | null; tag: string | null; ev: number | null; img: string | null;
  item_url: string | null; order_url: string | null; po_number: string | null; order_number: string | null;
  brand: string | null; model: string | null; reference: string | null; dial_color: string | null;
  movement: string | null; case_material: string | null; case_diameter: string | null; gender: string | null;
  condition: string | null; bracelet_material: string | null; bracelet_color: string | null;
  box: string | null; papers: string | null; purchase_cost: number | null; status: string | null;
};

// rejected items are never shown (cards or watches)
export const isRejected = (status: unknown) => /reject/i.test(String(status ?? ""));

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const s = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v).trim());
const n = (v: unknown) => { if (v === null || v === undefined || v === "") return null; const x = Number(String(v).replace(/[$,]/g, "")); return Number.isFinite(x) ? x : null; };

function toRow(o: Record<string, unknown>): WatchRow {
  const g = (...keys: string[]) => { for (const k of keys) { const hit = Object.keys(o).find((x) => x.toLowerCase() === k); if (hit && o[hit] != null && o[hit] !== "") return o[hit]; } return null; };
  const itemUrl = s(g("item_url"));
  const id = s(g("item_id", "watch_id", "id")) ?? itemUrl?.match(UUID)?.[0] ?? "";
  return {
    item_id: (id.match(UUID)?.[0] ?? "").toLowerCase(), ac: s(g("ac_number", "ac")), tag: s(g("tag", "tags")),
    ev: n(g("estimated_value", "ev")), img: s(g("image_url", "img")), item_url: itemUrl, order_url: s(g("order_url")),
    po_number: s(g("po_number")), order_number: s(g("order_number")), brand: s(g("brand_name", "brand")), model: s(g("model")),
    reference: s(g("reference", "reference_number")), dial_color: s(g("dial_color")), movement: s(g("movement")),
    case_material: s(g("case_material")), case_diameter: s(g("case_diameter")), gender: s(g("gender")), condition: s(g("condition")),
    bracelet_material: s(g("bracelet_material")), bracelet_color: s(g("bracelet_color")),
    box: s(g("box_details")), papers: s(g("papers_details")), purchase_cost: n(g("purchase_cost")),
    status: s(g("status", "watch_status", "item_status", "operation_status")),
  };
}

// words that name a field: "brand rolex", "ref 16030", "po 4439"
const FIELDS: Record<string, keyof WatchRow> = {
  tag: "tag", tags: "tag", brand: "brand", make: "brand", model: "model", ref: "reference", reference: "reference",
  movement: "movement", dial: "dial_color", case: "case_material", material: "case_material", size: "case_diameter", mm: "case_diameter",
  gender: "gender", condition: "condition", bracelet: "bracelet_material", box: "box", papers: "papers",
  po: "po_number", order: "order_number", ac: "ac",
};
const EXACT = new Set<keyof WatchRow>(["po_number", "order_number", "ac", "reference"]);
const TEXT_FIELDS: (keyof WatchRow)[] = ["tag", "brand", "model", "reference", "dial_color", "movement", "case_material", "case_diameter", "gender", "condition", "bracelet_material", "bracelet_color", "box", "papers", "po_number", "order_number", "ac"];

export function parseWatchQuery(text: string) {
  const words = text.toLowerCase().replace(/[#:=]/g, " ").replace(/[$,]/g, "").split(/\s+/).filter(Boolean)
    .filter((w) => !/^(show|me|all|the|watch|watches|find|with|and|for|in|of)$/.test(w));
  const filters: { field: keyof WatchRow; value: string }[] = [];
  const free: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const f = FIELDS[words[i]];
    // "ref 1234", "ref #1234", "reference number 1234", "order no 2345"
    if (f && /^(number|num|no|nr)$/.test(words[i + 1] ?? "")) i++;
    if (f && words[i + 1]) { filters.push({ field: f, value: words[++i] }); continue; }
    free.push(words[i]);
  }
  return { filters, free };
}

const norm = (v: unknown) => String(v ?? "").toLowerCase().replace(/^8ac0*/, "").replace(/^0+/, "");

export function matchWatch(r: WatchRow, q: ReturnType<typeof parseWatchQuery>) {
  // several tags = any of them
  const tags = q.filters.filter((f) => f.field === "tag").map((f) => f.value);
  if (tags.length) {
    const have = String(r.tag ?? "").toLowerCase().split(/[\s,]+/);
    if (!tags.some((t) => have.some((h) => h === t || h.includes(t)))) return false;
  }
  for (const f of q.filters) {
    if (f.field === "tag") continue;
    const have = String(r[f.field] ?? "").toLowerCase();
    if (EXACT.has(f.field)) { if (norm(have) !== norm(f.value)) return false; continue; }
    if (!have.includes(f.value)) return false;
  }
  const hay = TEXT_FIELDS.map((k) => String(r[k] ?? "").toLowerCase()).join(" | ");
  return q.free.every((w) => hay.includes(w));
}

/** Pull a question's rows once and say whether it has what the bot needs (Setup tab). */
export async function inspectWatchQuestion(id: number) {
  const res = await mb(`/api/card/${id}/query/json`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parameters: [], format_rows: false }) });
  if (!res.ok) throw new Error(`Metabase question ${id} didn't run: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error("That question didn't return rows.");
  const cols = [...new Set(data.slice(0, 200).flatMap((o: Record<string, unknown>) => Object.keys(o)).map((c: string) => c.toUpperCase()))] as string[];
  const rows = data.map(toRow);
  return {
    rows: data.length, columns: cols,
    has_item_id: cols.includes("ITEM_ID"), ids_found: rows.filter((r) => r.item_id).length,
    has_watch_fields: ["BRAND_NAME", "MODEL", "REFERENCE"].filter((c) => cols.includes(c)),
    has_image: cols.includes("IMAGE_URL"), has_tag: cols.includes("TAG"),
    status_col: cols.find((c) => ["STATUS", "WATCH_STATUS", "ITEM_STATUS", "OPERATION_STATUS"].includes(c)) ?? null,
    statuses: [...new Set(rows.map((r) => r.status).filter(Boolean))].slice(0, 10),
  };
}

export async function queryWatches(text: string, min?: number | null, max?: number | null) {
  const id = await watchCardId();
  if (!id) throw new Error("Watches aren't set up yet: an admin picks the watches question in the Setup tab.");
  const path = `/api/card/${id}/query/json`;
  let res = await mb(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parameters: [], format_rows: false }) });
  if (!res.ok && res.status >= 400 && res.status < 500) {
    res = await mb(path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ parameters: "[]", format_rows: "false" }).toString() });
  }
  if (!res.ok) throw new Error(`Metabase watches query failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(`Unexpected Metabase response: ${JSON.stringify(data).slice(0, 300)}`);
  const all = data.map(toRow);
  const q = parseWatchQuery(text);
  const rows = all.filter((r) => !isRejected(r.status) && matchWatch(r, q) && (min == null || (r.ev ?? 0) >= min) && (max == null || (r.ev ?? 0) <= max));
  return { rows, total_in_question: all.length, no_id: rows.filter((r) => !r.item_id).length, query: q };
}
