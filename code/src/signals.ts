// Helpers to extract attribution signals from request + body in a uniform way.

export type Signals = {
  ip: string;
  ua: string;
  country: string;
  asn: number | null;
  locale: string;
  timezone: string;
  screen_w: number | null;
  screen_h: number | null;
  dpr: number | null;
  platform: string;
};

type CfLike = { country?: string; asn?: number };

export function fromRequest(req: Request, body: Record<string, unknown>): Signals {
  const cf = (req.cf || {}) as CfLike;
  return {
    ip: req.headers.get('CF-Connecting-IP') || '',
    ua: String(body.ua || req.headers.get('User-Agent') || '').slice(0, 512),
    country: cf.country || '',
    asn: typeof cf.asn === 'number' ? cf.asn : null,
    locale: clean(body.locale, 32),
    timezone: clean(body.timezone, 64),
    screen_w: int(body.screen_w),
    screen_h: int(body.screen_h),
    dpr: num(body.dpr),
    platform: clean(body.platform, 16) || guessPlatform(req.headers.get('User-Agent') || ''),
  };
}

function clean(v: unknown, max: number): string {
  return String(v ?? '').slice(0, max);
}
function int(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n < 100000 ? Math.round(n) : null;
}
function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n < 100 ? n : null;
}
function guessPlatform(ua: string): string {
  if (/android/i.test(ua)) return 'android';
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
  return 'desktop';
}
