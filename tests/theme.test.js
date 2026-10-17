import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ThemeRegistry } from '../src/server/theme.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const userThemeDir = path.join(projectRoot, 'tests', 'fixtures', 'themes', 'user');
const builtinThemeDir = path.join(projectRoot, 'tests', 'fixtures', 'themes', 'builtin');
const registry = new ThemeRegistry({ userThemeDir, builtinThemeDir });

test('列出用户主题与内置主题', () => {
  const themes = registry.list();
  const themeIds = themes.map((theme) => theme.id);

  for (const expectedThemeId of ['github', 'night', 'pixyll', 'latex']) {
    assert.ok(themeIds.includes(expectedThemeId), `缺少主题：${expectedThemeId}`);
  }

  const githubTheme = themes.find((theme) => theme.id === 'github');
  assert.equal(githubTheme.source, 'user');
  assert.equal(path.dirname(githubTheme.cssPath), userThemeDir);
});

test('主题标识归一化支持大小写与 .css 后缀', () => {
  const githubDirectory = registry.getThemeDir('github');
  const latexDirectory = registry.getThemeDir('latex');

  assert.equal(registry.getThemeDir('Github'), githubDirectory);
  assert.equal(registry.getThemeDir('github.css'), githubDirectory);
  assert.equal(registry.getThemeDir('Latex'), latexDirectory);
});

test('github 主题改写字体资源路径并保留自定义 at-rule', async () => {
  const css = await registry.getCss('github');

  assert.ok(
    css.includes(
      '/theme-assets/github/github/open-sans-latin-400-normal.woff2',
    ),
  );
  assert.ok(css.includes('@include-when-export'));
});

test('night 主题内联 mermaid 导入且不再包含 @import', async () => {
  const mermaidCssPath = path.join(userThemeDir, 'night', 'mermaid.dark.css');
  const mermaidCss = await readFile(mermaidCssPath, 'utf8');
  const css = await registry.getCss('night');

  assert.ok(mermaidCss.includes('--mermaid-theme: night'));
  assert.ok(css.includes('--mermaid-theme: night'));
  assert.ok(!css.includes('@import'));
});

test('resolveAsset 返回主题目录内存在的绝对文件路径', () => {
  const assetPath = registry.resolveAsset(
    'github',
    './github/open-sans-latin-400-normal.woff2',
  );

  assert.ok(path.isAbsolute(assetPath));
  assert.ok(existsSync(assetPath));
  assert.equal(path.dirname(path.dirname(assetPath)), userThemeDir);
});

test('resolveAsset 拒绝目录穿越路径', () => {
  assert.equal(registry.resolveAsset('github', '../../../../etc/passwd'), null);
});

test('构造函数输入非字符串路径时抛出 TypeError', () => {
  assert.throws(() => new ThemeRegistry({ userThemeDir: 12345 }), TypeError);
  assert.throws(() => new ThemeRegistry({ builtinThemeDir: true }), TypeError);
  assert.throws(() => new ThemeRegistry({ bundledThemeDir: {} }), TypeError);
});

test('请求不存在的主题时 getCss 显式报错', async () => {
  await assert.rejects(
    async () => registry.getCss('nonexistent-theme-xyz'),
    /未知主题：nonexistent-theme-xyz/,
  );
});
