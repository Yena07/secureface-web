// 얼굴 인식: ArcFace MobileFaceNet (insightface buffalo_s의 w600k_mbf.onnx).
// insightface와 같은 방식으로, SCRFD 키포인트 5개를 ArcFace 표준 위치(112×112)에 맞추는
// 닮음 변환으로 얼굴을 정렬한 뒤 (값 - 127.5) / 127.5, RGB로 넣어 512차원 벡터를 얻는다.
// 같은 사람 판정은 코사인 유사도(라즈베리파이 버전과 같은 기준 0.45 이상).
import { createSession, run, toTensor } from './ort.js';

const MODEL = 'models/w600k_mbf.onnx';
export const MATCH_SIMILARITY = 0.45;

// insightface arcface_dst: 112×112 안에서 두 눈·코·입꼬리의 표준 위치
const TEMPLATE = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];

const crop = document.createElement('canvas');
crop.width = crop.height = 112;
const cropCtx = crop.getContext('2d', { willReadFrequently: true });

/** 키포인트 → 표준 위치로 보내는 닮음 변환(회전·크기·이동)의 최소제곱 해. [a, b, tx, ty]: x' = a·x − b·y + tx, y' = b·x + a·y + ty */
function similarity(src) {
  const n = src.length;
  let sx = 0, sy = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { sx += src[i].x; sy += src[i].y; dx += TEMPLATE[i][0]; dy += TEMPLATE[i][1]; }
  sx /= n; sy /= n; dx /= n; dy /= n;
  let num1 = 0, num2 = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const px = src[i].x - sx, py = src[i].y - sy, qx = TEMPLATE[i][0] - dx, qy = TEMPLATE[i][1] - dy;
    num1 += px * qx + py * qy;
    num2 += px * qy - py * qx;
    den += px * px + py * py;
  }
  const a = num1 / den, b = num2 / den;
  return [a, b, dx - (a * sx - b * sy), dy - (b * sx + a * sy)];
}

export async function createRecognizer() {
  const session = await createSession(MODEL);
  const inputName = session.inputNames[0], outputName = session.outputNames[0];

  async function embed() {
    const pixels = cropCtx.getImageData(0, 0, 112, 112).data;
    const out = await run(session, { [inputName]: toTensor(pixels, 112, 112, 127.5, 127.5) });
    const v = Float32Array.from(out[outputName].data);
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm);
    if (!norm || !Number.isFinite(norm)) return null;
    for (let i = 0; i < v.length; i++) v[i] /= norm;
    return v;
  }

  await embed();   // 첫 실행 지연을 없애기 위한 예열

  return {
    backend: 'CPU (WASM)',

    /** 원본(source)에서 box.keypoints로 얼굴을 정렬해 512차원 단위 벡터를 구한다. 키포인트가 없으면 null.
     *  정렬한 112×112 얼굴은 메모리에서만 쓰고 화면에 그리거나 저장하지 않는다. */
    async describe(source, box) {
      if (!box.keypoints || box.keypoints.length < 5) return null;
      const [a, b, tx, ty] = similarity(box.keypoints);
      cropCtx.setTransform(1, 0, 0, 1, 0, 0);
      cropCtx.fillStyle = '#000';
      cropCtx.fillRect(0, 0, 112, 112);
      cropCtx.setTransform(a, b, -b, a, tx, ty);   // 정렬은 그리는 순간 끝난다 (이후 원본이 바뀌어도 무관)
      cropCtx.drawImage(source, 0, 0);
      cropCtx.setTransform(1, 0, 0, 1, 0, 0);
      return embed();
    },
  };
}

/** 등록자 중 가장 닮은 사람 {person, similarity} 또는 null(비교할 등록자 없음). */
export function bestMatch(descriptor, gallery) {
  let best = null;
  for (const person of gallery) {
    for (const d of person.descriptors) {
      if (d.length !== descriptor.length) continue;
      let s = 0;
      for (let i = 0; i < d.length; i++) s += d[i] * descriptor[i];
      if (!best || s > best.similarity) best = { person, similarity: s };
    }
  }
  return best;
}
