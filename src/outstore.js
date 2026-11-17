// Where finished files live until the user saves them: folders in the
// browser's private storage for this site (OPFS). On disk, not in memory,
// invisible to other sites, and it never leaves the computer.
//
// Two separate areas, so one tool can never delete the other's files:
//   'out'   -- Roto-Slice exports (wiped before every new export)
//   'parts' -- Pre-Slice parts (kept so "Send to Roto-Slice" keeps working)
// Both are wiped when the page loads.

const AREAS = { out: 'roto-out', parts: 'roto-parts' };
const freshRun = () => `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

// Each run writes into its own sub-folder. If a run is cancelled mid-write the
// browser can keep that file locked for a while; a fresh folder means the next
// run can never trip over it.
const runs = { out: freshRun(), parts: freshRun() };

export const diskStoreAvailable = () => !!(navigator.storage && navigator.storage.getDirectory);

/** Switch an area to a new, empty scratch folder without deleting anything. */
export function newScratchFolder(area = 'out') { runs[area] = freshRun(); }

async function dir(area) {
  const root = await navigator.storage.getDirectory();
  const top = await root.getDirectoryHandle(AREAS[area], { create: true });
  return top.getDirectoryHandle(runs[area], { create: true });
}

/** Create (or empty) an output file and return its handle. */
export async function createOutput(name, area = 'out') {
  if (!diskStoreAvailable()) throw new Error('this browser has no private file storage');
  return (await dir(area)).getFileHandle(name, { create: true });
}

export async function removeOutput(name, area = 'out') {
  try { await (await dir(area)).removeEntry(name); } catch { /* already gone */ }
}

export async function clearOutputs(area = 'out') {
  if (!diskStoreAvailable()) return;
  runs[area] = freshRun();
  const keep = runs[area];
  try {
    const root = await navigator.storage.getDirectory();
    const top = await root.getDirectoryHandle(AREAS[area], { create: true });
    // remove old runs one by one so a single locked file cannot block the rest
    for await (const name of top.keys()) {
      if (name === keep || name === runs[area]) continue; // a newer run may already be writing
      try { await top.removeEntry(name, { recursive: true }); } catch { /* still locked; next time */ }
    }
  } catch { /* nothing there */ }
}

/** Free space the browser will let this site use, in bytes (null if unknown). */
export async function freeSpace() {
  try {
    const e = await navigator.storage.estimate();
    return e.quota != null && e.usage != null ? e.quota - e.usage : null;
  } catch {
    return null;
  }
}

/** Hand a finished file to the browser's normal download flow. */
export function download(file, name) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name || file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}
