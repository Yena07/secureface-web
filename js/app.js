// 실시간 모니터: 카메라 → 탐지 → 인식 → 가우시안 블러 → 경고 · 녹화
import { createDetector, DET_SIZE } from './detector.js';
import { createRecognizer, bestMatch, MATCH_SIMILARITY } from './recognizer.js';
import { blurRegion, expandBox } from './anonymize.js';
import { createTracker, identityOf } from './tracker.js';
import { createAlertTracker } from './alerts.js';
import { createRecorder } from './recorder.js';
import { openCamera } from './camera.js';
import { publicKeys } from './keys.js';
import { people, events } from './db.js';
import { FLOORS, DAYS, DEFAULTS, checkTime, checkWork, effective, evaluate, floorsText, loadSettings, saveSettings } from './access.js';

const $ = (id) => document.getElementById(id);
const video = $('source');
const canvas = $('view');
const ctx = canvas.getContext('2d');
// 처리 중인 한 프레임의 사본. 탐지가 비동기라 그사이 영상이 넘어가도, 탐지·블러·녹화가
// 모두 같은 그림을 쓰도록 한다 (화면에는 그리지 않음).
const frame = document.createElement('canvas');
const frameCtx = frame.getContext('2d');

const BOX_EXPAND = 0.15;   // 머리카락·턱까지 가리도록 탐지 상자를 넓히는 비율
const RECOG_MS = 500;      // 얼굴 하나를 다시 인식하는 간격

let detector = null, recognizer = null;
let running = false;
const tracker = createTracker();
const alertTracker = createAlertTracker();
const recorder = createRecorder();
let gallery = [];
let tracks = [];
let access = structuredClone(DEFAULTS);   // 출입 통제 설정 (loadSettings로 덮어씀)
let recogBusy = false;
let fps = 0, lastFrameAt = 0, detectMs = 0, recogMs = 0;

const setState = (text) => { $('statState').textContent = text; };
const showError = (text) => { $('error').textContent = text || ''; };
const avg = (prev, value) => (prev ? prev * 0.9 + value * 0.1 : value);

async function loadModels() {
  setState('모델 불러오는 중');
  const [det, rec] = await Promise.allSettled([createDetector({ size: DET_SIZE }), createRecognizer()]);
  if (det.status === 'rejected') throw det.reason;
  detector = det.value;
  if (rec.status === 'fulfilled') recognizer = rec.value;
  else showError('인식 모델을 불러오지 못해 블러만 동작합니다. 네트워크를 확인하고 새로고침해 주세요.');
}

// ── 얼굴 판정 ─────────────────────────────────────────────────────────
// 출입 판정(표시·경고): 미등록 → 비허가 등록 → 근무시간 외 → N층 출입금지 (access.js)
// 암호화 집단은 인식 결과만 따른다: 등록자로 인식 → 내부인, 미등록으로 확정 → 외부인,
// 아직 확인 중 → 전체 키로만 복원. 출입이 거부된 등록자도 내부인 키로 복원할 수 있다.
function judge(track, env) {
  const { decided, person } = identityOf(track);
  const { allowed, reason } = decided ? evaluate(person, env) : { allowed: false, reason: '' };
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
  // describe는 호출하는 순간 frame에서 얼굴을 잘라 가므로 다음 프레임이 frame을 덮어써도 된다.
  recognizer.describe(frame, due.box).then((descriptor) => {
    recogMs = avg(recogMs, performance.now() - t0);
    const match = descriptor && bestMatch(descriptor, gallery);
    // 인식할 수 없는 얼굴도 '미등록' 한 표로 센다 (확인할 수 없으면 허가하지 않는다).
    pushVote(due, match && match.similarity >= MATCH_SIMILARITY ? match.person : null);
  }).catch(() => {}).finally(() => { recogBusy = false; });
}

function pushVote(track, person) {
  track.votes.push(person);
  if (track.votes.length > 5) track.votes.shift();
}

// ── 프레임 처리 ───────────────────────────────────────────────────────
async function renderFrame() {
  if (!running) return;
  if (video.readyState >= 2 && video.videoWidth) {
    const w = video.videoWidth, h = video.videoHeight;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    if (frame.width !== w || frame.height !== h) { frame.width = w; frame.height = h; }
    frameCtx.drawImage(video, 0, 0, w, h);   // 이 프레임의 사본 (화면에는 그리지 않음)
    const now = performance.now();
    let detections;
    try {
      detections = await detector.detect(frame);
    } catch (err) {
      showError('얼굴 탐지 오류: ' + (err.message || err));
      scheduleNext();
      return;
    }
    if (!running) return;
    detectMs = avg(detectMs, performance.now() - now);
    tracks = tracker.update(detections, now);
    const env = effective(access);
    const faces = tracks.map((t) => judge(t, env))
      .map((f) => ({ ...f, box: expandBox(f.box, BOX_EXPAND, w, h) }));

    // 사본을 그린 직후 같은 작업 안에서 얼굴을 가린다. 브라우저는 이 작업이 끝난 뒤에
    // 화면을 그리므로, 가리기 전의 원본이 화면에 나타나지 않는다.
    ctx.drawImage(frame, 0, 0);
    faces.forEach((f) => blurRegion(ctx, frame, f.box));
    if ($('showBoxes').checked) faces.forEach((f) => drawLabel(f.box, labelOf(f)));

    recorder.capture(frame, faces, now);
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
// ArcFace 512차원 수치만 비교에 쓴다. 이전 인식 모델(128차원)로 등록한 사람은 다시 등록해야 한다.
const ARCFACE_DIM = 512;
const usable = (p) => p.descriptors?.[0]?.length === ARCFACE_DIM;

async function loadGallery() {
  const all = await people.all();
  gallery = all.filter(usable);
  $('peopleCount').textContent = all.length;
  const list = $('peopleList');
  list.replaceChildren();
  if (!all.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '등록된 사람이 없습니다.';
    list.append(li);
  }
  for (const p of all) {
    const li = document.createElement('li');
    const info = document.createElement('div');
    const name = document.createElement('b');
    name.textContent = p.name;
    const meta = document.createElement('span');
    meta.className = 'badge ' + (p.group === '허가' ? 'ok' : 'bad');
    meta.textContent = p.group;
    const floors = document.createElement('div');
    floors.className = 'hint';
    floors.textContent = p.group === '허가' ? `출입 허가: ${floorsText(p.floors)}` : '모든 층 출입 불가';
    info.append(name, ' ', meta);
    if (!usable(p)) {
      const stale = document.createElement('span');
      stale.className = 'badge bad';
      stale.textContent = '재등록 필요';
      info.append(' ', stale);
    }
    info.append(floors);
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'btn small';
    edit.textContent = '층 수정';
    edit.addEventListener('click', () => openFloorModal(p));
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
    actions.append(edit, del);
    li.append(info, actions);
    list.append(li);
  }
}

// ── 등록자 출입 허가 층 수정 ──────────────────────────────────────────
let editing = null;
function openFloorModal(person) {
  editing = person;
  $('floorName').textContent = person.name;
  $('floorMsg').textContent = '';
  const box = $('floorEditChecks');
  box.replaceChildren();
  const current = person.floors?.length ? person.floors : FLOORS;
  for (const f of FLOORS) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox'; input.value = f; input.checked = current.includes(f);
    label.append(input, ` ${f}층`);
    box.append(label);
  }
  $('floorModal').hidden = false;
}
$('floorCancel').addEventListener('click', () => { $('floorModal').hidden = true; });
$('floorSave').addEventListener('click', async () => {
  const floors = [...document.querySelectorAll('#floorEditChecks input:checked')].map((b) => Number(b.value));
  if (!floors.length) { $('floorMsg').textContent = '출입 허가 층을 하나 이상 선택하세요.'; return; }
  await people.put({ ...editing, floors });
  $('floorModal').hidden = true;
  await loadGallery();
  // 인식 결과(표)는 사람 객체를 가리키므로 새 정보로 바꿔 끼운다
  const byId = new Map(gallery.map((p) => [p.id, p]));
  tracks.forEach((t) => { t.votes = t.votes.map((v) => (v ? byId.get(v.id) ?? null : v)); });
});

// ── 관제 상황 시뮬레이션 · 근무시간 ─────────────────────────────────────
// 시연 모드가 켜져 있는 동안에는 입력칸을 저장된 값으로 덮어쓰지 않는다 (고치던 값이 되돌아가지 않게).
let simOn = false, simDirty = false;
const workDayButtons = DAYS.map((d, i) => {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'day'; b.textContent = d; b.dataset.day = i;
  b.addEventListener('click', () => b.classList.toggle('on'));
  $('workDays').append(b);
  return b;
});
DAYS.forEach((d, i) => $('simDay').append(new Option(`${d}요일`, i)));
for (const sel of ['simFloor', 'cameraFloor']) FLOORS.forEach((f) => $(sel).append(new Option(`${f}층`, f)));

function fillSimFields() {
  $('simDay').value = access.day;
  $('simTime').value = access.time;
  $('simFloor').value = access.floor;
}
function fillWorkFields() {
  workDayButtons.forEach((b, i) => b.classList.toggle('on', access.work.days.includes(i)));
  $('workStart').value = access.work.start;
  $('workEnd').value = access.work.end;
  $('cameraFloor').value = access.cameraFloor;
}

function renderAccess() {
  const env = effective(access);
  $('simSwitch').classList.toggle('on', simOn);
  $('simSwitch').setAttribute('aria-checked', String(simOn));
  $('simLabel').textContent = `시연 모드 ${simOn ? 'ON' : 'OFF'}`;
  ['simDay', 'simTime', 'simFloor', 'simApply'].forEach((id) => { $(id).disabled = !simOn; });
  $('modePill').className = 'mode-pill' + (access.demo ? '' : ' off');
  $('modePill').textContent = access.demo ? '시연 모드 적용 중' : '실제 환경 기준';
  $('scenario').classList.toggle('active-sim', access.demo);
  $('simMode').textContent = access.demo ? '◉ 시연 환경 적용' : '● 실제 환경';
  let context = `${DAYS[env.day]}요일 · ${env.time} · ${env.floor}층`;
  if (simOn && (simDirty || !access.demo)) context += '  (변경 사항은 [이 상황 적용]을 눌러야 반영됩니다)';
  $('simContext').textContent = context;
  const w = access.work;
  const days = w.days.join(',') === '0,1,2,3,4' ? '평일' : w.days.map((d) => DAYS[d]).join('·');
  $('simRule').className = env.afterHours ? 'deny' : 'ok';
  $('simRule').textContent = env.afterHours
    ? `근무시간 외 (${days} ${w.start}~${w.end} 밖) · 등록자도 전원 비허가`
    : `근무시간 (${days} ${w.start}~${w.end}) · 등록 시 허가한 층만 출입 허가`;
}

async function applyAccess(changes) {
  access = { ...access, ...changes };
  await saveSettings(access);
  renderAccess();
}

$('simSwitch').addEventListener('click', async () => {
  simOn = !simOn;
  if (simOn) { simDirty = true; fillSimFields(); renderAccess(); }
  else { simDirty = false; await applyAccess({ demo: false }); }
});
for (const id of ['simDay', 'simTime', 'simFloor']) {
  for (const type of ['input', 'change']) $(id).addEventListener(type, () => { simDirty = true; renderAccess(); });
}
$('simApply').addEventListener('click', async () => {
  try {
    await applyAccess({ demo: true, day: Number($('simDay').value), time: checkTime($('simTime').value), floor: Number($('simFloor').value) });
    simDirty = false;
    renderAccess();
  } catch (err) { $('simContext').textContent = err.message; }
});
$('simReset').addEventListener('click', async () => {
  simOn = false; simDirty = false;
  // 시연 상황만 기본값으로. 근무시간과 카메라 위치는 그대로 둔다.
  await applyAccess({ demo: DEFAULTS.demo, day: DEFAULTS.day, time: DEFAULTS.time, floor: DEFAULTS.floor });
  fillSimFields();
});
$('workSave').addEventListener('click', async () => {
  const msg = $('workMsg');
  try {
    const work = checkWork({
      days: workDayButtons.filter((b) => b.classList.contains('on')).map((b) => Number(b.dataset.day)),
      start: $('workStart').value, end: $('workEnd').value,
    });
    await applyAccess({ work, cameraFloor: Number($('cameraFloor').value) });
    msg.className = 'msg ok'; msg.textContent = '저장되었습니다';
  } catch (err) {
    msg.className = 'msg err'; msg.textContent = err.message;
  }
});
setInterval(renderAccess, 1000);   // 실제 시각이 근무시간 경계를 넘으면 표시도 바뀌도록

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
loadSettings().then((s) => {
  access = s;
  simOn = s.demo;
  fillSimFields();
  fillWorkFields();
  renderAccess();
});
loadGallery();
loadEvents();
