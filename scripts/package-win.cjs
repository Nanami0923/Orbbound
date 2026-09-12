const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { build, Platform, Arch } = require('electron-builder');
const { path7za } = require('7zip-bin');

async function main() {
  const root = path.resolve(__dirname, '..');
  const manifest = require('../electron/windows-package.json');
  const output = path.join(root, '最终交付', `Orbbound-Windows-${manifest.version}`);
  const stagingRoot = path.join(root, 'release');
  fs.mkdirSync(stagingRoot, { recursive: true });
  // A minimal desktop manifest prevents Android dependencies entering the desktop archive.
  const staging = fs.mkdtempSync(path.join(stagingRoot, 'windows-app-'));
  fs.cpSync(path.join(root, 'dist'), path.join(staging, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(staging, 'electron'));
  fs.copyFileSync(path.join(root, 'electron/main.cjs'), path.join(staging, 'electron/main.cjs'));
  fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify(manifest, null, 2));
  await build({
    projectDir: staging,
    targets: Platform.WINDOWS.createTarget('dir', Arch.x64),
    config: {
      appId: 'com.orbbound.game',
      productName: 'Orbbound',
      electronVersion: require('../package.json').devDependencies.electron,
      directories: { output },
      files: ['dist/**/*', 'electron/main.cjs', 'package.json'],
      asar: true,
      npmRebuild: false,
      electronLanguages: ['zh-CN', 'en-US'],
      win: { signAndEditExecutable: false },
    },
  });
  const gameDir = path.join(output, 'win-unpacked');
  fs.writeFileSync(path.join(gameDir, '开始游戏.txt'),
    `Orbbound Windows ${manifest.version}\r\n双击 Orbbound.exe 开始游戏，无需安装和联网。\r\n请保留整个目录。存档位于 %APPDATA%/orbbound，与旧 Windows 版共用。\r\n`);
  const archive = path.join(output, `Orbbound-Windows-${manifest.version}-x64.7z`);
  // Remove only this exact generated archive before rebuilding.
  if (path.dirname(archive) !== output) throw new Error('Invalid archive path');
  if (fs.existsSync(archive)) fs.unlinkSync(archive);
  const zip = spawnSync(path7za, ['a', '-t7z', '-mx=9', '-ms=on', archive, 'win-unpacked'], { cwd: output, stdio: 'inherit' });
  if (zip.status !== 0) throw new Error('7z packaging failed');
  const hash = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  fs.writeFileSync(`${archive}.sha256`, `${hash}  ${path.basename(archive)}\n`);
  console.log(`Game directory: ${gameDir}\nArchive: ${archive}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
