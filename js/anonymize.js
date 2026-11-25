// 얼굴 가우시안 블러.
//
// 얼굴 상자를 조금 넓힌 둥근 사각형 안에 원본 영상을 가우시안 블러(canvas filter: blur)로 다시 그린다.
// 블러 세기는 얼굴 크기에 비례한다(라즈베리파이 버전의 SELECTIVE_BLUR_FACE_RATIO와 같은 생각).
// canvas filter를 지원하지 않는 브라우저에서는 축소했다 키우는 방식으로 대신한다.

const BLUR_RATIO = 0.12;   // 블러 반경 = 얼굴 상자 긴 변 × 비율
const MIN_BLUR_PX = 8;
const CORNER_RATIO = 0.25;

const supportsFilter = (() => {
  const c = document.createElement('canvas');
  c.width = 3; c.height = 1;
  const x = c.getContext('2d', { willReadFrequently: true });
  if (!('filter' in x)) return false;
  const src = document.createElement('canvas');
  src.width = 3; src.height = 1;
  const s = src.getContext('2d');
  s.fillStyle = '#000'; s.fillRect(0, 0, 3, 1);
  s.fillStyle = '#fff'; s.fillRect(0, 0, 1, 1);
  x.filter = 'blur(2px)';
  x.drawImage(src, 0, 0);
  return x.getImageData(2, 0, 1, 1).data[0] > 0;   // 흰 점이 옆으로 번졌으면 지원
})();

/** 얼굴 상자를 비율만큼 넓히고 화면 안으로 자른다. */
export function expandBox(box, ratio, width, height) {
  const w = box.x2 - box.x1, h = box.y2 - box.y1;
  const x1 = Math.max(0, Math.floor(box.x1 - w * ratio));
  const y1 = Math.max(0, Math.floor(box.y1 - h * ratio));
  const x2 = Math.min(width, Math.ceil(box.x2 + w * ratio));
  const y2 = Math.min(height, Math.ceil(box.y2 + h * ratio));
  return { ...box, x1, y1, x2, y2 };
}

/** 상자를 scale 배로 바꾼다 (녹화용 작은 프레임에 맞출 때). */
export function scaleBox(box, scale) {
  return { ...box, x1: box.x1 * scale, y1: box.y1 * scale, x2: box.x2 * scale, y2: box.y2 * scale };
}

const work = document.createElement('canvas');
const workCtx = work.getContext('2d');

/**
 * ctx(이미 source 프레임이 그려진 캔버스)에서 box 영역을 블러로 덮는다.
 * source: 원본 <video>, scale: source → ctx 크기 비율.
 */
export function blurRegion(ctx, source, box, scale = 1) {
  const w = box.x2 - box.x1, h = box.y2 - box.y1;
  if (w < 2 || h < 2) return;
  const radius = Math.max(MIN_BLUR_PX, Math.max(w, h) * BLUR_RATIO);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(box.x1, box.y1, w, h, Math.min(w, h) * CORNER_RATIO);
  ctx.clip();
  if (supportsFilter) {
    // 블러가 상자 밖 픽셀까지 섞도록 여유를 두고 그린다 (가장자리가 비치지 않게).
    const m = radius * 2;
    const sx = Math.max(0, (box.x1 - m) / scale), sy = Math.max(0, (box.y1 - m) / scale);
    const sw = Math.min(source.videoWidth || source.width, (box.x2 + m) / scale) - sx;
    const sh = Math.min(source.videoHeight || source.height, (box.y2 + m) / scale) - sy;
    ctx.filter = `blur(${radius}px)`;
    ctx.drawImage(source, sx, sy, sw, sh, sx * scale, sy * scale, sw * scale, sh * scale);
  } else {
    const size = 10 / Math.max(w, h);
    work.width = Math.max(1, Math.round(w * size)); work.height = Math.max(1, Math.round(h * size));
    workCtx.drawImage(ctx.canvas, box.x1, box.y1, w, h, 0, 0, work.width, work.height);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(work, 0, 0, work.width, work.height, box.x1, box.y1, w, h);
  }
  ctx.restore();
}
