import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { app } from '../src/server/index.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(rootDir, 'tests', '.tmp', 'api');

// 使用真实 HTTP 服务验证接口，避免直接调用处理函数而遗漏路由问题
async function withServer(run) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('GET /api/themes 返回用户主题与内置主题', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/themes`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    const ids = payload.themes.map((theme) => theme.id);
    assert.ok(ids.includes('github'));
    assert.ok(ids.includes('latex'));
    const latex = payload.themes.find((theme) => theme.id === 'latex');
    assert.equal(latex.source, 'user');
  });
});

test('GET /api/themes/:id/css 返回改写后的 CSS', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/themes/github/css`);
    assert.equal(response.status, 200);
    const css = await response.text();
    assert.match(css, /\/theme-assets\/github\/github\/open-sans-v17-latin-ext_latin-regular\.woff2/);
    assert.match(css, /@include-when-export/);
  });
});

test('GET /theme-assets 提供真实字体文件并拒绝目录穿越', async () => {
  await withServer(async (base) => {
    const ok = await fetch(
      `${base}/theme-assets/github/github/open-sans-v17-latin-ext_latin-regular.woff2`
    );
    assert.equal(ok.status, 200);
    assert.ok(Number(ok.headers.get('content-length')) > 1000);

    const bad = await fetch(`${base}/theme-assets/github/..%2f..%2f..%2fetc%2fpasswd`);
    assert.equal(bad.status, 404);
  });
});

test('POST /api/render 返回 Typora 契约 HTML', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: '# 标题\n\n段落\n', theme: 'github' })
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.match(payload.body, /md-end-block md-heading/);
    assert.match(payload.body, /md-end-block md-p/);
  });
});

test('POST /api/preview 返回完整可渲染文档', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: '# 标题\n', theme: 'github', title: '预览' })
    });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<!DOCTYPE html>/);
    assert.match(html, /<div id="write" class="write"/);
  });
});

test('文件保存与打开真实读写磁盘', async () => {
  await mkdir(tmpDir, { recursive: true });
  const target = path.join(tmpDir, 'sample.md');
  try {
    await withServer(async (base) => {
      const save = await fetch(`${base}/api/file/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: target, content: '# 内容\n' })
      });
      assert.equal(save.status, 200);
      assert.equal((await save.json()).path, target);

      const open = await fetch(`${base}/api/file/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: target })
      });
      assert.equal(open.status, 200);
      const payload = await open.json();
      assert.equal(payload.content, '# 内容\n');
      assert.equal(payload.name, 'sample.md');
      assert.ok((await stat(target)).size > 0);
    });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('POST /api/export/pdf 真实生成 PDF', async () => {
  await mkdir(tmpDir, { recursive: true });
  const target = path.join(tmpDir, 'export.pdf');
  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/api/export/pdf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: '# 导出测试\n\n正文内容\n', theme: 'github', outPath: target })
      });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.outPath, target);
      assert.ok(payload.size > 1000);
      const head = await import('node:fs/promises').then((fs) => fs.readFile(target));
      assert.equal(head.subarray(0, 5).toString(), '%PDF-');
    });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('POST /api/export/html 真实写入 HTML 文件', async () => {
  await mkdir(tmpDir, { recursive: true });
  const target = path.join(tmpDir, 'export.html');
  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/api/export/html`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: '# 导出测试\n', theme: 'latex', outPath: target })
      });
      assert.equal(response.status, 200);
      assert.ok((await response.json()).size > 500);
    });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('POST /api/export/pandoc 拒绝不支持的格式', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/export/pandoc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: '# 标题\n', to: 'doc' })
    });
    assert.equal(response.status, 400);
  });
});

test('GET /api/environment 报告真实的 Chrome 与 pandoc', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/environment`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.ok(payload.chrome.includes('Google Chrome'));
    assert.ok(payload.pandoc.includes('pandoc'));
    assert.ok(payload.themes >= 8);
  });
});

test('GET /api/images/uploaders 列出全部内置上传器', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/images/uploaders`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    const ids = payload.uploaders.map((item) => item.id);
    for (const expected of ['ipic', 'picgo-app', 'piclist-app', 'upic', 'picsee', 'picgo-cli']) {
      assert.ok(ids.includes(expected), `缺少上传器 ${expected}`);
    }
  });
});

test('设置读写接口持久化到磁盘', async () => {
  await withServer(async (base) => {
    const save = await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_uploader: 'picgo-app' })
    });
    assert.equal(save.status, 200);
    const saved = await save.json();
    assert.equal(saved.image_uploader, 'picgo-app');

    const read = await fetch(`${base}/api/settings`);
    const current = await read.json();
    assert.equal(current.image_uploader, 'picgo-app');
  });
});
