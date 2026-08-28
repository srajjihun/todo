// 할 일 탭 — 간결한 리스트: "+ 할일 추가" 입력, 마감일 그룹(기한 초과/오늘/마감일 없음/완료), 우측 마감 라벨
(function () {
  'use strict';

  let root = null;
  let ctx = null;
  const state = {
    dateMode: false,   // false = 전체(그룹) 보기, true = 특정 날짜 보기
    viewDate: null,    // dateMode일 때 보는 날짜
    collapsed: new Set(['completed']),
    confirmDelId: null,
    confirmTimer: null,
  };

  const GROUPS = [
    { key: 'overdue', name: '기한 초과', cls: 'overdue' },
    { key: 'today', name: '오늘', cls: '' },
    { key: 'someday', name: '마감일 없음', cls: '' },
    { key: 'completed', name: '완료', cls: '' },
  ];

  function init(rootEl, context) {
    root = rootEl;
    ctx = context;
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('submit', onSubmit);
  }

  function onClick(e) {
    if (e.target.closest('.td-prev')) { shiftDate(-1); return; }
    if (e.target.closest('.td-next')) { shiftDate(1); return; }
    if (e.target.closest('.td-today')) { state.viewDate = ctx.D.todayStr(); render(); return; }
    if (e.target.closest('.td-mode')) {
      state.dateMode = !state.dateMode;
      if (state.dateMode && !state.viewDate) state.viewDate = ctx.D.todayStr();
      render();
      return;
    }
    const action = e.target.closest('.grp-action');
    if (action) {
      e.stopPropagation();
      postponeOverdue();
      return;
    }
    const head = e.target.closest('.grp-head');
    if (head) {
      const key = head.dataset.grp;
      if (state.collapsed.has(key)) state.collapsed.delete(key);
      else state.collapsed.add(key);
      render();
      return;
    }
    const del = e.target.closest('.row-del');
    if (del) {
      const id = del.dataset.id;
      if (state.confirmDelId === id) {
        clearTimeout(state.confirmTimer);
        state.confirmDelId = null;
        ctx.call(ctx.api.deleteTask(id));
      } else {
        state.confirmDelId = id;
        clearTimeout(state.confirmTimer);
        state.confirmTimer = setTimeout(() => { state.confirmDelId = null; render(); }, 2000);
        render();
      }
    }
  }

  function shiftDate(delta) {
    if (!state.viewDate) state.viewDate = ctx.D.todayStr();
    state.viewDate = ctx.D.addDays(state.viewDate, delta);
    if (!state.dateMode) state.dateMode = true;
    render();
  }

  function onChange(e) {
    if (e.target.matches('.chk')) {
      const row = e.target.closest('.task-row');
      if (row) ctx.call(ctx.api.setTaskCompleted(row.dataset.id, e.target.checked));
    }
  }

  async function onSubmit(e) {
    if (!e.target.matches('#task-form')) return;
    e.preventDefault();
    const titleInput = root.querySelector('#task-title');
    const dueInput = root.querySelector('#task-due');
    const title = titleInput.value.trim();
    if (!title) return;
    const due = dueInput.value || null;
    titleInput.value = '';
    const res = await ctx.call(ctx.api.addTask({ title, due }));
    if (res) titleInput.focus();
  }

  async function postponeOverdue() {
    const res = await ctx.call(ctx.api.postponeOverdue());
    if (res && res.count) ctx.toast(`${res.count}건을 오늘로 연기했습니다`);
  }

  function render() {
    if (!root) return;
    const D = ctx.D;
    const esc = ctx.U.esc;
    const data = ctx.getData();
    const today = D.todayStr();
    const groups = D.groupTasks(data.tasks || [], today);

    // 입력 중이던 내용 보존 (백그라운드 동기화로 다시 그려질 때)
    const prevTitle = root.querySelector('#task-title');
    const prevDue = root.querySelector('#task-due');
    const keepTitle = prevTitle ? prevTitle.value : '';
    const keepDue = prevDue ? prevDue.value : '';
    const hadFocus = prevTitle && document.activeElement === prevTitle;

    // 날짜 보기: 그 날짜가 마감인 항목만 (미완료 먼저, 완료 아래)
    const viewDate = state.viewDate || today;
    const dayTasks = (data.tasks || [])
      .filter((t) => t.due === viewDate)
      .sort((a, b) => {
        if ((a.status === 'completed') !== (b.status === 'completed')) return a.status === 'completed' ? 1 : -1;
        return (a.position || '').localeCompare(b.position || '');
      });

    const sections = GROUPS.map((g) => {
      const items = groups[g.key];
      if (!items || items.length === 0) return '';
      const isCollapsed = state.collapsed.has(g.key);
      const action = g.key === 'overdue'
        ? '<span class="grp-action" title="기한 초과 항목을 모두 오늘로 연기">연기</span>'
        : '';
      const rows = isCollapsed ? '' : items.map((t) => taskRow(t, today)).join('');
      return `
        <button class="grp-head" data-grp="${g.key}">
          <span class="chev">${isCollapsed ? '▸' : '▾'}</span>
          <span class="grp-name ${g.cls}">${g.name}</span>
          <span class="grp-count">${items.length}</span>
          ${action}
        </button>
        ${rows}`;
    }).join('');

    const total = (data.tasks || []).length;

    // 날짜 이동 바 (‹ 날짜 ›) + 전체/날짜 보기 전환
    const dateBar = `
      <div class="td-datebar${state.dateMode ? ' on' : ''}">
        <button class="td-prev" title="이전 날">‹</button>
        <span class="td-date">${state.dateMode ? esc(D.formatKoreanDate(viewDate)) : '전체 보기'}</span>
        <button class="td-next" title="다음 날">›</button>
        ${state.dateMode && viewDate !== today ? '<button class="td-today" title="오늘로">오늘</button>' : ''}
        <button class="td-mode" title="${state.dateMode ? '전체 목록 보기' : '날짜별로 보기'}">${state.dateMode ? '전체' : '날짜'}</button>
      </div>`;

    // 날짜 모드에서는 추가 시 그 날짜를 기본 마감일로
    const dueValue = keepDue || (state.dateMode ? viewDate : '');

    const body = state.dateMode
      ? (dayTasks.length
          ? dayTasks.map((t) => taskRow(t, today)).join('')
          : '<div class="empty-hint">이 날짜에 마감인 할 일이 없습니다</div>')
      : (sections || (total === 0 ? '<div class="empty-hint">할 일이 없습니다 🎉</div>' : ''));

    root.innerHTML = `
      ${dateBar}
      <form id="task-form" class="task-add">
        <span class="plus">＋</span>
        <input type="text" id="task-title" placeholder="할일 추가" value="${esc(keepTitle)}" autocomplete="off">
        <input type="date" id="task-due" title="마감일 (선택)" value="${esc(dueValue)}">
        <!-- 숨김 submit 버튼: 필드가 2개라 Enter의 암시적 제출에 반드시 필요 -->
        <button type="submit" hidden tabindex="-1" aria-hidden="true"></button>
      </form>
      ${body}`;

    if (hadFocus) {
      const t = root.querySelector('#task-title');
      if (t) {
        t.focus();
        t.setSelectionRange(t.value.length, t.value.length);
      }
    }
  }

  function taskRow(t, today) {
    const esc = ctx.U.esc;
    const done = t.status === 'completed';
    const confirm = state.confirmDelId === t.id;
    const label = done ? null : ctx.D.dueLabel(t.due, today);
    const dueHtml = label ? `<span class="t-due ${label.cls}">${esc(label.text)}</span>` : '';
    return `<div class="task-row${done ? ' done' : ''}" data-id="${esc(t.id)}">
      <input type="checkbox" class="chk" ${done ? 'checked' : ''} title="${done ? '미완료로 표시' : '완료'}">
      <span class="t-title" title="${esc(t.title)}">${esc(t.title)}</span>
      ${dueHtml}
      <button class="row-del${confirm ? ' confirm' : ''}" data-id="${esc(t.id)}">${confirm ? '삭제?' : '✕'}</button>
    </div>`;
  }

  window.TodoView = { init, render };
})();
