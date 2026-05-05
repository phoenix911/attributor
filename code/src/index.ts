import type { Env } from './env';
import { handleClick } from './click';
import { handleMatch } from './match';
import { handleDashboard } from './dashboard';
import { json, preflight } from './http';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') return preflight(req, env);

    if (req.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/click') {
      return handleClick(req, env);
    }

    if (req.method === 'POST' && url.pathname === '/match') {
      return handleMatch(req, env);
    }

    if (req.method === 'GET' && url.pathname.startsWith('/dashboard')) {
      return handleDashboard(req, env);
    }

    return json({ error: 'not_found' }, { status: 404 });
  },
};
