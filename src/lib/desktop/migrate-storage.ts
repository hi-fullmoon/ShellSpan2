import { desktop } from './core';

const MARKER = 'shellspan.electron.webviewMigration.v1';
const KEYS = ['shellspan.theme', 'shellspan.aiPanelWidth', 'shellspan.update.lastStartupCheckAt'];
/** Imports the last Tauri bridge snapshot before any UI or draft store mounts. */
export async function migrateLegacyStorage(): Promise<void> {
  if (!window.shellspan) return;
  const raw = await readLegacySnapshot();
  if (!raw) return;
  const fingerprint = await digest(raw);
  if (window.localStorage.getItem(MARKER) === fingerprint) return;
  const snapshot = JSON.parse(raw) as {
    version: number;
    localStorage: Record<string, unknown>;
    drafts: Record<string, unknown>[];
  };
  if (
    snapshot.version !== 1 ||
    !snapshot.localStorage ||
    typeof snapshot.localStorage !== 'object' ||
    Array.isArray(snapshot.localStorage) ||
    !Array.isArray(snapshot.drafts)
  )
    throw new Error('Unsupported WebView migration snapshot');
  const owners = new Set<string>();
  for (const draft of snapshot.drafts) {
    if (
      !draft ||
      typeof draft.owner !== 'string' ||
      !Number.isSafeInteger(draft.revision) ||
      (draft.revision as number) < 0 ||
      typeof draft.text !== 'string' ||
      !Array.isArray(draft.images)
    )
      throw new Error('Invalid WebView draft snapshot');
    if (owners.has(draft.owner)) throw new Error('Duplicate WebView draft owner');
    owners.add(draft.owner);
    for (const image of draft.images) {
      if (
        !image ||
        typeof image.mediaType !== 'string' ||
        typeof image.data !== 'string' ||
        typeof image.name !== 'string'
      )
        throw new Error('Invalid WebView image');
    }
    if (
      draft.operation !== undefined &&
      (!draft.operation ||
        typeof draft.operation !== 'object' ||
        typeof (draft.operation as Record<string, unknown>).id !== 'string' ||
        typeof (draft.operation as Record<string, unknown>).sessionId !== 'string' ||
        !['start', 'nextTurn', 'nextStep'].includes(
          String((draft.operation as Record<string, unknown>).mode),
        ))
    )
      throw new Error('Invalid WebView operation');
  }
  if (snapshot.drafts.length) {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        reject(new Error('WebView migration database open timed out'));
      }, 10000);
      const request = indexedDB.open('shellspan-image-drafts-v1', 2);
      request.onupgradeneeded = () => {
        if (expired) {
          request.transaction!.abort();
          return;
        }
        const store = request.result.objectStoreNames.contains('drafts')
          ? request.transaction!.objectStore('drafts')
          : request.result.createObjectStore('drafts', { keyPath: 'owner' });
        if (!store.indexNames.contains('session'))
          store.createIndex('session', 'operation.sessionId');
      };
      request.onsuccess = () => {
        clearTimeout(timer);
        if (expired) request.result.close();
        else resolve(request.result);
      };
      request.onerror = () => {
        clearTimeout(timer);
        reject(request.error);
      };
      request.onblocked = () => {
        clearTimeout(timer);
        expired = true;
        reject(new Error('WebView migration database blocked'));
      };
    });
    try {
      const historyKey = `${MARKER}.owners`;
      const historyRaw = window.localStorage.getItem(historyKey);
      const storedHistory = historyRaw ? (JSON.parse(historyRaw) as Record<string, string>) : {};
      if (!storedHistory || typeof storedHistory !== 'object' || Array.isArray(storedHistory))
        throw new Error('Invalid WebView migration history');
      const history = Object.assign(Object.create(null) as Record<string, string>, storedHistory);
      const candidates: {
        draft: Record<string, unknown>;
        before: string | undefined;
        hash: string;
        write: boolean;
      }[] = [];
      for (const draft of snapshot.drafts) {
        const owner = draft.owner as string;
        const current = await new Promise<unknown>((resolve, reject) => {
          const request = db.transaction('drafts').objectStore('drafts').get(owner);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const before = current === undefined ? undefined : JSON.stringify(current);
        const hash = await digest(JSON.stringify(draft));
        const currentHash = before === undefined ? undefined : await digest(before);
        const write = before === undefined || currentHash === history[owner];
        candidates.push({ draft, before, hash, write });
        if (write || currentHash === hash) history[owner] = hash;
      }
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('drafts', 'readwrite');
        const store = tx.objectStore('drafts');
        for (const { draft, before, write } of candidates) {
          const request = store.get(draft.owner as string);
          request.onsuccess = () => {
            if (JSON.stringify(request.result) !== before) {
              tx.abort();
              return;
            }
            if (write) store.put(draft);
          };
        }
        tx.oncomplete = () => resolve();
        tx.onabort = () =>
          reject(tx.error || new Error('WebView migration interrupted or draft changed'));
        tx.onerror = () => reject(tx.error || new Error('WebView migration transaction failed'));
      });
      window.localStorage.setItem(historyKey, JSON.stringify(history));
    } finally {
      db.close();
    }
  }
  for (const key of KEYS) {
    const value = snapshot.localStorage[key];
    if (typeof value === 'string' && window.localStorage.getItem(key) === null)
      window.localStorage.setItem(key, value);
  }
  window.localStorage.setItem(MARKER, fingerprint);
}

async function readValue(key: string): Promise<string | null> {
  const parts: string[] = [];
  let offset = 0;
  for (;;) {
    const part = await desktop().migrationRead(key, offset);
    if (part === null) {
      if (offset) throw new Error('Interrupted WebView snapshot');
      return null;
    }
    if (!part.done && part.next <= offset) throw new Error('Invalid WebView chunk');
    parts.push(part.text);
    if (part.done) return parts.join('');
    offset = part.next;
  }
}
export async function readLegacySnapshot(): Promise<string | null> {
  const manifestRaw = await readValue('electron.webviewMigration.v2');
  if (manifestRaw === null) return readValue('electron.webviewMigration.v1');
  const manifest = JSON.parse(manifestRaw) as {
    version: number;
    slot: number;
    chunks: number;
    bytes: number;
    sha256: string;
  };
  if (
    manifest.version !== 2 ||
    ![0, 1].includes(manifest.slot) ||
    !Number.isSafeInteger(manifest.chunks) ||
    manifest.chunks < 1 ||
    manifest.chunks > 8192 ||
    !Number.isSafeInteger(manifest.bytes) ||
    manifest.bytes < 1 ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256)
  )
    throw new Error('Invalid WebView migration manifest');
  const chunks: string[] = [];
  for (let i = 0; i < manifest.chunks; i++) {
    const chunk = await readValue(`electron.webviewMigration.chunk.${manifest.slot}.${i}`);
    if (chunk === null) throw new Error('Incomplete WebView migration snapshot');
    chunks.push(chunk);
  }
  if ((await readValue('electron.webviewMigration.v2')) !== manifestRaw)
    throw new Error('WebView snapshot changed during import');
  const raw = chunks.join('');
  const bytes = new TextEncoder().encode(raw);
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (x) =>
    x.toString(16).padStart(2, '0'),
  ).join('');
  if (bytes.length !== manifest.bytes || sha256 !== manifest.sha256)
    throw new Error('WebView snapshot integrity check failed');
  return raw;
}

async function digest(raw: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))),
    (x) => x.toString(16).padStart(2, '0'),
  ).join('');
}
