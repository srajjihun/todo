'use strict';
// 포커스 미니 창: 메인 위젯과 독립적으로 화면 우상단에 떠 있는 작은 타이머 카드.
// 최상단 고정도 메인 위젯과 별개로 켜고 끌 수 있다.
const path = require('path');
const { pathToFileURL } = require('url');
const { BrowserWindow, screen } = require('electron');

const WIDTH = 232;
const HEIGHT = 84;
const MARGIN = 16;

let win = null;
let settingsStore = null;
let saveMoveTimer = null;

function bottomlessTopRight() {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - WIDTH - MARGIN, y: wa.y + MARGIN };
}

function isVisibleOnSomeDisplay(pos) {
  return screen.getAllDisplays().some((d) => {
    const wa = d.workArea;
    return pos.x + WIDTH - 30 > wa.x && pos.x + 30 < wa.x + wa.width
      && pos.y + 20 > wa.y && pos.y + 30 < wa.y + wa.height;
  });
}

function create(store) {
  settingsStore = store;
  if (win && !win.isDestroyed()) return win;

  win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: !!settingsStore.data.miniPinned,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, '..', 'preload.js'),
      spellcheck: false,
    },
  });

  const miniPath = path.join(__dirname, '..', 'renderer', 'mini.html');
  const miniUrl = pathToFileURL(miniPath).href;
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== miniUrl) e.preventDefault();
  });

  const saved = settingsStore.data.miniPos;
  const pos = saved && isVisibleOnSomeDisplay(saved) ? saved : bottomlessTopRight();
  win.setBounds({ x: pos.x, y: pos.y, width: WIDTH, height: HEIGHT });

  win.loadFile(miniPath);
  win.once('ready-to-show', () => {
    if (settingsStore.data.miniPinned) win.setAlwaysOnTop(true, 'screen-saver');
    win.show();
  });

  win.on('moved', () => {
    clearTimeout(saveMoveTimer);
    saveMoveTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const [x, y] = win.getPosition();
      settingsStore.update({ miniPos: { x, y } });
    }, 500);
  });

  win.on('closed', () => { win = null; });
  return win;
}

function get() { return win && !win.isDestroyed() ? win : null; }
function isOpen() { return !!get(); }

function show(store) {
  const w = create(store);
  if (w.isMinimized()) w.restore();
  w.show();
  return true;
}

function close() {
  const w = get();
  if (w) w.close();
  win = null;
}

function toggle(store) {
  if (isOpen()) { close(); return false; }
  show(store);
  return true;
}

function setPinned(pinned) {
  settingsStore.update({ miniPinned: !!pinned });
  const w = get();
  // 'screen-saver' 레벨이면 전체화면 앱 위에도 유지된다
  if (w) w.setAlwaysOnTop(!!pinned, 'screen-saver');
}

function resetPosition() {
  const w = get();
  settingsStore.update({ miniPos: null });
  if (w) {
    const p = bottomlessTopRight();
    w.setBounds({ x: p.x, y: p.y, width: WIDTH, height: HEIGHT });
  }
}

module.exports = { create, get, isOpen, show, close, toggle, setPinned, resetPosition };
