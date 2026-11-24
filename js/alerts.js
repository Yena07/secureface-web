// 비허가자 감지 판정 (라즈베리파이 버전 core/detection_alerts.py와 같은 기준).
// - 같은 얼굴이 confirmMs 동안 계속 비허가로 판정될 때만 알린다.
// - 한 사람이 화면에 있는 동안은 한 번만 알리고, 추적 번호가 바뀌어도
//   rearmMs 안에 같은 자리에서 잡히면 같은 사람으로 본다.

const overlaps = (a, b) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;

export function createAlertTracker({ confirmMs = 1000, rearmMs = 5000 } = {}) {
  const pending = new Map();   // track id -> 처음 비허가로 보인 시각
  const alerted = new Map();   // track id -> {box, last}
  return {
    /** faces: [{id, box, allowed, decided, held}] → 새로 확정된 얼굴 목록 */
    update(faces, now) {
      const seen = new Set();
      const confirmed = [];
      for (const f of faces) {
        seen.add(f.id);
        if (alerted.has(f.id)) { alerted.set(f.id, { box: f.box, last: now }); continue; }
        if (f.allowed || !f.decided) { pending.delete(f.id); continue; }   // 허가자 또는 아직 확인 중
        if ([...alerted.values()].some((a) => now - a.last <= rearmMs && overlaps(f.box, a.box))) {
          alerted.set(f.id, { box: f.box, last: now });
          pending.delete(f.id);
          continue;
        }
        if (!pending.has(f.id)) pending.set(f.id, now);
        if (!f.held && now - pending.get(f.id) >= confirmMs) {
          pending.delete(f.id);
          alerted.set(f.id, { box: f.box, last: now });
          confirmed.push(f);
        }
      }
      for (const id of [...pending.keys()]) if (!seen.has(id)) pending.delete(id);
      for (const [id, a] of [...alerted]) if (now - a.last > rearmMs) alerted.delete(id);
      return confirmed;
    },
    reset() { pending.clear(); alerted.clear(); },
  };
}
