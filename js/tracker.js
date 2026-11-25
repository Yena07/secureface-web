// 얼굴 추적과 신원 판정.
//
// - 프레임마다 탐지 상자를 이전 얼굴과 겹침(IoU)으로 이어 붙여 같은 번호를 준다.
// - 탐지기가 얼굴을 잠깐 놓쳐도 holdMs 동안 마지막 위치를 유지해 계속 가린다.
// - 인식 결과는 얼굴마다 최근 3번을 모아, 같은 사람이 2번 이상 나와야 그 사람으로 본다
//   (라즈베리파이 버전의 FACE_AUTH_CONFIRM_MATCHES=2 / WINDOW=3과 같은 생각).
//   한 번 잘못 인식된 결과로 표시가 깜빡이지 않는다.

export function iou(a, b) {
  const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const inter = ix * iy;
  const union = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
  return union > 0 ? inter / union : 0;
}

/** 겹침이 작아도 크기가 비슷하고 중심이 가까우면 같은 얼굴로 본다
 *  (라즈베리파이 버전 _hold_detector_dropouts의 same_region과 같은 기준).
 *  처리 속도가 느린 노트북에서는 프레임 사이에 얼굴이 많이 움직여 겹침만으로는 이어지지 않는다. */
function sameRegion(a, b) {
  const aw = a.x2 - a.x1, ah = a.y2 - a.y1, bw = b.x2 - b.x1, bh = b.y2 - b.y1;
  if (Math.min(aw, ah, bw, bh) <= 0) return false;
  const sizeRatio = Math.min(aw * ah, bw * bh) / Math.max(aw * ah, bw * bh);
  const dx = (a.x1 + a.x2 - b.x1 - b.x2) / 2, dy = (a.y1 + a.y2 - b.y1 - b.y2) / 2;
  const radius = 0.45 * Math.max(aw, ah, bw, bh);
  return sizeRatio >= 0.4 && dx * dx + dy * dy <= radius * radius;
}

export function createTracker({ holdMs = 800, iouThreshold = 0.3 } = {}) {
  let tracks = [];
  let nextId = 1;
  return {
    update(detections, now) {
      const matched = new Set();
      for (const det of detections) {
        let best = null, bestIou = iouThreshold;
        for (const t of tracks) {
          if (matched.has(t)) continue;
          const v = iou(det, t.box);
          if (v >= bestIou) { best = t; bestIou = v; }
        }
        if (!best) best = tracks.find((t) => !matched.has(t) && sameRegion(det, t.box)) || null;
        if (best) {
          Object.assign(best, { box: det, lastSeen: now, held: false });
          matched.add(best);
        } else {
          const t = { id: nextId++, box: det, lastSeen: now, held: false, firstSeen: now,
            votes: [], lastRecogAt: 0, pending: false };
          tracks.push(t);
          matched.add(t);
        }
      }
      tracks = tracks.filter((t) => matched.has(t) || now - t.lastSeen <= holdMs);
      for (const t of tracks) if (!matched.has(t)) t.held = true;
      return tracks;
    },
    reset() { tracks = []; },
  };
}

/** 최근 인식 결과 3번으로 신원 판정. decided=false면 아직 확인 중. */
export function identityOf(track) {
  const recent = track.votes.slice(-3);
  const counts = new Map();
  for (const v of recent) if (v) counts.set(v.id, (counts.get(v.id) || 0) + 1);
  let person = null;
  for (const v of recent) if (v && counts.get(v.id) >= 2) person = v;
  return { decided: track.votes.length >= 2, person };
}
