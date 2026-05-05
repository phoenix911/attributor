import { getApp, type Env } from './env';
import { corsHeaders, json, readJson } from './http';
import { fromRequest, type Signals } from './signals';

type MatchBody = {
  app_id?: string;
  play_referrer?: string;   // Android: raw INSTALL_REFERRER string
  ua?: string;
  locale?: string;
  timezone?: string;
  screen_w?: number;
  screen_h?: number;
  dpr?: number;
  platform?: string;
};

const SCORE_THRESHOLD = 60;

export async function handleMatch(req: Request, env: Env): Promise<Response> {
  const origin = req.headers.get('Origin');
  const cors = corsHeaders(origin, env);

  const body = await readJson<MatchBody>(req);
  if (!body) return json({ error: 'invalid_json' }, { status: 400 }, cors);

  const appId = String(body.app_id || '').trim();
  const app = getApp(env, appId);
  if (!app) return json({ error: 'unknown_app' }, { status: 400 }, cors);

  const s = fromRequest(req, body as unknown as Record<string, unknown>);
  const matchedAt = Date.now();

  // ── Android: Play Install Referrer is deterministic, skip fingerprint scoring.
  const playReferrer = String(body.play_referrer || '');
  if (playReferrer) {
    const click = await lookupByPlayReferrer(env, appId, playReferrer);
    if (click) {
      await recordOutcome(env, appId, click.click_id, 'play_referrer', null, 1, s, matchedAt);
      return json(
        { matched: true, referrer: click.referrer, method: 'play_referrer', click_id: click.click_id },
        { status: 200 },
        cors,
      );
    }
    await recordOutcome(env, appId, null, 'unattributed', null, 0, s, matchedAt);
    return json({ matched: false, method: 'unattributed' }, { status: 200 }, cors);
  }

  // ── iOS / web fallback: probabilistic fingerprint scoring.
  const cutoff = matchedAt - app.ttl_days * 86400 * 1000;
  const candidates = await loadCandidates(env, appId, s, cutoff);

  if (candidates.length === 0) {
    await recordOutcome(env, appId, null, 'unattributed', null, 0, s, matchedAt);
    return json({ matched: false, method: 'unattributed' }, { status: 200 }, cors);
  }

  let best: { row: ClickRow; score: number } | null = null;
  for (const row of candidates) {
    const score = scoreCandidate(row, s, matchedAt);
    if (!best || score > best.score) best = { row, score };
  }

  if (!best || best.score < SCORE_THRESHOLD) {
    await recordOutcome(env, appId, null, 'unattributed', best?.score ?? 0, candidates.length, s, matchedAt);
    return json({ matched: false, method: 'unattributed' }, { status: 200 }, cors);
  }

  await recordOutcome(env, appId, best.row.click_id, 'fingerprint', best.score, candidates.length, s, matchedAt);
  return json(
    {
      matched: true,
      referrer: best.row.referrer,
      method: 'fingerprint',
      click_id: best.row.click_id,
      score: best.score,
    },
    { status: 200 },
    cors,
  );
}

// ── helpers ────────────────────────────────────────────────────────────

type ClickRow = {
  click_id: string;
  referrer: string;
  ip: string;
  ua: string | null;
  locale: string | null;
  timezone: string | null;
  country: string | null;
  asn: number | null;
  screen_w: number | null;
  screen_h: number | null;
  dpr: number | null;
  platform: string | null;
  landing_at: number;
};

async function loadCandidates(env: Env, appId: string, s: Signals, cutoff: number): Promise<ClickRow[]> {
  // Pull candidates by IP first (cheap, indexed). Fall back to ASN+country
  // bucket so a Wi-Fi → cellular IP change doesn't lose the match.
  const byIp = await env.DB.prepare(
    `SELECT click_id, referrer, ip, ua, locale, timezone, country, asn,
            screen_w, screen_h, dpr, platform, landing_at
     FROM clicks
     WHERE app_id = ? AND ip = ? AND landing_at >= ?
     ORDER BY landing_at DESC LIMIT 50`,
  )
    .bind(appId, s.ip, cutoff)
    .all<ClickRow>();

  const rows = byIp.results || [];
  if (rows.length > 0) return rows;

  if (s.asn !== null && s.country) {
    const byAsn = await env.DB.prepare(
      `SELECT click_id, referrer, ip, ua, locale, timezone, country, asn,
              screen_w, screen_h, dpr, platform, landing_at
       FROM clicks
       WHERE app_id = ? AND asn = ? AND country = ? AND landing_at >= ?
       ORDER BY landing_at DESC LIMIT 100`,
    )
      .bind(appId, s.asn, s.country, cutoff)
      .all<ClickRow>();
    return byAsn.results || [];
  }
  return [];
}

function scoreCandidate(row: ClickRow, s: Signals, now: number): number {
  // Hard reject: platform mismatch (Android click → iOS install can't be the same device).
  if (row.platform && s.platform && row.platform !== 'desktop' && s.platform !== 'desktop') {
    if (row.platform !== s.platform) return -1;
  }

  let score = 0;
  if (row.ip && row.ip === s.ip) score += 40;
  if (row.ua && s.ua) {
    if (row.ua === s.ua) score += 25;
    else if (sameDeviceClass(row.ua, s.ua)) score += 15;
  }
  if (row.locale && row.locale === s.locale) score += 15;
  if (row.timezone && row.timezone === s.timezone) score += 10;
  if (row.screen_w && row.screen_w === s.screen_w && row.screen_h === s.screen_h) score += 10;
  if (row.dpr && s.dpr && row.dpr === s.dpr) score += 5;
  if (row.country && row.country === s.country) score += 5;
  if (row.asn !== null && row.asn === s.asn) score += 5;

  // Recency penalty: ~1pt per hour, soft.
  const hours = Math.max(0, (now - row.landing_at) / 3_600_000);
  score -= Math.min(48, Math.round(hours));
  return score;
}

function sameDeviceClass(a: string, b: string): boolean {
  // Crude: same OS family + same major version.
  const re = /(iPhone|iPad|iPod|Android)[^;)]*?(\d+)/i;
  const ma = a.match(re);
  const mb = b.match(re);
  return Boolean(ma && mb && ma[1].toLowerCase() === mb[1].toLowerCase() && ma[2] === mb[2]);
}

async function lookupByPlayReferrer(env: Env, appId: string, playReferrer: string): Promise<ClickRow | null> {
  // The install page sends the FULL query string as `referrer=` to Play; we
  // need to dig the originating click_id back out. We embed `click_id=<uuid>`
  // in that string at /click time (see install/index.astro update).
  const m = playReferrer.match(/(?:^|&)click_id=([a-f0-9-]{36})/);
  if (!m) return null;
  const row = await env.DB.prepare(
    `SELECT click_id, referrer, ip, ua, locale, timezone, country, asn,
            screen_w, screen_h, dpr, platform, landing_at
     FROM clicks WHERE app_id = ? AND click_id = ? LIMIT 1`,
  )
    .bind(appId, m[1])
    .first<ClickRow>();
  return row || null;
}

async function recordOutcome(
  env: Env,
  appId: string,
  clickId: string | null,
  method: 'play_referrer' | 'fingerprint' | 'unattributed',
  score: number | null,
  candidates: number,
  s: Signals,
  matchedAt: number,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO matches (app_id, click_id, method, score, candidates, ip, ua, matched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(appId, clickId, method, score, candidates, s.ip, s.ua, matchedAt)
    .run();
}
