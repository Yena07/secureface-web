// 얼굴 인식 (face-api.js — @vladmandic 판, MIT).
// 얼굴 사진을 128차원 벡터로 바꾸고, 등록된 벡터와 거리를 비교한다.
// 탐지는 MediaPipe가 하고, 여기서는 그 얼굴 주변을 잘라 정렬(68점 랜드마크)한 뒤 벡터를 뽑는다.
import * as faceapi from 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/dist/face-api.esm.js';

const MODELS = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model';
export const MATCH_DISTANCE = 0.5;   // 이보다 가까우면 같은 사람 (face-api 기본 0.6보다 엄격하게)

const crop = document.createElement('canvas');
const cropCtx = crop.getContext('2d', { willReadFrequently: true });

export async function createRecognizer() {
  await faceapi.tf.ready();
  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri(MODELS),
    faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODELS),
    faceapi.nets.faceRecognitionNet.loadFromUri(MODELS),
  ]);
  const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 160, scoreThreshold: 0.3 });

  // 첫 추론 때 GPU 셰이더를 만드느라 몇 초 걸리므로, 빈 그림으로 미리 한 번씩 돌려 둔다.
  // (안 하면 첫 등록 촬영이나 첫 인식이 그만큼 늦어진다.)
  const blank = document.createElement('canvas');
  blank.width = blank.height = 160;
  await faceapi.detectSingleFace(blank, options);
  await faceapi.detectFaceLandmarksTiny(blank);
  await faceapi.computeFaceDescriptor(blank);

  return {
    backend: faceapi.tf.getBackend(),

    /** 원본 영상(source)에서 box 주변을 잘라 벡터를 구한다. 얼굴을 다시 찾지 못하면 null.
     *  잘라낸 원본은 메모리에서만 쓰고 화면에 그리거나 저장하지 않는다. */
    async describe(source, box) {
      const w = box.x2 - box.x1, h = box.y2 - box.y1;
      const sw = source.videoWidth, sh = source.videoHeight;
      const x1 = Math.max(0, box.x1 - w * 0.4), y1 = Math.max(0, box.y1 - h * 0.4);
      const x2 = Math.min(sw, box.x2 + w * 0.4), y2 = Math.min(sh, box.y2 + h * 0.4);
      const scale = Math.min(1, 256 / Math.max(x2 - x1, y2 - y1));
      crop.width = Math.max(1, Math.round((x2 - x1) * scale));
      crop.height = Math.max(1, Math.round((y2 - y1) * scale));
      cropCtx.drawImage(source, x1, y1, x2 - x1, y2 - y1, 0, 0, crop.width, crop.height);
      const result = await faceapi.detectSingleFace(crop, options).withFaceLandmarks(true).withFaceDescriptor();
      cropCtx.clearRect(0, 0, crop.width, crop.height);
      return result ? result.descriptor : null;
    },
  };
}

/** 등록자 중 가장 가까운 사람. {person, distance} 또는 null(등록자 없음). */
export function bestMatch(descriptor, gallery) {
  let best = null;
  for (const person of gallery) {
    for (const d of person.descriptors) {
      const distance = faceapi.euclideanDistance(descriptor, d);
      if (!best || distance < best.distance) best = { person, distance };
    }
  }
  return best;
}
