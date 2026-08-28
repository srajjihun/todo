'use strict';
const { app, Menu } = require('electron');
const { createStores } = require('./store');
const auth = require('./auth');
const sync = require('./sync');
const pomodoro = require('./pomodoro');
const windowMod = require('./window');
const miniWindow = require('./mini-window');
const tray = require('./tray');
const ipc = require('./ipc');

// Windows 토스트 알림은 셸에 등록된 AppUserModelId가 필요 — 개발 실행(electron .)에서는
// 커스텀 AUMID가 등록돼 있지 않아 알림이 조용히 사라지므로 실행 파일 경로를 쓴다
app.setAppUserModelId(app.isPackaged ? 'com.siraj.desk-widget' : process.execPath);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 이미 실행 중이라 이 프로세스는 종료된다. 아무 흔적이 없으면
  // "실행했는데 반응이 없다"는 상황을 나중에 확인할 수 없으므로 로그를 남긴다.
  try {
    const fsx = require('fs');
    const px = require('path');
    fsx.appendFileSync(px.join(app.getPath('userData'), 'sync.log'),
      new Date().toISOString() + '  실행 시도 — 이미 다른 창이 떠 있어 기존 창을 사용합니다' + '\n');
  } catch { /* 무시 */ }
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

    // 동기화 주기 선택지가 분 단위(1~30)에서 시간 단위(3/6/12시간)로 바뀌어,
    // 예전에 저장된 값은 가장 짧은 새 주기로 옮긴다
    const ALLOWED_INTERVALS = [180, 360, 720];
    if (!ALLOWED_INTERVALS.includes(Number(stores.settings.data.syncIntervalMin))) {
      stores.settings.update({ syncIntervalMin: 180 });
    }

    auth.init(stores);

    const win = windowMod.create(stores.settings, {
      isQuitting: () => quitting,
      onSessionEnd: () => { quitting = true; }, // OS 종료/로그오프가 close에 막히지 않게
    });

    ipc.init(stores);

    sync.init(stores, {
      onState: (state) => ipc.broadcast('push:state-changed', state),
      onStatus: (status) => ipc.broadcast('push:sync-status', status),
    }, { userDataDir: app.getPath('userData') });

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
      isMiniOpen: () => miniWindow.isOpen(),
      onToggleMini: () => {
        const open = miniWindow.toggle(stores.settings);
        ipc.broadcast('push:mini-changed', { open });
        tray.rebuild();
      },
      isMiniPinned: () => !!stores.settings.data.miniPinned,
      onSetMiniPinned: (pinned) => { miniWindow.setPinned(pinned); tray.rebuild(); },
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
