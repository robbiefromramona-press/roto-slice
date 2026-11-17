# Contributing to Roto-Slice

Thanks for helping! Roto-Slice is a small, free tool and contributions of any size are welcome.

## Report a bug or suggest a feature
Open an issue: https://github.com/robbiefromramona-press/roto-slice/issues/new/choose
Please do not attach private video. Describe what happened (and your browser) instead.

## Run it locally
```
npm install
npm run dev        # http://localhost:5183
npm test           # unit tests
npm run build && npm run serve:dist   # production build with the real headers (port 5191)
```

## Ground rules
- **Video never leaves the computer.** No uploads and no analytics. The only runtime network request is the ffmpeg engine file from jsDelivr (version pinned, SHA-384 checked in `src/engine.js`).
- Keep the security headers in `public/_headers` working.
- Keep changes small and explain them in the pull request. Add or update a test when you fix a bug.
- By contributing you agree your work is released under the MIT license.
