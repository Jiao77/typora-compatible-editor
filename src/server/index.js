import express from 'express';
import multer from 'multer';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import { getRuntimeDataDir } from './runtime-data.js';
import { ThemeRegistry } from './theme.js';
import { ImageHost, UPLOADERS, checkPicGoService, DEFAULT_PICGO_ENDPOINT } from './imagehost.js';
import { renderMarkdown, renderDocument } from './render.js';
import { createDocumentAssetsRouter } from './document-assets.js';
import { parseBlocks } from './blocks.js';
import { exportPdf, exportStandaloneHtml, exportViaPandoc, findChrome, findPandoc } from './export.js';
import {
  DEFAULT_USER_THEME_DIR,
  DEFAULT_BUILTIN_THEME_DIR,
  DEFAULT_BUNDLED_THEME_DIR,
  loadSettings,
  saveSettings,
  resetSettings
} from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '../..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const BRANDING_DIR = path.join(ROOT_DIR, 'resources/branding');
const FORMAT_HOME = path.join(os.homedir(), 'Library/Application Support/abnerworks.Typora');

const app = express();
const port = Number(process.env.PORT || 7788);

const userThemeDir = process.env.TYPORA_THEME_DIR || path.join(FORMAT_HOME, 'themes');
const builtinThemeDir = process.env.TYPORA_BUILTIN_THEME_DIR || DEFAULT_BUILTIN_THEME_DIR;
const bundledThemeDir = DEFAULT_BUNDLED_THEME_DIR;
const themes = new ThemeRegistry({ userThemeDir, builtinThemeDir, bundledThemeDir });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024 } });

app.use(express.json({ limit: '32mb' }));

// ---------- 主题 ----------

app.get('/api/themes', (req, res) => {
  res.json({ themes: themes.list() });
});

app.get('/api/themes/:id/css', async (req, res, next) => {
  try {
    const css = await themes.getCss(req.params.id);
    res.type('text/css').send(css);
  } catch (error) {
    next(error);
  }
});

// 主题目录内的字体与图片资源，路径穿越由 ThemeRegistry 拦截
app.get('/theme-assets/:id/*assetPath', (req, res, next) => {
  try {
    const segments = req.params.assetPath;
    const relative = Array.isArray(segments) ? segments.join('/') : String(segments);
    const resolved = themes.resolveAsset(req.params.id, relative);
    if (!resolved) {
      res.status(404).json({ error: `主题资源不存在：${relative}` });
      return;
    }
    res.sendFile(resolved);
  } catch (error) {
    next(error);
  }
});

// ---------- 渲染 ----------

app.post('/api/render', async (req, res, next) => {
  try {
    const source = String(req.body.source ?? '');
    const themeId = req.body.theme || 'github';
    const css = await themes.getCss(themeId);
    const { body, frontMatter } = renderMarkdown(source);
    res.json({ body, frontMatter, theme: themeId });
  } catch (error) {
    next(error);
  }
});

// 就地编辑使用的块级渲染：返回每个顶层块的源码区间与渲染结果
app.post('/api/render-blocks', async (req, res, next) => {
  try {
    const source = String(req.body.source ?? '');
    const result = parseBlocks(source);
    res.json({
      blocks: result.blocks.map((block) => ({
        index: block.index,
        startLine: block.startLine,
        endLine: block.endLine,
        type: block.type,
        source: block.source,
        html: block.html
      })),
      lineCount: result.lineCount
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/preview', async (req, res, next) => {
  try {
    const source = String(req.body.source ?? '');
    const themeId = req.body.theme || 'github';
    const title = req.body.title || 'TYPOAR';
    const css = await themes.getCss(themeId);
    const html = renderDocument({ source, css, title });
    res.type('html').send(html);
  } catch (error) {
    next(error);
  }
});

// ---------- 导出 ----------

app.post('/api/export/html', async (req, res, next) => {
  try {
    const source = String(req.body.source ?? '');
    const themeId = req.body.theme || 'github';
    const outPath = req.body.outPath || defaultOutputPath('html');
    const css = await themes.getCss(themeId);
    const { body } = renderMarkdown(source);
    await exportStandaloneHtml({
      bodyHtml: body,
      title: req.body.title || 'TYPOAR',
      css,
      outPath,
      themeId,
      resolveAsset: (id, relative) => themes.resolveAsset(id, relative),
      dark: /night|dark/i.test(themeId),
      lang: req.body.lang
    });
    res.json({ outPath, size: (await stat(outPath)).size });
  } catch (error) {
    next(error);
  }
});

app.post('/api/export/pdf', async (req, res, next) => {
  try {
    const source = String(req.body.source ?? '');
    const themeId = req.body.theme || 'github';
    const outPath = req.body.outPath || defaultOutputPath('pdf');
    const css = await themes.getCss(themeId);
    const { body } = renderMarkdown(source);
    await mkdir(path.dirname(outPath), { recursive: true });
    await exportPdf({
      bodyHtml: body,
      title: req.body.title || 'TYPOAR',
      css,
      outPath,
      options: {
        pageSize: req.body.pageSize,
        margin: req.body.margin,
        themeId,
        resolveAsset: (id, relative) => themes.resolveAsset(id, relative),
        dark: /night|dark/i.test(themeId),
        lang: req.body.lang
      }
    });
    res.json({ outPath, size: (await stat(outPath)).size });
  } catch (error) {
    next(error);
  }
});

const PANDOC_FORMATS = new Set(['docx', 'odt', 'rtf', 'epub', 'latex', 'mediawiki']);

app.post('/api/export/pandoc', async (req, res, next) => {
  try {
    const source = String(req.body.source ?? '');
    const to = String(req.body.to || 'docx');
    if (!PANDOC_FORMATS.has(to)) {
      res.status(400).json({ error: `不支持的导出格式：${to}` });
      return;
    }
    const outPath = req.body.outPath || defaultOutputPath(to);
    await mkdir(path.dirname(outPath), { recursive: true });
    await exportViaPandoc({ markdown: source, to, outPath, options: req.body.options || {} });
    res.json({ outPath, size: (await stat(outPath)).size });
  } catch (error) {
    next(error);
  }
});

// ---------- 文件读写 ----------

app.post('/api/file/open', async (req, res, next) => {
  try {
    const target = path.resolve(String(req.body.path || ''));
    const content = await readFile(target, 'utf8');
    res.json({ path: target, content, name: path.basename(target) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/file/save', async (req, res, next) => {
  try {
    const target = path.resolve(String(req.body.path || ''));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, String(req.body.content ?? ''), 'utf8');
    res.json({ path: target, size: (await stat(target)).size });
  } catch (error) {
    next(error);
  }
});

app.get('/api/files', async (req, res, next) => {
  try {
    const dir = path.resolve(String(req.query.dir || process.cwd()));
    const entries = await readdir(dir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && /\.(md|markdown|txt|mmd|qmd|mdx)$/i.test(entry.name))
      .map((entry) => ({ name: entry.name, path: path.join(dir, entry.name) }));
    res.json({ dir, files });
  } catch (error) {
    next(error);
  }
});

// ---------- 图床 ----------

app.get('/api/images/uploaders', (req, res) => {
  res.json({ uploaders: UPLOADERS, defaultEndpoint: DEFAULT_PICGO_ENDPOINT });
});

app.get('/api/images/status', async (req, res, next) => {
  try {
    const endpoint = String(req.query.endpoint || DEFAULT_PICGO_ENDPOINT);
    const online = await checkPicGoService(endpoint);
    res.json({ endpoint, online });
  } catch (error) {
    next(error);
  }
});

app.post('/api/images/upload', upload.array('files'), async (req, res, next) => {
  try {
    const settings = await loadSettings(ROOT_DIR);
    let documentDir = process.cwd();
    const rawDocDir = String(req.body.documentDir || '');
    if (rawDocDir.trim()) {
      const resolvedDocPath = path.resolve(rawDocDir.trim());
      try {
        const s = await stat(resolvedDocPath);
        documentDir = s.isFile() ? path.dirname(resolvedDocPath) : resolvedDocPath;
      } catch {
        documentDir = path.extname(resolvedDocPath) ? path.dirname(resolvedDocPath) : resolvedDocPath;
      }
    } else {
      documentDir = path.join(getRuntimeDataDir(ROOT_DIR), 'uploads');
    }
    const staging = path.join(getRuntimeDataDir(ROOT_DIR), 'uploads');
    await mkdir(staging, { recursive: true });

    const files = [];
    for (const file of req.files || []) {
      const originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
      const target = path.join(staging, `${Date.now()}-${originalname}`);
      await writeFile(target, file.buffer);
      files.push({ path: target, filename: originalname, mime: file.mimetype });
    }

    const effectiveSettings = {
      ...settings,
      targetDir: (typeof settings.targetDir === 'string' && settings.targetDir.trim() !== '') ? settings.targetDir.trim() : 'uploads'
    };

    const host = new ImageHost({
      uploader: req.body.uploader || settings.image_uploader,
      settings: effectiveSettings,
      documentDir
    });
    const results = await host.upload(files);
    res.json({ results });
  } catch (error) {
    next(error);
  }
});

// ---------- 设置与运行环境 ----------

app.get('/api/settings', async (req, res, next) => {
  try {
    res.json(await loadSettings(ROOT_DIR));
  } catch (error) {
    next(error);
  }
});

app.post('/api/settings', async (req, res, next) => {
  try {
    res.json(await saveSettings(ROOT_DIR, req.body || {}));
  } catch (error) {
    next(error);
  }
});

// 恢复默认设置，供偏好设置窗口的恢复按钮调用
app.post('/api/settings/reset', async (req, res, next) => {
  try {
    res.json(await resetSettings(ROOT_DIR));
  } catch (error) {
    next(error);
  }
});

app.get('/api/environment', async (req, res, next) => {
  try {
    const [chrome, pandoc] = await Promise.all([findChrome(), findPandoc()]);
    res.json({
      chrome,
      pandoc,
      themes: themes.list().length,
      node: process.version,
      platform: process.platform
    });
  } catch (error) {
    next(error);
  }
});

// ---------- 本地与文档媒体资源 ----------

app.use(createDocumentAssetsRouter({ rootDir: ROOT_DIR }));

// ---------- 静态资源 ----------

app.use(express.static(PUBLIC_DIR));
app.use('/branding', express.static(BRANDING_DIR));
app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(BRANDING_DIR, 'typo-ar.png'));
});
// 前端构建产物
app.use('/dist', express.static(path.join(ROOT_DIR, 'dist')));
// MathJax 与 Mermaid 由 Node 依赖直接提供，导出与预览共用同一份文件
app.use('/vendor/mathjax', express.static(path.join(ROOT_DIR, 'node_modules/mathjax')));
// MathJax 字体扩展包统一挂载到 /vendor/@mathjax，与 paths.fonts 对应
app.use('/vendor/@mathjax', express.static(path.join(ROOT_DIR, 'node_modules/@mathjax')));
app.use('/vendor/mermaid', express.static(path.join(ROOT_DIR, 'node_modules/mermaid/dist')));

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

function defaultOutputPath(ext) {
  return path.join(getRuntimeDataDir(ROOT_DIR), 'exports', `export-${Date.now()}.${ext}`);
}

// 统一错误处理，完整反馈真实原因
app.use((error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  res.status(500).json({ error: error.message, code: error.code || null });
});

// 只有直接运行时才监听端口，便于测试导入
// 启动内嵌服务；Electron 主进程传入 0 让系统分配空闲端口
// 返回服务实例、实际端口与访问地址，供桌面外壳与测试复用
export function startServer({ port: requestedPort = port, host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(requestedPort, host);
    server.once('listening', () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : requestedPort;
      resolve({
        server,
        port: actualPort,
        host,
        url: `http://${host}:${actualPort}`,
        themeDirs: { userThemeDir, builtinThemeDir }
      });
    });
    server.once('error', reject);
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startServer({ port }).then((info) => {
    console.log(`TYPOAR 已启动：${info.url}`);
    console.log(`用户主题目录：${userThemeDir}`);
    console.log(`内置主题目录：${builtinThemeDir}`);
  });
}

export { app, themes, ROOT_DIR };
export default app;
