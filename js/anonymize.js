// 얼굴 익명화.
//
// 블러: 라즈베리파이 버전(core/selective_crypto.protect)과 같은 방식으로, 얼굴 영역을 아주
// 작게 줄였다가(축소 ROI) 부드럽게 다시 키운다. 축소 크기가 작을수록 강하게 뭉개진다.
// canvas filter(blur)를 쓰지 않아 브라우저마다 결과가 같다.
// (탐지 누락 시 계속 가리기는 tracker.js가 맡는다.)

const work = document.createElement('canvas');
const workCtx = work.getContext('2d');

/** 얼굴 상자를 비율만큼 넓히고 화면 안으로 자른다. */
export function expandBox(box, ratio, width, height) {
  const w = box.x2 - box.x1, h = box.y2 - box.y1;
  const x1 = Math.max(0, Math.floor(box.x1 - w * ratio));
  const y1 = Math.max(0, Math.floor(box.y1 - h * ratio));
  const x2 = Math.min(width, Math.ceil(box.x2 + w * ratio));
  const y2 = Math.min(height, Math.ceil(box.y2 + h * ratio));
  return { ...box, x1, y1, x2, y2 };
}

/** ctx에 이미 그려진 프레임의 box 영역을 강하게 흐린다. workSize: 축소했을 때 긴 변의 픽셀 수. */
export function blurRegion(ctx, box, workSize = 10) {
  const w = box.x2 - box.x1, h = box.y2 - box.y1;
  if (w < 2 || h < 2) return;
  const scale = workSize / Math.max(w, h);
  const sw = Math.max(1, Math.round(w * scale)), sh = Math.max(1, Math.round(h * scale));
  work.width = sw; work.height = sh;
  workCtx.imageSmoothingEnabled = true;
  workCtx.imageSmoothingQuality = 'high';
  workCtx.drawImage(ctx.canvas, box.x1, box.y1, w, h, 0, 0, sw, sh);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(work, 0, 0, sw, sh, box.x1, box.y1, w, h);
  ctx.restore();
}
