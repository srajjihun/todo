// 캘린더 탭 — Win11 달력 플라이아웃 스타일:
// 선택 날짜 헤더 → 월 타이틀(▲▼) → 요일/그리드 → 선택일 일정 목록(+ 추가 폼)
(function () {
  'use strict';

  let root = null;
  let ctx = null;
  const state = {
    year: 0,
    month: 0, // 0-based
    selected: null,
    formOpen: false,
    confirmDelId: null,
    confirmTimer: null,
  };

  function init(rootEl, context) {
    root = rootEl;
    ctx = context;
    const today = ctx.D.todayStr();
    const d = ctx.D.parseDateStr(today);
    state.year = d.getFullYear();
    state.month = d.getMonth();
    state.selected = today;

    root.addEventListener('click', onClick);
    root.addEventListener('submit', onSubmit);
    root.addEventListener('change', onChange);
  }

  function onClick(e) {
    const cell = e.target.closest('.cal-cell');
    if (cell) {
      state.selected = cell.dataset.date;
      const d = ctx.D.parseDateStr(state.selected);
      state.year = d.getFullYear();
      state.month = d.getMonth();
      render();
      return;
    }
    if (e.target.closest('.day-prev')) { selectDate(ctx.D.addDays(state.selected, -1)); return; }
    if (e.target.closest('.day-next')) { selectDate(ctx.D.addDays(state.selected, 1)); return; }
    if (e.target.closest('.nav-up')) { moveMonth(-1); return; }
    if (e.target.closest('.nav-down')) { moveMonth(1); return; }
    if (e.target.closest('.nav-today')) {
      const today = ctx.D.todayStr();
      state.selected = today;
      const d = ctx.D.parseDateStr(today);
      state.year = d.getFullYear();
      state.month = d.getMonth();
      render();
      return;
    }
    if (e.target.closest('#cal-add')) {
      state.formOpen = !state.formOpen;
      render();
      if (state.formOpen) {
        const f = root.querySelector('#event-form');
        if (f) f.scrollIntoView({ block: 'nearest' });
        const t = root.querySelector('#ev-title');
        if (t) t.focus();
      }
      return;
    }
    if (e.target.closest('.form-cancel')) {
      state.formOpen = false;
      render();
      return;
    }
    const del = e.target.closest('.row-del');
    if (del) {
      const id = del.dataset.id;
      if (state.confirmDelId === id) {
        clearTimeout(state.confirmTimer);
        state.confirmDelId = null;
        ctx.call(ctx.api.deleteEvent(id));
      } else {
        state.confirmDelId = id;
        clearTimeout(state.confirmTimer);
        state.confirmTimer = setTimeout(() => { state.confirmDelId = null; render(); }, 2000);
        render();
      }
    }
  }

  function onChange(e) {
    if (e.target.matches('#ev-allday')) {
      const times = root.querySelector('.times');
      if (times) times.classList.toggle('hidden', e.target.checked);
    }
  }

  async function onSubmit(e) {
    if (!e.target.matches('#event-form')) return;
    e.preventDefault();
    const f = e.target;
    const title = f.querySelector('#ev-title').value.trim();
    const date = f.querySelector('#ev-date').value;
    const allDay = f.querySelector('#ev-allday').checked;
    const startTime = f.querySelector('#ev-start').value;
    const endTime = f.querySelector('#ev-end').value;
    if (!title || !date) return;
    state.formOpen = false;
    state.selected = date;
    // 다른 달의 날짜로 추가했으면 그 달로 이동해 결과가 바로 보이게
    const d = ctx.D.parseDateStr(date);
    state.year = d.getFullYear();
    state.month = d.getMonth();
    const res = await ctx.call(ctx.api.addEvent({ title, date, allDay, startTime, endTime }));
    if (res) ctx.toast('일정을 추가했습니다');
    render();
  }

  // 선택 날짜를 옮기고, 달이 바뀌면 그리드도 따라간다
  function selectDate(dateStr) {
    state.selected = dateStr;
    const d = ctx.D.parseDateStr(dateStr);
    state.year = d.getFullYear();
    state.month = d.getMonth();
    render();
  }

  function moveMonth(delta) {
    const d = new Date(state.year, state.month + delta, 1);
    state.year = d.getFullYear();
    state.month = d.getMonth();
    render();
  }

  function captureFormValues() {
    if (!state.formOpen) return null;
    const f = root.querySelector('#event-form');
    if (!f) return null;
    return {
      title: f.querySelector('#ev-title').value,
      date: f.querySelector('#ev-date').value,
      allDay: f.querySelector('#ev-allday').checked,
      start: f.querySelector('#ev-start').value,
      end: f.querySelector('#ev-end').value,
    };
  }

  function render() {
    if (!root) return;
    const D = ctx.D;
    const esc = ctx.U.esc;
    const data = ctx.getData();
    const buckets = D.bucketEventsByDay(data.events || []);
    const today = D.todayStr();
    const saved = captureFormValues();

    const cells = D.buildMonthGrid(state.year, state.month).map((c) => {
      const cls = ['cal-cell'];
      if (c.otherMonth) cls.push('other');
      if (c.dateStr === today) cls.push('today');
      if (c.dateStr === state.selected) cls.push('selected');
      const dot = buckets[c.dateStr] ? '<span class="dot"></span>' : '';
      return `<button class="${cls.join(' ')}" data-date="${c.dateStr}">${c.day}${dot}</button>`;
    }).join('');

    // 백그라운드 동기화로 다시 그릴 때 폼 입력 포커스/커서 유지
    const active = document.activeElement;
    const activeId = active && root.contains(active) ? active.id : null;
    const caret = activeId && typeof active.selectionStart === 'number' ? active.selectionStart : null;

    const dayEvents = buckets[state.selected] || [];
    const rows = dayEvents.map((ev) => {
      const confirm = state.confirmDelId === ev.id;
      const time = ev.allDay
        ? '<span class="ev-time allday">종일</span>'
        : `<span class="ev-time">${esc(ev.startTime || '')}</span>`;
      return `<div class="event-row">
        ${time}
        <span class="ev-title" title="${esc(ev.title)}">${esc(ev.title)}</span>
        <button class="row-del${confirm ? ' confirm' : ''}" data-id="${esc(ev.id)}">${confirm ? '삭제?' : '✕'}</button>
      </div>`;
    }).join('') || '<div class="empty-hint">일정이 없습니다</div>';

    const defDate = saved ? saved.date : state.selected;
    const form = state.formOpen ? `
      <form id="event-form" class="add-form">
        <input type="text" id="ev-title" placeholder="일정 제목" value="${saved ? esc(saved.title) : ''}" required>
        <div class="row">
          <input type="date" id="ev-date" value="${esc(defDate)}" required>
          <label><input type="checkbox" id="ev-allday" ${saved && saved.allDay ? 'checked' : ''}>종일</label>
        </div>
        <div class="row times${saved && saved.allDay ? ' hidden' : ''}">
          <input type="time" id="ev-start" value="${saved ? esc(saved.start) : '09:00'}">
          <span>~</span>
          <input type="time" id="ev-end" value="${saved ? esc(saved.end) : '10:00'}">
        </div>
        <div class="row actions">
          <button type="button" class="btn form-cancel">취소</button>
          <button type="submit" class="btn primary">추가</button>
        </div>
      </form>` : '';

    root.innerHTML = `
      <div class="cal-selected">
        <button class="day-prev" title="이전 날">‹</button>
        <span class="cal-selected-text">${D.formatKoreanDate(state.selected)}</span>
        <button class="day-next" title="다음 날">›</button>
      </div>
      <div class="cal-nav">
        <span class="cal-title">${D.monthTitle(state.year, state.month)}</span>
        <button class="nav-today" title="오늘로 이동">오늘</button>
        <button class="nav-up" title="이전 달">▲</button>
        <button class="nav-down" title="다음 달">▼</button>
      </div>
      <div class="cal-weekdays">${D.WEEKDAYS.map((w) => `<span>${w}</span>`).join('')}</div>
      <div class="cal-grid">${cells}</div>
      <div class="day-section">
        <div class="day-head">
          <span class="label">${D.formatShortDate(state.selected)} 일정</span>
          <button id="cal-add" title="일정 추가">＋</button>
        </div>
        ${form}
        ${rows}
      </div>`;

    if (activeId) {
      const el = root.querySelector('#' + activeId);
      if (el) {
        el.focus();
        if (caret !== null && typeof el.setSelectionRange === 'function' && el.type === 'text') {
          try { el.setSelectionRange(caret, caret); } catch { /* 무시 */ }
        }
      }
    }
  }

  window.CalendarView = { init, render };
})();
