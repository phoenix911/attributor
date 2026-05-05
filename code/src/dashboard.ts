// Dashboard for the attribution Worker.
// - GET  /dashboard            → HTML page (Basic auth)
// - GET  /dashboard/api/stats  → JSON aggregations
//
// Auth via env: DASHBOARD_USER + DASHBOARD_PASS (set with `wrangler secret put DASHBOARD_PASS`).
// Without DASHBOARD_USER set, the dashboard is closed (returns 503).

import type { Env } from './env';
import { getApps } from './env';

type DashboardEnv = Env & {
  DASHBOARD_USER?: string;
  DASHBOARD_PASS?: string;
};

const TIME_WINDOW_DAYS = 30;

export async function handleDashboard(req: Request, env: DashboardEnv): Promise<Response> {
  if (!env.DASHBOARD_USER || !env.DASHBOARD_PASS) {
    return text('Dashboard not configured. Set DASHBOARD_USER + DASHBOARD_PASS.', 503);
  }
  const auth = req.headers.get('Authorization') || '';
  const expected = 'Basic ' + btoa(`${env.DASHBOARD_USER}:${env.DASHBOARD_PASS}`);
  if (auth !== expected) {
    return new Response('Authentication required', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="attribution"' },
    });
  }

  const url = new URL(req.url);
  if (url.pathname === '/dashboard/api/stats') {
    return handleStats(req, env);
  }
  return new Response(DASHBOARD_HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function handleStats(req: Request, env: DashboardEnv): Promise<Response> {
  const url = new URL(req.url);
  const days = clamp(parseInt(url.searchParams.get('days') || '30'), 1, 90);
  const appFilter = url.searchParams.get('app') || '';
  const cutoff = Date.now() - days * 86400 * 1000;

  const where = appFilter ? 'AND app_id = ?' : '';
  const bindings = appFilter ? [cutoff, appFilter] : [cutoff];
  const matchBindings = appFilter ? [cutoff, appFilter] : [cutoff];

  const [
    appsRow,
    summaryRow,
    perDayRow,
    methodRow,
    topReferrersRow,
    perRefRow,
    countriesRow,
    perAppRow,
  ] = await Promise.all([
    env.DB.prepare(`SELECT DISTINCT app_id FROM clicks ORDER BY app_id`).all<{ app_id: string }>(),

    env.DB.prepare(
      `SELECT
        (SELECT count(*) FROM clicks  WHERE landing_at >= ? ${where}) AS clicks,
        (SELECT count(*) FROM matches WHERE matched_at >= ? ${where}) AS matches_total,
        (SELECT count(*) FROM matches WHERE matched_at >= ? ${where} AND method != 'unattributed') AS matches_hit,
        (SELECT count(DISTINCT referrer) FROM clicks WHERE landing_at >= ? ${where}) AS referrers_count`,
    )
      .bind(...bindings, ...bindings, ...bindings, ...bindings)
      .first<{ clicks: number; matches_total: number; matches_hit: number; referrers_count: number }>(),

    env.DB.prepare(
      `SELECT date(landing_at/1000, 'unixepoch') AS d, count(*) AS n
       FROM clicks WHERE landing_at >= ? ${where}
       GROUP BY d ORDER BY d`,
    )
      .bind(...bindings)
      .all<{ d: string; n: number }>(),

    env.DB.prepare(
      `SELECT method, count(*) AS n
       FROM matches WHERE matched_at >= ? ${where}
       GROUP BY method`,
    )
      .bind(...matchBindings)
      .all<{ method: string; n: number }>(),

    env.DB.prepare(
      `SELECT referrer, count(*) AS clicks
       FROM clicks WHERE landing_at >= ? ${where}
       GROUP BY referrer ORDER BY clicks DESC LIMIT 20`,
    )
      .bind(...bindings)
      .all<{ referrer: string; clicks: number }>(),

    env.DB.prepare(
      `WITH ref_clicks AS (
         SELECT referrer, click_id FROM clicks WHERE landing_at >= ? ${where}
       )
       SELECT rc.referrer,
              count(*) AS clicks,
              sum(CASE WHEN m.method IS NOT NULL AND m.method != 'unattributed' THEN 1 ELSE 0 END) AS matched
       FROM ref_clicks rc
       LEFT JOIN matches m ON m.click_id = rc.click_id
       GROUP BY rc.referrer ORDER BY clicks DESC LIMIT 20`,
    )
      .bind(...bindings)
      .all<{ referrer: string; clicks: number; matched: number }>(),

    env.DB.prepare(
      `SELECT country, count(*) AS n
       FROM clicks WHERE landing_at >= ? ${where} AND country != ''
       GROUP BY country ORDER BY n DESC LIMIT 10`,
    )
      .bind(...bindings)
      .all<{ country: string; n: number }>(),

    env.DB.prepare(
      `SELECT app_id, count(*) AS n
       FROM clicks WHERE landing_at >= ?
       GROUP BY app_id ORDER BY n DESC`,
    )
      .bind(cutoff)
      .all<{ app_id: string; n: number }>(),
  ]);

  const apps = (appsRow.results || []).map((r) => r.app_id);
  const knownApps = Object.keys(getApps(env));
  for (const a of knownApps) if (!apps.includes(a)) apps.push(a);

  return new Response(
    JSON.stringify({
      days,
      app: appFilter || null,
      apps,
      summary: summaryRow || { clicks: 0, matches_total: 0, matches_hit: 0, referrers_count: 0 },
      perDay: perDayRow.results || [],
      method: methodRow.results || [],
      topReferrers: topReferrersRow.results || [],
      perReferrer: perRefRow.results || [],
      countries: countriesRow.results || [],
      perApp: perAppRow.results || [],
      generated_at: new Date().toISOString(),
    }),
    { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
  );
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : min));
}
function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Attribution · measures.fit</title>
<style>
  :root {
    --bg: #0F0F0F;
    --panel: #1a1a1a;
    --line: rgba(255,255,255,0.08);
    --text: #fefbf8;
    --dim: rgba(254,251,248,0.55);
    --coral: #FF6B47;
    --emerald: #10b981;
    --amber: #f59e0b;
    --rose: #f43f5e;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; }
  header { padding: 20px 24px; border-bottom: 1px solid var(--line); display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
  header h1 { margin: 0; font-size: 18px; font-weight: 700; letter-spacing: -0.3px; }
  header .ctl { display: flex; gap: 8px; flex-wrap: wrap; }
  select, button { background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; font-size: 13px; font-family: inherit; cursor: pointer; }
  select:hover, button:hover { border-color: var(--coral); }
  button[data-active="true"] { background: var(--coral); border-color: var(--coral); }
  main { padding: 24px; display: grid; gap: 16px; max-width: 1280px; margin: 0 auto; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 18px; }
  .card.full { grid-column: 1 / -1; }
  .card h2 { margin: 0 0 12px; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: var(--dim); font-weight: 600; }
  .stat { font-size: 32px; font-weight: 700; letter-spacing: -1px; line-height: 1; }
  .stat .unit { font-size: 13px; color: var(--dim); font-weight: 500; margin-left: 6px; }
  .delta { font-size: 12px; color: var(--dim); margin-top: 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  table th { text-align: left; color: var(--dim); font-weight: 500; padding: 6px 8px; border-bottom: 1px solid var(--line); }
  table td { padding: 8px; border-bottom: 1px solid rgba(255,255,255,0.04); font-variant-numeric: tabular-nums; }
  table td.num { text-align: right; }
  .bar { display: inline-block; height: 6px; background: var(--coral); border-radius: 3px; vertical-align: middle; }
  .barbg { display: block; height: 6px; background: rgba(255,255,255,0.06); border-radius: 3px; margin-top: 4px; }
  .barbg .barfill { display: block; height: 100%; background: var(--coral); border-radius: 3px; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; letter-spacing: 0.3px; }
  .pill.ok { background: rgba(16,185,129,0.15); color: var(--emerald); }
  .pill.miss { background: rgba(244,63,94,0.15); color: var(--rose); }
  .pill.det { background: rgba(245,158,11,0.15); color: var(--amber); }
  .pct { color: var(--dim); margin-left: 8px; }
  canvas { width: 100%; height: 200px; display: block; }
  footer { padding: 16px 24px; color: var(--dim); font-size: 11px; text-align: center; }
  .empty { color: var(--dim); padding: 12px 0; font-size: 13px; }
</style>
</head>
<body>
<header>
  <h1>Attribution · measures.fit</h1>
  <div class="ctl">
    <select id="app-filter"><option value="">All apps</option></select>
    <button data-days="7">7d</button>
    <button data-days="30" data-active="true">30d</button>
    <button data-days="90">90d</button>
    <button id="refresh">↻</button>
  </div>
</header>
<main id="grid">
  <div class="card"><h2>Clicks</h2><div class="stat" id="stat-clicks">—</div></div>
  <div class="card"><h2>Match rate</h2><div class="stat" id="stat-rate">—<span class="unit">%</span></div><div class="delta" id="stat-rate-detail"></div></div>
  <div class="card"><h2>Unique referrers</h2><div class="stat" id="stat-referrers">—</div></div>
  <div class="card"><h2>Matches logged</h2><div class="stat" id="stat-matches">—</div></div>

  <div class="card full"><h2>Clicks per day</h2><canvas id="chart-perday"></canvas></div>

  <div class="card full"><h2>Match method</h2><div id="method-list"></div></div>

  <div class="card full"><h2>Top referrers — clicks → matched</h2><div id="ref-table"></div></div>

  <div class="card"><h2>Top countries</h2><div id="country-table"></div></div>
  <div class="card"><h2>Per-app split</h2><div id="app-split"></div></div>
</main>
<footer id="meta"></footer>
<script>
const params = new URLSearchParams();
let days = 30;
let appFilter = '';

const fmt = (n) => n == null ? '—' : Number(n).toLocaleString();

async function load() {
  params.set('days', days);
  if (appFilter) params.set('app', appFilter); else params.delete('app');
  const r = await fetch('/dashboard/api/stats?' + params.toString(), { credentials: 'same-origin' });
  if (!r.ok) { document.getElementById('grid').innerHTML = '<div class="card full empty">Error: ' + r.status + '</div>'; return; }
  const d = await r.json();
  render(d);
}

function render(d) {
  const s = d.summary || {};
  document.getElementById('stat-clicks').textContent = fmt(s.clicks);
  document.getElementById('stat-matches').textContent = fmt(s.matches_total);
  document.getElementById('stat-referrers').textContent = fmt(s.referrers_count);
  const rate = s.matches_total > 0 ? (s.matches_hit / s.matches_total * 100) : 0;
  document.getElementById('stat-rate').firstChild.nodeValue = rate.toFixed(1);
  document.getElementById('stat-rate-detail').textContent = fmt(s.matches_hit) + ' matched / ' + fmt(s.matches_total) + ' tries';

  // App filter dropdown
  const sel = document.getElementById('app-filter');
  if (sel.options.length <= 1 && d.apps?.length) {
    for (const a of d.apps) {
      const opt = document.createElement('option'); opt.value = a; opt.textContent = a;
      if (a === appFilter) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  // Per-day line chart
  drawLine('chart-perday', (d.perDay || []).map(x => ({ label: x.d, value: x.n })));

  // Match method
  const totalMethods = (d.method || []).reduce((a, b) => a + b.n, 0) || 1;
  document.getElementById('method-list').innerHTML = (d.method || []).map(m => {
    const pct = (m.n / totalMethods * 100).toFixed(1);
    const cls = m.method === 'unattributed' ? 'miss' : m.method === 'play_referrer' ? 'det' : 'ok';
    return '<div style="margin-bottom:10px"><span class="pill '+cls+'">'+m.method+'</span> <span style="font-weight:600;margin-left:8px">'+fmt(m.n)+'</span><span class="pct">'+pct+'%</span><span class="barbg"><span class="barfill" style="width:'+pct+'%"></span></span></div>';
  }).join('') || '<div class="empty">No /match calls yet</div>';

  // Top referrers
  const max = Math.max(1, ...(d.perReferrer || []).map(x => x.clicks));
  document.getElementById('ref-table').innerHTML = '<table><thead><tr><th>Referrer</th><th class="num">Clicks</th><th class="num">Matched</th><th class="num">Rate</th><th></th></tr></thead><tbody>' +
    ((d.perReferrer || []).map(r => {
      const rate = r.clicks > 0 ? (r.matched / r.clicks * 100) : 0;
      const w = (r.clicks / max * 100);
      return '<tr><td>' + esc(r.referrer) + '</td><td class="num">' + fmt(r.clicks) + '</td><td class="num">' + fmt(r.matched) + '</td><td class="num">' + rate.toFixed(0) + '%</td><td><span class="bar" style="width:'+w+'px"></span></td></tr>';
    }).join('')) + '</tbody></table>' || '<div class="empty">No referrers yet</div>';

  // Countries
  document.getElementById('country-table').innerHTML = '<table><tbody>' +
    ((d.countries || []).map(c => '<tr><td>' + esc(c.country) + '</td><td class="num">' + fmt(c.n) + '</td></tr>').join('')) +
    '</tbody></table>' || '<div class="empty">—</div>';

  // App split
  document.getElementById('app-split').innerHTML = '<table><tbody>' +
    ((d.perApp || []).map(a => '<tr><td>' + esc(a.app_id) + '</td><td class="num">' + fmt(a.n) + '</td></tr>').join('')) +
    '</tbody></table>' || '<div class="empty">—</div>';

  document.getElementById('meta').textContent = 'Last refreshed ' + new Date(d.generated_at).toLocaleString() + ' · window: ' + d.days + 'd' + (d.app ? ' · app: ' + d.app : '');
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function drawLine(id, points) {
  const c = document.getElementById(id);
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  c.width = w * dpr; c.height = h * dpr;
  const ctx = c.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  if (!points.length) {
    ctx.fillStyle = 'rgba(254,251,248,0.4)'; ctx.font = '13px system-ui';
    ctx.fillText('No clicks in window', 12, h / 2);
    return;
  }
  const maxv = Math.max(...points.map(p => p.value), 1);
  const pad = { l: 30, r: 12, t: 14, b: 22 };
  const cw = w - pad.l - pad.r, ch = h - pad.t - pad.b;
  // Y axis grid
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.fillStyle = 'rgba(254,251,248,0.4)';
  ctx.font = '11px system-ui';
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + ch - (ch * i / 4);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillText(Math.round(maxv * i / 4), 4, y + 3);
  }
  // Path
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#FF6B47';
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = pad.l + (i / Math.max(1, points.length - 1)) * cw;
    const y = pad.t + ch - (p.value / maxv) * ch;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  // Fill
  ctx.lineTo(pad.l + cw, pad.t + ch);
  ctx.lineTo(pad.l, pad.t + ch);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,107,71,0.12)';
  ctx.fill();
  // X axis labels (first / mid / last)
  ctx.fillStyle = 'rgba(254,251,248,0.4)';
  if (points.length) {
    const f = points[0].label, m = points[Math.floor(points.length / 2)].label, l = points[points.length - 1].label;
    ctx.fillText(f, pad.l, h - 6);
    ctx.fillText(m, pad.l + cw / 2 - 22, h - 6);
    ctx.fillText(l, w - pad.r - 50, h - 6);
  }
}

// Wire controls
document.querySelectorAll('header button[data-days]').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('header button[data-days]').forEach(x => x.removeAttribute('data-active'));
    b.setAttribute('data-active', 'true');
    days = parseInt(b.dataset.days);
    load();
  });
});
document.getElementById('app-filter').addEventListener('change', e => { appFilter = e.target.value; load(); });
document.getElementById('refresh').addEventListener('click', load);
window.addEventListener('resize', () => load());

load();
</script>
</body>
</html>`;
