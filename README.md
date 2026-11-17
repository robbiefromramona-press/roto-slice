# Roto-Slice

**Cut the dead air out of talking-head video.** Free and open source, from [Fire-Press](https://fire-press.netlify.app).

**Live:** https://roto-slice.pages.dev

![Roto-Slice showing a video timeline with the silent parts marked to cut](docs/screenshot.jpg)

Drop in a video. Roto-Slice finds the silent parts and cuts them, so you get tight jump cuts without
the timeline work. Get one tight video, or every spoken bit as its own numbered clip. Pre-Slice mode
splits long videos into pieces, and you can also export a cut list (JSON / EDL) for your editor.

**It runs in your browser. Nothing is uploaded.** Your video never leaves your computer. There is no
account and no server. The ffmpeg engine runs as WebAssembly in your browser. Its one big file is
loaded from jsDelivr (version pinned and checked against a SHA-384 hash before use).

## Run it on your computer

You need [Node.js](https://nodejs.org) 22 or newer.

```
npm install
npm run dev
```

Then open http://localhost:5183. Other commands: `npm test` (unit tests), `npm run build`
(production build into `dist/`), `npm run serve:dist` (serves `dist/` with the real security headers
on port 5191). The app needs internet access the first time, to fetch the ffmpeg engine file from jsDelivr.

## Report a bug or suggest a feature

[Open an issue](https://github.com/robbiefromramona-press/roto-slice/issues/new/choose). Please do not
attach private video; describe what happened and your browser instead. See [CONTRIBUTING.md](CONTRIBUTING.md).

## How it is built

Vite + plain JavaScript + ffmpeg.wasm. `scripts/copy-core.mjs` copies the (patched) ffmpeg core scripts
into `public/ffmpeg/` at build time; the patches add fast reads and write-to-disk output for big files.
Hosting is Cloudflare Pages, which refuses files over 25 MiB, which is why the ~31 MB `.wasm` files come
from jsDelivr. `public/_headers` holds the security headers, including cross-origin isolation (COOP and
COEP `require-corp`) for the fast multi-threaded engine.

## License

[MIT](LICENSE) (c) Fire-Press / Robbie. ffmpeg.wasm and ffmpeg have their own licenses; see their projects.
