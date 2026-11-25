// 집단별 복원 키 (브라우저 WebCrypto).
//
// 라즈베리파이 버전과 같은 3개 집단:
//   외부인(external) — 등록되지 않은 얼굴
//   내부인(internal) — 등록자로 인식된 얼굴
//   전체(master)     — 모든 얼굴 (확인 중이던 얼굴은 전체 키로만 복원)
//
// 그룹마다 RSA-OAEP 키 쌍을 만든다. 공개키는 그대로 저장해 녹화할 때 쓰고(녹화하는 쪽은 복호화할 수
// 없다), 개인키는 그 그룹 비밀번호에서 PBKDF2로 만든 키로 암호화해 저장한다.
// 녹화 묶음마다 그룹별 데이터 키(AES-256-GCM)를 새로 만들고, 그 키를 해당 그룹 공개키와 전체 공개키로
// 감싸 둔다. 그래서 외부인 키로는 외부인 얼굴만, 전체 키로는 모든 얼굴을 열 수 있다.
import { keys as store } from './db.js';

export const GROUPS = ['external', 'internal', 'master'];
export const GROUP_LABEL = { external: '외부인', internal: '내부인', master: '전체' };
const RECORD_ID = 'groups';
const PBKDF2_ITERATIONS = 250000;
const RSA = { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
const text = new TextEncoder();

async function passwordKey(password, salt) {
  const base = await crypto.subtle.importKey('raw', text.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function isConfigured() {
  return !!(await store.get(RECORD_ID));
}

/** passwords: {master, internal, external} — 처음 한 번만 설정한다. */
export async function setupKeys(passwords) {
  if (await isConfigured()) throw new Error('복원 키가 이미 설정되어 있습니다.');
  const record = { id: RECORD_ID, createdAt: new Date().toISOString(), public: {}, private: {} };
  for (const group of GROUPS) {
    const pair = await crypto.subtle.generateKey(RSA, true, ['encrypt', 'decrypt']);
    record.public[group] = pair.publicKey;
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await passwordKey(passwords[group], salt), pkcs8);
    record.private[group] = { salt, iv, data };
  }
  await store.put(record);
}

export async function publicKeys() {
  return (await store.get(RECORD_ID))?.public ?? null;
}

/** 비밀번호로 그룹 개인키를 연다. 틀리면 오류. */
export async function unlock(group, password) {
  const record = await store.get(RECORD_ID);
  const sealed = record?.private?.[group];
  if (!sealed) throw new Error('복원 키가 설정되지 않았습니다.');
  let pkcs8;
  try {
    pkcs8 = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv }, await passwordKey(password, sealed.salt), sealed.data);
  } catch {
    throw new Error(`${GROUP_LABEL[group]} 키가 올바르지 않습니다.`);
  }
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
}

/** 녹화 묶음용 그룹별 데이터 키와, 각 키를 감싼 값 {데이터키그룹: {열수있는그룹: 감싼키}} */
export async function newChunkKeys(pub) {
  const deks = {}, wrapped = {};
  for (const group of GROUPS) {
    deks[group] = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const raw = await crypto.subtle.exportKey('raw', deks[group]);
    wrapped[group] = {};
    for (const opener of new Set([group, 'master'])) {
      wrapped[group][opener] = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub[opener], raw);
    }
  }
  return { deks, wrapped };
}

/** 개인키(opener 그룹)로 열 수 있는 데이터 키들 {데이터키그룹: CryptoKey} */
export async function openChunkKeys(wrapped, opener, privateKey) {
  const deks = {};
  for (const group of GROUPS) {
    const w = wrapped[group]?.[opener];
    if (!w) continue;
    const raw = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, w);
    deks[group] = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  }
  return deks;
}

/** aad: 이 얼굴이 어느 묶음·프레임·순서의 것인지 묶어, 다른 자리로 옮겨 붙이면 복호화가 실패하게 한다. */
export async function seal(dek, bytes, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: text.encode(aad) }, dek, bytes);
  return { iv, data };
}

export function openSealed(dek, sealed, aad) {
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv, additionalData: text.encode(aad) }, dek, sealed.data);
}
