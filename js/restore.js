// 녹화 복원: 블러된 녹화를 재생하고, 집단 키를 넣으면 그 집단 얼굴만 원본으로 되돌린다.
import { chunks, frames } from './db.js';
import { GROUP_LABEL, isConfigured, setupKeys, unlock, openChunkKeys, openSealed } from './keys.js';

const $ = (id) => document.getElementById(id);
const canvas = $('player');
const ctx = canvas.getContext('2d');

let current = null;        // 선택한 묶음 정보
let rows = [];             // 그 묶음의 프레임들
let deks = null, opener = null;   // 복원 중이면 열린 데이터 키와 사용한 키 종류
let index = 0, playing = true, timer = null, drawToken = 0;
const faceCache = new Map();      // `${프레임}/${얼굴}` → 복원된 얼굴 ImageBitmap

const fmtTime = (iso) => new Date(iso).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

// ── 키 설정 ───────────────────────────────────────────────────────────
$('setupKeys').addEventListener('click', async () => {
  const pw = { master: $('pwMaster').value, internal: $('pwInternal').value, external: $('pwExternal').value };
  const msg = $('setupMsg');
  msg.className = 'msg err';
  if (Object.values(pw).some((p) => p.length < 4)) { msg.textContent = '세 키 모두 4자 이상으로 정해 주세요.'; return; }
  if (new Set(Object.values(pw)).size !== 3) { msg.textContent = '세 키는 서로 달라야 합니다.'; return; }
  $('setupKeys').disabled = true;
  msg.className = 'msg';
  msg.textContent = '키를 만드는 중…';
  try {
    await setupKeys(pw);
    await showPage();
  } catch (err) {
    msg.className = 'msg err';
    msg.textContent = err.message || String(err);
    $('setupKeys').disabled = false;
  }
});

// ── 녹화 목록 ─────────────────────────────────────────────────────────
async function loadList() {
  const all = (await chunks.all()).sort((a, b) => b.id - a.id);
  $('chunkCount').textContent = `${all.length}개`;
  const list = $('chunkList');
  list.replaceChildren();
  if (!all.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '녹화가 없습니다. 실시간 모니터에서 카메라를 켜면 30초 단위로 녹화됩니다.';
    list.append(li);
  }
  for (const c of all) {
    const li = document.createElement('li');
    li.className = 'chunk-item' + (current?.id === c.id ? ' selected' : '');
    const title = document.createElement('b');
    title.textContent = fmtTime(c.startedAt);
    const meta = document.createElement('span');
    meta.className = 'hint';
    const secs = c.frameCount / c.fps;
    meta.textContent = `${secs.toFixed(0)}초 · 외부인 ${c.faces.external} · 내부인 ${c.faces.internal} · 확인 중 ${c.faces.master}`
      + (c.status === 'complete' ? '' : ' · 중간에 끊김');
    li.append(title, meta);
    li.addEventListener('click', () => select(c.id));
    list.append(li);
  }
}

async function select(id) {
  stopPlayback();
  current = await chunks.get(id);
  rows = (await frames.of(id)).sort((a, b) => a.index - b.index);
  resetRestore();
  index = 0;
  $('viewerEmpty').hidden = true;
  $('viewerBody').hidden = !current;
  if (!current) return;
  $('viewerTitle').textContent = fmtTime(current.startedAt);
  $('viewerMeta').textContent = `${rows.length}프레임 · ${(rows.length / current.fps).toFixed(1)}초 · ${current.width}×${current.height}`;
  $('seek').max = Math.max(0, rows.length - 1);
  canvas.width = current.width;
  canvas.height = current.height;
  await loadList();
  playing = true;
  $('playPause').textContent = '일시정지';
  startPlayback();
}

// ── 재생 ──────────────────────────────────────────────────────────────
async function drawFrame(i) {
  const row = rows[i];
  if (!row) return;
  const token = ++drawToken;
  const base = await createImageBitmap(row.image);
  const restored = [];
  if (deks) {
    for (let f = 0; f < row.faces.length; f++) {
      const face = row.faces[f];
      const dek = deks[face.group];
      if (!dek) continue;
      const key = `${i}/${f}`;
      if (!faceCache.has(key)) {
        const bytes = await openSealed(dek, face, `${current.id}/${row.index}/${f}`);
        faceCache.set(key, await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' })));
      }
      restored.push([face.box, faceCache.get(key)]);
    }
  }
  if (token !== drawToken) return;   // 그사이 다른 프레임을 그리기 시작했으면 버린다
  ctx.drawImage(base, 0, 0, canvas.width, canvas.height);
  for (const [box, bmp] of restored) ctx.drawImage(bmp, box.x1, box.y1, box.x2 - box.x1, box.y2 - box.y1);
  $('seek').value = i;
  $('timeLabel').textContent = `${(row.t ?? i / current.fps).toFixed(1)}초`;
}

function startPlayback() {
  stopPlayback();
  drawFrame(index);
  if (!playing || rows.length < 2) return;
  timer = setInterval(() => {
    index = (index + 1) % rows.length;
    drawFrame(index);
  }, 1000 / current.fps);
}
function stopPlayback() { clearInterval(timer); timer = null; }

$('playPause').addEventListener('click', () => {
  playing = !playing;
  $('playPause').textContent = playing ? '일시정지' : '재생';
  startPlayback();
});
$('seek').addEventListener('input', () => {
  index = Number($('seek').value);
  playing = false;
  $('playPause').textContent = '재생';
  startPlayback();
});

// ── 복원 ──────────────────────────────────────────────────────────────
function resetRestore() {
  deks = null; opener = null;
  faceCache.clear();
  $('keyInput').value = '';
  $('restoreMsg').textContent = '';
  $('blurBtn').hidden = true;
  $('viewerMode').textContent = '블러 영상';
  $('viewerMode').className = 'badge';
}

$('restoreBtn').addEventListener('click', async () => {
  const group = document.querySelector('input[name="keyGroup"]:checked').value;
  const msg = $('restoreMsg');
  msg.className = 'msg';
  msg.textContent = '키 확인 중…';
  $('restoreBtn').disabled = true;
  try {
    const privateKey = await unlock(group, $('keyInput').value);
    deks = await openChunkKeys(current.wrapped, group, privateKey);
    opener = group;
    faceCache.clear();
    $('keyInput').value = '';
    msg.className = 'msg';
    msg.textContent = '';
    $('viewerMode').textContent = `${GROUP_LABEL[group]} 복원 중`;
    $('viewerMode').className = 'badge bad';
    $('blurBtn').hidden = false;
    drawFrame(index);
  } catch (err) {
    deks = null;
    msg.className = 'msg err';
    msg.textContent = err.message || '복원에 실패했습니다.';
  } finally {
    $('restoreBtn').disabled = false;
  }
});
$('keyInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('restoreBtn').click(); });

$('blurBtn').addEventListener('click', () => { resetRestore(); drawFrame(index); });

$('deleteChunk').addEventListener('click', async () => {
  if (!current || !confirm('이 녹화를 삭제할까요? 되돌릴 수 없습니다.')) return;
  stopPlayback();
  await chunks.remove(current.id);
  current = null;
  rows = [];
  $('viewerBody').hidden = true;
  $('viewerEmpty').hidden = false;
  loadList();
});

// 다른 페이지로 나가면 복원된 얼굴을 메모리에서 지운다.
addEventListener('pagehide', () => { stopPlayback(); faceCache.clear(); deks = null; });

async function showPage() {
  const ready = await isConfigured();
  $('setupCard').hidden = ready;
  $('restoreLayout').hidden = !ready;
  if (ready) await loadList();
}
showPage().catch((err) => { $('error').textContent = err.message || String(err); });
