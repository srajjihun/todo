// 포커스 미니 창 로직
(function () {
  'use strict';

  const api = window.api;
  const D = window.DateLogic;
  const RADIUS = 25;
  const CIRC = 2 * Math.PI * RADIUS;

  const els = {
    card: document.querySelector('.card'),
    ring: document.getElementById('toggle'),
    bar: document.querySelector('.bar'),
    glyph: document.getElementById('glyph'),
    label: document.getElementById('label'),
    time: document.getElementById('time'),
    pin: document.getElementById('pin'),
    close: document.getElementById('close'),
  };

  let pomo = null;

  els.bar.setAttribute('stroke-dasharray', CIRC.toFixed(2));

  function render() {
    if (!pomo) return;
    const isBreak = pomo.phase !== 'focus';
    els.ring.classList.toggle('break', isBreak);

    els.label.textContent = pomo.label || '집중';
    els.label.title = pomo.label || '집중';
    els.time.textContent = D.formatTimer(pomo.remainingMs);

    const frac = pomo.totalMs > 0 ? Math.max(0, Math.min(1, pomo.remainingMs / pomo.totalMs)) : 0;
    els.bar.style.strokeDashoffset = String(CIRC * (1 - frac));

    els.glyph.className = 'glyph ' + (pomo.running ? 'pause' : 'play');
  }

  els.ring.addEventListener('click', async () => {
    if (pomo && pomo.running) await api.pomoPause();
    else await api.pomoStart();
  });

  // 라벨을 누르면 메인 위젯의 포커스 탭을 연다
  els.label.parentElement.addEventListener('click', () => api.openFocusTab());

  els.pin.addEventListener('click', async () => {
    const s = await api.getSettings();
    const next = !(s && s.data && s.data.miniPinned);
    await api.setMiniPinned(next);
    els.pin.classList.toggle('active', next);
  });

  els.close.addEventListener('click', () => api.closeMini());

  async function main() {
    const s = await api.getSettings();
    if (s && s.data) els.pin.classList.toggle('active', !!s.data.miniPinned);
    const p = await api.pomoGet();
    if (p && p.data) { pomo = p.data; render(); }
    api.onPomoTick((next) => { pomo = next; render(); });
  }

  main();
})();
