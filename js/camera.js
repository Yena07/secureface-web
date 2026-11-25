// 노트북 카메라 열기 (모니터·등록 화면 공용).

export async function openCamera(video) {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('카메라는 https 주소나 localhost에서만 쓸 수 있습니다.');
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
    });
  } catch (err) {
    if (err.name === 'NotAllowedError') throw new Error('카메라 권한이 거부되었습니다. 주소창의 카메라 권한을 허용해 주세요.');
    if (err.name === 'NotFoundError') throw new Error('카메라를 찾을 수 없습니다. 웹캠이 연결되어 있는지 확인해 주세요.');
    if (err.name === 'NotReadableError') throw new Error('다른 프로그램(또는 다른 탭)이 카메라를 쓰고 있습니다.');
    throw err;
  }
  video.srcObject = stream;
  await video.play();
  return () => stream.getTracks().forEach((t) => t.stop());
}
