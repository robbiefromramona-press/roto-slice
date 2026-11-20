// Phone note: visible and dismissible on an iPhone profile, absent on desktop.
//   npm run build && npm run serve:dist; node tests/browser/phone-note.mjs
import { webkit, chromium, devices } from 'playwright';
const BASE = process.env.BASE || 'http://localhost:5191';
let bad = 0;
const t = (ok, m) => { console.log((ok ? 'ok   ' : 'FAIL ') + m); if (!ok) bad++; };
const phoneB = await webkit.launch();
const phone = await (await phoneB.newContext(devices['iPhone 14'])).newPage();
await phone.goto(BASE + '/');
const note = phone.locator('#view-roto .phone-note');
t(await note.isVisible(), 'visible on phone');
t(/Works best on desktop/.test(await note.innerText()), 'text is right');
await note.locator('.x').click();
t(!(await note.isVisible()), 'dismisses');
await phone.reload();
t(!(await note.isVisible()), 'stays dismissed this session');
await phoneB.close();
const dB = await chromium.launch({ channel: 'chrome' });
const desk = await (await dB.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await desk.goto(BASE + '/');
t(!(await desk.locator('.phone-note').first().isVisible()), 'hidden on desktop');
await dB.close();
process.exit(bad ? 1 : 0);
