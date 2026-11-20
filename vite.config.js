import { defineConfig } from 'vite';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

// These two headers switch on "cross-origin isolation", which the browser
// requires before it will allow SharedArrayBuffer -- and the multithreaded
// ffmpeg core needs that. Netlify sends the same pair via public/_headers.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// Dev only: serve the (git-ignored) testmedia/ folder at /testmedia so big
// test videos can be loaded by URL without ending up in the build.
const testMedia = {
  name: 'roto-testmedia',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use('/testmedia', (req, res, next) => {
      const file = join(import.meta.dirname, 'testmedia', decodeURIComponent(req.url.split('?')[0]));
      if (!existsSync(file) || !statSync(file).isFile()) return next();
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Length', statSync(file).size);
      createReadStream(file).pipe(res);
    });
  },
};

// Dev only: /credits is a real page (credits.html). The host (Cloudflare Pages) maps the
// clean URL itself; this does the same for `vite` and `vite preview`.
const cleanUrls = {
  name: 'roto-clean-urls',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => { if (req.url === '/credits') req.url = '/credits.html'; next(); });
  },
  configurePreviewServer(server) {
    server.middlewares.use((req, _res, next) => { if (req.url === '/credits') req.url = '/credits.html'; next(); });
  },
};

export default defineConfig({
  plugins: [testMedia, cleanUrls],
  server: { port: 5183, strictPort: true, headers: isolation },
  preview: { port: 5183, strictPort: true, headers: isolation },
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'] },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    rollupOptions: { input: { main: 'index.html', credits: 'credits.html' } },
  },
});
