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

export default defineConfig({
  plugins: [testMedia],
  server: { port: 5183, strictPort: true, headers: isolation },
  preview: { port: 5183, strictPort: true, headers: isolation },
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'] },
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
