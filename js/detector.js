// 얼굴 탐지: SCRFD-500M (insightface buffalo_s의 det_500m.onnx).
// 전처리·후처리는 insightface의 SCRFD 구현을 그대로 옮겼다:
//   입력은 비율을 유지해 size×size 정사각형의 왼쪽 위에 맞추고, (값 - 127.5) / 128, RGB.
//   보폭 8·16·32마다 점수·상자 거리·키포인트 5개를 받아 앵커 중심에서 되돌린 뒤 NMS.
// 모든 처리는 브라우저 안에서 하며, 영상은 어디로도 전송되지 않는다.
import { createSession, run, toTensor } from './ort.js';

const MODEL = 'models/det_500m.onnx';
const STRIDES = [8, 16, 32];
const ANCHORS = 2;
const anchorCache = new Map();

function anchors(stride, size) {
  const key = `${stride}/${size}`;
  if (!anchorCache.has(key)) {
    const n = size / stride;
    const centers = new Float32Array(n * n * ANCHORS * 2);
    let k = 0;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) for (let a = 0; a < ANCHORS; a++) {
      centers[k++] = x * stride; centers[k++] = y * stride;
    }
    anchorCache.set(key, centers);
  }
  return anchorCache.get(key);
}

function iou(a, b) {
  const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const inter = ix * iy;
  return inter / ((a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter);
}

/** 출력 9개를 보폭별 {score, bbox, kps}로 나눈다 (마지막 차원 1·4·10, 앵커 수로 보폭 판별). */
function groupOutputs(outputs, size) {
  const byStride = {};
  for (const t of Object.values(outputs)) {
    const last = t.dims[t.dims.length - 1];
    const count = t.data.length / last;
    const stride = STRIDES.find((s) => (size / s) ** 2 * ANCHORS === count);
    const kind = { 1: 'score', 4: 'bbox', 10: 'kps' }[last];
    if (stride && kind) (byStride[stride] ??= {})[kind] = t.data;
  }
  return byStride;
}

/** size: 탐지 입력 한 변(32의 배수). 클수록 작은(먼) 얼굴까지 찾지만 느려진다. */
export const DET_SIZE = 480;   // 웹캠 얼굴에는 충분하고 640보다 약 1.3배 빠름 (8코어 PC: 46 ms vs 59 ms)

export async function createDetector({ threshold = 0.5, nms = 0.4, size = DET_SIZE } = {}) {
  const session = await createSession(MODEL);
  const inputName = session.inputNames[0];
  const input = document.createElement('canvas');
  input.width = input.height = size;
  const inputCtx = input.getContext('2d', { willReadFrequently: true });

  async function detect(source) {
    const sw = source.videoWidth || source.width, sh = source.videoHeight || source.height;
    const scale = Math.min(size / sw, size / sh);
    const w = Math.round(sw * scale), h = Math.round(sh * scale);
    inputCtx.fillStyle = '#000';
    inputCtx.fillRect(0, 0, size, size);
    inputCtx.drawImage(source, 0, 0, w, h);
    const pixels = inputCtx.getImageData(0, 0, size, size).data;
    const outputs = await run(session, { [inputName]: toTensor(pixels, size, size, 127.5, 128) });

    const found = [];
    for (const [stride, o] of Object.entries(groupOutputs(outputs, size))) {
      const s = Number(stride), centers = anchors(s, size);
      for (let i = 0; i < o.score.length; i++) {
        if (o.score[i] < threshold) continue;
        const cx = centers[i * 2], cy = centers[i * 2 + 1];
        const d = (j) => o.bbox[i * 4 + j] * s;
        const keypoints = [];
        for (let k = 0; k < 5; k++) {
          keypoints.push({ x: (cx + o.kps[i * 10 + k * 2] * s) / scale, y: (cy + o.kps[i * 10 + k * 2 + 1] * s) / scale });
        }
        found.push({
          x1: (cx - d(0)) / scale, y1: (cy - d(1)) / scale,
          x2: (cx + d(2)) / scale, y2: (cy + d(3)) / scale,
          score: o.score[i], keypoints,
        });
      }
    }
    found.sort((a, b) => b.score - a.score);
    const kept = [];
    for (const f of found) if (kept.every((k) => iou(f, k) <= nms)) kept.push(f);
    return kept.map((f) => ({
      ...f,
      x1: Math.max(0, f.x1), y1: Math.max(0, f.y1), x2: Math.min(sw, f.x2), y2: Math.min(sh, f.y2),
    }));
  }

  // 첫 실행 지연을 없애기 위해 빈 화면으로 한 번 돌려 둔다.
  const blank = document.createElement('canvas');
  blank.width = 64; blank.height = 48;
  await detect(blank);

  /** source: <video> 또는 <canvas> → [{x1,y1,x2,y2,score,keypoints}] (원본 픽셀 좌표)
   *  keypoints: 눈 2개, 코끝, 입꼬리 2개 (insightface 순서) */
  return { backend: 'CPU (WASM)', detect };
}
