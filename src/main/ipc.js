'use strict';
// 렌더러 ↔ 메인 IPC. 모든 핸들러는 {ok, data?, error?} 봉투로 응답.
const { ipcMain, shell, app } = require('electron');
const path = require('path');
const auth = require('./auth');
const sync = require('./sync');
const pomodoro = require('./pomodoro');
const windowMod = require('./window');
const tray = require('./tray');

let stores = null;

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  });
}

function broadcast(channel, payload) {
  const win = windowMod.get();
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function applyAutoLaunch(enabled) {
  app.setLoginItemSettings({
    openAtLogin: !!enabled,
    path: process.execPath,
    // 개발 모드(electron .)에서는 앱 경로를 인자로 넘겨야 함
    args: app.isPackaged ? [] : [app.getAppPath()],
  });
}

function setPinnedEverywhere(pinned) {
  windowMod.setPinned(pinned);
  tray.rebuild();
  sync.pushState();
}

const SETTABLE_KEYS = new Set([
  'clientId', 'clientSecret', 'taskListId', 'syncIntervalMin', 'autoLaunch',
  'pomoFocusMin', 'pomoShortBreakMin', 'pomoLongBreakMin', 'pomoLongBreakEvery',
]);

function init(s) {
  stores = s;

  handle('settings:get', () => stores.settings.data);

  handle('settings:set', (partial) => {
    const prev = { ...stores.settings.data };
    const clean = {};
    for (const [k, v] of Object.entries(partial || {})) {
      if (SETTABLE_KEYS.has(k)) clean[k] = v;
    }
    stores.settings.update(clean);
    const next = stores.settings.data;

    if ('syncIntervalMin' in clean && prev.syncIntervalMin !== next.syncIntervalMin) {
      sync.startScheduler();
    }
    if ('autoLaunch' in clean && prev.autoLaunch !== next.autoLaunch) {
      applyAutoLaunch(next.autoLaunch);
    }
    if ('taskListId' in clean && prev.taskListId !== next.taskListId) {
      sync.onTaskListChanged();
    }
    if (['pomoFocusMin', 'pomoShortBreakMin', 'pomoLongBreakMin', 'pomoLongBreakEvery']
      .some((k) => k in clean && prev[k] !== next[k])) {
      pomodoro.onSettingsChanged();
    }
    return next;
  });

  handle('auth:login', async () => {
    await auth.login();
    sync.syncNow('post-login');
    return { loggedIn: true };
  });
  handle('auth:logout', () => { auth.logout(); sync.setStatus({ phase: 'auth-required' }); sync.pushState(); });
  handle('auth:status', () => ({ loggedIn: auth.isLoggedIn() }));

  handle('state:get', () => sync.getState());
  handle('sync:now', () => { sync.syncNow('manual'); });
  handle('sync:status', () => sync.getStatus());

  handle('events:add', (ev) => sync.addEvent(ev));
  handle('events:delete', (id) => sync.deleteEvent(id));

  handle('tasks:add', (t) => sync.addTask(t));
  handle('tasks:setCompleted', (id, completed) => sync.setTaskCompleted(id, completed));
  handle('tasks:delete', (id) => sync.deleteTask(id));
  handle('tasks:postponeOverdue', () => sync.postponeOverdue());

  handle('tasklists:list', async () => {
    const googleApi = require('./google-api');
    const res = await googleApi.listTaskLists();
    return (res.items || []).map((l) => ({ id: l.id, title: l.title }));
  });

  handle('window:setPinned', (pinned) => { setPinnedEverywhere(!!pinned); });
  handle('window:hide', () => windowMod.hide());
  handle('window:resetPosition', () => windowMod.resetPosition());

  handle('pomo:get', () => pomodoro.getState());
  handle('pomo:start', () => pomodoro.start());
  handle('pomo:pause', () => pomodoro.pause());
  handle('pomo:reset', () => pomodoro.reset());
  handle('pomo:skip', () => pomodoro.skip());

  handle('misc:openSetupGuide', () => {
    return shell.openPath(path.join(app.getAppPath(), 'SETUP.md'));
  });
  handle('shell:openExternal', (url) => {
    if (typeof url === 'string' && url.startsWith('https://')) return shell.openExternal(url);
    throw new Error('허용되지 않는 URL입니다');
  });
}

module.exports = { init, broadcast, applyAutoLaunch, setPinnedEverywhere };
