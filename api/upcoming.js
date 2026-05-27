const { loadEnvFiles } = require('../lib/load-env');
const { fetchUpcoming } = require('../lib/match-service');

loadEnvFiles();

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const data = await fetchUpcoming(req.query || {});
    return res.status(200).json(data);
  } catch (err) {
    if (err.code === 'MISSING_API_KEY') {
      return res.status(500).json({ ok: false, error: err.message });
    }
    console.error('[api/upcoming]', err);
    const body = { ok: false, error: err.message || 'Failed to load upcoming data' };
    if (err.debug) body.debug = err.debug;
    return res.status(502).json(body);
  }
};
