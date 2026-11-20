// End-to-end check against the production build, in one browser:
//   npm run build && npm run serve:dist     (port 5191)
//   BROWSER=chrome|edge|firefox|iphone node tests/browser/e2e.mjs [video]
// Checks the brand/credits/Ko-fi wiring, then drops a video, runs a REAL silence-cut
// export (Ripple, Quick), downloads the result and fails on any console / CSP error.
import { chromium, firefox, webkit, devices } from 'playwright';
import { statSync, mkdirSync } from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:5191';
const which = process.env.BROWSER || 'chrome';
const video = process.argv[2] || 'testmedia/small_1min.mp4';
const shots = process.env.SHOTS; // folder for screenshots
const launchers = {
  chrome: () => chromium.launch({ channel: 'chrome' }),
  edge: () => chromium.launch({ channel: 'msedge' }),
  firefox: () => firefox.launch(),
  iphone: () => webkit.launch(),
};
const b = await launchers[which]();
const ctx = await b.newContext({ acceptDownloads: true, ...(which === 'iphone' ? devices['iPhone 14'] : { viewport: { width: 1440, height: 900 } }) });
const page = await ctx.newPage();
const problems = [];
const fail = (m) => problems.push(m);
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) fail(`console ${m.type()}: ${m.text().slice(0, 200)}`); });
page.on('pageerror', (e) => fail('pageerror: ' + String(e).slice(0, 200)));
page.on('requestfailed', (r) => /ABORTED/.test(r.failure()?.errorText || '') || fail(`requestfailed ${r.url().slice(0, 90)} ${r.failure()?.errorText}`));
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fail(what); };

await page.goto(BASE + '/');
check(await page.evaluate(() => crossOriginIsolated), 'cross-origin isolated');
check(await page.locator('.wordmark img').evaluate((i) => i.complete && i.naturalWidth > 0), 'header logo loaded');
check((await page.locator('link[rel=icon]').count()) >= 3 && (await page.locator('link[rel=apple-touch-icon]').count()) === 1, 'favicon + apple-touch-icon links');
check((await page.locator('meta[property="og:image"]').getAttribute('content')).endsWith('/brand/og-image.jpg'), 'og:image meta');
for (const url of ['/favicon.ico', '/favicon.svg', '/site.webmanifest', '/brand/og-image.jpg', '/brand/apple-touch-icon.png', '/brand/icon-192.png', '/brand/icon-512.png', '/licenses/GPL-2.0.txt', '/brand/bg-texture.webp']) {
  const r = await page.request.get(BASE + url);
  check(r.status() === 200, `GET ${url} -> ${r.status()}`);
}
const kofi = page.locator('a[href="https://ko-fi.com/robbiefromramona"]');
check((await kofi.count()) >= 3, `Ko-fi links (${await kofi.count()})`);
for (const a of await kofi.all()) {
  const rel = await a.getAttribute('rel'), t = await a.getAttribute('target');
  if (t !== '_blank' || !/noopener/.test(rel) || !/noreferrer/.test(rel)) fail('Ko-fi link missing target/rel');
}
check((await page.locator('script[src*="ko-fi"]').count()) === 0, 'no Ko-fi scripts');
check(await page.locator('.foot-links a[href="/credits"]').count() === 1, 'footer links to /credits');
if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: `${shots}/${which}-landing.png`, fullPage: true }); }

// /split still routes
await page.goto(BASE + '/split');
check(await page.locator('#view-split').isVisible(), '/split opens Pre-Slice');

// credits page
const cr = await page.goto(BASE + '/credits');
check(cr.status() === 200, '/credits 200');
const txt = await page.locator('main').innerText();
check(/GPL-2\.0-or-later/.test(txt) && /github\.com\/FFmpeg\/FFmpeg/.test(await page.content()) && /Bebas Neue/.test(txt) && /all rights reserved/i.test(txt), '/credits lists FFmpeg GPL + source, fonts, artwork');
if (shots) await page.screenshot({ path: `${shots}/${which}-credits.png`, fullPage: true });

// real silence-cut export
await page.goto(BASE + '/');
await page.waitForFunction(() => /multithreaded|single-thread|FAILED/.test(document.getElementById('st-core')?.textContent || ''), null, { timeout: 120000 });
console.log('core:', await page.locator('#st-core').textContent());
await page.locator('#file').setInputFiles(video);
await page.waitForSelector('#work:not([hidden])', { timeout: 180000 });
if (shots) await page.screenshot({ path: `${shots}/${which}-editor.png`, fullPage: true });
await page.locator('#export-btn').click();
await page.waitForSelector('#results:not([hidden])', { timeout: 300000 });
const pieces = await page.locator('.piece').count();
check(pieces >= 1, `export produced ${pieces} file(s): ${await page.locator('#results-summary').textContent()}`);
check(await page.locator('#kofi-nudge-roto').isVisible(), 'Ko-fi line shown after export');
const dlBtn = page.locator('.piece button').first();
check(await dlBtn.isEnabled(), 'download button usable while the Ko-fi line is shown');
if (shots) await page.screenshot({ path: `${shots}/${which}-results.png`, fullPage: true });
const dl = page.waitForEvent('download');
await dlBtn.click();
const d = await dl; await d.saveAs(`tests/browser/out.${which}.bin`);
const bytes = statSync(`tests/browser/out.${which}.bin`).size;
check(bytes > 10000, `downloaded ${bytes} bytes`);
await page.locator('#kofi-nudge-roto .x').click();
check(!(await page.locator('#kofi-nudge-roto').isVisible()), 'Ko-fi line dismisses');

await b.close();
console.log(problems.length ? `\n${which}: ${problems.length} PROBLEM(S)\n` + problems.join('\n') : `\n${which}: ALL PASSED`);
process.exit(problems.length ? 1 : 0);
