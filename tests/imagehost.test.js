import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import {
  ImageHost,
  checkPicGoService,
  renderCustomTemplate,
  UPLOADERS,
} from '../src/server/imagehost.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const tempRoot = path.join(testDir, '.tmp');

async function createTempDirectory() {
  const directory = path.join(tempRoot, randomUUID());
  await mkdir(directory, { recursive: true });
  return directory;
}

async function startServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function closeServer(server) {
  if (!server.listening) {
    return;
  }
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    server.closeAllConnections?.();
  });
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

test('UPLOADERS 包含 Typora 内置上传器且默认 ipic', () => {
  assert.deepEqual(
    UPLOADERS.map((item) => item.id),
    ['ipic', 'picgo-app', 'piclist-app', 'upic', 'picsee', 'picgo-cli'],
  );
  assert.equal(UPLOADERS.find((item) => item.default)?.id, 'ipic');
});

test('renderCustomTemplate 替换 filepath 与 filename 占位符', () => {
  const result = renderCustomTemplate(
    'url=${filename}&path=${filepath}&name=${filename}',
    { filepath: '/Users/test/图片.png', filename: '图片.png' },
  );
  assert.equal(result, 'url=图片.png&path=/Users/test/图片.png&name=图片.png');
});

test('custom 上传器真实发送模板化请求并透传响应 URL', async (t) => {
  const directory = await createTempDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, 'photo.png');
  await writeFile(sourcePath, 'custom-image');

  let received;
  const app = await startServer(async (request, response) => {
    const body = await readRequestBody(request);
    received = {
      method: request.method,
      headers: request.headers,
      body,
    };
    const parsed = (() => {
      try {
        return JSON.parse(body);
      } catch (error) {
        return null;
      }
    })();
    const valid = request.method === 'POST'
      && request.headers['x-test-source'] === 'imagehost-test'
      && parsed?.filename === 'photo.png'
      && parsed?.filepath === sourcePath
      && body.includes('"filename":"photo.png"');
    if (!valid) {
      response.writeHead(422, { 'Content-Type': 'text/plain' });
      response.end('custom request contract mismatch');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: { url: 'https://example.com/custom.png' } }));
  });
  t.after(() => closeServer(app.server));

  const host = new ImageHost({
    uploader: 'custom',
    documentDir: directory,
    settings: {
      url: `${app.baseUrl}/upload`,
      method: 'POST',
      headers: { 'X-Test-Source': 'imagehost-test' },
      body: '{"filename":"${filename}","filepath":"${filepath}"}',
      urlPath: 'data.url',
    },
  });
  const result = await host.upload([
    { path: sourcePath, filename: 'photo.png', mime: 'image/png' },
  ]);

  assert.equal(received.method, 'POST');
  assert.equal(received.headers['x-test-source'], 'imagehost-test');
  assert.ok(received.body.includes('"filename":"photo.png"'));
  assert.deepEqual(result, [{
    url: 'https://example.com/custom.png',
    filename: 'photo.png',
    uploader: 'custom',
  }]);
});

test('PicGo 与 PicList 兼容上传器调用真实 LED 接口', async (t) => {
  const directory = await createTempDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, 'led.png');
  await writeFile(sourcePath, 'led-image');

  const requests = [];
  const app = await startServer(async (request, response) => {
    const body = await readRequestBody(request);
    requests.push({ method: request.method, body });
    const parsed = (() => {
      try {
        return JSON.parse(body);
      } catch (error) {
        return null;
      }
    })();
    if (request.method !== 'POST' || parsed?.list?.[0] !== sourcePath) {
      response.writeHead(422, { 'Content-Type': 'text/plain' });
      response.end('PicGo request contract mismatch');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      success: true,
      result: ['https://example.com/a.png'],
    }));
  });
  t.after(() => closeServer(app.server));

  for (const uploader of ['picgo-app', 'piclist-app']) {
    const host = new ImageHost({
      uploader,
      documentDir: directory,
      settings: { endpoint: `${app.baseUrl}/upload` },
    });
    const result = await host.upload([
      { path: sourcePath, filename: 'a.png', mime: 'image/png' },
    ]);
    assert.deepEqual(result, [{
      url: 'https://example.com/a.png',
      filename: 'a.png',
      uploader,
    }]);
  }

  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.method, 'POST');
    assert.deepEqual(JSON.parse(request.body), { list: [sourcePath] });
  }
});

test('local 上传器复制真实文件并自动处理重复文件名', async (t) => {
  const directory = await createTempDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceDirectory = path.join(directory, 'source');
  await mkdir(sourceDirectory, { recursive: true });
  const sourcePath = path.join(sourceDirectory, 'photo.png');
  await writeFile(sourcePath, 'local-image-content');

  const host = new ImageHost({
    uploader: 'local',
    documentDir: directory,
    settings: { targetDir: 'uploads' },
  });
  const first = await host.uploadOne({
    path: sourcePath,
    filename: 'photo.png',
    mime: 'image/png',
  });
  const second = await host.uploadOne({
    path: sourcePath,
    filename: 'photo.png',
    mime: 'image/png',
  });

  const expectedFirstPath = path.join(directory, 'uploads', 'photo.png');
  const expectedSecondPath = path.join(directory, 'uploads', 'photo-1.png');
  assert.equal(first.url, '/local-images/photo.png');
  assert.equal(first.filename, 'photo.png');
  assert.equal(first.uploader, 'local');
  assert.equal(first.absolutePath, expectedFirstPath);
  assert.equal(second.url, '/local-images/photo-1.png');
  assert.equal(second.filename, 'photo-1.png');
  assert.equal(second.uploader, 'local');
  assert.equal(second.absolutePath, expectedSecondPath);
  assert.equal(await readFile(expectedFirstPath, 'utf8'), 'local-image-content');
  assert.equal(await readFile(expectedSecondPath, 'utf8'), 'local-image-content');
  assert.ok((await stat(expectedFirstPath)).isFile());
  assert.ok((await stat(expectedSecondPath)).isFile());
});

test('checkPicGoService 探测在线服务并在端口关闭后返回 false', async (t) => {
  const app = await startServer((request, response) => {
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('not found');
  });
  let closed = false;
  const closeOnce = async () => {
    if (!closed) {
      closed = true;
      await closeServer(app.server);
    }
  };
  t.after(closeOnce);

  assert.equal(await checkPicGoService(`${app.baseUrl}/upload`), true);
  await closeOnce();
  assert.equal(await checkPicGoService(`${app.baseUrl}/upload`), false);
});
