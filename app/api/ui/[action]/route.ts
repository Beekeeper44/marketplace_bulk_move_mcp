// JSON API for the Marketplace Move Bot screen. Everything except sign-in/setup/invites needs a signed-in account.
import { config } from "@/lib/config";
import { setupCheck } from "@/lib/setup";
import { queryWatches, isRejected, inspectWatchQuestion } from "@/lib/watches";
import { watchCardId, setSetting } from "@/lib/settings";
import { mb } from "@/lib/metabase";
import { moveCards, recentMoves, listMoveRuns, probeMove, mmConfig, type MoveItem } from "@/lib/market";
import { filterTasks } from "@/lib/tasks";
import { listPrompts, addPrompt, renamePrompt, deletePrompt } from "@/lib/ui";
import { smartSearch } from "@/lib/search";
import { readTarget } from "@/lib/target";
import { parsePasted, searchPasted } from "@/lib/paste";
import { readTags, hasTag } from "@/lib/tagfilter";
import { titleSearch, looksLikeTcg } from "@/lib/title";
import { readEvRange } from "@/lib/evrange";
import { readOrders } from "@/lib/orders";
import { queryCards, queryOrderCards } from "@/lib/metabase";
import {
  can, actorOf, currentUser, sessionCookie, clearCookie, signIn, needsSetup, setupFirstAdmin, inviteInfo, acceptInvite,
  changePassword, listUsers, addUser, updateUser, relinkAdmin, testAdminLink, resetInvite, type User, type Role,
} from "@/lib/users";

export const maxDuration = 300;

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
const fail = (e: unknown, status = 400) => json({ error: e instanceof Error ? e.message : String(e) }, status);
const origin = (req: Request) => new URL(req.url).origin;
const forbid = (u: User, role: Role) => (can(u, role) ? null : json({ error: `This needs ${role} access. You're a ${u.role}.` }, 403));

type Ctx = { params: Promise<{ action: string }> };

function me(u: User) {
  let shared = !u.admin_user_id;
  try { shared = actorOf(u).attribution === "shared"; } catch { /* not linked, no fallback */ }
  return {
    user: u.name, email: u.email, role: u.role, id: u.id,
    can_write: can(u, "editor") && (!shared || config.sharedSessionFallback()),
    can_approve: can(u, "approver"),
    is_admin: can(u, "admin"),
    admin_link: shared ? (config.sharedSessionFallback() ? "shared" : "missing") : "own",
    dry_run: config.dryRun(), max_items_per_run: config.maxItemsPerRun(), full_access: config.fullAccess(),
    move_configured: !!mmConfig().path,
  };
}

export async function GET(req: Request, ctx: Ctx) {
  const { action } = await ctx.params;
  try {
    if (action === "config") return json({ needs_setup: await needsSetup() });
    const u = await currentUser(req);
    if (!u) return json({ error: "signed_out" }, 401);
    switch (action) {
      case "me":
        return json(me(u), 200, { "Set-Cookie": sessionCookie(u.id) }); // refresh: stays signed in while used
      case "runs":
        return json(await listMoveRuns(25));
      case "prompts":
        return json(await listPrompts());
      case "users":
        return forbid(u, "admin") ?? json(await listUsers());
      default:
        return json({ error: "not found" }, 404);
    }
  } catch (e) {
    return fail(e, 500);
  }
}

export async function POST(req: Request, ctx: Ctx) {
  const { action } = await ctx.params;
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    /* empty body */
  }
  const str = (k: string) => String(body[k] ?? "");

  // ---- no sign-in needed ----
  try {
    switch (action) {
      case "setup": {
        const u = await setupFirstAdmin({ email: str("email"), name: str("name"), password: str("password"), code: str("code") });
        return json({ user: u.name }, 200, { "Set-Cookie": sessionCookie(u.id) });
      }
      case "login": {
        const u = await signIn(str("email"), str("password"));
        return json({ user: u.name }, 200, { "Set-Cookie": sessionCookie(u.id) });
      }
      case "logout":
        return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
      case "invite-info":
        return json(await inviteInfo(str("token")));
      case "invite-accept": {
        const u = await acceptInvite(str("token"), str("password"));
        return json({ user: u.name }, 200, { "Set-Cookie": sessionCookie(u.id) });
      }
    }
  } catch (e) {
    return fail(e, action === "login" ? 401 : 400);
  }

  const u = await currentUser(req).catch(() => null);
  if (!u) return json({ error: "signed_out" }, 401);

  try {
    switch (action) {
      case "find": {
        // EV range: typed ("5000 or more ev", "$5k+", "under $100") and/or the range tab picked on screen
        const rng = readEvRange(str("text"));
        const num = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
        // a range typed in the request wins; otherwise the range tab picked on screen
        const typed = rng.min != null || rng.max != null;
        const mins = [typed ? rng.min : num(body.min_ev)].filter((x): x is number => x != null);
        const maxs = [typed ? rng.max : num(body.max_ev)].filter((x): x is number => x != null);
        const evMin = mins.length ? Math.max(...mins) : null, evMax = maxs.length ? Math.min(...maxs) : null;
        const rangeF = { ...(evMin != null ? { min_estimated_value: evMin } : {}), ...(evMax != null ? { max_estimated_value: evMax } : {}) };
        // order / PO numbers ("order 1234567", "po 4386")
        const ord = readOrders(rng.rest);
        const { target, rest } = readTarget(ord.rest);
        // pasted card rows (set · insert · player + # · parallel · grade) search exactly; anything else is a typed request
        const pasted = parsePasted(rest);
        const tg = pasted ? { tags: [], untagged: false, rest } : readTags(rest);
        // tag only ("tag sd_wemby_grail"): pull the cards with that tag straight from 4131
        const tagOnly = !pasted && (tg.tags.length > 0) && !tg.rest;
        // order #: every card in that order — customers' too — from the orders question (44123);
        // other words narrow it ("order 1234567 psa 10"). PO on its own: 4131 (warehouse).
        const byOrder = !pasted && ord.orders.length > 0;
        const orderOnly = !pasted && !byOrder && !tg.tags.length && !tg.rest.trim() && ord.pos.length > 0;
        // a range on its own (a tab picked, nothing typed): every warehouse card in that range
        const rangeOnly = !orderOnly && !pasted && !tg.tags.length && !tg.untagged && !tg.rest.trim() && Object.keys(rangeF).length > 0;
        const ordF = [...ord.orders.map((o) => ({ order_number: o })), ...ord.pos.map((p) => ({ po_number: p }))];
        const r0 = byOrder
          ? await (async () => { const t0 = Date.now();
              let rows = (await Promise.all(ord.orders.map((o) => queryOrderCards(o)))).flat();
              rows = [...new Map(rows.map((x) => [x.item_id, x])).values()];
              if (tg.rest.trim()) rows = filterTasks(rows as unknown as Parameters<typeof filterTasks>[0], tg.rest).rows as unknown as typeof rows;
              return { parsed: { filters: { scope: "every card in the order (customers too)" }, post_filters: {} }, has_filter: true, queries: ord.orders.map((o) => ({ __order: o })) as Record<string, unknown>[], ms: Date.now() - t0, rows, missing: [] as string[] }; })()
          : orderOnly
          ? await (async () => { const t0 = Date.now(); const rows = (await Promise.all(ordF.map((f) => queryCards({ ...f, ...rangeF })))).flat();
              return { parsed: { filters: {}, post_filters: {} }, has_filter: true, queries: ordF, ms: Date.now() - t0, rows: [...new Map(rows.map((x) => [x.item_id, x])).values()], missing: [] as string[] }; })()
          : rangeOnly
          ? await (async () => { const t0 = Date.now(); const rows = await queryCards(rangeF);
              return { parsed: { filters: {}, post_filters: {} }, has_filter: true, queries: [rangeF], ms: Date.now() - t0, rows, missing: [] as string[] }; })()
          : tagOnly
          ? await (async () => { const t0 = Date.now(); const rows = (await Promise.all(tg.tags.map((t) => queryCards({ tag: t, ...rangeF })))).flat();
              return { parsed: { filters: {}, post_filters: {} }, has_filter: true, queries: tg.tags.map((t) => ({ tag: t })), ms: Date.now() - t0, rows: [...new Map(rows.map((x) => [x.item_id, x])).values()], missing: [] as string[] }; })()
          : pasted
          ? await (async () => { const t0 = Date.now(); const p = await searchPasted(pasted);
              return { parsed: { filters: p.display, post_filters: {} }, has_filter: true, queries: p.queries, ms: Date.now() - t0, rows: p.rows, missing: p.missing }; })()
          : await (async () => {
              // Pokémon / One Piece titles: title search first; anything else: the Tag Bot search, with title search as the fallback
              const asTitle = async () => { const x = await titleSearch(tg.rest); return x && x.rows.length ? { parsed: { filters: x.display, post_filters: {} }, has_filter: true, queries: x.queries, ms: x.ms, rows: x.rows, missing: x.missing } : null; };
              if (looksLikeTcg(tg.rest)) { const x = await asTitle(); if (x) return x; }
              const r1 = await smartSearch(tg.rest, rangeF).catch(() => null);
              if (r1 && r1.rows.length) return r1;
              return (await asTitle()) ?? r1 ?? (await smartSearch(tg.rest, rangeF));
            })();
        // tag filter on top of whatever else was typed
        const bareN = (x: unknown) => String(x ?? "").replace(/^#/, "").trim().toLowerCase();
        const tagRows = r0.rows.filter((x) => !isRejected(x.item_status) && hasTag(x.tag, tg.tags) && (!tg.untagged || !x.tag)
          && (!ord.orders.length || ord.orders.some((o) => bareN(x.order_number) === bareN(o)))
          && (!ord.pos.length || ord.pos.some((p) => bareN(x.po_number) === bareN(p)))
          && (evMin == null || (x.estimated_value ?? 0) >= evMin) && (evMax == null || (x.estimated_value ?? 0) <= evMax)
          // a year on its own ("2020 basketball") holds results to sets from that year
          && (!rng.year || pasted != null || String(x.set_name ?? "").includes(rng.year)));
        const r = { ...r0, rows: tagRows, queries: r0.queries,
          parsed: { ...r0.parsed, filters: { ...(r0.parsed?.filters ?? {}), ...rangeF, ...(rng.year && !pasted ? { year: rng.year } : {}), ...(ord.orders.length ? { order_number: ord.orders.join(", ") } : {}), ...(ord.pos.length ? { po_number: ord.pos.join(", ") } : {}), ...(tg.tags.length ? { tag: tg.tags.join(" or ") } : {}), ...(tg.untagged ? { tag: "none (untagged)" } : {}) } },
          has_filter: r0.has_filter || tg.tags.length > 0 || tg.untagged };
        const LIMIT = 6000; // the screen pages through these 200 at a time
        // moved through this bot in the last 7 days (any teammate) — marked on the tiles
        const recent = await recentMoves(r.rows.slice(0, LIMIT).map((x) => x.item_id)).catch(() => new Map());
        return json({
          target_ev: target,
          ev_range: { min: evMin, max: evMax, typed },
          parsed: r.parsed,
          has_filter: r.has_filter,
          queries: r.queries,
          ms: r.ms,
          total: r.rows.length,
          missing: r.missing,
          cards: r.rows.slice(0, LIMIT).map((r) => ({
            item_id: r.item_id, ac: r.ac_number ?? "", cert: r.cert_number ?? "", sport: (r.sport ?? "").toLowerCase(),
            set_name: r.set_name ?? "", player_name: r.player_name ?? "(no player)", parallel_name: r.parallel_name,
            grading_company: (r.grading_company ?? "").toLowerCase(), grade: (r.grade ?? "").toLowerCase(),
            ev: r.estimated_value ?? 0, tag: r.tag, img: r.front_slab_picture_url, card_url: r.card_url,
            insert: r.insert, parallel_total: r.parallel_total, status: r.item_status,
            ev_date: r.ev_date, ev_age_days: r.ev_age_days, ev_source: r.ev_source, order_number: r.order_number,
            times_sold_back: r.times_sold_back, bin: r.storage_bin_id, slot: r.storage_bin_slot,
            purchase_cost: r.purchase_cost, purchase_location: r.purchase_location, po_number: r.po_number, set_number: r.set_number,
            last_comp: r.last_comp,
            owner: r.owner_email ?? null,
            moved: recent.get(r.item_id) ?? null,
          })),
        });
      }
      case "move":
        // Move to Marketplace — the only admin write in this app
        return forbid(u, "editor") ?? json(await moveCards({ items: (Array.isArray(body.items) ? body.items : []) as MoveItem[], actor: actorOf(u), dry_run: body.dry_run === true, category: body.category === "watches" ? "watches" : "cards" }));
      case "find-watches": {
        const t0 = Date.now();
        const nn = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
        // a typed range ("$100-$250", "under $500", "$5k+") wins over the range tab
        const wr = readEvRange(str("text"));
        const typedW = wr.min != null || wr.max != null;
        const r = await queryWatches(wr.rest, typedW ? wr.min : nn(body.min_ev), typedW ? wr.max : nn(body.max_ev));
        const rangeW = typedW ? { ...(wr.min != null ? { min_estimated_value: wr.min } : {}), ...(wr.max != null ? { max_estimated_value: wr.max } : {}) } : {};
        const LIMIT = 2000;
        const moved = await recentMoves(r.rows.slice(0, LIMIT).map((x) => x.item_id).filter(Boolean)).catch(() => new Map());
        return json({ ms: Date.now() - t0, total: r.rows.length, has_filter: !!(r.query.filters.length || r.query.free.length || typedW), no_id: r.no_id,
          parsed: { filters: [...r.query.filters.map((f) => [f.field, f.value] as [string, string]), ...(r.query.free.length ? [["contains", r.query.free.join(" ")] as [string, string]] : [])]
            .reduce((o, [k, v]) => ({ ...o, [k]: o[k] ? `${o[k]} or ${v}` : v }), { ...rangeW } as Record<string, string | number>), post_filters: {} },
          missing: [], cards: r.rows.slice(0, LIMIT).map((x) => ({ ...x, moved: moved.get(x.item_id) ?? null })) });
      }
      case "mb-search": {
        // Setup tab: find saved Metabase questions by name
        const no = forbid(u, "admin"); if (no) return no;
        const term = str("q") || "watch";
        const r = await mb(`/api/search?q=${encodeURIComponent(term)}&models=card`);
        if (!r.ok) throw new Error(`Metabase search failed: ${r.status}`);
        const j = await r.json();
        const list = (Array.isArray(j) ? j : j.data ?? []) as { id: number; name: string; collection?: { name?: string } }[];
        return json({ current: await watchCardId(), results: list.slice(0, 15).map((x) => ({ id: x.id, name: x.name, collection: x.collection?.name ?? "" })) });
      }
      case "watch-question": {
        // Setup tab: check a question and (save=true) use it for watches
        const no = forbid(u, "admin"); if (no) return no;
        const id = Number(str("id").replace(/\D/g, ""));
        if (!id) throw new Error("Enter the question number.");
        const info = await inspectWatchQuestion(id);
        if (body.save === true) await setSetting("watch_card_id", String(id), u.name);
        return json({ id, saved: body.save === true, ...info });
      }
      case "setup-check":
        return forbid(u, "admin") ?? json(await setupCheck(actorOf(u).session_user_id, str("tag").replace(/^tag\s+/i, "").replace(/^#/, "") || undefined));
      case "probe":
        // setup check: shows the exact call a move would send for one card (sends nothing)
        return forbid(u, "admin") ?? json(probeMove(str("item_id"), body.ev == null ? null : Number(body.ev)));
      case "password":
        await changePassword(u.id, str("current"), str("next"));
        return json({ ok: true });
      case "prompts":
        return json(await addPrompt(str("text"), u.name, body.name as string | undefined));
      case "prompts-rename":
        await renamePrompt(str("id"), str("name"));
        return json({ ok: true });
      case "prompts-delete":
        await deletePrompt(str("id"));
        return json({ ok: true });

      // ---- user management (admins) ----
      case "users-add": {
        const f = forbid(u, "admin");
        if (f) return f;
        const r = await addUser({ email: str("email"), name: str("name"), role: str("role") as Role, admin_user_id: str("admin_user_id") || null }, u);
        return json({ ...r, invite_url: `${origin(req)}/?invite=${r.invite_token}` });
      }
      case "users-update": {
        const f = forbid(u, "admin");
        if (f) return f;
        await updateUser(str("id"), {
          role: (body.role as Role) || undefined,
          active: typeof body.active === "boolean" ? body.active : undefined,
          admin_user_id: body.admin_user_id === undefined ? undefined : String(body.admin_user_id ?? ""),
        }, u);
        return json({ ok: true });
      }
      case "users-relink":
        return forbid(u, "admin") ?? json(await relinkAdmin(str("id"), str("email") || undefined));
      case "users-test":
        return forbid(u, "admin") ?? json(await testAdminLink(str("id")));
      case "users-invite": {
        const f = forbid(u, "admin");
        if (f) return f;
        const r = await resetInvite(str("id"));
        return json({ invite_url: `${origin(req)}/?invite=${r.invite_token}` });
      }
      default:
        return json({ error: "not found" }, 404);
    }
  } catch (e) {
    return fail(e);
  }
}
