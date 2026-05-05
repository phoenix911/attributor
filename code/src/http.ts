import { getAllowedOrigins, type Env } from './env';

export function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const allowed = getAllowedOrigins(env);
  const ok = origin && allowed.has(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': ok,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function json(body: unknown, init: ResponseInit = {}, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...headers, ...(init.headers || {}) },
  });
}

export function preflight(req: Request, env: Env): Response {
  return new Response(null, { status: 204, headers: corsHeaders(req.headers.get('Origin'), env) });
}

export async function readJson<T = unknown>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}
