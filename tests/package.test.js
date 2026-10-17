import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, rm, mkdir, symlink, readdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { computeSha256, writeManifest, recordArtifactInManifest, cleanBrokenSymlinks } from '../scripts/package-mac.js';
import { makeDmg } from '../scripts/make-dmg.js';
import {
  PRODUCT_NAME,
  BUNDLE_ID,
  ICON_PNG_NAME,
  ICON_ICNS_NAME,
  ICON_PNG_PATH,
  ICON_ICNS_PATH,
  assertBrandAssetsExist
} from '../src/branding.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('package.json 打包与镜像脚本调用链配置', async () => {
  const pkgRaw = await readFile(path.join(projectRoot, 'package.json'), 'utf8');
  const pkg = JSON.parse(pkgRaw);

  assert.ok(pkg.scripts, 'package.json 应包含 scripts 节点');
  assert.equal(pkg.scripts['package:mac'], 'npm run build && node scripts/package-mac.js');
  assert.equal(pkg.scripts['package:dmg'], 'npm run package:mac && node scripts/make-dmg.js');
  assert.equal(pkg.scripts['package'], 'npm run package:dmg');
  assert.equal(pkg.name, 'typora-compatible-editor', '保留内部包名 typora-compatible-editor');
  assert.equal(pkg.productName, 'TYPOAR', 'package.json 应包含正确的 productName 字段');
  assert.ok(pkg.description.includes('TYPOAR'), '产品描述应体现 TYPOAR 品牌');
});

test('cleanBrokenSymlinks 删除无效断链并保留有效符号链接', async () => {
  const tmpDir = path.join(projectRoot, 'work/packaging_20261016/test-symlinks');
  await mkdir(tmpDir, { recursive: true });

  const realTarget = path.join(tmpDir, 'real-target.txt');
  await writeFile(realTarget, 'real content', 'utf8');

  const validLink = path.join(tmpDir, 'valid-link');
  await symlink(realTarget, validLink);

  const brokenLink = path.join(tmpDir, 'broken-link');
  await symlink(path.join(tmpDir, 'non-existent.txt'), brokenLink);

  // 执行断链清理
  await cleanBrokenSymlinks(tmpDir);

  const remaining = await readdir(tmpDir);
  assert.ok(remaining.includes('real-target.txt'), '实体文件必须保留');
  assert.ok(remaining.includes('valid-link'), '有效符号链接必须保留');
  assert.ok(!remaining.includes('broken-link'), '目标为 ENOENT 的断链必须被清除');
  assert.equal(existsSync(validLink), true, '有效链接应当指向可访问实体');

  await rm(tmpDir, { recursive: true, force: true });
});

test('真实 plutil 工具对 Info.plist 属性增删改验证', async () => {
  const tmpDir = path.join(projectRoot, 'work/packaging_20261016/test-plist');
  await mkdir(tmpDir, { recursive: true });
  const testPlist = path.join(tmpDir, 'test_info.plist');

  const initialPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleName</key>
\t<string>Electron</string>
\t<key>CFBundleIdentifier</key>
\t<string>com.github.Electron</string>
\t<key>ElectronAsarIntegrity</key>
\t<dict/>
</dict>
</plist>`;

  await writeFile(testPlist, initialPlist, 'utf8');

  execFileSync('plutil', ['-replace', 'CFBundleName', '-string', 'Typora 兼容编辑器', testPlist]);
  execFileSync('plutil', ['-replace', 'CFBundleIdentifier', '-string', 'com.jiao77.typora.editor', testPlist]);
  execFileSync('plutil', ['-replace', 'CFBundleVersion', '-string', '1.0.0', testPlist]);

  const jsonRaw = execFileSync('plutil', ['-convert', 'json', '-o', '-', testPlist], { encoding: 'utf8' });
  const parsed = JSON.parse(jsonRaw);
  assert.ok('ElectronAsarIntegrity' in parsed);

  execFileSync('plutil', ['-remove', 'ElectronAsarIntegrity', testPlist]);
  execFileSync('plutil', ['-lint', testPlist]);

  const output = execFileSync('plutil', ['-p', testPlist], { encoding: 'utf8' });
  assert.match(output, /"CFBundleName" => "Typora 兼容编辑器"/);
  assert.match(output, /"CFBundleIdentifier" => "com.jiao77.typora.editor"/);
  assert.doesNotMatch(output, /ElectronAsarIntegrity/);

  await rm(tmpDir, { recursive: true, force: true });
});

test('SHA256 计算工具输出有效哈希校验码', async () => {
  const tmpDir = path.join(projectRoot, 'work/packaging_20261016/test-hash');
  await mkdir(tmpDir, { recursive: true });
  const testFile = path.join(tmpDir, 'dummy.bin');

  await writeFile(testFile, 'Test payload for typoar packaging validation\n', 'utf8');
  const hash = await computeSha256(testFile);

  assert.equal(typeof hash, 'string');
  assert.equal(hash.length, 64, 'SHA256 结果长度应为 64 位十六进制字符');
  assert.match(hash, /^[0-9a-f]{64}$/, 'SHA256 格式应为纯小写十六进制');

  await rm(tmpDir, { recursive: true, force: true });
});

test('分发清单维护功能与增量产物合并验证', async () => {
  const tmpDir = path.join(projectRoot, 'work/packaging_20261016/test-manifest');
  await mkdir(tmpDir, { recursive: true });

  const pkg = { name: 'test-app', version: '2.0.0' };
  const zipArtifact = {
    file: 'test-2.0.0.zip',
    format: 'ZIP',
    mimeType: 'application/zip',
    sizeBytes: 1024,
    sizeMb: 0.001,
    sha256: 'a'.repeat(64)
  };

  await writeManifest(tmpDir, pkg, [zipArtifact]);

  const manifestPath = path.join(tmpDir, 'manifest.json');
  const initialManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(initialManifest.artifacts.length, 1);
  assert.equal(initialManifest.artifacts[0].file, 'test-2.0.0.zip');

  const dmgArtifact = {
    file: 'test-2.0.0.dmg',
    format: 'UDZO',
    mimeType: 'application/x-apple-diskimage',
    sizeBytes: 2048,
    sizeMb: 0.002,
    sha256: 'b'.repeat(64)
  };

  await recordArtifactInManifest(tmpDir, pkg, dmgArtifact);
  const updatedManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(updatedManifest.artifacts.length, 2);
  assert.equal(updatedManifest.artifacts[1].format, 'UDZO');

  const sums = await readFile(path.join(tmpDir, 'SHA256SUMS.txt'), 'utf8');
  assert.match(sums, /a{64}\s+test-2\.0\.0\.zip/);
  assert.match(sums, /b{64}\s+test-2\.0\.0\.dmg/);

  await rm(tmpDir, { recursive: true, force: true });
});

test('损坏清单与架构版本不一致时拒绝静默忽略并抛出错误', async () => {
  const tmpDir = path.join(projectRoot, 'work/packaging_20261016/test-corrupt-manifest');
  await mkdir(tmpDir, { recursive: true });
  const manifestPath = path.join(tmpDir, 'manifest.json');
  const pkg = { name: 'test-app', version: '1.0.0' };
  const dummyArtifact = {
    file: 'dummy.dmg',
    format: 'UDZO',
    mimeType: 'application/x-apple-diskimage',
    sizeBytes: 100,
    sizeMb: 0.0001,
    sha256: 'c'.repeat(64)
  };

  // 场景 1：文件内容损坏（非合法 JSON）
  await writeFile(manifestPath, '{ "corrupted_json": [ incomplete', 'utf8');
  await assert.rejects(
    async () => {
      await recordArtifactInManifest(tmpDir, pkg, dummyArtifact);
    },
    /已有 manifest\.json 解析失败，内容损坏/,
    'JSON 损坏时必须抛出明确错误'
  );

  // 场景 2：缺少 artifacts 数组结构
  await writeFile(manifestPath, JSON.stringify({ version: '1.0.0', platform: process.platform, arch: process.arch }), 'utf8');
  await assert.rejects(
    async () => {
      await recordArtifactInManifest(tmpDir, pkg, dummyArtifact);
    },
    /缺少有效的 artifacts 列表/,
    '缺少 artifacts 列表时必须抛出错误'
  );

  // 场景 3：版本不匹配
  await writeFile(manifestPath, JSON.stringify({ version: '0.9.0', platform: process.platform, arch: process.arch, artifacts: [] }), 'utf8');
  await assert.rejects(
    async () => {
      await recordArtifactInManifest(tmpDir, pkg, dummyArtifact);
    },
    /版本号 \(0\.9\.0\) 与当前构建版本 \(1\.0\.0\) 不一致/,
    '构建版本不一致时必须抛出错误'
  );

  // 场景 4：架构不匹配
  const mismatchedArch = process.arch === 'arm64' ? 'x64' : 'arm64';
  await writeFile(manifestPath, JSON.stringify({ version: '1.0.0', platform: process.platform, arch: mismatchedArch, artifacts: [] }), 'utf8');
  await assert.rejects(
    async () => {
      await recordArtifactInManifest(tmpDir, pkg, dummyArtifact);
    },
    /架构.*不一致/,
    '构建架构不一致时必须抛出错误'
  );

  await rm(tmpDir, { recursive: true, force: true });
});

test('makeDmg 显式指定非法或不存在 TYPORA_APP_PATH 时 Fast-fail 报错终止', async () => {
  const originalEnv = process.env.TYPORA_APP_PATH;
  try {
    process.env.TYPORA_APP_PATH = '/path/to/non-existent-app.app';
    await assert.rejects(
      async () => {
        await makeDmg();
      },
      /显式指定的 TYPORA_APP_PATH 不存在/,
      '不存在的 TYPORA_APP_PATH 必须直接报错，不得自动 fallback'
    );
  } finally {
    if (originalEnv !== undefined) {
      process.env.TYPORA_APP_PATH = originalEnv;
    } else {
      delete process.env.TYPORA_APP_PATH;
    }
  }
});
