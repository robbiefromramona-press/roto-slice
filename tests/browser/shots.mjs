// Screenshots of landing, editor and results (Chrome, desktop):
//   BASE=http://localhost:5191 node tests/browser/shots.mjs <outdir> [video]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:5191';
const out = process.argv[2] || 'docs/shots';
const video = process.argv[3] || 'testmedia/small_1min.mp4';
mkdirSync(out, { recursive: true });
const b = await chromium.launch({ channel: 'chrome' });
const page = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto(BASE + '/');
await page.waitForFunction(() => /multithreaded|single-thread|FAILED/.test(document.getElementById('st-core')?.textContent || ''), null, { timeout: 120000 });
await page.screenshot({ path: `${out}/1-landing.png` });
await page.locator('#file').setInputFiles(video);
await page.waitForSelector('#work:not([hidden])', { timeout: 180000 });
await page.screenshot({ path: `${out}/2-editor.png`, fullPage: true });
await page.locator('#export-btn').click();
await page.waitForSelector('#results:not([hidden])', { timeout: 300000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/3-results.png`, fullPage: true });
await page.goto(BASE + '/split');
await page.screenshot({ path: `${out}/4-pre-slice.png` });
await b.close();
console.log('saved to', out);
