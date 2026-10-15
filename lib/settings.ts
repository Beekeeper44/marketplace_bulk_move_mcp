// App settings an admin picks in the Setup tab (stored in Neon, so no Vercel change or redeploy).
import { q } from "./db";
import { config } from "./config";

export async function getSetting(key: string): Promise<string | null> {
  const rows = await q<{ value: string }>(`SELECT value FROM mm_settings WHERE key=$1`, [key]);
  return rows[0]?.value ?? null;
}
export async function setSetting(key: string, value: string, by: string) {
  await q(`INSERT INTO mm_settings (key, value, updated_by, updated_at) VALUES ($1,$2,$3,now())
           ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`, [key, value, by]);
}
/** The watches question: WATCH_CARD_ID in Vercel wins; otherwise the one picked in the Setup tab. */
export async function watchCardId(): Promise<number> {
  const env = config.watchCardId();
  if (env) return env;
  return Number(await getSetting("watch_card_id").catch(() => null)) || 0;
}
