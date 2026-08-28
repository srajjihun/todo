// 공용 렌더러 유틸 (가장 먼저 로드)
(function () {
  'use strict';

  // HTML 이스케이프 — 사용자/구글에서 온 문자열은 반드시 이걸 거쳐 innerHTML에 넣는다
  function esc(s) {
    return String(s == null ? '' : s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  // IPC 봉투({ok,data,error}) 처리: 실패 시 toast 후 null 반환
  async function call(promise, toast) {
    let res;
    try {
      res = await promise;
    } catch (e) {
      if (toast) toast('오류: ' + (e.message || e));
      return null;
    }
    if (!res) return null;
    if (res.ok === false) {
      if (toast) toast(res.error || '오류가 발생했습니다');
      return null;
    }
    return res.ok === true ? (res.data !== undefined ? res.data : true) : res;
  }

  window.Util = { esc, call };
})();
