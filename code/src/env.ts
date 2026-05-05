export interface Env {
  DB: D1Database;
  APPS_CONFIG: string;
  ALLOWED_ORIGINS: string;
  // Optional dashboard auth — both must be set for /dashboard to be reachable.
  DASHBOARD_USER?: string;
  DASHBOARD_PASS?: string;
}

export type AppConfig = {
  ttl_days: number;
  max_referrer_len: number;
  referrer_pattern: string;
};

let _appsCache: Record<string, AppConfig> | null = null;
let _originsCache: Set<string> | null = null;

export function getApps(env: Env): Record<string, AppConfig> {
  if (_appsCache) return _appsCache;
  try {
    _appsCache = JSON.parse(env.APPS_CONFIG) as Record<string, AppConfig>;
  } catch {
    _appsCache = {};
  }
  return _appsCache;
}

export function getApp(env: Env, appId: string): AppConfig | null {
  const apps = getApps(env);
  return apps[appId] || null;
}

export function getAllowedOrigins(env: Env): Set<string> {
  if (_originsCache) return _originsCache;
  _originsCache = new Set(
    (env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return _originsCache;
}
