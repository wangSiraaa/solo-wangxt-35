import type { ScenarioMeta, ScenarioRecord } from './types';

const DB_NAME = 'walkreach';
const STORE = 'scenarios';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'));
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB 操作失败'));
        t.oncomplete = () => db.close();
      })
  );
}

export async function saveScenario(rec: ScenarioRecord): Promise<void> {
  await tx('readwrite', (s) => s.put(rec));
}

export async function loadScenario(id: string): Promise<ScenarioRecord | undefined> {
  return tx('readonly', (s) => s.get(id) as IDBRequest<ScenarioRecord | undefined>);
}

export async function deleteScenario(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id));
}

export async function listScenarios(): Promise<ScenarioMeta[]> {
  const all = await tx('readonly', (s) => s.getAll() as IDBRequest<ScenarioRecord[]>);
  return all
    .map(({ id, name, savedAt }) => ({ id, name, savedAt }))
    .sort((a, b) => b.savedAt - a.savedAt);
}
