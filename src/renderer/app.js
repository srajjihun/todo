// 앱 오케스트레이션: 탭 전환, 전역 상태, 상태표시줄, 토스트, 푸시 구독
(function () {
  'use strict';

  const api = window.api;
  const D = window.DateLogic;
  const U = window.Util;

  const S = {
    view: 'calendar',
    prevView: 'calendar',
    data: { events: [], tasks: [], lastSyncAt: null, pendingCount: 0, loggedIn: false, pinned: false },
    status: null,
    settings: null,
    pomo: null,
  };

  const sections = {
    calendar: document.getElementById('view-calendar'),
    todo: document.getElementById('view-todo'),
    focus: document.getElementById('view-focus'),
    settings: document.getElementById('view-settings'),
  };
  const views = {
    calendar: window.CalendarView,
    todo: window.TodoView,
    focus: window.FocusView,
    settings: window.SettingsView,
  };

  let toastTimer = null;
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
  }

  const call = (p) => U.call(p, toast);

  async function setSettings(partial) {
    const next = await call(api.setSettings(partial));
    if (next) S.settings = next;
    return next;
  }

  const ctx = {
    api,
    D,
    U,
    call,
    toast,
    setSettings,
    getData: () => S.data,
    getSettings: () => S.settings,
    getPomo: () => S.pomo,
    setPomo: (p) => { S.pomo = p; },
    goBack: () => showView(S.prevView),
    showView,
  };

  function showView(view) {
    if (S.view !== 'settings' && view === 'settings') S.prevView = S.view;
    S.view = view;
    for (const [k, sec] of Object.entries(sections)) {
      sec.classList.toggle('hidden', k !== view);
    }
    document.querySelectorAll('.tab').forEach((t) => {
      t.classList.toggle('active', t.dataset.tab === view);
    });
    views[view].render();
  }

  function renderCurrentDataView() {
    // 데이터가 표시되는 뷰만 다시 그림 (설정 화면 입력 중 방해 금지)
    if (S.view === 'calendar' || S.view === 'todo') views[S.view].render();
  }

  function renderPin() {
    document.getElementById('btn-pin').classList.toggle('active', !!S.data.pinned);
  }

  function renderStatus() {
    const bar = document.querySelector('.statusbar');
    const el = document.getElementById('status-text');
    const st = S.status;
    bar.classList.remove('syncing');
    el.classList.remove('link');
    el.onclick = null;

    if (!st) { el.textContent = '—'; return; }
    const pendingSuffix = st.pendingCount > 0 ? ` · 대기 ${st.pendingCount}건` : '';

    if (st.phase === 'syncing') {
      bar.classList.add('syncing');
      el.textContent = '동기화 중…';
    } else if (st.phase === 'offline') {
      el.textContent = `오프라인${pendingSuffix}`;
    } else if (st.phase === 'auth-required') {
      el.textContent = `구글 로그인 필요 — 설정에서 연결하세요${pendingSuffix}`;
      el.classList.add('link');
      el.onclick = () => showView('settings');
    } else if (st.phase === 'error') {
      el.innerHTML = `<span class="warn">${U.esc(st.message || '동기화 오류')}</span>`;
    } else {
      const at = st.lastSyncAt ? new Date(st.lastSyncAt) : null;
      const time = at
        ? `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
        : null;
      let text = time ? `마지막 동기화 ${time}` : '동기화 대기';
      if (st.message) text += ` · ${st.message}`;
      el.textContent = text + pendingSuffix;
    }
  }

  function bindHeader() {
    document.querySelectorAll('.tab').forEach((t) => {
      t.addEventListener('click', () => showView(t.dataset.tab));
    });
    document.getElementById('btn-pin').addEventListener('click', async () => {
      const next = !S.data.pinned;
      S.data.pinned = next;
      renderPin();
      await call(api.setPinned(next));
      toast(next ? '위젯을 항상 위에 고정했습니다' : '항상 위 고정을 해제했습니다');
    });
    document.getElementById('btn-settings').addEventListener('click', () => showView('settings'));
    document.getElementById('btn-hide').addEventListener('click', () => api.hideWindow());
    document.getElementById('btn-sync').addEventListener('click', () => {
      if (!S.data.loggedIn) { showView('settings'); return; }
      call(api.syncNow());
    });
  }

  async function initData() {
    const [settings, data, status, pomo] = await Promise.all([
      call(api.getSettings()),
      call(api.getState()),
      call(api.getSyncStatus()),
      call(api.pomoGet()),
    ]);
    if (settings) S.settings = settings;
    if (data) S.data = data;
    if (status) S.status = status;
    if (pomo) S.pomo = pomo;
  }

  function subscribe() {
    api.onStateChanged((data) => {
      S.data = data;
      renderPin();
      renderCurrentDataView();
    });
    api.onSyncStatus((status) => {
      S.status = status;
      renderStatus();
    });
    api.onAuthChanged(({ loggedIn }) => {
      S.data.loggedIn = loggedIn;
      if (S.view === 'settings') views.settings.render();
      renderStatus();
    });
    api.onPomoTick((pomo) => {
      S.pomo = pomo;
      if (S.view === 'focus') views.focus.render();
    });
    api.onOpenFocusTab(() => showView('focus'));
  }

  async function main() {
    for (const [k, v] of Object.entries(views)) v.init(sections[k], ctx);
    bindHeader();
    await initData();
    subscribe();
    renderPin();
    renderStatus();
    showView('calendar');
  }

  main();
})();
