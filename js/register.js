// 얼굴 등록: 정면 → 한쪽 → 반대쪽 순서로 고개를 돌리며 각도별 얼굴 수치를 모은다.
import { createDetector, DET_SIZE } from './detector.js';
import { createRecognizer } from './recognizer.js';
import { openCamera } from './camera.js';
import { people } from './db.js';
import { FLOORS, floorsText } from './access.js';

const $ = (id) => document.getElementById(id);
const video = $('source');
const canvas = $('regView');
const ctx = canvas.getContext('2d');

const SAMPLES_PER_STEP = 2;
// SCRFD의 코끝 키포인트는 고개를 돌려도 가운데 쪽으로 덜 움직여 값의 범위가 작다
// (시연 영상에서 |값| 중앙값 0.07, 최대 0.18). 그 범위에 맞춘 기준이다.
const FRONT_MAX = 0.08;   // |고개 방향| 이 이하면 정면
const SIDE_MIN = 0.15;    // |고개 방향| 이 이상이면 옆으로 돌린 것
const SAMPLE_GAP_MS = 350;

let detector = null, recognizer = null, closeCamera = null;
let running = false, busy = false, lastSampleAt = 0;
let step = 0, firstSide = 0, samples = [], stepCount = 0, faceBox = null;
let name = '', group = '허가', floors = [...FLOORS];

// 출입 허가 층 체크박스 (기본: 전체 층)
for (const f of FLOORS) {
  const label = document.createElement('label');
  const box = document.createElement('input');
  box.type = 'checkbox'; box.value = f; box.checked = true;
  label.append(box, ` ${f}층`);
  $('floorChecks').append(label);
}
const checkedFloors = () => [...document.querySelectorAll('#floorChecks input:checked')].map((b) => Number(b.value));

/** 고개 방향: 코끝이 두 눈 가운데에서 얼마나 벗어났는지 (눈 사이 거리 기준). 정면 ≈ 0 */
function yawOf(face) {
  const [rEye, lEye, nose] = face.keypoints;
  if (!rEye || !lEye || !nose) return null;
  const eyes = Math.abs(lEye.x - rEye.x);
  return eyes > 1 ? (nose.x - (rEye.x + lEye.x) / 2) / eyes : null;
}

function poseMatches(yaw) {
  if (step === 0) return Math.abs(yaw) <= FRONT_MAX;
  if (step === 1) return Math.abs(yaw) >= SIDE_MIN;
  return Math.abs(yaw) >= SIDE_MIN && Math.sign(yaw) === -firstSide;   // 반대쪽
}

const INSTRUCTIONS = [
  '정면을 바라봐 주세요',
  '고개를 천천히 한쪽으로 돌려 주세요 ↔',
  '이번에는 반대쪽으로 천천히 돌려 주세요',
];

function updateSteps() {
  document.querySelectorAll('.step').forEach((el) => {
    const i = Number(el.dataset.step);
    el.classList.toggle('active', i === step);
    el.classList.toggle('done', i < step);
  });
  $('regBar').style.width = `${(samples.length / (SAMPLES_PER_STEP * 3)) * 100}%`;
}

// 탐지가 비동기라, 탐지·화면·인식이 같은 그림을 쓰도록 프레임 사본을 둔다.
const frame = document.createElement('canvas');
const frameCtx = frame.getContext('2d');

async function render() {
  if (!running) return;
  if (video.readyState >= 2 && video.videoWidth) {
    const w = video.videoWidth, h = video.videoHeight;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    if (frame.width !== w || frame.height !== h) { frame.width = w; frame.height = h; }
    frameCtx.drawImage(video, 0, 0, w, h);
    const faces = await detector.detect(frame);
    if (!running) return;
    // 거울처럼 좌우를 뒤집어 보여 준다 (본인이 맞추기 쉽도록). 판정은 원본 좌표로 한다.
    ctx.setTransform(-1, 0, 0, 1, w, 0);
    ctx.drawImage(frame, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    let hint = '', ok = false;
    if (faces.length === 0) hint = '얼굴이 보이지 않습니다. 카메라를 바라봐 주세요.';
    else if (faces.length > 1) hint = `화면에 한 사람만 나오게 해 주세요 (지금 ${faces.length}명).`;
    else {
      faceBox = faces[0];
      const yaw = yawOf(faceBox);
      ok = yaw !== null && poseMatches(yaw);
      hint = ok ? '좋아요, 그대로 잠시만…' : step === 0 ? '정면을 봐 주세요.' : '조금 더 돌려 주세요.';
      $('guideOval').classList.toggle('ok', ok);
      if (ok) trySample();
    }
    if (!ok) $('guideOval').classList.remove('ok');
    $('poseHint').textContent = hint;
  }
  if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(render);
  else requestAnimationFrame(render);
}

async function trySample() {
  const now = performance.now();
  if (busy || now - lastSampleAt < SAMPLE_GAP_MS) return;
  busy = true;
  lastSampleAt = now;
  const box = faceBox;
  const yaw = yawOf(box);
  try {
    const d = await recognizer.describe(frame, box);
    if (!d || !running) return;
    samples.push(d);
    stepCount++;
    if (step === 1 && stepCount === 1) firstSide = Math.sign(yaw);
    if (stepCount >= SAMPLES_PER_STEP) {
      step++;
      stepCount = 0;
      if (step === 3) return finish();
      $('instruction').textContent = INSTRUCTIONS[step];
    }
    updateSteps();
  } finally {
    busy = false;
  }
}

async function finish() {
  running = false;
  updateSteps();
  closeCamera?.();
  await people.add({ name, group, floors, descriptors: samples, createdAt: new Date().toISOString() });
  $('captureCard').hidden = true;
  $('doneCard').hidden = false;
  $('doneTitle').textContent = `${name} 등록 완료`;
  $('doneText').textContent = `${group === '허가' ? `허가(${floorsText(floors)})` : '비허가'}로 등록했습니다. `
    + `정면·양옆 얼굴 수치 ${samples.length}개를 이 브라우저에 저장했습니다.`;
}

function reset() {
  running = false;
  closeCamera?.();
  closeCamera = null;
  step = 0; firstSide = 0; samples = []; stepCount = 0;
  $('formCard').hidden = false;
  $('captureCard').hidden = true;
  $('doneCard').hidden = true;
  $('startReg').disabled = false;
}

$('startReg').addEventListener('click', async () => {
  name = $('regName').value.trim();
  group = $('regGroup').value;
  floors = checkedFloors();
  $('error').textContent = '';
  if (!name) { $('formMsg').textContent = '이름을 입력하세요.'; $('formMsg').className = 'msg err'; return; }
  if (!floors.length) { $('formMsg').textContent = '출입 허가 층을 하나 이상 선택하세요.'; $('formMsg').className = 'msg err'; return; }
  $('formMsg').textContent = '';
  $('startReg').disabled = true;
  $('formCard').hidden = true;
  $('captureCard').hidden = false;
  $('instruction').textContent = '모델을 불러오는 중…';
  updateSteps();
  try {
    if (!detector) [detector, recognizer] = await Promise.all([createDetector({ size: DET_SIZE }), createRecognizer()]);
    $('instruction').textContent = '카메라를 여는 중…';
    closeCamera = await openCamera(video);
  } catch (err) {
    reset();
    $('error').textContent = err.message || String(err);
    return;
  }
  $('instruction').textContent = INSTRUCTIONS[0];
  running = true;
  render();
});

$('cancelReg').addEventListener('click', reset);
$('again').addEventListener('click', () => { $('regName').value = ''; reset(); });
addEventListener('pagehide', () => closeCamera?.());
