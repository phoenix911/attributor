import { getApp, type Env } from './env';
import { corsHeaders, json, readJson } from './http';
import { fromRequest } from './signals';

type ClickBody = {
  app_id?: string;
  referrer?: string;
  ua?: string;
  locale?: string;
  timezone?: string;
  screen_w?: number;
  screen_h?: number;
  dpr?: number;
  platform?: string;
};

export async function handleClick(req: Request, env: Env): Promise<Response> {
  const origin = req.headers.get('Origin');
  const cors = corsHeaders(origin, env);

  const body = await readJson<ClickBody>(req);
  if (!body) return json({ error: 'invalid_json' }, { status: 400 }, cors);

  const appId = String(body.app_id || '').trim();
  const app = getApp(env, appId);
  if (!app) return json({ error: 'unknown_app' }, { status: 400 }, cors);

  const referrerRe = new RegExp(app.referrer_pattern);
  const referrer = String(body.referrer || '').trim().toLowerCase().slice(0, app.max_referrer_len);
  if (!referrer || !referrerRe.test(referrer)) {
    return json({ error: 'invalid_referrer' }, { status: 400 }, cors);
  }

  const s = fromRequest(req, body as unknown as Record<string, unknown>);
  if (!s.ip) return json({ error: 'no_ip' }, { status: 400 }, cors);

  const clickId = crypto.randomUUID();
  const landingAt = Date.now();

  await env.DB.prepare(
    `INSERT INTO clicks
     (click_id, app_id, referrer, ip, ua, locale, timezone, country, asn,
      screen_w, screen_h, dpr, platform, landing_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      clickId,
      appId,
      referrer,
      s.ip,
      s.ua,
      s.locale,
      s.timezone,
      s.country,
      s.asn,
      s.screen_w,
      s.screen_h,
      s.dpr,
      s.platform,
      landingAt,
    )
    .run();

  return json({ click_id: clickId }, { status: 200 }, cors);
}
