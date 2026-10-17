import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm, mkdir, stat, readFile, mkdtemp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { computeSha256, recordArtifactInManifest, packageMac } from './package-mac.js';
import { PRODUCT_NAME } from '../src/branding.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const distAppDir = process.env.TYPORA_PACKAGE_DIR
  ? path.resolve(process.env.TYPORA_PACKAGE_DIR)
  : path.join(rootDir, 'dist-package');

export async function makeDmg() {
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

  const ARCH_LIPO_MAP = {
    arm64: 'arm64',
    x64: 'x86_64'
  };
  const expectedLipoArch = ARCH_LIPO_MAP[ARCH] || ARCH;

  let targetApp;
  if (process.env.TYPORA_APP_PATH) {
    targetApp = path.resolve(process.env.TYPORA_APP_PATH);
    if (!existsSync(targetApp)) {
      throw new Error(`显式指定的 TYPORA_APP_PATH 不存在：${targetApp}，打包终止`);
    }

    // 严格核验显式指定应用的代码签名有效性
    try {
      execFileSync('codesign', ['--verify', '--deep', '--strict', targetApp], { stdio: 'pipe' });
    } catch (err) {
      throw new Error(`显式指定应用未通过代码签名验证 (${targetApp})：${err.message}`);
    }

    // 严格核验 Info.plist 版本号匹配
    const plistPath = path.join(targetApp, 'Contents/Info.plist');
    if (!existsSync(plistPath)) {
      throw new Error(`显式指定应用缺少 Info.plist：${plistPath}`);
    }
    const plistRaw = execFileSync('plutil', ['-convert', 'json', '-o', '-', plistPath], { encoding: 'utf8' });
    const plistJson = JSON.parse(plistRaw);
    if (plistJson.CFBundleShortVersionString !== VERSION) {
      throw new Error(`显式指定应用版本号 (${plistJson.CFBundleShortVersionString}) 与项目版本号 (${VERSION}) 不一致`);
    }

    // 严格核验二进制架构匹配
    const electronBinary = path.join(targetApp, 'Contents/MacOS/Electron');
    if (!existsSync(electronBinary)) {
      throw new Error(`显式指定应用缺少二进制入口：${electronBinary}`);
    }
    const archOutput = execFileSync('lipo', ['-archs', electronBinary], { encoding: 'utf8' }).trim();
    if (!archOutput.split(/\s+/).includes(expectedLipoArch)) {
      throw new Error(`显式指定应用架构 (${archOutput}) 与当前目标架构 (${expectedLipoArch}) 不匹配`);
    }
  } else {
    targetApp = path.join(distAppDir, `${APP_NAME}.app`);
    if (!existsSync(targetApp)) {
      console.log('[package:dmg] 未检测到已构建的 .app，正在组装最新客户端...');
      const buildResult = await packageMac();
      targetApp = buildResult.targetApp;
    }
  }

  console.log(`[package:dmg] 启动制作 macOS DMG 磁盘镜像 (${ARCH})...`);
  console.log(`[package:dmg] 源应用包路径: ${targetApp}`);

  await mkdir(distAppDir, { recursive: true });
  // 使用 mkdtemp 在 distAppDir 目录下创建专属临时 staging 目录，不污染系统或外部目录
  const dmgStaging = await mkdtemp(path.join(distAppDir, 'dmg-staging-'));

  try {
    console.log('[package:dmg] 1. 准备 DMG 镜像挂载目录内容...');
    execFileSync('cp', ['-R', targetApp, path.join(dmgStaging, `${APP_NAME}.app`)]);
    execFileSync('ln', ['-s', '/Applications', path.join(dmgStaging, 'Applications')]);

    const dmgPath = path.join(distAppDir, `${APP_NAME}-${VERSION}-mac-${ARCH}.dmg`);
    await rm(dmgPath, { force: true });

    console.log('[package:dmg] 2. 调用 hdiutil 创建真实 UDZO 压缩镜像...');
    execFileSync('hdiutil', [
      'create',
      '-volname', APP_NAME,
      '-srcfolder', dmgStaging,
      '-ov',
      '-format', 'UDZO',
      dmgPath
    ], { stdio: 'inherit' });

    console.log('[package:dmg] 3. 校验 DMG 校验和与镜像结构...');
    execFileSync('hdiutil', ['verify', dmgPath], { stdio: 'inherit' });

    console.log('[package:dmg] 4. 验证 DMG 镜像格式是否为 UDZO...');
    const imageInfo = execFileSync('hdiutil', ['imageinfo', dmgPath], { encoding: 'utf8' });
    if (!imageInfo.includes('Format: UDZO')) {
      throw new Error(`DMG 镜像格式不合规，预期必须为 Format: UDZO。实际信息：\n${imageInfo}`);
    }

    const dmgStat = await stat(dmgPath);
    const dmgHash = await computeSha256(dmgPath);
    console.log(`   DMG 文件生成完成: ${dmgPath} (${(dmgStat.size / (1024 * 1024)).toFixed(2)} MB)`);

    const dmgArtifact = {
      file: path.basename(dmgPath),
      format: 'UDZO',
      mimeType: 'application/x-apple-diskimage',
      sizeBytes: dmgStat.size,
      sizeMb: Number((dmgStat.size / (1024 * 1024)).toFixed(2)),
      sha256: dmgHash
    };

    console.log('[package:dmg] 5. 将验证通过的 DMG 写入分发清单...');
    await recordArtifactInManifest(distAppDir, pkg, dmgArtifact);

    console.log('[package:dmg] 镜像制作完成！');
    return { dmgPath, dmgArtifact };
  } finally {
    // 无论成功还是失败，必经 finally 彻底清理 staging 临时目录
    await rm(dmgStaging, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await makeDmg();
  } catch (error) {
    console.error('[package:dmg] 失败:', error.message);
    process.exit(1);
  }
}
