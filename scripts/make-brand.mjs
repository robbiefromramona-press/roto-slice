// One-off: copies the chosen brand files from the Fire-Press asset pack into public/brand/
// and optimizes the big ones. The committed output lives in public/; the pack itself stays
// outside this repo. Re-run only when the pack changes:
//   node scripts/make-brand.mjs "<path to FIRE-PRESS_ROTO-SLICE_ASSET-PACK_v1.0>"
import sharp from 'sharp';
import { copyFileSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pack = process.argv[2];
if (!pack) { console.error('usage: node scripts/make-brand.mjs <asset pack folder>'); process.exit(1); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'brand');
mkdirSync(out, { recursive: true });
const P = (...a) => join(pack, ...a);
const kb = (f) => (statSync(f).size / 1024).toFixed(0) + ' KB';
const log = (f) => console.log(f.replace(root, '').padEnd(46), kb(f));

// --- favicons / app icons -------------------------------------------------------------
copyFileSync(P('app-icons', 'favicon.svg'), join(root, 'public', 'favicon.svg'));
for (const n of [16, 32, 192, 512]) copyFileSync(P('app-icons', `app-icon-${n}.png`), join(out, `icon-${n}.png`));
copyFileSync(P('app-icons', 'apple-touch-icon.png'), join(out, 'apple-touch-icon.png'));
copyFileSync(P('app-icons', 'roto-slice-icon.svg'), join(out, 'roto-slice-icon.svg'));

// favicon.ico: PNG-in-ICO with 16, 32 and 48 px (the pack's own .ico is one 87 KB 256 px image)
const sizes = [16, 32, 48];
const pngs = await Promise.all(sizes.map((s) => sharp(P('app-icons', 'app-icon-256.png')).resize(s, s).png({ compressionLevel: 9 }).toBuffer()));
const head = Buffer.alloc(6 + 16 * sizes.length);
head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
let offset = head.length;
sizes.forEach((s, i) => {
  const e = 6 + 16 * i;
  head[e] = s; head[e + 1] = s; head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
  head.writeUInt32LE(pngs[i].length, e + 8); head.writeUInt32LE(offset, e + 12);
  offset += pngs[i].length;
});
writeFileSync(join(root, 'public', 'favicon.ico'), Buffer.concat([head, ...pngs]));

// --- logos ---------------------------------------------------------------------------
copyFileSync(P('logos', 'roto-slice-horizontal.svg'), join(out, 'logo-horizontal.svg'));
copyFileSync(P('logos', 'roto-slice-hero.svg'), join(out, 'logo-hero.svg'));
copyFileSync(P('monogram', 'rs-neon.svg'), join(out, 'monogram-neon.svg'));
// The SVG logos draw their lettering as <text> (system fonts), so the page uses these
// pixel versions, which look the same everywhere.
await sharp(P('logos', 'roto-slice-horizontal.png')).resize({ width: 1050 }).webp({ quality: 90, alphaQuality: 95 }).toFile(join(out, 'logo-horizontal.webp'));
await sharp(P('logos', 'roto-slice-hero-master.png')).resize({ width: 1400 }).webp({ quality: 88, alphaQuality: 95 }).toFile(join(out, 'logo-hero.webp'));

// --- social preview (og:image), 1200x630 -----------------------------------------------
// Crop the 1920x1080 hero to the 1.905:1 shape, keeping the logo and the waveform.
await sharp(P('website', 'hero-1920x1080.png'))
  .extract({ left: 200, top: 90, width: 1560, height: 819 })
  .resize(1200, 630)
  .jpeg({ quality: 84, mozjpeg: true })
  .toFile(join(out, 'og-image.jpg'));


// --- web manifest ---------------------------------------------------------------------
writeFileSync(join(root, 'public', 'site.webmanifest'), JSON.stringify({
  name: 'Roto-Slice',
  short_name: 'Roto-Slice',
  description: 'Cut the dead air out of talking-head video. Free, in your browser.',
  start_url: '/',
  display: 'standalone',
  background_color: '#0B0814',
  theme_color: '#0B0814',
  icons: [
    { src: '/brand/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/brand/icon-512.png', sizes: '512x512', type: 'image/png' },
  ],
}, null, 2) + '\n');

for (const f of ['public/favicon.svg', 'public/favicon.ico', 'public/site.webmanifest', 'public/brand/logo-horizontal.webp', 'public/brand/logo-hero.webp', 'public/brand/og-image.jpg', 'public/brand/apple-touch-icon.png', 'public/brand/icon-512.png']) log(join(root, f));

// subtle texture behind the drop zone (the pack's blank hero background, shrunk)
await sharp(P('website', 'hero-background-1920x1080.png')).resize({ width: 1280 }).webp({ quality: 62 }).toFile(join(out, 'bg-texture.webp'));
console.log('bg-texture.webp', kb(join(out, 'bg-texture.webp')));
