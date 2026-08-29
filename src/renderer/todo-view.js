// 할 일 탭 — 간결한 리스트: "+ 할일 추가" 입력, 마감일 그룹(지난 일/오늘/마감일 없음/완료), 우측 마감 라벨
(function () {
  'use strict';

  let root = null;
  let ctx = null;
  const state = {
    repeatOpen: false, // 반복 할 일 추가 폼
    mode: 'all',       // 'all' 전체(그룹) | 'day' 하루 | 'week' 한 주
    viewDate: null,    // day/week 보기의 기준 날짜
    collapsed: new Set(['completed']),
    confirmDelId: null,
    confirmTimer: null,
  };

  const GROUPS = [
    { key: 'overdue', name: '지난 일', cls: 'overdue' },
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
    if (e.target.closest('#btn-repeat')) {
      state.repeatOpen = !state.repeatOpen;
      render();
      const t = root.querySelector('#rep-title');
      if (t) t.focus();
      return;
    }
    if (e.target.closest('.repeat-cancel')) { state.repeatOpen = false; render(); return; }
    if (e.target.closest('.td-prev')) { shiftDate(-1); return; }
    if (e.target.closest('.td-next')) { shiftDate(1); return; }
    if (e.target.closest('.td-today')) { state.viewDate = ctx.D.todayStr(); render(); return; }
    if (e.target.closest('.td-mode')) {
      state.mode = state.mode === 'all' ? 'day' : state.mode === 'day' ? 'week' : 'all';
      if (state.mode !== 'all' && !state.viewDate) state.viewDate = ctx.D.todayStr();
      render();
      return;
    }
    const wd = e.target.closest('.wk-day');
    if (wd) { state.viewDate = wd.dataset.date; state.mode = 'day'; render(); return; }
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
      const isOcc = del.dataset.occ === '1';
      if (state.confirmDelId === id) {
        clearTimeout(state.confirmTimer);
        state.confirmDelId = null;
        ctx.call(isOcc ? ctx.api.deleteRecurringTodo(id) : ctx.api.deleteTask(id));
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
    if (state.mode === 'all') state.mode = 'day';
    state.viewDate = ctx.D.addDays(state.viewDate, state.mode === 'week' ? delta * 7 : delta);
    render();
  }

  function onChange(e) {
    if (!e.target.matches('.chk')) return;
    const row = e.target.closest('.task-row');
    if (!row) return;
    if (row.dataset.kind === 'occ') {
      ctx.call(ctx.api.setTodoDone(row.dataset.master, row.dataset.date, e.target.checked));
    } else {
      ctx.call(ctx.api.setTaskCompleted(row.dataset.id, e.target.checked));
    }
  }

  async function onSubmit(e) {
    if (e.target.matches('#repeat-form')) {
      e.preventDefault();
      const title = root.querySelector('#rep-title').value.trim();
      const startDate = root.querySelector('#rep-start').value;
      const repeat = root.querySelector('#rep-freq').value;
      if (!title || !startDate) return;
      state.repeatOpen = false;
      render();
      const res = await ctx.call(ctx.api.addRecurringTodo({ title, startDate, repeat }));
      if (res) ctx.toast('반복 할 일을 추가했습니다');
      return;
    }
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
    // 구글 할 일(Tasks) + 전용 캘린더의 반복 할 일 발생분을 한 목록으로 합친다
    const merged = [...(data.tasks || []), ...(data.todoOccurrences || [])];
    const groups = D.groupTasks(merged, today);
    // 할 일 캘린더에서 온 항목(kind==='occ')은 지난 일로 쌓지 않는다.
    // 지나간 일정은 되돌려 할 수 있는 게 아니므로 목록만 어지럽힌다.
    groups.overdue = groups.overdue.filter((t) => t.kind !== 'occ');
    // 완료 그룹은 오늘 끝낸 것만 남긴다. 어제 것까지 쌓이면 목록이 계속 길어진다.
    // 캘린더 항목은 발생 날짜(due)로, 구글 할 일은 완료 시각으로 판단한다.
    groups.completed = groups.completed.filter((t) => (
      t.kind === 'occ' ? t.due === today : t.completedAt === today
    ));

    // 입력 중이던 내용 보존 (백그라운드 동기화로 다시 그려질 때)
    const prevTitle = root.querySelector('#task-title');
    const prevDue = root.querySelector('#task-due');
    const keepTitle = prevTitle ? prevTitle.value : '';
    const keepDue = prevDue ? prevDue.value : '';
    const hadFocus = prevTitle && document.activeElement === prevTitle;

    // 날짜 보기: 그 날짜가 마감인 항목만 (미완료 먼저, 완료 아래)
    const viewDate = state.viewDate || today;
    const weekDays = D.weekOf(viewDate);
    const dayTasks = merged
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
        ? '<span class="grp-action" title="지난 일을 모두 오늘로 옮기기">연기</span>'
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

    const total = merged.length;

    // 날짜 이동 바 (‹ 날짜 ›) + 전체/날짜 보기 전환
    const modeLabel = { all: '전체 보기', day: D.formatKoreanDate(viewDate), week: D.weekTitle(weekDays) };
    const nextMode = { all: '날짜', day: '주', week: '전체' };
    const dateBar = `
      <div class="td-datebar${state.mode !== 'all' ? ' on' : ''}">
        <button class="td-prev" title="${state.mode === 'week' ? '이전 주' : '이전 날'}">‹</button>
        <span class="td-date">${esc(modeLabel[state.mode])}</span>
        <button class="td-next" title="${state.mode === 'week' ? '다음 주' : '다음 날'}">›</button>
        ${state.mode !== 'all' && viewDate !== today ? '<button class="td-today" title="오늘로">오늘</button>' : ''}
        <button class="td-mode" title="보기 전환">${nextMode[state.mode]}</button>
      </div>`;


    // 날짜 모드에서는 추가 시 그 날짜를 기본 마감일로
    const dueValue = keepDue || (state.mode !== 'all' ? viewDate : '');

    // 주 보기: 그 주 7일을 각 날짜의 할 일과 함께 편다
    const weekList = weekDays.map((ds) => {
      const items = merged.filter((t) => t.due === ds)
        .sort((a, b) => (a.status === 'completed' ? 1 : 0) - (b.status === 'completed' ? 1 : 0));
      const d = D.parseDateStr(ds);
      const cls = ['wk-day'];
      if (ds === today) cls.push('today');
      if (d.getDay() === 0) cls.push('sun');
      if (d.getDay() === 6) cls.push('sat');
      const inner = items.length
        ? items.map((t) => `<div class="wk-ev${t.status === 'completed' ? ' done' : ''}">${t.kind === 'occ' && t.repeating ? '<span class="t-rep">↻</span>' : ''}<span class="ev-title" title="${esc(t.title)}">${esc(t.title)}</span></div>`).join('')
        : '<div class="wk-empty">—</div>';
      return `<button class="${cls.join(' ')}" data-date="${ds}">
          <span class="wk-date">${d.getDate()}<em>${D.WEEKDAYS[d.getDay()]}</em></span>
          <span class="wk-items">${inner}</span>
        </button>`;
    }).join('');

    const body = state.mode === 'week'
      ? `<div class="wk-list">${weekList}</div>`
      : state.mode === 'day'
      ? (dayTasks.length
          ? dayTasks.map((t) => taskRow(t, today)).join('')
          : '<div class="empty-hint">이 날짜에 마감인 할 일이 없습니다</div>')
      : (sections || (total === 0 ? '<div class="empty-hint">할 일이 없습니다 🎉</div>' : ''));

    root.innerHTML = `
      ${dateBar}
      ${state.repeatOpen ? repeatForm(esc, viewDate, today) : ''}
      <form id="task-form" class="task-add">
        <span class="plus">＋</span>
        <input type="text" id="task-title" placeholder="할일 추가" value="${esc(keepTitle)}" autocomplete="off">
        <input type="date" id="task-due" title="마감일 (선택)" value="${esc(dueValue)}">
        <!-- 숨김 submit 버튼: 필드가 2개라 Enter의 암시적 제출에 반드시 필요 -->
        <button type="submit" hidden tabindex="-1" aria-hidden="true"></button>
      </form>
      <button class="repeat-toggle" id="btn-repeat">${state.repeatOpen ? '반복 추가 닫기' : '↻ 반복 할 일 추가'}</button>
      ${body}`;

    if (hadFocus) {
      const t = root.querySelector('#task-title');
      if (t) {
        t.focus();
        t.setSelectionRange(t.value.length, t.value.length);
      }
    }
  }

  function repeatForm(esc, viewDate, today) {
    const start = state.mode !== 'all' ? viewDate : today;
    return `
      <form id="repeat-form" class="add-form">
        <input type="text" id="rep-title" placeholder="반복할 할 일 (예: 헬스)" required>
        <div class="row">
          <input type="date" id="rep-start" value="${esc(start)}" required>
          <select id="rep-freq">
            <option value="daily">매일</option>
            <option value="weekdays">평일(월~금)</option>
            <option value="every2days">격일</option>
            <option value="weekly">매주</option>
            <option value="monthly">매월</option>
          </select>
        </div>
        <div class="row actions">
          <button type="button" class="btn repeat-cancel">취소</button>
          <button type="submit" class="btn primary">추가</button>
        </div>
      </form>`;
  }

  function taskRow(t, today) {
    const esc = ctx.U.esc;
    const done = t.status === 'completed';
    const isOcc = t.kind === 'occ';
    const delId = isOcc ? t.masterId : t.id;
    const confirm = state.confirmDelId === delId;
    const label = done ? null : ctx.D.dueLabel(t.due, today);
    const dueHtml = label ? `<span class="t-due ${label.cls}">${esc(label.text)}</span>` : '';
    const badge = isOcc && t.repeating ? '<span class="t-rep" title="반복">↻</span>' : '';
    const attrs = isOcc
      ? ` data-kind="occ" data-master="${esc(t.masterId)}" data-date="${esc(t.due)}"`
      : '';
    return `<div class="task-row${done ? ' done' : ''}" data-id="${esc(t.id)}"${attrs}>
      <input type="checkbox" class="chk" ${done ? 'checked' : ''} title="${done ? '미완료로 표시' : '완료'}">
      <span class="t-title" title="${esc(t.title)}">${esc(t.title)}</span>
      ${badge}
      ${dueHtml}
      <button class="row-del${confirm ? ' confirm' : ''}" data-id="${esc(delId)}" data-occ="${isOcc ? '1' : ''}">${confirm ? (isOcc ? '반복 전체 삭제?' : '삭제?') : '✕'}</button>
    </div>`;
  }

  window.TodoView = { init, render };
})();
