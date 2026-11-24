import { createDetector } from './detector.js';
import { blurRegion, createHold, expandBox } from './anonymize.js';

const $ = (id) => document.getElementById(id);
const video = $('source');
const canvas = $('view');
const ctx = canvas.getContext('2d', { willReadFrequently: false });

const BOX_EXPAND = 0.15;   // 머리카락·턱까지 가리도록 탐지 상자를 넓히는 비율

let detector = null;
let stream = null;
let fileUrl = null;
let running = false;
let hold = createHold();
let fps = 0, lastFrameAt = 0, detectMs = 0;

function setState(text) { $('statState').textContent = text; }
function showError(text) { $('error').textContent = text || ''; }

async function ensureDetector() {
  if (detector) return detector;
  setState('모델 불러오는 중');
  detector = await createDetector();
  $('statBackend').textContent = detector.backend === 'GPU' ? 'GPU (WebGL)' : 'CPU (WASM)';
  return detector;
}

function drawLabel(box) {
  const text = '미등록';
  ctx.save();
  ctx.lineWidth = Math.max(2, canvas.width / 400);
  ctx.strokeStyle = '#ef4444';
  ctx.strokeRect(box.x1, box.y1, box.x2 - box.x1, box.y2 - box.y1);
  ctx.font = `600 ${Math.max(14, Math.round(canvas.width / 60))}px sans-serif`;
  const pad = 4, th = parseInt(ctx.font.match(/\d+px/)[0], 10) + pad * 2;
  const tw = ctx.measureText(text).width + pad * 2;
  const y = Math.max(0, box.y1 - th);
  ctx.fillStyle = '#ef4444';
  ctx.fillRect(box.x1, y, tw, th);
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'top';
  ctx.fillText(text, box.x1 + pad, y + pad);
  ctx.restore();
}

function renderFrame() {
  if (!running) return;
  if (video.readyState >= 2 && video.videoWidth) {
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    const now = performance.now();
    const t0 = performance.now();
    const detections = detector.detect(video, now);
    detectMs = detectMs ? detectMs * 0.9 + (performance.now() - t0) * 0.1 : performance.now() - t0;
    const boxes = hold(detections, now).map((b) => expandBox(b, BOX_EXPAND, canvas.width, canvas.height));

    // 원본 프레임을 그린 직후 같은 작업 안에서 얼굴을 가린다. 브라우저는 이 작업이 끝난 뒤에
    // 화면을 그리므로, 가리기 전의 원본이 화면에 나타나지 않는다.
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    for (const box of boxes) blurRegion(ctx, box);
    if ($('showBoxes').checked) boxes.forEach(drawLabel);

    if (lastFrameAt) fps = fps ? fps * 0.9 + (1000 / (now - lastFrameAt)) * 0.1 : 1000 / (now - lastFrameAt);
    lastFrameAt = now;
    $('statFaces').textContent = detections.length;
    $('statFps').textContent = `${fps.toFixed(1)} fps`;
    $('statMs').textContent = `${detectMs.toFixed(1)} ms`;
  }
  scheduleNext();
}

function scheduleNext() {
  if (!running) return;
  if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(renderFrame);
  else requestAnimationFrame(renderFrame);
}

async function start(setup, label) {
  stop();
  showError('');
  try {
    await ensureDetector();
    await setup();
    await video.play();
  } catch (err) {
    stop();
    showError(err.message || String(err));
    return;
  }
  running = true;
  hold = createHold();
  fps = 0; lastFrameAt = 0; detectMs = 0;
  $('placeholder').hidden = true;
  $('stop').disabled = false;
  setState(label);
  scheduleNext();
}

function stop() {
  running = false;
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  if (fileUrl) { URL.revokeObjectURL(fileUrl); fileUrl = null; }
  video.pause();
  video.removeAttribute('src');
  video.srcObject = null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  $('placeholder').hidden = false;
  $('stop').disabled = true;
  $('statFaces').textContent = '0';
  $('statFps').textContent = '-';
  $('statMs').textContent = '-';
  setState('대기');
}

$('startCamera').addEventListener('click', () => start(async () => {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('카메라는 https 주소나 localhost에서만 쓸 수 있습니다.');
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
    });
  } catch (err) {
    if (err.name === 'NotAllowedError') throw new Error('카메라 권한이 거부되었습니다. 주소창의 카메라 권한을 허용해 주세요.');
    if (err.name === 'NotFoundError') throw new Error('카메라를 찾을 수 없습니다. 영상 파일로 테스트할 수 있습니다.');
    throw err;
  }
  video.srcObject = stream;
  video.loop = false;
}, '카메라 실시간'));

$('videoFile').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  start(async () => {
    fileUrl = URL.createObjectURL(file);
    video.src = fileUrl;
    video.loop = true;
  }, '영상 파일');
});

$('stop').addEventListener('click', stop);
