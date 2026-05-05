-- Single click log shared across all apps. Multi-tenant via app_id.
-- Apply locally:  npm run db:apply:local
-- Apply remote:   npm run db:apply:remote

CREATE TABLE IF NOT EXISTS clicks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  click_id     TEXT NOT NULL UNIQUE,
  app_id       TEXT NOT NULL,
  referrer     TEXT NOT NULL,
  ip           TEXT NOT NULL,
  ua           TEXT,
  locale       TEXT,
  timezone     TEXT,
  country      TEXT,
  asn          INTEGER,
  screen_w     INTEGER,
  screen_h     INTEGER,
  dpr          REAL,
  platform     TEXT,           -- 'ios' | 'android' | 'desktop' | 'unknown'
  landing_at   INTEGER NOT NULL  -- unix ms
);

-- Hot path on /match: same app + same IP, recent first.
CREATE INDEX IF NOT EXISTS idx_clicks_match
  ON clicks(app_id, ip, landing_at DESC);

-- Fallback path when IP changed (Wi-Fi → cellular): same ASN+country bucket.
CREATE INDEX IF NOT EXISTS idx_clicks_asn
  ON clicks(app_id, asn, country, landing_at DESC);

-- Outcome of each /match call. Lets us measure attribution rate over time.
CREATE TABLE IF NOT EXISTS matches (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id       TEXT NOT NULL,
  click_id     TEXT,            -- NULL when no match
  method       TEXT NOT NULL,   -- 'play_referrer' | 'fingerprint' | 'unattributed'
  score        INTEGER,
  candidates   INTEGER,
  ip           TEXT,
  ua           TEXT,
  matched_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_matches_app_time
  ON matches(app_id, matched_at DESC);
