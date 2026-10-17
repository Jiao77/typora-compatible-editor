import path from 'node:path';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import postcss from 'postcss';
import valueParser from 'postcss-value-parser';

import { MATHJAX_CONFIG } from '../shared/mathjax-config.js';
import { runProcess } from './run-process.js';
import { getRuntimeDataDir } from './runtime-data.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MATHJAX_BUNDLE = path.join(ROOT_DIR, 'node_modules/mathjax/tex-svg.js');
const MERMAID_BUNDLE = path.join(ROOT_DIR, 'node_modules/mermaid/dist/mermaid.min.js');
const VENDOR_DIAGRAM_FILES = [
  'public/vendor/diagrams/jquery.js',
  'public/vendor/diagrams/underscore.js',
  'public/vendor/diagrams/raphael.js',
  'public/vendor/diagrams/flowchart.js',
  'public/vendor/diagrams/sequence-diagram.js'
];
const EXPORT_RENDER_SCRIPT = path.join(ROOT_DIR, 'src/web/export-render.js');

const MIME_TYPES = new Map([
  ['.woff2', 'font/woff2'],
  ['.woff', 'font/woff'],
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.svg', 'image/svg+xml'],
  ['.cur', 'image/x-icon']
]);

// 把主题 CSS 中的 /theme-assets/<id>/<path> 引用替换为内嵌 data URI
// 导出文件之后无需任何本地服务即可独立打开
export async function inlineThemeAssets(css, themeId, resolveAsset) {
  const prefix = `/theme-assets/${themeId}/`;
  const cache = new Map();
  const root = postcss.parse(css);

  const toDataUri = async (relativePath) => {
    if (cache.has(relativePath)) return cache.get(relativePath);
    const absolutePath = resolveAsset(themeId, relativePath);
    if (!absolutePath) {
      throw new Error(`主题资源缺失：${themeId}/${relativePath}`);
    }
    const bytes = await readFile(absolutePath);
    const mime = MIME_TYPES.get(path.extname(absolutePath).toLowerCase());
    if (!mime) {
      throw new Error(`不支持的主题资源类型：${absolutePath}`);
    }
    const dataUri = `data:${mime};base64,${bytes.toString('base64')}`;
    cache.set(relativePath, dataUri);
    return dataUri;
  };

  const declarations = [];
  root.walkDecls((declaration) => {
    if (declaration.value.includes(prefix)) declarations.push(declaration);
  });

  // 逐个声明等待资源读取完成后再序列化，避免替换结果被提前写回
  for (const declaration of declarations) {
    const parsed = valueParser(declaration.value);
    const nodes = [];
    parsed.walk((node) => {
      if (node.type === 'function' && node.value.toLowerCase() === 'url') {
        nodes.push(node);
      }
      return undefined;
    });
    for (const node of nodes) {
      const raw = valueParser.stringify(node.nodes).trim().replace(/^['"]|['"]$/g, '');
      if (!raw.startsWith(prefix)) continue;
      const uri = await toDataUri(raw.slice(prefix.length));
      node.nodes = [{ type: 'word', value: uri }];
    }
    declaration.value = parsed.toString();
  }
  const replaced = root.toString();
  if (replaced.includes(prefix)) {
    throw new Error(`主题资源替换未完成：${themeId}`);
  }
  return convertIncludeWhenExport(replaced);
}

// @include-when-export 是 Typora 的自定义指令，语义为"仅在导出时引入"
// 导出阶段把它转换为标准 @import，让导出文件成为合法 CSS
function convertIncludeWhenExport(css) {
  return css.replace(
    /@include-when-export\s+url\(\s*(['"]?)([^'")]+)\1\s*\)\s*;?/g,
    (match, quote, url) => `@import url("${url}");`
  );
}

// 生成导出页面：内联主题样式、MathJax 与 Mermaid bundle、导出渲染脚本
export async function buildRenderableExportHtml({ bodyHtml, title, css, lang, dark }) {
  const [mathJaxBundle, mermaidBundle, renderScript, ...diagramBundles] = await Promise.all([
    readFile(MATHJAX_BUNDLE, 'utf8'),
    readFile(MERMAID_BUNDLE, 'utf8'),
    readFile(EXPORT_RENDER_SCRIPT, 'utf8'),
    ...VENDOR_DIAGRAM_FILES.map((file) => readFile(path.join(ROOT_DIR, file), 'utf8'))
  ]);

  const mathJaxConfig = JSON.stringify(MATHJAX_CONFIG).replace(/</g, '\\u003c');
  const moduleSource = renderScript
    .replace(/^import mermaid from 'mermaid';$/m, 'const mermaid = window.mermaid;')
    .replace(/export\s+/g, '');
  const diagramScripts = diagramBundles.map((source) => `<script>${source}</script>`).join('\n');

  return `<!DOCTYPE html>
<html lang="${escapeAttribute(lang || 'zh-CN')}" data-dark="${dark ? 'true' : 'false'}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title || '')}</title>
<style>
${css}
</style>
<!--TYPORA_RENDER_BUNDLES_START-->
<script>window.MathJax = ${mathJaxConfig};</script>
<script>${mathJaxBundle}</script>
<script>${mermaidBundle}</script>
${diagramScripts}
<!--TYPORA_RENDER_BUNDLES_END-->
</head>
<body>
${bodyHtml}
<!--TYPORA_RENDER_SCRIPT_START-->
<script type="module">
${moduleSource}
</script>
<!--TYPORA_RENDER_SCRIPT_END-->
</body>
</html>
`;
}

// 用 Chrome 无头模式加载导出页面，等待公式与图表渲染完成后取回固化 DOM
export async function renderExportDom({ html, chromePath, timeoutMs = 60_000 }) {
  const runtimeTmpDir = path.join(getRuntimeDataDir(ROOT_DIR), 'tmp');
  await mkdir(runtimeTmpDir, { recursive: true });
  const temporaryDirectory = await mkdtemp(path.join(runtimeTmpDir, 'typora-render-'));
  const sourcePath = path.join(temporaryDirectory, 'document.html');
  const profileDirectory = path.join(temporaryDirectory, 'chrome-profile');
  try {
    await writeFile(sourcePath, html, 'utf8');
    await mkdir(profileDirectory, { recursive: true });
    const result = await runProcess(chromePath, [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      `--user-data-dir=${profileDirectory}`,
      '--allow-file-access-from-files',
      '--run-all-compositor-stages-before-draw',
      '--virtual-time-budget=20000',
      '--dump-dom',
      '--no-first-run',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      pathToFileURL(sourcePath).href
    ], {
      timeoutMs,
      timeoutMessage: `Chrome 渲染导出页面超时（${timeoutMs} 毫秒）`
    });
    if (result.code !== 0) {
      throw new Error(`Chrome 渲染导出页面失败，退出码 ${result.code}：${result.stderr.trim() || result.stdout.trim()}`);
    }
    if (result.stdout.length === 0) {
      throw new Error('Chrome 渲染导出页面未返回 DOM 内容');
    }
    return { html: normalizeRenderedHtml(result.stdout) };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

// Chrome 的 dump-dom 会输出已固化的 DOM
// 渲染完成后移除 MathJax 与 Mermaid bundle 以及渲染脚本，产物只保留固化结果
function normalizeRenderedHtml(html) {
  const documentStart = html.indexOf('<!DOCTYPE html>');
  let source = documentStart >= 0 ? html.slice(documentStart) : html;
  source = removeBetweenMarkers(source, '<!--TYPORA_RENDER_BUNDLES_START-->', '<!--TYPORA_RENDER_BUNDLES_END-->');
  source = removeBetweenMarkers(source, '<!--TYPORA_RENDER_SCRIPT_START-->', '<!--TYPORA_RENDER_SCRIPT_END-->');
  // 图表围栏在渲染阶段已移除，此处防御性清理残留节点
  source = source.replace(/<pre class="md-fences mock-cm md-end-block"[^>]*><code class="md-diagram-source">[\s\S]*?<\/code><\/pre>/g, '');
  return source
    .replace(/\sdata-render-state="[^"]*"/g, '')
    .replace(/\sdata-render-summary="[^"]*"/g, '');
}

// 移除起始与结束标记之间的全部内容，包含标记自身
function removeBetweenMarkers(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start < 0) return source;
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error(`导出页面缺少结束标记：${endMarker}`);
  return source.slice(0, start) + source.slice(end + endMarker.length);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/'/g, '&#39;');
}
