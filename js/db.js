// 브라우저 안 저장소(IndexedDB). 서버로 보내지 않는다.
// people: 등록자 {id, name, group('허가'|'비허가'), descriptors: Float32Array[], createdAt}
//         얼굴 사진은 저장하지 않고 인식용 수치만 저장한다.
// events: 비허가자 감지 이력 {id, time, name, reason}
// keys:   복원 키 {id:'groups', public: {master, internal, external}, private: {그룹: 비밀번호로 잠근 개인키}}
// chunks: 녹화 묶음 정보 {id, startedAt, endedAt, status, fps, width, height, frameCount, faces, wrapped}
// frames: 녹화 프레임 {chunkId, index, t, image(블러된 프레임 JPEG), faces: [{box, group, iv, data(암호화된 원본 얼굴)}]}
const NAME = 'secureface-web';
const VERSION = 2;
let opening = null;

function open() {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const make = (name, options) => { if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, options); };
      make('people', { keyPath: 'id', autoIncrement: true });
      make('events', { keyPath: 'id', autoIncrement: true });
      make('keys', { keyPath: 'id' });
      make('chunks', { keyPath: 'id', autoIncrement: true });
      make('frames', { keyPath: ['chunkId', 'index'] });
    };
    req.onsuccess = () => {
      const db = req.result;
      // 새 버전 페이지가 저장소 구조를 바꾸려 하면 이 탭의 연결을 놓아 준다 (안 놓으면 그쪽이 멈춘다).
      db.onversionchange = () => { db.close(); opening = null; };
      resolve(db);
    };
    req.onerror = () => { opening = null; reject(req.error); };
    req.onblocked = () => {
      opening = null;
      reject(new Error('이 사이트가 다른 탭에서 열려 있어 저장소를 갱신하지 못했습니다. 다른 탭을 닫고 새로고침해 주세요.'));
    };
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

const framesOf = (chunkId) => IDBKeyRange.bound([chunkId, 0], [chunkId, Infinity]);

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

export const keys = {
  get: (id) => run('keys', 'readonly', (s) => s.get(id)),
  put: (record) => run('keys', 'readwrite', (s) => s.put(record)),
};

export const chunks = {
  all: () => run('chunks', 'readonly', (s) => s.getAll()),
  get: (id) => run('chunks', 'readonly', (s) => s.get(id)),
  add: (chunk) => run('chunks', 'readwrite', (s) => s.add(chunk)),
  put: (chunk) => run('chunks', 'readwrite', (s) => s.put(chunk)),
  async remove(id) {
    await run('frames', 'readwrite', (s) => s.delete(framesOf(id)));
    await run('chunks', 'readwrite', (s) => s.delete(id));
  },
};

export const frames = {
  put: (frame) => run('frames', 'readwrite', (s) => s.put(frame)),
  of: (chunkId) => run('frames', 'readonly', (s) => s.getAll(framesOf(chunkId))),
};
