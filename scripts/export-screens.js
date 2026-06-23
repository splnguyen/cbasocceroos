// One-off: screenshot every screen-*.html at native 1080×1920 into ./screenshots.
// Usage: node scripts/export-screens.js [baseUrl]
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:65268';
const OUT = path.join(__dirname, '..', 'screenshots');
const screens = fs
  .readdirSync(path.join(__dirname, '..'))
  .filter((f) => /^screen-.*\.html$/.test(f))
  .sort();

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1080, height: 1920 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  const results = [];
  for (const file of screens) {
    const url = `${BASE}/${file}?demo=1`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    // Flat settle: long enough for the screen's first poll round-trip to land
    // AND repaint. (A "wait until no error text" check races: the initial frame
    // is clean before the fetch resolves, so it can screenshot too early.)
    await page.waitForTimeout(6500);
    const out = path.join(OUT, file.replace(/\.html$/, '.png'));
    await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1080, height: 1920 } });
    results.push(file);
    console.log('saved', path.basename(out));
  }
  await browser.close();
  console.log(`\nDone: ${results.length} screens → ${OUT}`);
})();
