# Optional password gate (NOT used)

Vox-Slice is public, so the gate is switched off. `basic-auth.ts` is a Netlify
Edge Function (HTTP basic auth, MIT-licensed code adapted from the Netlify
community; see the notice at the top of the file). To use it again on Netlify:

1. Copy it to `netlify/edge-functions/basic-auth.ts`.
2. Add to `netlify.toml`:
   ```toml
   [[edge_functions]]
     path = "/*"
     function = "basic-auth"
   ```
3. Set `BASIC_AUTH_CREDENTIALS` (`username:password`) in the Netlify dashboard and redeploy.

It FAILS CLOSED: with no variable set, the whole site is locked. It does not work on Cloudflare Pages.
