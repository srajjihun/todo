'use strict';
// 뽀모도로(포커스) 타이머 — 창이 숨겨져도 정확하도록 메인 프로세스에서 관리.
// endsAt(절대 시각) 기반이라 렌더러 스로틀링/절전에도 어긋나지 않음.
const { Notification } = require('electron');

let settingsStore = null;
let cacheStore = null;
let onTick = () => {};

const state = {
  phase: 'focus', // 'focus' | 'shortBreak' | 'longBreak'
  running: false,
  endsAt: null,       // running일 때 종료 예정 epoch ms
  remainingMs: 0,     // 일시정지 상태의 남은 시간
  totalMs: 0,
  cycleCount: 0,      // 긴 휴식 판단용 (연속 집중 횟수)
};

let timer = null;

function init(stores, callbacks) {
  settingsStore = stores.settings;
  cacheStore = stores.cache;
  if (callbacks && callbacks.onTick) onTick = callbacks.onTick;
  resetPhase('focus');
}

function durations() {
  const s = settingsStore.data;
  return {
    focus: clampMin(s.pomoFocusMin, 25) * 60000,
    shortBreak: clampMin(s.pomoShortBreakMin, 5) * 60000,
    longBreak: clampMin(s.pomoLongBreakMin, 15) * 60000,
    longBreakEvery: Math.max(1, Number(s.pomoLongBreakEvery) || 4),
  };
}
function clampMin(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 && n <= 180 ? n : fallback;
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function focusCountToday() {
  const c = cacheStore.data;
  return c.pomoDate === todayStr() ? (c.pomoCount || 0) : 0;
}

function bumpFocusCount() {
  const today = todayStr();
  const c = cacheStore.data;
  const count = (c.pomoDate === today ? (c.pomoCount || 0) : 0) + 1;
  cacheStore.update({ pomoDate: today, pomoCount: count });
}

// 미니 창/포커스 탭에 표시할 문구: 집중 단계면 선택한 할 일 이름, 아니면 휴식 표시
function currentLabel() {
  if (state.phase === 'shortBreak') return '휴식';
  if (state.phase === 'longBreak') return '긴 휴식';
  return cacheStore.data.focusTaskTitle || '집중';
}

function getState() {
  const remainingMs = state.running ? Math.max(0, state.endsAt - Date.now()) : state.remainingMs;
  return {
    phase: state.phase,
    running: state.running,
    remainingMs,
    totalMs: state.totalMs,
    focusCountToday: focusCountToday(),
    taskId: cacheStore.data.focusTaskId || null,
    taskTitle: cacheStore.data.focusTaskTitle || null,
    label: currentLabel(),
  };
}

// 집중 대상 할 일 지정 (null이면 해제)
function setFocusTask(task) {
  cacheStore.update({
    focusTaskId: task ? task.id : null,
    focusTaskTitle: task ? task.title : null,
  });
  emit();
  return getState();
}

function emit() { onTick(getState()); }

function resetPhase(phase) {
  const d = durations();
  state.phase = phase;
  state.running = false;
  state.endsAt = null;
  state.totalMs = phase === 'focus' ? d.focus : phase === 'shortBreak' ? d.shortBreak : d.longBreak;
  state.remainingMs = state.totalMs;
  stopTimer();
}

function start() {
  if (state.running) return getState();
  if (state.remainingMs <= 0) resetPhase(state.phase);
  state.running = true;
  state.endsAt = Date.now() + state.remainingMs;
  startTimer();
  emit();
  return getState();
}

function pause() {
  if (!state.running) return getState();
  state.remainingMs = Math.max(0, state.endsAt - Date.now());
  state.running = false;
  state.endsAt = null;
  stopTimer();
  emit();
  return getState();
}

function reset() {
  resetPhase(state.phase);
  emit();
  return getState();
}

// 현재 단계를 건너뛰고 다음 단계로 (완료로 치지 않음)
function skip() {
  advance(false);
  emit();
  return getState();
}

function startTimer() {
  stopTimer();
  timer = setInterval(() => {
    if (!state.running) return;
    if (Date.now() >= state.endsAt) {
      complete();
    } else {
      emit();
    }
  }, 500);
}
function stopTimer() {
  if (timer) { clearInterval(timer); timer = null; }
}

function complete() {
  const finishedPhase = state.phase;
  if (finishedPhase === 'focus') bumpFocusCount();
  advance(finishedPhase === 'focus');

  // 다음 단계로 자동 이어가기 (설정에서 끌 수 있음)
  const s = settingsStore.data;
  const autoNext = state.phase === 'focus'
    ? s.pomoAutoStartFocus !== false
    : s.pomoAutoStartBreak !== false;

  notify(finishedPhase, autoNext);
  if (autoNext) start(); // start() 안에서 emit
  else emit();
}

function advance(countCycle) {
  const d = durations();
  if (state.phase === 'focus') {
    if (countCycle) state.cycleCount += 1;
    const useLong = countCycle && state.cycleCount % d.longBreakEvery === 0;
    resetPhase(useLong ? 'longBreak' : 'shortBreak');
  } else {
    resetPhase('focus');
  }
}

function notify(finishedPhase, autoNext) {
  if (!Notification.isSupported()) return;
  const focusDone = finishedPhase === 'focus';
  const title = cacheStore.data.focusTaskTitle;
  const nextMin = Math.round(state.totalMs / 60000); // advance() 이후라 다음 단계 길이
  const nextName = state.phase === 'focus' ? '집중' : state.phase === 'longBreak' ? '긴 휴식' : '휴식';

  const body = focusDone
    ? `${title ? `"${title}" · ` : ''}오늘 ${focusCountToday()}번째 집중을 마쳤어요. `
      + (autoNext ? `${nextMin}분 ${nextName}을 시작합니다.` : '잠시 휴식하세요.')
    : (autoNext ? `${nextMin}분 집중을 시작합니다.` : '다시 집중할 시간이에요.');

  const n = new Notification({
    title: focusDone ? '집중 완료! 🎉' : '휴식 끝!',
    body,
  });
  n.show();
}

// 설정(집중/휴식 길이) 변경 시: 실행 중이 아니면 현재 단계 길이 갱신
function onSettingsChanged() {
  if (!state.running) {
    resetPhase(state.phase);
    emit();
  }
}

module.exports = { init, getState, start, pause, reset, skip, setFocusTask, onSettingsChanged };
