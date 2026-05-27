const fs = require('fs');
const path = require('path');

/**
 * Load .env.local / .env into process.env (only keys not already set).
 */
function loadEnvFiles(rootDir = path.join(__dirname, '..')) {
  for (const name of ['.env.local', '.env']) {
    const filePath = path.join(rootDir, name);
    if (!fs.existsSync(filePath)) continue;

    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;

      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

function getApiFootballKey() {
  return (
    process.env.API_FOOTBALL_KEY ||
    process.env.api_football_key ||
    process.env.APISPORTS_KEY ||
    process.env.APIFOOTBALL_KEY ||
    ''
  ).trim();
}

module.exports = { loadEnvFiles, getApiFootballKey };
