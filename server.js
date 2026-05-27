#!/usr/bin/env node
/**
 * Local dev server — serves static files + /api/match (loads .env.local).
 * Use: npm run dev
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { loadEnvFiles } = require('./lib/load-env');
const { fetchMatch, fetchUpcoming, fetchUpcomingList, getApiFootballKey } = require('./lib/match-service');
const { fetchStandings } = require('./lib/standings-service');

loadEnvFiles();

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function parseQuery(url) {
  const params = new URL(url, 'http://localhost').searchParams;
  const query = {};
  for (const [k, v] of params) query[k] = v;
  return query;
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function serveStatic(req, res) {
  let pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/') pathname = '/index.html';

  const filePath = path.join(ROOT, pathname);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url?.startsWith('/api/match')) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    if (req.method !== 'GET') {
      return sendJson(res, 405, { error: 'Method not allowed' });
    }
    try {
      const data = await fetchMatch(parseQuery(req.url));
      return sendJson(res, 200, data);
    } catch (err) {
      if (err.code === 'MISSING_API_KEY') {
        return sendJson(res, 500, { ok: false, error: err.message });
      }
      console.error('[api/match]', err);
      return sendJson(res, 502, { ok: false, error: err.message });
    }
  }

  if (req.url?.startsWith('/api/standings')) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    if (req.method !== 'GET') {
      return sendJson(res, 405, { error: 'Method not allowed' });
    }
    try {
      const data = await fetchStandings(parseQuery(req.url));
      return sendJson(res, 200, data);
    } catch (err) {
      if (err.code === 'MISSING_API_KEY') {
        return sendJson(res, 500, { ok: false, error: err.message });
      }
      console.error('[api/standings]', err);
      return sendJson(res, 502, { ok: false, error: err.message });
    }
  }

  if (req.url?.startsWith('/api/upcoming-list')) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    if (req.method !== 'GET') {
      return sendJson(res, 405, { error: 'Method not allowed' });
    }
    try {
      const data = await fetchUpcomingList(parseQuery(req.url));
      return sendJson(res, 200, data);
    } catch (err) {
      if (err.code === 'MISSING_API_KEY') {
        return sendJson(res, 500, { ok: false, error: err.message });
      }
      console.error('[api/upcoming-list]', err);
      return sendJson(res, 502, { ok: false, error: err.message });
    }
  }

  if (req.url?.startsWith('/api/upcoming')) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    if (req.method !== 'GET') {
      return sendJson(res, 405, { error: 'Method not allowed' });
    }
    try {
      const data = await fetchUpcoming(parseQuery(req.url));
      return sendJson(res, 200, data);
    } catch (err) {
      if (err.code === 'MISSING_API_KEY') {
        return sendJson(res, 500, { ok: false, error: err.message });
      }
      console.error('[api/upcoming]', err);
      const body = { ok: false, error: err.message };
      if (err.debug) body.debug = err.debug;
      return sendJson(res, 502, body);
    }
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  const hasKey = Boolean(getApiFootballKey());
  console.log(`\n  CBA Socceroos dev server → http://localhost:${PORT}`);
  console.log(`  Match Live → http://localhost:${PORT}/screen-matchlive.html`);
  console.log(`  API key: ${hasKey ? 'loaded from .env.local' : 'MISSING — set API_FOOTBALL_KEY in .env.local'}\n`);
});
