// ONNX 모델 실행 (onnxruntime-web, WASM/CPU). SCRFD 탐지와 ArcFace 인식이 함께 쓴다.
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/ort.wasm.min.mjs';

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/';
// 여러 스레드는 사이트에 교차 출처 격리 헤더가 있을 때만 쓸 수 있다. 없으면 한 스레드로 돈다.
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

export { ort };

export function createSession(url) {
  return ort.InferenceSession.create(url, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
}

// 탐지와 인식이 같은 WASM 실행기를 쓰므로, 겹쳐 돌지 않게 한 번에 하나씩 실행한다.
let queue = Promise.resolve();
export function run(session, feeds) {
  const next = queue.then(() => session.run(feeds));
  queue = next.catch(() => {});
  return next;
}

/** RGBA 픽셀 → NCHW float32 (RGB 순서, (값 - mean) / std) */
export function toTensor(rgba, width, height, mean, std) {
  const plane = width * height;
  const data = new Float32Array(plane * 3);
  for (let i = 0, p = 0; p < plane; i += 4, p++) {
    data[p] = (rgba[i] - mean) / std;
    data[plane + p] = (rgba[i + 1] - mean) / std;
    data[plane * 2 + p] = (rgba[i + 2] - mean) / std;
  }
  return new ort.Tensor('float32', data, [1, 3, height, width]);
}
