'use strict';
const { app, Menu } = require('electron');
const { createStores } = require('./store');
const auth = require('./auth');
const sync = require('./sync');
const pomodoro = require('./pomodoro');
const windowMod = require('./window');
const tray = require('./tray');
const ipc = require('./ipc');

app.setAppUserModelId('com.siraj.desk-widget');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let quitting = false;
  app.on('before-quit', () => { quitting = true; });

  // 창을 숨겨도(또는 닫혀도) 트레이에 상주
  app.on('window-all-closed', () => { /* 종료하지 않음 — 트레이 상주 */ });

  app.on('second-instance', () => windowMod.show());

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);

    const stores = createStores(app.getPath('userData'));
    auth.init(stores);

    const win = windowMod.create(stores.settings, { isQuitting: () => quitting });

    ipc.init(stores);

    sync.init(stores, {
      onState: (state) => ipc.broadcast('push:state-changed', state),
      onStatus: (status) => ipc.broadcast('push:sync-status', status),
    });

    pomodoro.init(stores, {
      onTick: (t) => ipc.broadcast('push:pomo-tick', t),
    });

    auth.onChange((a) => {
      ipc.broadcast('push:auth-changed', a);
      sync.pushState();
    });

    tray.create({
      onToggleVisibility: () => windowMod.toggleVisibility(),
      onSyncNow: () => sync.syncNow('manual'),
      isPinned: () => !!stores.settings.data.pinned,
      onSetPinned: (pinned) => ipc.setPinnedEverywhere(pinned),
      onQuit: () => { quitting = true; app.quit(); },
    });

    sync.startScheduler();
    if (auth.isLoggedIn()) {
      sync.syncNow('startup');
    } else {
      sync.setStatus({ phase: 'auth-required' });
    }

    // 창을 다시 표시할 때 최신 상태로
    win.on('show', () => sync.syncNow('show'));
  });
}
