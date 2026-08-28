'use strict';
// 설치 파일(.exe) 없이 이미 설치된 앱의 코드만 바꿔치기한다.
// 앱 코드는 resources/app.asar 한 파일이라, Electron 본체는 그대로 두고 이것만 교체하면 된다.
// 서명 없는 설치 파일을 다시 실행할 필요가 없어 Windows SmartScreen 경고도 뜨지 않는다.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = path.join(__dirname, '..', 'dist', 'win-unpacked', 'resources', 'app.asar');
const CANDIDATES = [
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Desk Widget'),
  path.join(process.env.PROGRAMFILES || '', 'Desk Widget'),
];

function ps(cmd) {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function findInstallDir() {
  for (const dir of CANDIDATES) {
    if (dir && fs.existsSync(path.join(dir, 'resources', 'app.asar'))) return dir;
  }
  return null;
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.error('빌드 결과가 없습니다. 먼저 실행하세요:  npm run pack');
    process.exit(1);
  }
  const dir = findInstallDir();
  if (!dir) {
    console.error('설치된 앱을 찾지 못했습니다. 처음 한 번은 dist의 설치 파일로 설치해야 합니다.');
    process.exit(1);
  }

  const wasRunning = ps("(Get-Process -Name 'Desk Widget' -ErrorAction SilentlyContinue).Count") !== '0';
  if (wasRunning) {
    console.log('실행 중인 위젯을 종료합니다…');
    ps("Get-Process -Name 'Desk Widget' -ErrorAction SilentlyContinue | Stop-Process -Force");
    execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 2']);
  }

  const dest = path.join(dir, 'resources', 'app.asar');
  const backup = dest + '.bak';
  fs.copyFileSync(dest, backup);          // 문제 생기면 되돌릴 수 있게
  fs.copyFileSync(SRC, dest);
  const size = (fs.statSync(dest).size / 1024).toFixed(0);
  console.log(`갱신 완료: ${dest} (${size} KB)`);
  console.log(`이전 버전 백업: ${path.basename(backup)}`);

  const exe = path.join(dir, 'Desk Widget.exe');
  console.log('위젯을 다시 실행합니다…');
  ps(`Start-Process -FilePath '${exe.replace(/'/g, "''")}'`);
  console.log('완료. 설치 파일을 실행할 필요가 없으므로 SmartScreen 경고도 뜨지 않습니다.');
}

main();
