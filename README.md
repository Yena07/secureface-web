# SecureFace-RX Web

라즈베리파이·AI HAT+ 없이 **노트북 브라우저만으로** 돌아가는 SecureFace-RX 웹 버전입니다.
노트북 카메라 영상에서 얼굴을 찾아 화면에 그리기 전에 블러 처리합니다.

- 모든 처리는 브라우저 안에서 합니다. 카메라 영상은 서버로 전송되지 않습니다.
- 빌드 과정이 없는 정적 사이트(HTML + JavaScript 모듈)라 Vercel에 그대로 올릴 수 있습니다.
- 얼굴 탐지: MediaPipe Face Detector (BlazeFace short-range, CPU/WASM). 카메라 가까이(약 2m 이내)의
  얼굴에 맞춘 모델이라 노트북 웹캠에 적합합니다. 모델과 실행 파일은 실행할 때 CDN에서 받아옵니다.

## 로컬에서 실행

카메라는 `https` 주소나 `localhost`에서만 쓸 수 있습니다.

```bash
python -m http.server 5173 --bind 127.0.0.1
```

브라우저에서 `http://127.0.0.1:5173` 을 엽니다. 웹캠이 없으면 **영상 파일로 테스트**를 쓰면 됩니다.

## Vercel 배포

둘 중 하나로 배포합니다. 빌드 설정은 필요 없습니다(Framework Preset: Other).

- GitHub 저장소에 올린 뒤 Vercel 대시보드에서 **Add New → Project → Import**
- 이 폴더에서 Vercel CLI 실행: `npx vercel` (처음 한 번 로그인 필요)

## 진행 단계

1. [x] 카메라 / 영상 파일 → 얼굴 탐지 → 실시간 블러 (탐지 누락 시 0.8초 동안 마지막 위치를 계속 가림)
2. [ ] 얼굴 등록·인식 (허가자 / 미등록 표시), 비허가자 경고 팝업
3. [ ] 1분 단위 녹화, 브라우저 안 AES-256-GCM 암호화 저장, 비밀번호 복원
4. [ ] 시간·층 출입 통제, 집단별 선택적 복원
