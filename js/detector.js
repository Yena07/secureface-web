// 얼굴 탐지 (MediaPipe Face Detector, BlazeFace short-range).
// 노트북 웹캠처럼 카메라 가까이(약 2m 이내) 있는 얼굴에 맞춘 모델이다.
// 모든 처리는 브라우저 안에서 하며, 영상은 어디로도 전송되지 않는다.
import { FilesetResolver, FaceDetector } from
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';

// 기본은 CPU(WASM). BlazeFace는 작은 모델이라 CPU로도 1280×720 한 장에 약 20ms면 충분하고,
// 그래픽 카드가 없는 PC에서는 GPU(WebGL) 방식이 오히려 10배가량 느렸다(약 200ms).
// 주소 뒤에 ?gpu 를 붙이면 GPU 방식을 시험할 수 있다.
export async function createDetector({ minConfidence = 0.5,
  useGpu = new URLSearchParams(location.search).has('gpu') } = {}) {
  const fileset = await FilesetResolver.forVisionTasks(WASM);
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: 'VIDEO',
    minDetectionConfidence: minConfidence,
  });
  let detector;
  let backend = useGpu ? 'GPU' : 'CPU';
  try {
    detector = await FaceDetector.createFromOptions(fileset, options(backend));
  } catch (err) {
    if (backend === 'CPU') throw err;
    backend = 'CPU';   // WebGL을 쓸 수 없는 환경
    detector = await FaceDetector.createFromOptions(fileset, options('CPU'));
  }
  let lastTs = -1;
  return {
    backend,
    /** source: <video>, nowMs: 단조 증가 시각 → [{x1,y1,x2,y2,score,keypoints}] (원본 픽셀 좌표)
     *  keypoints: [오른눈, 왼눈, 코끝, 입, 오른귀, 왼귀] (사람 기준 좌우) */
    detect(source, nowMs) {
      const ts = Math.max(nowMs, lastTs + 1);   // MediaPipe는 시각이 계속 증가해야 한다
      lastTs = ts;
      const result = detector.detectForVideo(source, ts);
      const w = source.videoWidth, h = source.videoHeight;
      return result.detections.map((d) => {
        const b = d.boundingBox;
        return {
          x1: b.originX, y1: b.originY,
          x2: b.originX + b.width, y2: b.originY + b.height,
          score: d.categories?.[0]?.score ?? 0,
          keypoints: (d.keypoints || []).map((k) => ({ x: k.x * w, y: k.y * h })),
        };
      });
    },
    close() { detector.close(); },
  };
}
