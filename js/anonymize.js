// 얼굴 익명화와 탐지 누락 보완.
//
// 블러: 라즈베리파이 버전(core/selective_crypto.protect)과 같은 방식으로, 얼굴 영역을 아주
// 작게 줄였다가(축소 ROI) 부드럽게 다시 키운다. 축소 크기가 작을수록 강하게 뭉개진다.
// canvas filter(blur)를 쓰지 않아 브라우저마다 결과가 같다.

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

function iou(a, b) {
  const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const inter = ix * iy;
  const union = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * 탐지 누락 보완: 탐지기가 한두 프레임 얼굴을 놓쳐도 마지막 위치를 holdMs 동안 계속 가린다
 * (라즈베리파이 버전의 FACE_AUTH_HOLD_SECONDS와 같은 역할). 이게 없으면 놓친 프레임에
 * 얼굴이 그대로 드러난다.
 */
export function createHold({ holdMs = 800, iouThreshold = 0.3 } = {}) {
  let tracks = [];   // {box, lastSeen}
  return function update(detections, now) {
    const fresh = detections.map((box) => ({ box, lastSeen: now }));
    const held = tracks.filter((t) => now - t.lastSeen <= holdMs
      && !detections.some((d) => iou(d, t.box) >= iouThreshold));
    tracks = [...fresh, ...held];
    return tracks.map((t) => ({ ...t.box, held: t.lastSeen !== now }));
  };
}
