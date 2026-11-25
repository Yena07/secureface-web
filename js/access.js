// 시간·층별 출입 판정 (화면 표시와 경고 전용, 라즈베리파이 버전 core/access_policy.py와 같은 기준).
//
// 암호화 집단은 바꾸지 않는다: 등록자로 인식된 얼굴은 출입이 거부되어도 내부인 키로 복원된다.
// 판정 순서: 미등록 → 비허가 등록 → 근무시간 외 → N층 출입금지 → 허가
//
// 관제 환경은 실제 시각 + 카메라 설치 층을 따르고, 시연 모드를 켜면 가정한 요일·시간·층을 쓴다.
import { settings as store } from './db.js';

export const FLOORS = [1, 2, 3];   // 건물 층 목록 (등록 시 이 중 허가 층을 고른다)
export const DAYS = ['월', '화', '수', '목', '금', '토', '일'];
const HHMM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export const DEFAULTS = Object.freeze({
  id: 'access', demo: false, day: 1, time: '19:00', floor: FLOORS[0], cameraFloor: FLOORS[0],
  work: { days: [0, 1, 2, 3, 4], start: '09:00', end: '18:00' },
});

export function checkWork(work) {
  const days = [...new Set(work.days)].sort();
  if (!days.length || days.some((d) => d < 0 || d > 6)) throw new Error('근무 요일을 하나 이상 선택하세요.');
  if (!HHMM.test(work.start) || !HHMM.test(work.end)) throw new Error('근무 시각을 입력하세요.');
  if (work.start >= work.end) throw new Error('근무 종료 시각은 시작 시각보다 늦어야 합니다.');
  return { days, start: work.start, end: work.end };
}

export function checkTime(time) {
  if (!HHMM.test(time)) throw new Error('시간을 입력하세요.');
  return time;
}

export async function loadSettings() {
  const saved = await store.get('access');
  return { ...structuredClone(DEFAULTS), ...(saved || {}) };
}

export const saveSettings = (s) => store.put(s);

/** 지금 판정에 쓰는 환경 {demo, day(0=월), time, floor, afterHours} */
export function effective(s, now = new Date()) {
  let day, time, floor;
  if (s.demo) ({ day, time, floor } = s);
  else {
    day = (now.getDay() + 6) % 7;   // JS는 일요일이 0
    time = now.toTimeString().slice(0, 5);
    floor = s.cameraFloor;
  }
  const afterHours = !s.work.days.includes(day) || !(s.work.start <= time && time < s.work.end);
  return { demo: s.demo, day, time, floor, afterHours };
}

/** person: 인식된 등록자 {group, floors} 또는 null(미등록). → {allowed, reason} */
export function evaluate(person, env) {
  if (!person) return { allowed: false, reason: '미등록' };
  if (person.group === '비허가') return { allowed: false, reason: '비허가 등록' };
  if (env.afterHours) return { allowed: false, reason: '근무시간 외' };
  if (person.floors && !person.floors.includes(env.floor)) return { allowed: false, reason: `${env.floor}층 출입금지` };
  return { allowed: true, reason: '' };
}

export const floorsText = (floors) => (floors?.length ? floors : FLOORS).map((f) => `${f}층`).join(', ');
