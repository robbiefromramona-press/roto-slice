// The small "Saved you some time?" line shown after an export. It is a plain link in a
// dismissible strip: no Ko-fi scripts, nothing loaded from Ko-fi, and it never sits in
// front of the download buttons. Dismissing it hides it for the rest of the browser session.
const KEY = 'rs-kofi-dismissed';

function dismissed() {
  try { return sessionStorage.getItem(KEY) === '1'; } catch { return false; }
}

export function showKofiNudge(id) {
  const el = document.getElementById(id);
  if (el) el.hidden = dismissed();
}

export function hideKofiNudge(id) {
  const el = document.getElementById(id);
  if (el) el.hidden = true;
}

export function initKofiNudges() {
  for (const btn of document.querySelectorAll('.kofi-nudge .x')) {
    btn.addEventListener('click', () => {
      btn.closest('.kofi-nudge').hidden = true;
      try { sessionStorage.setItem(KEY, '1'); } catch { /* private mode: it just comes back next time */ }
    });
  }
}
