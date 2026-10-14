# Marketplace Move Bot

Search cards (same search as ev-bot: tag, player, set, order, PO, AC / cert), select them, **Move to Marketplace**.
No estimated values are written and there is no approve step.

- Search → slab tiles (same look as ev-bot). Everything is selected except cards this bot moved in the last 7 days.
- **Move to Marketplace (N)** → confirm (type the count when 25+) → batches of `MAX_ITEMS_PER_RUN` → per-card ✓ / failed with admin's error.
- Every move (and dry run) is logged to Neon `mm_moves`; **Recent moves** shows the runs.
- Same Neon `DATABASE_URL` as ev-bot = everyone keeps their ev-bot login.

## The move call

Captured from admin: `DELETE /admin/v1/repacks/warehouse/card_{ITEM_ID}` → 204, no body. That is the default. A 404 shows as "not in the repack warehouse (already on the marketplace?)". To change it later, set:

| Var | What |
|---|---|
| `MM_METHOD` | `POST` / `PATCH` / `PUT` |
| `MM_PATH` | path with `{id}` for the ITEM_ID, e.g. `/admin/v1/cards/{id}/...` |
| `MM_BODY` | JSON template; `"{id}"`, `"{ev}"`, `"{ev_cents}"`; `"{ids}"` makes it one bulk call per `MM_BATCH` cards |

Check (signed in as admin, browser console):
`fetch("/api/ui/probe",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({item_id:"<ITEM_ID>",ev:100})}).then(r=>r.json()).then(console.log)`

Then dry run on screen (the result shows the exact call), then `DRY_RUN=false`, move 1–2 cards, check admin.

Not built yet: undo (needs admin's "remove from marketplace" call), Claude connector.
