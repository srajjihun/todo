'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const on = (channel) => (cb) => {
  const listener = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('api', {
  // 설정
  getSettings: () => invoke('settings:get'),
  setSettings: (partial) => invoke('settings:set', partial),
  // 인증
  login: () => invoke('auth:login'),
  logout: () => invoke('auth:logout'),
  // 상태/동기화
  getState: () => invoke('state:get'),
  getSyncStatus: () => invoke('sync:status'),
  syncNow: () => invoke('sync:now'),
  // 일정
  addEvent: (ev) => invoke('events:add', ev),
  deleteEvent: (id) => invoke('events:delete', id),
  // 할 일
  addTask: (t) => invoke('tasks:add', t),
  setTaskCompleted: (id, completed) => invoke('tasks:setCompleted', id, completed),
  deleteTask: (id) => invoke('tasks:delete', id),
  postponeOverdue: () => invoke('tasks:postponeOverdue'),
  listTaskLists: () => invoke('tasklists:list'),
  // 캘린더
  listCalendars: () => invoke('calendars:list'),
  peekCalendar: (id, days) => invoke('calendars:peek', id, days),
  // 반복 할 일
  addRecurringTodo: (t) => invoke('todos:addRecurring', t),
  setTodoDone: (masterId, date, done) => invoke('todos:setDone', masterId, date, done),
  deleteRecurringTodo: (masterId) => invoke('todos:deleteRecurring', masterId),
  // 창
  setPinned: (pinned) => invoke('window:setPinned', pinned),
  hideWindow: () => invoke('window:hide'),
  resetPosition: () => invoke('window:resetPosition'),
  // 뽀모도로
  pomoGet: () => invoke('pomo:get'),
  pomoStart: () => invoke('pomo:start'),
  pomoPause: () => invoke('pomo:pause'),
  pomoReset: () => invoke('pomo:reset'),
  pomoSkip: () => invoke('pomo:skip'),
  pomoSetTask: (task) => invoke('pomo:setTask', task),
  // 포커스 미니 창
  toggleMini: () => invoke('mini:toggle'),
  closeMini: () => invoke('mini:close'),
  isMiniOpen: () => invoke('mini:isOpen'),
  setMiniPinned: (pinned) => invoke('mini:setPinned', pinned),
  openFocusTab: () => invoke('window:openFocusTab'),
  // 기타
  openSetupGuide: () => invoke('misc:openSetupGuide'),
  // 푸시 구독
  onStateChanged: on('push:state-changed'),
  onSyncStatus: on('push:sync-status'),
  onAuthChanged: on('push:auth-changed'),
  onPomoTick: on('push:pomo-tick'),
  onMiniChanged: on('push:mini-changed'),
  onOpenFocusTab: on('push:open-focus-tab'),
});
