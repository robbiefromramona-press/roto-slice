// A small dismissible "works best on desktop" note, shown only on phones (touch screen,
// narrow viewport). Dismissing hides it for the rest of the browser session.
const KEY = 'rs-phone-note-dismissed';
const isPhone = () => matchMedia('(hover: none) and (pointer: coarse) and (max-width: 820px)').matches;

export function initPhoneNote() {
  const notes = document.querySelectorAll('.phone-note');
  let gone = false;
  try { gone = sessionStorage.getItem(KEY) === '1'; } catch { /* storage blocked: show it */ }
  if (!isPhone() || gone) return;
  for (const n of notes) {
    n.hidden = false;
    n.querySelector('.x').addEventListener('click', () => {
      notes.forEach((m) => { m.hidden = true; });
      try { sessionStorage.setItem(KEY, '1'); } catch { /* it just comes back next time */ }
    });
  }
}
