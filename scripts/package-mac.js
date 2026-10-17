import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm, mkdir, readFile, writeFile, stat, readdir, lstat, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { existsSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  PRODUCT_NAME,
  BUNDLE_ID,
  ICON_ICNS_NAME,
  ICON_ICNS_PATH,
  assertBrandAssetsExist
} from '../src/branding.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const distAppDir = process.env.TYPORA_PACKAGE_DIR
  ? path.resolve(process.env.TYPORA_PACKAGE_DIR)
  : path.join(rootDir, 'dist-package');

export async function computeSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

export async function cleanBrokenSymlinks(dirPath) {
  if (!existsSync(dirPath)) return;
  const entries = await readdir(dirPath);
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry);
    const linkStat = await lstat(entryPath);
    if (linkStat.isSymbolicLink()) {
      let targetExists = false;
      try {
        await stat(entryPath);
        targetExists = true;
      } catch (err) {
        if (err.code === 'ENOENT') {
          targetExists = false;
        } else {
          throw err;
        }
      }
      if (!targetExists) {
        await rm(entryPath);
      }
    }
  }
}

export async function writeManifest(distDir, pkg, artifacts) {
  const appName = PRODUCT_NAME;
  const manifest = {
    appName,
    version: pkg.version,
    platform: process.platform,
    arch: process.arch,
    updatedAt: new Date().toISOString(),
    artifacts
  };

  const sumsLines = artifacts.map((item) => `${item.sha256}  ${item.file}`);

  await writeFile(path.join(distDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(path.join(distDir, 'SHA256SUMS.txt'), `${sumsLines.join('\n')}\n`, 'utf8');
  return manifest;
}

export async function recordArtifactInManifest(distDir, pkg, newArtifact) {
  const manifestPath = path.join(distDir, 'manifest.json');
  let currentArtifacts = [];

  if (existsSync(manifestPath)) {
    const content = await readFile(manifestPath, 'utf8');
    let existing;
    try {
      existing = JSON.parse(content);
    } catch (err) {
      throw new Error(`已有 manifest.json 解析失败，内容损坏：${err.message}`);
    }

    if (!existing || typeof existing !== 'object' || !Array.isArray(existing.artifacts)) {
      throw new Error('已有 manifest.json 结构不合法，缺少有效的 artifacts 列表');
    }

    if (existing.version && existing.version !== pkg.version) {
      throw new Error(`已有 manifest.json 版本号 (${existing.version}) 与当前构建版本 (${pkg.version}) 不一致`);
    }

    if (existing.platform && existing.platform !== process.platform) {
      throw new Error(`已有 manifest.json 平台 (${existing.platform}) 与当前构建平台 (${process.platform}) 不一致`);
    }

    if (existing.arch && existing.arch !== process.arch) {
      throw new Error(`已有 manifest.json 架构 (${existing.arch}) 与当前构建架构 (${process.arch}) 不一致`);
    }

    currentArtifacts = existing.artifacts.filter((item) => item.file !== newArtifact.file);
  }

  currentArtifacts.push(newArtifact);
  return writeManifest(distDir, pkg, currentArtifacts);
}

export async function packageMac() {
  if (process.platform !== 'darwin') {
    throw new Error(`打包平台不支持：${process.platform}，仅支持 macOS (darwin)`);
  }

  const pkgRaw = await readFile(path.join(rootDir, 'package.json'), 'utf8');
  const pkg = JSON.parse(pkgRaw);

  if (!pkg.version || typeof pkg.version !== 'string' || !pkg.version.trim()) {
    throw new Error(`package.json 中未配置有效的 version 字段：${JSON.stringify(pkg.version)}，打包终止`);
  }

  const APP_NAME = PRODUCT_NAME;
  const VERSION = pkg.version.trim();
  const ARCH = process.arch;

  // 严格核验品牌资源完整性，若图标不存在立即终止
  assertBrandAssetsExist(rootDir);
  if (!existsSync(ICON_ICNS_PATH)) {
    throw new Error(`缺少品牌 ICNS 图标文件：${ICON_ICNS_PATH}，打包终止`);
  }

  const electronTemplateApp = path.join(rootDir, 'node_modules/electron/dist/Electron.app');
  if (!existsSync(electronTemplateApp)) {
    throw new Error(`未找到 Electron 模版应用：${electronTemplateApp}。请确保已执行 npm ci 安装 electron`);
  }

  // 严格核验 Electron 二进制架构与当前运行架构一致（Node process.arch 到 lipo 命名映射）
  const electronBinary = path.join(electronTemplateApp, 'Contents/MacOS/Electron');
  if (!existsSync(electronBinary)) {
    throw new Error(`未找到 Electron 主可执行文件：${electronBinary}`);
  }

  const ARCH_LIPO_MAP = {
    arm64: 'arm64',
    x64: 'x86_64'
  };
  const expectedLipoArch = ARCH_LIPO_MAP[ARCH] || ARCH;

  const archOutput = execFileSync('lipo', ['-archs', electronBinary], { encoding: 'utf8' }).trim();
  const binaryArchs = archOutput.split(/\s+/);
  if (!binaryArchs.includes(expectedLipoArch)) {
    throw new Error(`Electron 模版应用架构 (${archOutput}) 与当前系统架构 (${expectedLipoArch}) 不匹配，打包终止`);
  }

  console.log(`[package:mac] 启动构建 macOS 独立客户端 (${APP_NAME} v${VERSION} ${ARCH})...`);
  console.log(`[package:mac] 1. 清理本轮构建目标产物：${distAppDir}`);
  await mkdir(distAppDir, { recursive: true });

  const targetApp = path.join(distAppDir, `${APP_NAME}.app`);
  const targetZip = path.join(distAppDir, `${APP_NAME}-${VERSION}-mac-${ARCH}.zip`);
  const targetDmg = path.join(distAppDir, `${APP_NAME}-${VERSION}-mac-${ARCH}.dmg`);

  await rm(targetApp, { recursive: true, force: true });
  await rm(targetZip, { force: true });
  await rm(targetDmg, { force: true });

  console.log('[package:mac] 2. 复制 Electron 原生模版应用...');
  execFileSync('cp', ['-R', electronTemplateApp, targetApp]);

  const resourcesDir = path.join(targetApp, 'Contents/Resources');
  const defaultAppAsar = path.join(resourcesDir, 'default_app.asar');
  if (existsSync(defaultAppAsar)) {
    await rm(defaultAppAsar, { force: true });
  }

  console.log('[package:mac] 2.1 安装应用品牌图标并清理默认图标...');
  const targetIcnsPath = path.join(resourcesDir, ICON_ICNS_NAME);
  await copyFile(ICON_ICNS_PATH, targetIcnsPath);

  const oldElectronIcns = path.join(resourcesDir, 'electron.icns');
  if (existsSync(oldElectronIcns)) {
    await rm(oldElectronIcns, { force: true });
  }

  console.log('[package:mac] 3. 复制应用代码与运行依赖至 Resources/app...');
  const appDest = path.join(resourcesDir, 'app');
  await mkdir(appDest, { recursive: true });

  const requiredItems = [
    'package.json',
    'package-lock.json',
    'dist',
    'public',
    'src',
    'resources',
    'node_modules'
  ];

  for (const item of requiredItems) {
    const srcPath = path.join(rootDir, item);
    if (!existsSync(srcPath)) {
      throw new Error(`缺少必要打包目录或文件：${srcPath}，打包终止。请先执行构建并准备必要资源`);
    }
    const destPath = path.join(appDest, item);
    execFileSync('cp', ['-R', srcPath, destPath]);
  }

  // 关键操作：剔除嵌套的 node_modules/electron，避免将外层 ~300MB 的 Electron.app 二进制重复打入 app 内部
  const nestedElectronDir = path.join(appDest, 'node_modules/electron');
  if (existsSync(nestedElectronDir)) {
    console.log('[package:mac] 3.1 清理嵌套的 node_modules/electron 运行时...');
    await rm(nestedElectronDir, { recursive: true, force: true });
  }

  // 清除 node_modules/.bin 中确认为断链（目标 ENOENT）的无效符号链接，保留有效软链接，异常明确传播
  const binDir = path.join(appDest, 'node_modules/.bin');
  await cleanBrokenSymlinks(binDir);

  // 严格核查：产物不得包含任何嵌套 Electron.app
  const forbiddenNestedApp = path.join(appDest, 'node_modules/electron/dist/Electron.app');
  if (existsSync(forbiddenNestedApp)) {
    throw new Error('检测到残留的嵌套 Electron.app，违反打包标准，打包终止');
  }

  console.log('[package:mac] 4. 使用 plutil 工具配置 Info.plist 真实元数据...');
  const plistPath = path.join(targetApp, 'Contents/Info.plist');
  execFileSync('plutil', ['-replace', 'CFBundleName', '-string', APP_NAME, plistPath]);
  execFileSync('plutil', ['-replace', 'CFBundleDisplayName', '-string', APP_NAME, plistPath]);
  execFileSync('plutil', ['-replace', 'CFBundleIdentifier', '-string', BUNDLE_ID, plistPath]);
  execFileSync('plutil', ['-replace', 'CFBundleVersion', '-string', VERSION, plistPath]);
  execFileSync('plutil', ['-replace', 'CFBundleShortVersionString', '-string', VERSION, plistPath]);
  execFileSync('plutil', ['-replace', 'CFBundleIconFile', '-string', ICON_ICNS_NAME, plistPath]);

  // 先读取 plist 内容转换为 JSON 对象检查键是否存在，存在则移除，避免使用空 catch 屏蔽潜在系统错误
  const plistJsonRaw = execFileSync('plutil', ['-convert', 'json', '-o', '-', plistPath], { encoding: 'utf8' });
  const plistJson = JSON.parse(plistJsonRaw);
  if ('ElectronAsarIntegrity' in plistJson) {
    execFileSync('plutil', ['-remove', 'ElectronAsarIntegrity', plistPath]);
  }
  if ('CFBundleIconName' in plistJson) {
    execFileSync('plutil', ['-remove', 'CFBundleIconName', plistPath]);
  }

  // 语法合规性检查
  execFileSync('plutil', ['-lint', plistPath]);

  console.log('[package:mac] 5. 执行本地代码签名 (codesign)...');
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', targetApp], { stdio: 'inherit' });

  console.log('[package:mac] 5.1 验证代码签名有效性...');
  execFileSync('codesign', ['--verify', '--deep', '--strict', targetApp], { stdio: 'inherit' });
  console.log('   代码签名验证通过');

  console.log('[package:mac] 6. 生成 ZIP 格式便携分发包...');
  execFileSync('ditto', ['-c', '-k', '--keepParent', targetApp, targetZip]);

  const zipStat = await stat(targetZip);
  const zipHash = await computeSha256(targetZip);
  console.log(`   ZIP 文件生成完成: ${targetZip} (${(zipStat.size / (1024 * 1024)).toFixed(2)} MB)`);

  const zipArtifact = {
    file: path.basename(targetZip),
    format: 'ZIP',
    mimeType: 'application/zip',
    sizeBytes: zipStat.size,
    sizeMb: Number((zipStat.size / (1024 * 1024)).toFixed(2)),
    sha256: zipHash
  };

  console.log('[package:mac] 7. 写入本轮有效分发清单...');
  await writeManifest(distAppDir, pkg, [zipArtifact]);

  console.log('[package:mac] 客户端构建完成！');
  return { targetApp, zipPath: targetZip, zipArtifact };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await packageMac();
  } catch (error) {
    console.error('[package:mac] 失败:', error.message);
    process.exit(1);
  }
}
