const { loadEnvFiles } = require('../lib/load-env');
const { fetchMatch, getLastRateLimit } = require('../lib/match-service');

loadEnvFiles();

// Expose the latest api-football rate-limit snapshot (per-minute + per-day) on
// the response headers and in the JSON body, so we can see the real limit and
// remaining count rather than guessing.
function withRateLimit(res, body) {
  const rl = getLastRateLimit();
  if (rl) {
    if (rl.perMinLimit != null)     res.setHeader('X-RateLimit-Limit', rl.perMinLimit);
    if (rl.perMinRemaining != null) res.setHeader('X-RateLimit-Remaining', rl.perMinRemaining);
    if (rl.dayLimit != null)        res.setHeader('X-RateLimit-Day-Limit', rl.dayLimit);
    if (rl.dayRemaining != null)    res.setHeader('X-RateLimit-Day-Remaining', rl.dayRemaining);
    if (body && typeof body === 'object') body.rateLimit = rl;
  }
  return body;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const data = await fetchMatch(req.query || {});
    return res.status(200).json(withRateLimit(res, data));
  } catch (err) {
    if (err.code === 'MISSING_API_KEY') {
      return res.status(500).json({ ok: false, error: err.message });
    }
    console.error('[api/match]', err);
    const status = err.code === 'RATE_LIMITED' ? 429 : 502;
    return res.status(status).json(withRateLimit(res, { ok: false, error: err.message || 'Failed to load match data' }));
  }
};
