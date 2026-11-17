// Production-build check: serve dist/ with the real _headers (npm run serve:dist), then
//   node tests/browser/prod-flow.mjs [video]
// Drops a video, exports it, downloads the ZIP, and fails on any console/CSP error.
// Needs `npm i -D playwright` (not a dependency of the app) and a local test video.
import { chromium } from 'playwright';
import { statSync } from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:5191';
const video = process.argv[2] || 'testmedia/small_1min.mp4';
const errors = [];
const b = await chromium.launch();
const ctx = await b.newContext({ acceptDownloads: true });
const page = await ctx.newPage();
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) errors.push(`${m.type()}: ${m.text().slice(0, 250)}`); });
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 250)));
page.on('requestfailed', (r) => errors.push(`reqfail ${r.url().slice(0, 100)} ${r.failure()?.errorText}`));
const hosts = new Set();
page.on('request', (r) => hosts.add(new URL(r.url()).host));
await page.goto(BASE + '/');
console.log('crossOriginIsolated:', await page.evaluate(() => crossOriginIsolated));
await page.waitForFunction(() => /multithreaded|single-thread|FAILED/.test(document.getElementById('st-core')?.textContent || ''), null, { timeout: 90000 });
console.log('core:', await page.locator('#st-core').textContent());
await page.locator('#file').setInputFiles(video);
await page.waitForFunction(() => window.__rotoLast || (window.__roto && window.__roto.duration), null, { timeout: 120000 }).catch(() => {});
await page.waitForTimeout(3000);
if (process.env.MODE === 'slice') await page.locator('input[name=mode][value=slice]').check();
await page.locator('#export-btn').click();
await page.waitForSelector('#results:not([hidden])', { timeout: 240000 });
console.log('pieces:', await page.locator('.piece').count());
console.log('summary:', await page.locator('#results-summary').textContent());
const dl = page.waitForEvent('download');
await ((await page.locator('#dl-all').isVisible()) ? page.locator('#dl-all') : page.locator('.piece button').first()).click();
const d = await dl; await d.saveAs('tests/browser/out.bin');
console.log('download bytes:', statSync('tests/browser/out.bin').size, 'engine:', await page.evaluate(() => window.__rotoLast?.engine));
console.log('hosts:', [...hosts].join(', '));
console.log('console problems:', errors.length ? '\n' + errors.join('\n') : 'none');
await b.close();
process.exit(errors.length ? 1 : 0);
