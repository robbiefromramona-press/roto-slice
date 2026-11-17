// Cloudflare Pages refuses any single file over 25 MiB. This fails the build if a
// file in dist/ is too big (the big ffmpeg .wasm files are NOT shipped: they load
// from jsDelivr, see src/engine.js).
import { readdirSync, statSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
const LIMIT = 25 * 1024 * 1024;
const dist = new URL('../dist', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
// Pre-Slice lives at /split but is the same single-page app. Cloudflare serves split.html at /split
// (no redirect), so the address bar keeps /split and the app opens on the right view.
copyFileSync(join(dist, 'index.html'), join(dist, 'split.html'));
let bad = 0;
for (const f of walk(dist)) if (statSync(f).size > LIMIT) { console.error('check-dist: OVER 25 MiB:', f); bad++; }
if (bad) process.exit(1);
console.log('check-dist: every file is under 25 MiB');
