export type Env = Record<string, string | undefined>;

export interface Config {
  databaseUrl: string;
  signingSecret: string;
  siteId: string;
  companyId: number;
}

/** Returns null when any required variable is missing or malformed. */
export function readConfig(env: Env): Config | null {
  const databaseUrl = env.DATABASE_URL;
  const signingSecret = env.FLUID_SIGNING_SECRET;
  const siteId = env.FLUID_SITE_ID;
  const companyId = env.FLUID_COMPANY_ID;
  if (!databaseUrl || !signingSecret || !siteId || !companyId) return null;
  if (!/^[0-9]{1,15}$/.test(companyId)) return null;
  return { databaseUrl, signingSecret, siteId, companyId: Number(companyId) };
}
