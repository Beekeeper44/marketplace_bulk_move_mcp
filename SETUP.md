# Marketplace Move Bot — Vercel setup

What it does: search cards (Metabase 4131) → select → **Move to Marketplace**, which sends admin's own call
`DELETE https://admin-api.arenaclub.com/admin/v1/repacks/warehouse/card_<ITEM_ID>` (204 = moved).

## 1. Put the code on GitHub
1. Unzip `marketplace-move-bot.zip`.
2. GitHub → **New repository** → `marketplace-move-bot` (private) → upload the folder's contents (not the folder itself) → Commit.

## 2. Create the Vercel project
1. vercel.com → **Add New… → Project** → import `marketplace-move-bot`.
2. Framework: **Next.js** (auto). Leave build settings as they are.
3. Open **Environment Variables** before clicking Deploy and add the vars in step 3.

## 3. Environment variables
Copy these from the **ev-bot** project (Vercel → ev-bot → Settings → Environment Variables → click the eye to reveal):

| Name | Value |
|---|---|
| `METABASE_HOST` | same as ev-bot |
| `METABASE_API_KEY` | same as ev-bot |
| `SUPERTOKENS_CONNECTION_URI` | same as ev-bot |
| `SUPERTOKENS_API_KEY` | same as ev-bot |
| `ADMIN_SESSION_USER_ID` | same as ev-bot |
| `DATABASE_URL` | same as ev-bot — everyone keeps their ev-bot login |
| `SESSION_SECRET` | same as ev-bot, or any long random string |

New for this project:

| Name | Value |
|---|---|
| `DRY_RUN` | `true` (switch to `false` in step 6) |
| `ADMIN_SESSION_MFA_DONE` | `true` only if ev-bot has it |
| `SETUP_CODE` | only if you use a **new** database: a one-time code to create the first admin |

Not needed (built in): `MM_METHOD`, `MM_PATH`, `MM_BODY`, `METABASE_CARD_ID` (4131), `EV_ORDERS_CARD_ID` (44123), `MAX_ITEMS_PER_RUN` (250).

Click **Deploy**.

## 4. Sign in
Open the Vercel URL and sign in with your ev-bot email + password.
(New database: enter name, email, password and the `SETUP_CODE`, then delete `SETUP_CODE` in Vercel.)

## 5. Run the Setup check (in the app)
**Setup** tab → type a tag (e.g. `sd_wemby_grail`) → **Run setup check**. Every row should be ✅:
env vars · Neon · Metabase 4131 · admin login (repack warehouse) · the tag's cards are found and in the repack warehouse · the move call.

## 6. Dry run, then go live
1. **Move cards** tab → **Search by: Tag** → type `sd_wemby_grail` → Enter → select 1 card → **Move to Marketplace** → the result shows the exact DELETE it would send.
2. Vercel → Settings → Environment Variables → `DRY_RUN` = `false` → **Deployments → ⋯ → Redeploy**.
3. Move 1–2 cards, check them on the marketplace in admin. Run the same search again — they show "Moved … by …" and start unselected.

## 6b. Watches
1. Watches use Metabase question **45046** (built in). It needs `ITEM_ID` (= `public.items.id`, not ITEM_TYPE_ID) and ideally a status column (`ITEM_STATUS` / `STATUS`) so rejected watches are hidden.
2. To check it: **Setup** tab → **Find the watches question** → type `45046` → **Check**. To switch questions later, **Use for watches** (saved in the app) or set `WATCH_CARD_ID` in Vercel.
3. Moves send `DELETE /admin/v1/repacks/warehouse/watch_<ITEM_ID>` (confirmed from admin's Timebox warehouse).
4. Click **Watches** → Tag `vookum`, or **Anything** → `rolex datejust ref #16030`. Dry run first.

## 7. Team
**Users** tab (admins): **Add person** → send the invite link. With the shared ev-bot database, everyone already in ev-bot can sign in.
If someone gets "admin refused this login": Users → **link by admin email** → **test**.

## Troubleshooting
| Shows | Fix |
|---|---|
| ❌ Vercel env vars | add the missing names, redeploy |
| ❌ Metabase | `METABASE_HOST` / `METABASE_API_KEY` |
| ❌ Admin login HTTP 401/403 | SuperTokens vars; `ADMIN_SESSION_MFA_DONE=true` if the message mentions st-mfa |
| Tile: "Not in the repack warehouse" | already on the marketplace (or not a repack card) |
