// Copies licence texts into public/licenses/ so they ship with the site (linked from /credits).
// public/licenses/GPL-2.0.txt is committed by hand (FFmpeg's COPYING.GPLv2, same text).
// Runs before dev and build; the files it writes are small, so they are committed too.
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'licenses');
mkdirSync(out, { recursive: true });
const jobs = [
  ['LICENSE', 'roto-slice-MIT.txt'],
  ['node_modules/@fontsource/bebas-neue/LICENSE', 'font-bebas-neue-OFL.txt'],
  ['node_modules/@fontsource/orbitron/LICENSE', 'font-orbitron-OFL.txt'],
  ['node_modules/@fontsource-variable/inter/LICENSE', 'font-inter-OFL.txt'],
  ['node_modules/fflate/LICENSE', 'fflate-MIT.txt'],
];
for (const [from, to] of jobs) {
  const src = join(root, from);
  if (!existsSync(src)) { console.warn('copy-licenses: missing', from); continue; }
  copyFileSync(src, join(out, to));
}
console.log('licence texts ready in public/licenses/');
