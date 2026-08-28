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

// 어떤 예외도 조용히 사라지지 않게 파일에 남긴다.
// (창을 띄우는 도중 예외가 나면 아이콘을 눌러도 아무 일도 안 일어나는 것처럼 보인다)
function logFatal(tag, err) {
  const line = new Date().toISOString() + '  !! ' + tag + ': '
    + (err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err));
  console.error(line);
  try {
    require('fs').appendFileSync(
      require('path').join(app.getPath('userData'), 'sync.log'), line + '\n');
  } catch { /* 무시 */ }
}
process.on('uncaughtException', (e) => logFatal('uncaughtException', e));
process.on('unhandledRejection', (e) => logFatal('unhandledRejection', e));

// 부팅 비콘: 이 프로세스가 main.js를 실행했다는 사실 자체를 가장 먼저 남긴다.
// (로그가 한 줄도 없으면 "실행됐는데 기록이 없다"와 "실행 자체가 안 됐다"를 구분할 수 없다)
try {
  require('fs').appendFileSync(
    require('path').join(app.getPath('userData'), 'sync.log'),
    new Date().toISOString() + '  [부팅] pid=' + process.pid + ' argv=' + process.argv.slice(1).join(' ') + '\n');
} catch (e) {
  try {
    require('fs').appendFileSync('C:\\Siraj\\todo\\boot-fallback.log',
      new Date().toISOString() + '  userData 로그 기록 실패: ' + e.message + '\n');
  } catch { /* 무시 */ }
}

const HEARTBEAT_FILE = require('path').join(app.getPath('userData'), 'heartbeat.txt');
const HEARTBEAT_STALE_MS = 45000;

// 정상 인스턴스는 15초마다 심장박동을 남긴다.
// 응답 없는 유령 인스턴스(구버전/멈춘 프로세스)가 잠금만 쥐고 있는 상황을
// 새로 뜬 프로세스가 감지해 강제로 자리를 넘겨받기 위한 장치다.
function writeHeartbeat() {
  try { require('fs').writeFileSync(HEARTBEAT_FILE, process.pid + ' ' + Date.now()); } catch { /* 무시 */ }
}
function heartbeatAgeMs() {
  try {
    const [, t] = require('fs').readFileSync(HEARTBEAT_FILE, 'utf8').trim().split(' ');
    return Date.now() - Number(t);
  } catch { return Infinity; }
}
function bootLog(msg) {
  try {
    require('fs').appendFileSync(
      require('path').join(app.getPath('userData'), 'sync.log'),
      new Date().toISOString() + '  ' + msg + '\n');
  } catch { /* 무시 */ }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  const age = heartbeatAgeMs();
  const retried = process.argv.includes('--after-takeover');
  if (age > HEARTBEAT_STALE_MS && !retried) {
    // 잠금은 쥐고 있는데 심장박동이 없다 → 유령. 같은 실행 파일의 프로세스를 정리하고 다시 뜬다.
    bootLog('!! 응답 없는 기존 인스턴스 감지(심장박동 ' +
      (age === Infinity ? '없음' : Math.round(age / 1000) + '초 전') + ') → 정리 후 재시작');
    try {
      const { execFileSync } = require('child_process');
      const me = process.pid;
      const out = execFileSync('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command',
          "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | " +
          "Where-Object { $_.ExecutablePath -eq '" + process.execPath.replace(/'/g, "''") + "' -and $_.ProcessId -ne " + me + " } | " +
          "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }"],
        { encoding: 'utf8', timeout: 15000 });
      bootLog('정리된 pid: ' + (out.trim().replace(/\s+/g, ',') || '없음'));
    } catch (e) {
      bootLog('!! 유령 정리 실패: ' + e.message);
    }
    app.relaunch({ args: process.argv.slice(1).concat(['--after-takeover']) });
    app.exit(0);
    return;
  }
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

  // 아이콘을 다시 눌렀을 때: 창이 죽어 있으면 새로 만들고, 최신 상태로 맞춘다
  app.on('second-instance', () => {
    try {
      windowMod.show();
    } catch (e) {
      logFatal('second-instance: 창 표시 실패', e);
    }
    try {
      sync.syncNow('second-instance');
    } catch (e) {
      logFatal('second-instance: 동기화 실패', e);
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    writeHeartbeat();
    setInterval(writeHeartbeat, 15000);

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
