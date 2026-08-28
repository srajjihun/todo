// 포커스 탭 — 뽀모도로 타이머 (원형 진행 링, 재생/일시정지/초기화/건너뛰기)
(function () {
  'use strict';

  const RADIUS = 90;
  const CIRC = 2 * Math.PI * RADIUS;

  let root = null;
  let ctx = null;

  const PHASE_LABEL = {
    focus: { text: '포커스', cls: 'focus-label' },
    shortBreak: { text: '휴식', cls: 'break-label' },
    longBreak: { text: '긴 휴식', cls: 'break-label' },
  };

  function init(rootEl, context) {
    root = rootEl;
    ctx = context;
    root.addEventListener('click', onClick);
  }

  function onClick(e) {
    if (e.target.closest('#pomo-toggle')) {
      const pomo = ctx.getPomo();
      if (pomo && pomo.running) ctx.call(ctx.api.pomoPause());
      else ctx.call(ctx.api.pomoStart());
      return;
    }
    if (e.target.closest('#pomo-reset')) { ctx.call(ctx.api.pomoReset()); return; }
    if (e.target.closest('#pomo-skip')) { ctx.call(ctx.api.pomoSkip()); }
  }

  function buildSkeleton() {
    root.innerHTML = `
      <div class="pomo">
        <div class="pomo-ring">
          <svg width="200" height="200" viewBox="0 0 200 200">
            <circle class="track" cx="100" cy="100" r="${RADIUS}" stroke-width="8" fill="none"/>
            <circle class="bar" cx="100" cy="100" r="${RADIUS}" stroke-width="8" fill="none"
              stroke-linecap="round" stroke-dasharray="${CIRC.toFixed(2)}" stroke-dashoffset="0"/>
          </svg>
          <div class="pomo-center">
            <div class="pomo-phase">포커스</div>
            <div class="pomo-time">25:00</div>
          </div>
        </div>
        <div class="pomo-controls">
          <button class="pomo-sub-btn" id="pomo-reset" title="처음부터">↺</button>
          <button class="pomo-main-btn" id="pomo-toggle" title="시작 / 일시정지">▶</button>
          <button class="pomo-sub-btn" id="pomo-skip" title="다음 단계로 건너뛰기">⏭</button>
        </div>
        <div class="pomo-count"></div>
      </div>`;
  }

  function render() {
    if (!root) return;
    const pomo = ctx.getPomo();
    if (!pomo) return;
    if (!root.querySelector('.pomo')) buildSkeleton();

    const label = PHASE_LABEL[pomo.phase] || PHASE_LABEL.focus;
    const phaseEl = root.querySelector('.pomo-phase');
    phaseEl.textContent = label.text;
    phaseEl.className = `pomo-phase ${label.cls}`;

    root.querySelector('.pomo-time').textContent = ctx.D.formatTimer(pomo.remainingMs);

    const frac = pomo.totalMs > 0 ? Math.max(0, Math.min(1, pomo.remainingMs / pomo.totalMs)) : 0;
    const bar = root.querySelector('.bar');
    bar.style.strokeDashoffset = String(CIRC * (1 - frac));
    bar.classList.toggle('break', pomo.phase !== 'focus');

    root.querySelector('#pomo-toggle').textContent = pomo.running ? '❚❚' : '▶';
    root.querySelector('.pomo-count').textContent = `오늘 집중 ${pomo.focusCountToday}회 완료`;
  }

  window.FocusView = { init, render };
})();
