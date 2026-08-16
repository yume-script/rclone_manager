// scan_scheduler 환경설정 탭 스크립트
// index.html/script.js(카테고리 풀페이지)와 별개로, 환경설정 > 플러그인 설정
// 탭에서만 실행됩니다. new Function('pluginId', 'container', ...)로 실행되므로
// 별도 import 없이 pluginId/container 인자만 사용합니다.

(function () {
  console.log('[scan_scheduler][settings] 환경설정 탭 로드됨 (별도 저장 설정 없음)');
  // config_schema가 비어있어 저장할 값이 없으므로 별도 동작은 없습니다.
  // 추후 겹침 판정 기준(예: 몇 분 이내를 겹침으로 볼지) 등을 설정값으로
  // 추가하게 되면 이 파일에서 입력 폼 이벤트를 처리하면 됩니다.
})();
