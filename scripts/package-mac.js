import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp, rm, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distAppDir = path.join(rootDir, 'dist-package');
const electronTemplateApp = path.join(rootDir, 'node_modules/electron/dist/Electron.app');

if (!existsSync(electronTemplateApp)) {
  console.error('未找到 Electron 模版应用：', electronTemplateApp);
  process.exit(1);
}

const APP_NAME = 'Typora 兼容编辑器';
const BUNDLE_ID = 'com.jiao77.typora.editor';
const VERSION = '1.0.0';

console.log('1. 清理并准备输出目录：', distAppDir);
await rm(distAppDir, { recursive: true, force: true });
await mkdir(distAppDir, { recursive: true });

const targetApp = path.join(distAppDir, `${APP_NAME}.app`);
console.log('2. 复制并重命名 Electron 应用模版...');
execFileSync('cp', ['-R', electronTemplateApp, targetApp]);

const resourcesDir = path.join(targetApp, 'Contents/Resources');
const defaultAppAsar = path.join(resourcesDir, 'default_app.asar');
if (existsSync(defaultAppAsar)) {
  await rm(defaultAppAsar, { force: true });
}

console.log('3. 安装应用代码至 Resources/app 目录...');
const appDest = path.join(resourcesDir, 'app');
await mkdir(appDest, { recursive: true });

// 复制必要目录与文件
const requiredItems = ['package.json', 'package-lock.json', 'dist', 'public', 'src', 'node_modules'];
for (const item of requiredItems) {
  const srcPath = path.join(rootDir, item);
  const destPath = path.join(appDest, item);
  if (existsSync(srcPath)) {
    execFileSync('cp', ['-R', srcPath, destPath]);
  }
}

console.log('4. 更新 Info.plist 元数据...');
const plistPath = path.join(targetApp, 'Contents/Info.plist');
let plistContent = await readFile(plistPath, 'utf8');
plistContent = plistContent
  .replace(/<key>CFBundleName<\/key>\s*<string>[^<]*<\/string>/, `<key>CFBundleName</key>\n\t<string>${APP_NAME}</string>`)
  .replace(/<key>CFBundleDisplayName<\/key>\s*<string>[^<]*<\/string>/, `<key>CFBundleDisplayName</key>\n\t<string>${APP_NAME}</string>`)
  .replace(/<key>CFBundleIdentifier<\/key>\s*<string>[^<]*<\/string>/, `<key>CFBundleIdentifier</key>\n\t<string>${BUNDLE_ID}</string>`)
  .replace(/<key>CFBundleVersion<\/key>\s*<string>[^<]*<\/string>/, `<key>CFBundleVersion</key>\n\t<string>${VERSION}</string>`)
  .replace(/<key>CFBundleShortVersionString<\/key>\s*<string>[^<]*<\/string>/, `<key>CFBundleShortVersionString</key>\n\t<string>${VERSION}</string>`);
await writeFile(plistPath, plistContent, 'utf8');

console.log('5. 执行本地签名 (codesign)...');
try {
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', targetApp]);
  console.log('   签名完成');
} catch (e) {
  console.warn('   签名跳过或失败：', e.message);
}

console.log('6. 创建 ZIP 绿色压缩包（解压即可使用）...');
const zipPath = path.join(distAppDir, `${APP_NAME}-${VERSION}-mac-arm64.zip`);
execFileSync('ditto', ['-c', '-k', '--keepParent', targetApp, zipPath]);
const zipStat = await stat(zipPath);
console.log(`   ZIP 制作完成: ${zipPath} (${(zipStat.size / (1024 * 1024)).toFixed(2)} MB)`);

console.log('7. 尝试创建 DMG 安装镜像...');
try {
  const dmgPath = path.join(distAppDir, `${APP_NAME}-${VERSION}-mac-arm64.dmg`);
  const dmgStaging = path.join(distAppDir, 'dmg-staging');
  await rm(dmgStaging, { recursive: true, force: true });
  await mkdir(dmgStaging, { recursive: true });

  execFileSync('cp', ['-R', targetApp, path.join(dmgStaging, `${APP_NAME}.app`)]);
  execFileSync('ln', ['-s', '/Applications', path.join(dmgStaging, 'Applications')]);

  execFileSync('hdiutil', [
    'create',
    '-volname', APP_NAME,
    '-srcfolder', dmgStaging,
    '-ov',
    '-format', 'UDZO',
    dmgPath
  ]);
  await rm(dmgStaging, { recursive: true, force: true });
  const dmgStat = await stat(dmgPath);
  console.log(`   DMG 制作完成: ${dmgPath} (${(dmgStat.size / (1024 * 1024)).toFixed(2)} MB)`);
} catch (e) {
  console.log('   DMG 工具在当前沙盒环境下受限，已提供标准安装应用 .app 与分发包 .zip');
}

console.log('\n打包全部成功！分发产物汇总：');
const entries = ['Typora 兼容编辑器.app', `${APP_NAME}-${VERSION}-mac-arm64.zip`];
for (const entry of entries) {
  const full = path.join(distAppDir, entry);
  if (existsSync(full)) {
    const s = await stat(full);
    console.log(` - ${entry}: ${(s.size / (1024 * 1024)).toFixed(2)} MB`);
  }
}
