// 브라우저 안 저장소(IndexedDB). 서버로 보내지 않는다.
// people: 등록자 {id, name, group('허가'|'비허가'), descriptors: Float32Array[], createdAt}
//         얼굴 사진은 저장하지 않고 인식용 벡터만 저장한다.
// events: 비허가자 감지 이력 {id, time, name, reason}
const NAME = 'secureface-web';
const VERSION = 1;
let opening = null;

function open() {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('people')) db.createObjectStore('people', { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains('events')) db.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return opening;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const people = {
  all: () => run('people', 'readonly', (s) => s.getAll()),
  add: (person) => run('people', 'readwrite', (s) => s.add(person)),
  remove: (id) => run('people', 'readwrite', (s) => s.delete(id)),
};

export const events = {
  add: (event) => run('events', 'readwrite', (s) => s.add(event)),
  async recent(limit = 50) {
    const rows = await run('events', 'readonly', (s) => s.getAll());
    return rows.slice(-limit).reverse();
  },
  clear: () => run('events', 'readwrite', (s) => s.clear()),
};
