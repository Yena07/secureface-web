// 실시간 모니터: 카메라 → 탐지 → 인식 → 가우시안 블러 → 경고 · 녹화
import { createDetector } from './detector.js';
import { createRecognizer, bestMatch, MATCH_DISTANCE } from './recognizer.js';
import { blurRegion, expandBox } from './anonymize.js';
import { createTracker, identityOf } from './tracker.js';
import { createAlertTracker } from './alerts.js';
import { createRecorder } from './recorder.js';
import { openCamera } from './camera.js';
import { publicKeys } from './keys.js';
import { people, events } from './db.js';

const $ = (id) => document.getElementById(id);
const video = $('source');
const canvas = $('view');
const ctx = canvas.getContext('2d');

const BOX_EXPAND = 0.15;   // 머리카락·턱까지 가리도록 탐지 상자를 넓히는 비율
const RECOG_MS = 500;      // 얼굴 하나를 다시 인식하는 간격

let detector = null, recognizer = null;
let running = false;
const tracker = createTracker();
const alertTracker = createAlertTracker();
const recorder = createRecorder();
let gallery = [];
let tracks = [];
let recogBusy = false;
let fps = 0, lastFrameAt = 0, detectMs = 0, recogMs = 0;

const setState = (text) => { $('statState').textContent = text; };
const showError = (text) => { $('error').textContent = text || ''; };
const avg = (prev, value) => (prev ? prev * 0.9 + value * 0.1 : value);

async function loadModels() {
  setState('모델 불러오는 중');
  const [det, rec] = await Promise.allSettled([createDetector(), createRecognizer()]);
  if (det.status === 'rejected') throw det.reason;
  detector = det.value;
  if (rec.status === 'fulfilled') recognizer = rec.value;
  else showError('인식 모델을 불러오지 못해 블러만 동작합니다. 네트워크를 확인하고 새로고침해 주세요.');
}

// ── 얼굴 판정 ─────────────────────────────────────────────────────────
// 암호화 집단: 등록자로 인식 → 내부인, 미등록으로 확정 → 외부인, 아직 확인 중 → 전체 키로만 복원
function judge(track) {
  const { decided, person } = identityOf(track);
  const allowed = !!person && person.group === '허가';
  const reason = !decided ? '' : person ? (allowed ? '' : '비허가 등록') : '미등록';
  const group = !decided ? 'master' : person ? 'internal' : 'external';
  return { id: track.id, box: track.box, held: track.held, decided, person, allowed, reason, group };
}

function labelOf(face) {
  if (!face.decided) return { text: '확인 중', color: '#64748b' };
  if (face.allowed) return { text: `허가자 · ${face.person.name}`, color: '#16a34a' };
  return { text: `비허가자 · ${face.reason}`, color: '#ef4444' };
}

function drawLabel(box, { text, color }) {
  ctx.save();
  ctx.lineWidth = Math.max(2, canvas.width / 400);
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.roundRect(box.x1, box.y1, box.x2 - box.x1, box.y2 - box.y1, Math.min(box.x2 - box.x1, box.y2 - box.y1) * 0.25);
  ctx.stroke();
  const size = Math.max(14, Math.round(canvas.width / 60));
  ctx.font = `600 ${size}px sans-serif`;
  const pad = 4, th = size + pad * 2, tw = ctx.measureText(text).width + pad * 2;
  const y = Math.max(0, box.y1 - th - 2);
  ctx.fillStyle = color;
  ctx.fillRect(box.x1, y, tw, th);
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'top';
  ctx.fillText(text, box.x1 + pad, y + pad);
  ctx.restore();
}

// 얼굴마다 RECOG_MS 간격으로, 한 번에 하나씩만 인식한다 (화면 처리가 밀리지 않도록).
function scheduleRecognition(now) {
  if (!recognizer || recogBusy) return;
  const due = tracks.filter((t) => !t.held && now - t.lastRecogAt >= RECOG_MS)
    .sort((a, b) => a.lastRecogAt - b.lastRecogAt)[0];
  if (!due) return;
  due.lastRecogAt = now;
  if (!gallery.length) { pushVote(due, null); return; }   // 등록자가 없으면 모두 미등록
  recogBusy = true;
  const t0 = performance.now();
  recognizer.describe(video, due.box).then((descriptor) => {
    recogMs = avg(recogMs, performance.now() - t0);
    const match = descriptor && bestMatch(descriptor, gallery);
    // 얼굴을 다시 찾지 못한 경우도 '미등록' 한 표로 센다 (확인할 수 없으면 허가하지 않는다).
    pushVote(due, match && match.distance < MATCH_DISTANCE ? match.person : null);
  }).catch(() => {}).finally(() => { recogBusy = false; });
}

function pushVote(track, person) {
  track.votes.push(person);
  if (track.votes.length > 5) track.votes.shift();
}

// ── 프레임 처리 ───────────────────────────────────────────────────────
function renderFrame() {
  if (!running) return;
  if (video.readyState >= 2 && video.videoWidth) {
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    const now = performance.now();
    const detections = detector.detect(video, now);
    detectMs = avg(detectMs, performance.now() - now);
    tracks = tracker.update(detections, now);
    const faces = tracks.map(judge).map((f) => ({ ...f, box: expandBox(f.box, BOX_EXPAND, canvas.width, canvas.height) }));

    // 원본 프레임을 그린 직후 같은 작업 안에서 얼굴을 가린다. 브라우저는 이 작업이 끝난 뒤에
    // 화면을 그리므로, 가리기 전의 원본이 화면에 나타나지 않는다.
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    faces.forEach((f) => blurRegion(ctx, video, f.box));
    if ($('showBoxes').checked) faces.forEach((f) => drawLabel(f.box, labelOf(f)));

    recorder.capture(video, faces, now);
    const alerts = alertTracker.update(faces, now);
    if (alerts.length) recordAlerts(alerts);
    scheduleRecognition(now);

    if (lastFrameAt) fps = avg(fps, 1000 / (now - lastFrameAt));
    lastFrameAt = now;
    $('statFaces').textContent = faces.filter((f) => !f.held).length;
    $('statDenied').textContent = faces.filter((f) => f.decided && !f.allowed).length;
    $('statPerf').textContent = `${fps.toFixed(1)} fps · ${detectMs.toFixed(0)}/${recogMs ? recogMs.toFixed(0) : '-'} ms`;
    if (recorder.active) $('statRec').textContent = `● REC ${Math.floor(recorder.chunkElapsed)}초`;
  }
  scheduleNext();
}

function scheduleNext() {
  if (!running) return;
  if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(renderFrame);
  else requestAnimationFrame(renderFrame);
}

$('startCamera').addEventListener('click', async () => {
  $('startCamera').disabled = true;
  showError('');
  try {
    if (!detector) await loadModels();
    setState('카메라 여는 중');
    await openCamera(video);
  } catch (err) {
    setState('대기');
    showError(err.message || String(err));
    $('startCamera').disabled = false;
    return;
  }
  const pub = await publicKeys();
  if (pub) { recorder.start(pub); $('statRec').classList.add('rec'); }
  else $('statRec').textContent = '꺼짐 (키 미설정)';
  running = true;
  $('placeholder').hidden = true;
  $('startCamera').textContent = '카메라 동작 중';
  setState('카메라 실시간');
  scheduleNext();
});

// 페이지를 떠날 때 녹화 중인 묶음을 마무리한다.
addEventListener('pagehide', () => { recorder.stop(); });

// ── 등록자 목록 ────────────────────────────────────────────────────────
async function loadGallery() {
  gallery = await people.all();
  $('peopleCount').textContent = gallery.length;
  const list = $('peopleList');
  list.replaceChildren();
  if (!gallery.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '등록된 사람이 없습니다.';
    list.append(li);
  }
  for (const p of gallery) {
    const li = document.createElement('li');
    const info = document.createElement('div');
    const name = document.createElement('b');
    name.textContent = p.name;
    const meta = document.createElement('span');
    meta.className = 'badge ' + (p.group === '허가' ? 'ok' : 'bad');
    meta.textContent = p.group;
    info.append(name, ' ', meta);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn small';
    del.textContent = '삭제';
    del.addEventListener('click', async () => {
      if (!confirm(`${p.name}의 등록 정보를 삭제할까요?`)) return;
      await people.remove(p.id);
      await loadGallery();
      tracks.forEach((t) => { t.votes = []; });
    });
    li.append(info, del);
    list.append(li);
  }
}

// ── 감지 이력 ─────────────────────────────────────────────────────────
async function recordAlerts(faces) {
  const time = new Date();
  for (const f of faces) {
    await events.add({ time: time.toISOString(), name: f.person?.name ?? null, reason: f.reason });
  }
  showAlert(faces.length, time, faces.map((f) => f.reason));
  loadEvents();
}

async function loadEvents() {
  const rows = await events.recent(50);
  const list = $('eventList');
  list.replaceChildren();
  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '감지 이력이 없습니다.';
    list.append(li);
  }
  for (const e of rows) {
    const li = document.createElement('li');
    const when = document.createElement('span');
    when.className = 'time';
    when.textContent = new Date(e.time).toLocaleString('ko-KR');
    const who = document.createElement('b');
    who.textContent = e.name || '이름 없음';
    const why = document.createElement('span');
    why.className = 'badge bad';
    why.textContent = e.reason;
    const info = document.createElement('div');
    info.append(who, ' ', why);
    li.append(info, when);
    list.append(li);
  }
}

$('clearEvents').addEventListener('click', async () => {
  if (!confirm('감지 이력을 모두 지울까요?')) return;
  await events.clear();
  loadEvents();
});

// ── 탭 ────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
  document.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = p.id !== 'tab-' + tab.dataset.tab; });
}));

// ── 비허가자 경고 팝업 (확인을 눌러야만 닫힘, 열려 있는 동안 누적) ─────────
const overlay = $('alertOverlay');
let alertTotal = 0, alertFirst = null, alertReasons = new Set();
function showAlert(count, time, reasons) {
  const t = time.toLocaleTimeString('ko-KR', { hour12: false });
  if (overlay.hidden) { alertTotal = 0; alertFirst = t; alertReasons = new Set(); }
  alertTotal += count;
  reasons.forEach((r) => r && alertReasons.add(r));
  $('alertCount').textContent = `비허가자 ${alertTotal}명이 감지되었습니다`;
  $('alertReason').textContent = alertReasons.size ? '사유: ' + [...alertReasons].join(', ') : '';
  $('alertTime').textContent = alertFirst === t ? `감지 시각 ${t}` : `처음 감지 ${alertFirst}\n최근 감지 ${t}`;
  if (overlay.hidden) {
    overlay.hidden = false;
    $('alertConfirm').focus();
  }
}
$('alertConfirm').addEventListener('click', () => { overlay.hidden = true; });

publicKeys().then((pub) => { $('keyNotice').hidden = !!pub; });
loadGallery();
loadEvents();
