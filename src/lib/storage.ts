import type { ProctorEvent, ProctoringSessionState } from '../types';

const DB_NAME = 'look-at-me-db';
const EVENT_STORE = 'session-events';
const STATE_STORE = 'session-state';
const STATE_KEY = 'current-session';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable in this browser context.'));
      return;
    }

    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(EVENT_STORE)) {
        db.createObjectStore(EVENT_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STATE_STORE)) {
        db.createObjectStore(STATE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB.'));
    request.onblocked = () => reject(new Error('IndexedDB upgrade is blocked by another open tab.'));
  });
}

const waitForTransaction = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction was aborted.'));
  });

export async function saveSessionEvents(events: ProctorEvent[]): Promise<void> {
  const db = await openDatabase();
  try {
    const transaction = db.transaction(EVENT_STORE, 'readwrite');
    const store = transaction.objectStore(EVENT_STORE);
    store.clear();
    events.forEach((event) => store.put(event));
    await waitForTransaction(transaction);
  } finally {
    db.close();
  }
}

export async function loadSessionEvents(): Promise<ProctorEvent[]> {
  const db = await openDatabase();
  try {
    const transaction = db.transaction(EVENT_STORE, 'readonly');
    const completed = waitForTransaction(transaction);
    const request = transaction.objectStore(EVENT_STORE).getAll();
    const result = await new Promise<ProctorEvent[]>((resolve, reject) => {
      request.onsuccess = () => resolve((request.result ?? []) as ProctorEvent[]);
      request.onerror = () => reject(request.error ?? new Error('Failed to load stored events.'));
    });
    await completed;
    return result;
  } finally {
    db.close();
  }
}

export async function saveProctoringSession(session: ProctoringSessionState): Promise<void> {
  const db = await openDatabase();
  try {
    const transaction = db.transaction(STATE_STORE, 'readwrite');
    transaction.objectStore(STATE_STORE).put(session, STATE_KEY);
    await waitForTransaction(transaction);
  } finally {
    db.close();
  }
}

export async function loadProctoringSession(): Promise<ProctoringSessionState | null> {
  const db = await openDatabase();
  try {
    const transaction = db.transaction(STATE_STORE, 'readonly');
    const completed = waitForTransaction(transaction);
    const request = transaction.objectStore(STATE_STORE).get(STATE_KEY);
    const result = await new Promise<ProctoringSessionState | null>((resolve, reject) => {
      request.onsuccess = () => resolve((request.result as ProctoringSessionState | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new Error('Failed to restore proctoring session.'));
    });
    await completed;
    return result;
  } finally {
    db.close();
  }
}
