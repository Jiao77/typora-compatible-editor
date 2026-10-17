import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { ThemeRegistry } from '../src/server/theme.js';
import { DEFAULT_SETTINGS, DEFAULT_BUNDLED_THEME_DIR } from '../src/server/config.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testBaseDir = path.join(rootDir, 'work', 'local_deployment_20261016', 'tmp', 'portability_test');

test('干净无 Typora 环境下生产默认 ThemeRegistry 自动发现全部内置基础主题且指向 resources', () => {
  const nonExistentDir = path.join(testBaseDir, 'non_existent_typora_dir');
  const registry = new ThemeRegistry({
    userThemeDir: nonExistentDir,
    builtinThemeDir: nonExistentDir,
    bundledThemeDir: DEFAULT_BUNDLED_THEME_DIR
  });

  const list = registry.list();
  const ids = list.map((item) => item.id);

  assert.ok(ids.includes('github'));
  assert.ok(ids.includes('night'));
  assert.ok(ids.includes('latex'));
  assert.ok(ids.includes('pixyll'));

  for (const item of list) {
    assert.equal(item.source, 'builtin');
    assert.ok(
      item.cssPath.startsWith(path.resolve(DEFAULT_BUNDLED_THEME_DIR)),
      `主题 ${item.id} 路径必须位于 resources/themes，实际为：${item.cssPath}`
    );
  }

  const githubDir = registry.getThemeDir('github');
  assert.equal(githubDir, path.resolve(DEFAULT_BUNDLED_THEME_DIR));
});

test('默认配置中的默认亮色与暗色主题均可正常解析且内容匹配', async () => {
  const registry = new ThemeRegistry({
    bundledThemeDir: DEFAULT_BUNDLED_THEME_DIR
  });

  const lightThemeDir = registry.getThemeDir(DEFAULT_SETTINGS.theme);
  const darkThemeDir = registry.getThemeDir(DEFAULT_SETTINGS.darkTheme);

  assert.ok(lightThemeDir, '默认亮色主题目录应解析成功');
  assert.ok(darkThemeDir, '默认暗色主题目录应解析成功');
  assert.equal(lightThemeDir, path.resolve(DEFAULT_BUNDLED_THEME_DIR));
  assert.equal(darkThemeDir, path.resolve(DEFAULT_BUNDLED_THEME_DIR));

  const lightCss = await registry.getCss(DEFAULT_SETTINGS.theme);
  assert.ok(lightCss.includes('open-sans-v17-latin-ext_latin-regular.woff2'));

  const darkCss = await registry.getCss(DEFAULT_SETTINGS.darkTheme);
  assert.ok(darkCss.includes('--mermaid-theme: night'), '暗色主题应内联 night 对应的图表样式');
});

test('请求不存在的主题立即抛出明确错误', async () => {
  const registry = new ThemeRegistry({
    bundledThemeDir: DEFAULT_BUNDLED_THEME_DIR
  });

  await assert.rejects(
    async () => registry.getCss('not-exist-theme-123'),
    /未知主题：not-exist-theme-123/
  );
});

test('用户自定义主题目录具备最高优先级并可覆盖同名内置主题', async () => {
  const userDir = path.join(testBaseDir, 'user_theme_override');
  await mkdir(userDir, { recursive: true });
  try {
    const customGithubCss = `
#write {
  color: #ff0000;
  font-family: "Custom User Override Font";
}
`;
    await writeFile(path.join(userDir, 'github.css'), customGithubCss, 'utf8');

    const registry = new ThemeRegistry({
      userThemeDir: userDir,
      bundledThemeDir: DEFAULT_BUNDLED_THEME_DIR
    });

    const list = registry.list();
    const githubItem = list.find((item) => item.id === 'github');
    assert.ok(githubItem);
    assert.equal(githubItem.source, 'user', '用户同名主题必须标记为 user 来源');

    const css = await registry.getCss('github');
    assert.ok(css.includes('Custom User Override Font'), '应加载用户覆盖的样式内容');
  } finally {
    await rm(userDir, { recursive: true, force: true });
  }
});

test('真实子进程在未配置外部主题环境变量时以生产默认配置启动并验证路径与接口', { timeout: 30000 }, async () => {
  await rm(testBaseDir, { recursive: true, force: true });
  await mkdir(testBaseDir, { recursive: true });

  const childEnv = { ...process.env };
  childEnv.PORT = '0';
  delete childEnv.TYPORA_THEME_DIR;
  delete childEnv.TYPORA_BUILTIN_THEME_DIR;

  const serverProc = spawn('node', ['src/server/index.js'], {
    cwd: rootDir,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const baseUrl = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      serverProc.kill('SIGTERM');
      reject(new Error(`等待子进程服务启动超时：${output}`));
    }, 20000);

    serverProc.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });

    serverProc.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });

    serverProc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    serverProc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`子进程服务过早退出，退出码：${code}，输出：${output}`));
    });
  });

  try {
    const resThemes = await fetch(`${baseUrl}/api/themes`);
    assert.equal(resThemes.status, 200);
    const { themes } = await resThemes.json();
    assert.ok(themes.length >= 4);

    const githubTheme = themes.find((t) => t.id === 'github');
    assert.ok(githubTheme);
    assert.equal(githubTheme.source, 'builtin', '无 Typora 环境下默认主题应为 builtin 来源');
    assert.ok(
      githubTheme.cssPath.startsWith(path.resolve(DEFAULT_BUNDLED_THEME_DIR)),
      `github.cssPath 必须位于 resources/themes，实际为：${githubTheme.cssPath}`
    );

    const resLightCss = await fetch(`${baseUrl}/api/themes/${DEFAULT_SETTINGS.theme.toLowerCase()}/css`);
    assert.equal(resLightCss.status, 200);
    const lightCss = await resLightCss.text();
    assert.ok(lightCss.includes('open-sans-v17-latin-ext_latin-regular.woff2'));

    const resDarkCss = await fetch(`${baseUrl}/api/themes/${DEFAULT_SETTINGS.darkTheme.toLowerCase()}/css`);
    assert.equal(resDarkCss.status, 200);
    const darkCss = await resDarkCss.text();
    assert.ok(darkCss.includes('--mermaid-theme: night'));

    const resRender = await fetch(`${baseUrl}/api/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: '# 可移植性端到端验证\n\n测试正文内容', theme: DEFAULT_SETTINGS.theme })
    });
    assert.equal(resRender.status, 200);
    const renderPayload = await resRender.json();
    assert.ok(renderPayload.body.includes('md-heading'));
  } finally {
    serverProc.kill('SIGTERM');
    await rm(testBaseDir, { recursive: true, force: true });
  }
});
