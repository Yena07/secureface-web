// 녹화: 블러된 프레임 + 얼굴마다 집단 키로 암호화한 원본 얼굴 (브라우저 안 IndexedDB).
//
// - RECORD_FPS로 프레임을 골라 RECORD_WIDTH 크기로 저장한다. 블러된 전체 프레임은 그대로(JPEG),
//   원본 얼굴은 블러한 영역 그대로 잘라 그 얼굴 집단의 데이터 키로 암호화해 저장한다.
// - CHUNK_SECONDS마다 새 묶음을 만들고 묶음마다 데이터 키를 새로 만든다.
//   묶음 정보(감싼 키)는 시작할 때 먼저 저장하므로, 창을 닫아 중간에 끊겨도 그때까지는 복원할 수 있다.
// - 묶음이 MAX_CHUNKS개를 넘으면 가장 오래된 것부터 지운다 (브라우저 저장 공간 보호).
import { chunks, frames } from './db.js';
import { newChunkKeys, seal } from './keys.js';
import { blurRegion, scaleBox } from './anonymize.js';

export const RECORD_FPS = 10;
export const CHUNK_SECONDS = 30;
const RECORD_WIDTH = 854;
const MAX_CHUNKS = 20;
const MAX_PENDING = 30;   // 저장이 밀리면 프레임을 건너뛴다 (메모리 보호)

const canvasBlob = (canvas, quality) => new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));

export function createRecorder() {
  const view = document.createElement('canvas');
  const viewCtx = view.getContext('2d');
  const crop = document.createElement('canvas');
  const cropCtx = crop.getContext('2d');
  let pub = null, chunk = null, lastCapture = 0, pending = 0, queue = Promise.resolve();
  const stats = { dropped: 0 };

  async function begin(now) {
    const { deks, wrapped } = await newChunkKeys(pub);
    const record = {
      startedAt: new Date().toISOString(), endedAt: null, status: 'recording', fps: RECORD_FPS,
      width: view.width, height: view.height, frameCount: 0,
      faces: { external: 0, internal: 0, master: 0 }, wrapped,
    };
    record.id = await chunks.add(record);
    return { record, deks, startedAt: now, index: 0 };
  }

  async function finish(c) {
    c.record.status = 'complete';
    c.record.endedAt = new Date().toISOString();
    await chunks.put(c.record);
    const all = (await chunks.all()).sort((a, b) => a.id - b.id);
    for (const old of all.slice(0, Math.max(0, all.length - MAX_CHUNKS))) await chunks.remove(old.id);
  }

  return {
    stats,
    get active() { return !!pub; },
    get chunkElapsed() { return chunk ? (performance.now() - chunk.startedAt) / 1000 : 0; },

    start(publicKeys) { pub = publicKeys; },

    /** 화면 처리 루프에서 매 프레임 부른다. faces: [{box(원본 좌표, 넓힌 상자), group}] */
    capture(video, faces, now) {
      if (!pub || now - lastCapture < 1000 / RECORD_FPS) return;
      if (pending >= MAX_PENDING) { stats.dropped++; return; }
      lastCapture = now;
      const scale = Math.min(1, RECORD_WIDTH / video.videoWidth);
      const w = Math.round(video.videoWidth * scale), h = Math.round(video.videoHeight * scale);

      // 블러된 프레임과 원본 얼굴 조각을 지금 프레임에서 바로 만든다 (toBlob은 호출 순간의 그림을 복사한다).
      if (view.width !== w || view.height !== h) { view.width = w; view.height = h; }
      viewCtx.drawImage(video, 0, 0, w, h);
      const boxes = faces.map((f) => {
        const b = scaleBox(f.box, scale);
        return { x1: Math.floor(b.x1), y1: Math.floor(b.y1), x2: Math.ceil(b.x2), y2: Math.ceil(b.y2) };
      });
      boxes.forEach((b) => blurRegion(viewCtx, video, b, scale));
      const imageBlob = canvasBlob(view, 0.75);
      const cropBlobs = boxes.map((b) => {
        crop.width = Math.max(1, b.x2 - b.x1); crop.height = Math.max(1, b.y2 - b.y1);
        cropCtx.drawImage(video, b.x1 / scale, b.y1 / scale, crop.width / scale, crop.height / scale, 0, 0, crop.width, crop.height);
        return canvasBlob(crop, 0.9);
      });
      const t = now;
      pending++;
      queue = queue.then(async () => {
        if (!chunk || (t - chunk.startedAt) / 1000 >= CHUNK_SECONDS) {
          if (chunk) await finish(chunk);
          chunk = await begin(t);
        }
        const c = chunk, index = c.index++;
        const sealedFaces = [];
        for (let i = 0; i < boxes.length; i++) {
          const group = faces[i].group;
          const bytes = await (await cropBlobs[i]).arrayBuffer();
          const sealed = await seal(c.deks[group], bytes, `${c.record.id}/${index}/${i}`);
          sealedFaces.push({ box: boxes[i], group, ...sealed });
          c.record.faces[group]++;
        }
        await frames.put({ chunkId: c.record.id, index, t: (t - c.startedAt) / 1000, image: await imageBlob, faces: sealedFaces });
        c.record.frameCount = index + 1;
        if (index % (RECORD_FPS * 5) === 0) await chunks.put(c.record);   // 5초마다 진행 상황 저장
      }).catch((err) => console.error('[녹화] 저장 실패', err)).finally(() => { pending--; });
    },

    /** 페이지를 떠날 때 지금 묶음을 마무리 (끝까지 저장된다는 보장은 없다). */
    async stop() {
      pub = null;
      await queue;
      if (chunk) { await finish(chunk); chunk = null; }
    },
  };
}
