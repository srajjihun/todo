'use strict';
// 시스템 트레이 아이콘 + 메뉴
const path = require('path');
const { Tray, Menu, nativeImage } = require('electron');

let tray = null;
let deps = null;

function create(d) {
  deps = d; // { onToggleVisibility, onSyncNow, isPinned, onSetPinned, onQuit }
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'tray.png');
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('캘린더 · 할 일 위젯');
  tray.on('click', () => deps.onToggleVisibility());
  rebuild();
  return tray;
}

function rebuild() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: '표시 / 숨기기', click: () => deps.onToggleVisibility() },
    { label: '지금 동기화', click: () => deps.onSyncNow() },
    {
      label: '최상단 고정',
      type: 'checkbox',
      checked: deps.isPinned(),
      click: (item) => deps.onSetPinned(item.checked),
    },
    { type: 'separator' },
    { label: '종료', click: () => deps.onQuit() },
  ]);
  tray.setContextMenu(menu);
}

module.exports = { create, rebuild };
