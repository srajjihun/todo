'use strict';
// 렌더러 ↔ 메인 IPC. 모든 핸들러는 {ok, data?, error?} 봉투로 응답.
const { ipcMain, shell, app } = require('electron');
const path = require('path');
const auth = require('./auth');
const sync = require('./sync');
const pomodoro = require('./pomodoro');
const windowMod = require('./window');
const miniWindow = require('./mini-window');
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

// 메인 위젯과 미니 창 양쪽에 전달 (미니 창도 타이머 갱신을 받아야 함)
function broadcast(channel, payload) {
  for (const win of [windowMod.get(), miniWindow.get()]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }
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

// 키 허용 목록 + 타입 검증 (잘못된 값이 설정/큐를 망가뜨리지 않게)
const SETTABLE_KEYS = {
  clientId: 'string',
  clientSecret: 'string',
  taskListId: 'string',
  syncIntervalMin: 'number',
  autoLaunch: 'boolean',
  pomoFocusMin: 'number',
  pomoShortBreakMin: 'number',
  pomoLongBreakMin: 'number',
  pomoLongBreakEvery: 'number',
};

function init(s) {
  stores = s;

  handle('settings:get', () => stores.settings.data);

  handle('settings:set', (partial) => {
    const prev = { ...stores.settings.data };
    const clean = {};
    for (const [k, v] of Object.entries(partial || {})) {
      if (SETTABLE_KEYS[k] && typeof v === SETTABLE_KEYS[k] && (typeof v !== 'number' || Number.isFinite(v))) {
        clean[k] = v;
      }
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
  handle('pomo:setTask', (task) => {
    if (task && typeof task.id === 'string' && typeof task.title === 'string') {
      return pomodoro.setFocusTask({ id: task.id, title: task.title.slice(0, 120) });
    }
    return pomodoro.setFocusTask(null);
  });

  handle('mini:toggle', () => {
    const open = miniWindow.toggle(stores.settings);
    broadcast('push:mini-changed', { open });
    tray.rebuild();
    return { open };
  });
  handle('mini:close', () => {
    miniWindow.close();
    broadcast('push:mini-changed', { open: false });
    tray.rebuild();
  });
  handle('mini:isOpen', () => ({ open: miniWindow.isOpen() }));
  handle('mini:setPinned', (pinned) => {
    miniWindow.setPinned(!!pinned);
    tray.rebuild();
  });

  handle('window:openFocusTab', () => {
    windowMod.show();
    broadcast('push:open-focus-tab', {});
  });

  handle('misc:openSetupGuide', () => {
    return shell.openPath(path.join(app.getAppPath(), 'SETUP.md'));
  });
}

module.exports = { init, broadcast, applyAutoLaunch, setPinnedEverywhere };
