// 포커스 탭 — 뽀모도로 타이머 (원형 진행 링, 재생/일시정지/초기화/건너뛰기)
// + 집중할 할 일 선택, 미니 창 토글
(function () {
  'use strict';

  const RADIUS = 90;
  const CIRC = 2 * Math.PI * RADIUS;

  let root = null;
  let ctx = null;
  let miniOpen = false;
  let picking = false; // 할 일 선택 목록 펼침 여부

  const BREAK_LABEL = { shortBreak: '휴식', longBreak: '긴 휴식' };

  function init(rootEl, context) {
    root = rootEl;
    ctx = context;
    root.addEventListener('click', onClick);
    ctx.api.isMiniOpen().then((r) => {
      if (r && r.ok) { miniOpen = !!r.data.open; render(); }
    });
    ctx.api.onMiniChanged(({ open }) => { miniOpen = open; render(); });
  }

  async function onClick(e) {
    if (e.target.closest('#pomo-toggle')) {
      const pomo = ctx.getPomo();
      if (pomo && pomo.running) ctx.call(ctx.api.pomoPause());
      else ctx.call(ctx.api.pomoStart());
      return;
    }
    if (e.target.closest('#pomo-reset')) { ctx.call(ctx.api.pomoReset()); return; }
    if (e.target.closest('#pomo-skip')) { ctx.call(ctx.api.pomoSkip()); return; }
    if (e.target.closest('#pomo-mini')) { ctx.call(ctx.api.toggleMini()); return; }

    if (e.target.closest('#pomo-target')) {
      picking = !picking;
      render();
      return;
    }
    const pick = e.target.closest('.pick-row');
    if (pick) {
      picking = false;
      const id = pick.dataset.id;
      if (!id) await ctx.call(ctx.api.pomoSetTask(null));
      else {
        const task = (ctx.getData().tasks || []).find((t) => t.id === id);
        if (task) await ctx.call(ctx.api.pomoSetTask({ id: task.id, title: task.title }));
      }
      const p = await ctx.call(ctx.api.pomoGet());
      if (p) ctx.setPomo(p);
      render();
    }
  }

  function buildSkeleton() {
    root.innerHTML = `
      <div class="pomo">
        <button class="pomo-target" id="pomo-target" title="집중할 할 일 선택">
          <span class="pt-text">집중</span><span class="pt-chev">▾</span>
        </button>
        <div class="pick-list hidden"></div>
        <div class="pomo-ring">
          <svg width="200" height="200" viewBox="0 0 200 200">
            <circle class="track" cx="100" cy="100" r="${RADIUS}" stroke-width="8" fill="none"/>
            <circle class="bar" cx="100" cy="100" r="${RADIUS}" stroke-width="8" fill="none"
              stroke-linecap="round" stroke-dasharray="${CIRC.toFixed(2)}" stroke-dashoffset="0"/>
          </svg>
          <div class="pomo-center">
            <div class="pomo-phase">집중</div>
            <div class="pomo-time">25:00</div>
          </div>
        </div>
        <div class="pomo-controls">
          <button class="pomo-sub-btn" id="pomo-reset" title="처음부터">↺</button>
          <button class="pomo-main-btn" id="pomo-toggle" title="시작 / 일시정지">▶</button>
          <button class="pomo-sub-btn" id="pomo-skip" title="다음 단계로 건너뛰기">⏭</button>
        </div>
        <div class="pomo-count"></div>
        <button class="btn mini-btn" id="pomo-mini">미니 창 열기</button>
      </div>`;
  }

  function render() {
    if (!root) return;
    const pomo = ctx.getPomo();
    if (!pomo) return;
    if (!root.querySelector('.pomo')) buildSkeleton();
    const esc = ctx.U.esc;

    const isBreak = pomo.phase !== 'focus';

    // 상단: 집중 대상 (휴식 중에는 단계 이름)
    const targetBtn = root.querySelector('#pomo-target');
    const targetText = isBreak ? BREAK_LABEL[pomo.phase] : (pomo.taskTitle || '집중');
    targetBtn.querySelector('.pt-text').textContent = targetText;
    targetBtn.title = isBreak ? '휴식 중입니다' : '집중할 할 일 선택';
    targetBtn.classList.toggle('has-task', !isBreak && !!pomo.taskTitle);

    // 할 일 선택 목록
    const list = root.querySelector('.pick-list');
    list.classList.toggle('hidden', !picking);
    if (picking) {
      const tasks = (ctx.getData().tasks || []).filter((t) => t.status !== 'completed');
      list.innerHTML = `
        <button class="pick-row" data-id="">— 지정 안 함 —</button>
        ${tasks.length
          ? tasks.map((t) => `<button class="pick-row${t.id === pomo.taskId ? ' on' : ''}" data-id="${esc(t.id)}">${esc(t.title)}</button>`).join('')
          : '<div class="empty-hint">할 일이 없습니다</div>'}`;
    }

    // 중앙 단계 라벨 + 시간
    const phaseEl = root.querySelector('.pomo-phase');
    phaseEl.textContent = isBreak ? BREAK_LABEL[pomo.phase] : '집중';
    phaseEl.className = 'pomo-phase ' + (isBreak ? 'break-label' : 'focus-label');
    root.querySelector('.pomo-time').textContent = ctx.D.formatTimer(pomo.remainingMs);

    const frac = pomo.totalMs > 0 ? Math.max(0, Math.min(1, pomo.remainingMs / pomo.totalMs)) : 0;
    const bar = root.querySelector('.bar');
    bar.style.strokeDashoffset = String(CIRC * (1 - frac));
    bar.classList.toggle('break', isBreak);

    root.querySelector('#pomo-toggle').textContent = pomo.running ? '❚❚' : '▶';
    root.querySelector('.pomo-count').textContent = `오늘 집중 ${pomo.focusCountToday}회 완료`;

    const miniBtn = root.querySelector('#pomo-mini');
    miniBtn.textContent = miniOpen ? '미니 창 닫기' : '미니 창 열기';
    miniBtn.classList.toggle('primary', !miniOpen);
  }

  window.FocusView = { init, render };
})();
