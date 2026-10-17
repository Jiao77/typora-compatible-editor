import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, rm, readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import { getRuntimeDataDir, ensureRuntimeDataDir } from '../src/server/runtime-data.js';
import { settingsPath, loadSettings, saveSettings, ROOT_DIR } from '../src/server/config.js';
import { renderExportDom } from '../src/server/export-render.js';
import { exportPdf } from '../src/server/export.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_TMP_DIR = path.resolve(__dirname, '../work/runtime_data_20261016/test_tmp');

before(async () => {
  await rm(TEST_TMP_DIR, { recursive: true, force: true });
  await mkdir(TEST_TMP_DIR, { recursive: true });
});

after(async () => {
  await rm(TEST_TMP_DIR, { recursive: true, force: true });
});

test('默认未配置 TYPORA_DATA_DIR 时返回 projectRoot/work', () => {
  const result = getRuntimeDataDir('/mock/project', {});
  assert.equal(result, path.resolve('/mock/project/work'));
});

test('显式配置绝对路径 TYPORA_DATA_DIR 时使用该路径', () => {
  const customPath = '/custom/absolute/data';
  const result = getRuntimeDataDir('/mock/project', { TYPORA_DATA_DIR: customPath });
  assert.equal(result, path.resolve(customPath));
});

test('显式配置相对路径 TYPORA_DATA_DIR 时基于 projectRoot 解析', () => {
  const result = getRuntimeDataDir('/mock/project', { TYPORA_DATA_DIR: 'custom-data' });
  assert.equal(result, path.resolve('/mock/project/custom-data'));
});

test('显式配置空字符串或纯空白字符 TYPORA_DATA_DIR 时必须报错', () => {
  assert.throws(
    () => getRuntimeDataDir('/mock/project', { TYPORA_DATA_DIR: '' }),
    /TYPORA_DATA_DIR 不能为空/
  );
  assert.throws(
    () => getRuntimeDataDir('/mock/project', { TYPORA_DATA_DIR: '   ' }),
    /TYPORA_DATA_DIR 不能为空/
  );
});

test('projectRoot 参数无效或为空时抛出明确错误', () => {
  assert.throws(() => getRuntimeDataDir(''), /projectRoot 必须是非空字符串/);
  assert.throws(() => getRuntimeDataDir('   '), /projectRoot 必须是非空字符串/);
  assert.throws(() => getRuntimeDataDir(null), /projectRoot 必须是非空字符串/);
  assert.throws(() => getRuntimeDataDir(undefined), /projectRoot 必须是非空字符串/);
});

test('ensureRuntimeDataDir 在真实磁盘上创建目录且支持读写', async () => {
  const targetDir = path.join(TEST_TMP_DIR, 'sub_data_dir');
  const returned = await ensureRuntimeDataDir('/unused', { TYPORA_DATA_DIR: targetDir });

  assert.equal(returned, targetDir);
  assert.ok(existsSync(targetDir));

  const testFile = path.join(targetDir, 'probe.txt');
  await writeFile(testFile, 'probe-content', 'utf8');
  const readBack = await readFile(testFile, 'utf8');
  assert.equal(readBack, 'probe-content');
});

test('settingsPath 遵从 TYPORA_DATA_DIR 环境变量', () => {
  const customDataDir = path.join(TEST_TMP_DIR, 'custom_settings_dir');
  const prev = process.env.TYPORA_DATA_DIR;
  try {
    process.env.TYPORA_DATA_DIR = customDataDir;
    const computed = settingsPath();
    assert.equal(computed, path.join(customDataDir, 'settings.json'));
  } finally {
    if (prev === undefined) {
      delete process.env.TYPORA_DATA_DIR;
    } else {
      process.env.TYPORA_DATA_DIR = prev;
    }
  }
});

test('loadSettings 与 saveSettings 在独立 TYPORA_DATA_DIR 下正确持久化', async () => {
  const customDataDir = path.join(TEST_TMP_DIR, 'isolated_runtime_data');
  const prev = process.env.TYPORA_DATA_DIR;
  try {
    process.env.TYPORA_DATA_DIR = customDataDir;
    const initial = await loadSettings();
    assert.equal(initial.fontSize, 16);

    const updated = await saveSettings(ROOT_DIR, { fontSize: 24, theme: 'CustomTheme' });
    assert.equal(updated.fontSize, 24);
    assert.equal(updated.theme, 'CustomTheme');

    // 确认 settings.json 确实落入独立 TYPORA_DATA_DIR
    const targetFile = path.join(customDataDir, 'settings.json');
    assert.ok(existsSync(targetFile), 'settings.json 必须位于 TYPORA_DATA_DIR 中');

    const content = JSON.parse(await readFile(targetFile, 'utf8'));
    assert.equal(content.fontSize, 24);
    assert.equal(content.theme, 'CustomTheme');

    // 重新 loadSettings 确认读取该文件
    const reloaded = await loadSettings();
    assert.equal(reloaded.fontSize, 24);
  } finally {
    if (prev === undefined) {
      delete process.env.TYPORA_DATA_DIR;
    } else {
      process.env.TYPORA_DATA_DIR = prev;
    }
  }
});

test('空 TYPORA_DATA_DIR 时 settingsPath 明确抛出错误', () => {
  const prev = process.env.TYPORA_DATA_DIR;
  try {
    process.env.TYPORA_DATA_DIR = '';
    assert.throws(() => settingsPath(), /TYPORA_DATA_DIR 不能为空/);
  } finally {
    if (prev === undefined) {
      delete process.env.TYPORA_DATA_DIR;
    } else {
      process.env.TYPORA_DATA_DIR = prev;
    }
  }
});

test('renderExportDom 异常时传播错误并在 TYPORA_DATA_DIR/tmp 下完成清理', async () => {
  const customDataDir = path.join(TEST_TMP_DIR, 'render_fail_cleanup');
  const prev = process.env.TYPORA_DATA_DIR;
  try {
    process.env.TYPORA_DATA_DIR = customDataDir;
    const runtimeTmpDir = path.join(customDataDir, 'tmp');

    // 使用真实失败命令 /usr/bin/false 触发真实生产错误
    await assert.rejects(
      async () => {
        await renderExportDom({
          html: '<p>test</p>',
          chromePath: '/usr/bin/false',
          timeoutMs: 5000
        });
      },
      /Chrome 渲染导出页面失败/
    );

    // 验证 TYPORA_DATA_DIR/tmp 下不存在遗留的 typora-render-* 目录
    if (existsSync(runtimeTmpDir)) {
      const remaining = await readdir(runtimeTmpDir);
      const leftover = remaining.filter((name) => name.startsWith('typora-render-'));
      assert.equal(leftover.length, 0, '异常退出后不得在 tmp 下遗留中间工作目录');
    }
  } finally {
    if (prev === undefined) {
      delete process.env.TYPORA_DATA_DIR;
    } else {
      process.env.TYPORA_DATA_DIR = prev;
    }
  }
});

test('exportPdf 异常时传播错误并在 TYPORA_DATA_DIR/tmp 下完成清理', async () => {
  const customDataDir = path.join(TEST_TMP_DIR, 'export_fail_cleanup');
  const prev = process.env.TYPORA_DATA_DIR;
  try {
    process.env.TYPORA_DATA_DIR = customDataDir;
    const runtimeTmpDir = path.join(customDataDir, 'tmp');
    const outPath = path.join(customDataDir, 'out.pdf');

    // 使用真实失败命令 /usr/bin/false 触发真实生产错误
    await assert.rejects(
      async () => {
        await exportPdf({
          bodyHtml: '<p>test</p>',
          title: 'test',
          css: '',
          outPath,
          options: {
            chromePath: '/usr/bin/false',
            timeoutMs: 5000
          }
        });
      },
      /Chrome 导出 PDF 失败/
    );

    // 验证 TYPORA_DATA_DIR/tmp 下不存在遗留的 typora-export-pdf-* 目录
    if (existsSync(runtimeTmpDir)) {
      const remaining = await readdir(runtimeTmpDir);
      const leftover = remaining.filter((name) => name.startsWith('typora-export-pdf-'));
      assert.equal(leftover.length, 0, '异常退出后不得在 tmp 下遗留 export-pdf 中间工作目录');
    }
  } finally {
    if (prev === undefined) {
      delete process.env.TYPORA_DATA_DIR;
    } else {
      process.env.TYPORA_DATA_DIR = prev;
    }
  }
});
