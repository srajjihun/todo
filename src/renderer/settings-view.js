// 설정 화면 — 구글 연동(자격증명/로그인/할 일 목록), 동기화 주기, 뽀모도로 시간, 일반
(function () {
  'use strict';

  let root = null;
  let ctx = null;
  let lists = null; // 가져온 할 일 목록 캐시
  let loggingIn = false;

  function init(rootEl, context) {
    root = rootEl;
    ctx = context;
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
  }

  function onClick(e) {
    if (e.target.closest('#btn-back')) { ctx.goBack(); return; }
    if (e.target.closest('#btn-guide')) { ctx.call(ctx.api.openSetupGuide()); return; }
    if (e.target.closest('#btn-save-cred')) { saveCredentials(); return; }
    if (e.target.closest('#btn-login')) { doLogin(); return; }
    if (e.target.closest('#btn-logout')) { doLogout(); return; }
    if (e.target.closest('#btn-reset-pos')) {
      ctx.call(ctx.api.resetPosition());
      ctx.toast('위치를 우측 하단으로 되돌렸습니다');
      return;
    }
    if (e.target.closest('#btn-refresh-lists')) { lists = null; render(); }
  }

  async function onChange(e) {
    const t = e.target;
    if (t.matches('#sel-tasklist')) {
      await ctx.setSettings({ taskListId: t.value });
      ctx.toast('할 일 목록을 변경했습니다');
    } else if (t.matches('#sel-interval')) {
      await ctx.setSettings({ syncIntervalMin: Number(t.value) });
    } else if (t.matches('#chk-autolaunch')) {
      await ctx.setSettings({ autoLaunch: t.checked });
      ctx.toast(t.checked ? 'Windows 시작 시 자동 실행합니다' : '자동 실행을 껐습니다');
    } else if (t.matches('.pomo-num')) {
      const min = Number(t.min) || 1;
      const max = Number(t.max) || 180;
      const v = Math.max(min, Math.min(max, Number(t.value) || min));
      t.value = String(v); // 잘린 값을 입력창에도 반영
      await ctx.setSettings({ [t.dataset.key]: v });
    }
  }

  async function saveCredentials() {
    const clientId = root.querySelector('#in-client-id').value.trim();
    const clientSecret = root.querySelector('#in-client-secret').value.trim();
    await ctx.setSettings({ clientId, clientSecret });
    ctx.toast('저장했습니다. 이제 로그인해보세요.');
    render();
  }

  async function doLogin() {
    if (loggingIn) return;
    loggingIn = true;
    render();
    const res = await ctx.call(ctx.api.login());
    loggingIn = false;
    if (res) ctx.toast('구글 로그인 완료!');
    lists = null;
    render();
  }

  async function doLogout() {
    await ctx.call(ctx.api.logout());
    lists = null;
    ctx.toast('로그아웃했습니다');
    render();
  }

  async function fetchLists() {
    const res = await ctx.call(ctx.api.listTaskLists());
    if (res) { lists = res; render(); }
    else lists = [];
  }

  function render() {
    if (!root) return;
    const esc = ctx.U.esc;
    const s = ctx.getSettings() || {};
    const loggedIn = !!(ctx.getData() && ctx.getData().loggedIn);

    // 비동기 재렌더(목록 로드/로그인 푸시)가 입력 중인 자격증명을 지우지 않게 보존
    const prevId = root.querySelector('#in-client-id');
    const prevSecret = root.querySelector('#in-client-secret');
    const keepId = prevId ? prevId.value : null;
    const keepSecret = prevSecret ? prevSecret.value : null;
    const activeId = document.activeElement && root.contains(document.activeElement)
      ? document.activeElement.id : null;

    if (loggedIn && lists === null) {
      lists = []; // 재요청 방지
      fetchLists();
    }

    const listOptions = (lists && lists.length ? lists : [{ id: '@default', title: '기본 목록' }])
      .map((l) => `<option value="${esc(l.id)}" ${l.id === s.taskListId ? 'selected' : ''}>${esc(l.title)}</option>`)
      .join('');

    const authRow = loggedIn
      ? `<div class="set-row auth-state"><label><span class="on">●</span> 구글 계정 연결됨</label>
           <button class="btn" id="btn-logout">로그아웃</button></div>`
      : `<div class="set-row auth-state"><label><span class="off">●</span> 연결 안 됨</label>
           <button class="btn primary" id="btn-login" ${loggingIn ? 'disabled' : ''}>
             ${loggingIn ? '브라우저에서 로그인 중…' : 'Google 계정 로그인'}
           </button></div>`;

    root.innerHTML = `
      <div class="set-head"><button id="btn-back" title="뒤로">←</button><span>설정</span></div>

      <div class="set-section">
        <h3>구글 연동</h3>
        <div class="set-row"><label>클라이언트 ID</label>
          <input type="text" id="in-client-id" class="wide" value="${esc(keepId !== null ? keepId : (s.clientId || ''))}" placeholder="xxx.apps.googleusercontent.com"></div>
        <div class="set-row"><label>클라이언트 보안 비밀</label>
          <input type="password" id="in-client-secret" class="wide" value="${esc(keepSecret !== null ? keepSecret : (s.clientSecret || ''))}"></div>
        <div class="set-row">
          <button class="set-link" id="btn-guide">📖 설정 가이드 보기 (SETUP.md)</button>
          <button class="btn" id="btn-save-cred" style="margin-left:auto">저장</button>
        </div>
        ${authRow}
        ${loggedIn ? `<div class="set-row"><label>할 일 목록</label>
          <select id="sel-tasklist">${listOptions}</select>
          <button class="icon-btn" id="btn-refresh-lists" title="목록 새로고침">⟳</button></div>` : ''}
      </div>

      <div class="set-section">
        <h3>동기화</h3>
        <div class="set-row"><label>자동 동기화 주기</label>
          <select id="sel-interval">
            ${[[180, '3시간'], [360, '6시간'], [720, '12시간']]
              .map(([m, t]) => `<option value="${m}" ${Number(s.syncIntervalMin) === m ? 'selected' : ''}>${t}</option>`).join('')}
          </select></div>
        <p class="set-note">위젯을 열 때와 ⟳ 버튼을 누를 때는 주기와 상관없이 바로 동기화됩니다.</p>
      </div>

      <div class="set-section">
        <h3>뽀모도로</h3>
        <div class="set-row"><label>집중 시간</label>
          <input type="number" class="pomo-num" data-key="pomoFocusMin" min="1" max="180" value="${Number(s.pomoFocusMin) || 25}"> <span>분</span></div>
        <div class="set-row"><label>짧은 휴식</label>
          <input type="number" class="pomo-num" data-key="pomoShortBreakMin" min="1" max="180" value="${Number(s.pomoShortBreakMin) || 5}"> <span>분</span></div>
        <div class="set-row"><label>긴 휴식</label>
          <input type="number" class="pomo-num" data-key="pomoLongBreakMin" min="1" max="180" value="${Number(s.pomoLongBreakMin) || 15}"> <span>분</span></div>
        <div class="set-row"><label>긴 휴식 간격</label>
          <input type="number" class="pomo-num" data-key="pomoLongBreakEvery" min="1" max="12" value="${Number(s.pomoLongBreakEvery) || 4}"> <span>회마다</span></div>
      </div>

      <div class="set-section">
        <h3>일반</h3>
        <div class="set-row"><label>Windows 시작 시 자동 실행</label>
          <input type="checkbox" id="chk-autolaunch" ${s.autoLaunch ? 'checked' : ''}></div>
        <div class="set-row"><label>위젯 위치</label>
          <button class="btn" id="btn-reset-pos">우측 하단으로 초기화</button></div>
      </div>`;

    if (activeId) {
      const el = root.querySelector('#' + activeId);
      if (el) {
        el.focus();
        if (typeof el.setSelectionRange === 'function' && (el.type === 'text' || el.type === 'password')) {
          try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* 무시 */ }
        }
      }
    }
  }

  window.SettingsView = { init, render };
})();
