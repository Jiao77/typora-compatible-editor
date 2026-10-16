import { constants as fsConstants } from 'node:fs'
import { access, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { runProcess } from './run-process.js'

export const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const CHROME_CANDIDATES = [
  CHROME_PATH,
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
]

const PANDOC_CANDIDATES = [
  '/opt/homebrew/bin/pandoc',
  '/usr/local/bin/pandoc',
  '/usr/bin/pandoc'
]

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_VIRTUAL_TIME_BUDGET_MS = 10_000
const PAPER_SIZES_MM = {
  a4: { width: 210, height: 297 },
  letter: { width: 215.9, height: 279.4 }
}

export async function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (await isExecutableFile(candidate)) return candidate
  }
  for (const commandName of ['google-chrome', 'chromium', 'chrome']) {
    const resolved = await resolveExecutableOnPath(commandName)
    if (resolved) return resolved
  }
  throw new Error('未找到可用的 Chrome 可执行文件，请安装 Google Chrome 或设置 PATH')
}

export async function findPandoc() {
  for (const candidate of PANDOC_CANDIDATES) {
    if (await isExecutableFile(candidate)) return candidate
  }
  const resolved = await resolveExecutableOnPath('pandoc')
  if (resolved) return resolved
  throw new Error('未找到可用的 pandoc 可执行文件，请安装 pandoc 或设置 PATH')
}

export function buildExportHtml({ bodyHtml, title, css, lang } = {}) {
  const documentLang = lang === undefined || lang === null || lang === '' ? 'zh-CN' : String(lang)
  const documentTitle = escapeHtml(title === undefined || title === null ? '' : String(title))
  const body = bodyHtml === undefined || bodyHtml === null ? '' : String(bodyHtml)
  const styles = css === undefined || css === null ? '' : String(css)
  return `<!DOCTYPE html>
<html lang="${escapeAttribute(documentLang)}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>${documentTitle}</title>
<style>
${styles}
</style>
</head>
<body>
${body}
</body>
</html>
`
}

export async function exportPdf({ bodyHtml, title, css, outPath, options } = {}) {
  if (!outPath) throw new Error('导出 PDF 需要提供 outPath')
  const chromePath = options && options.chromePath ? await assertExecutable(options.chromePath, 'Chrome') : await findChrome()
  const timeoutMs = normalizeTimeout(options && options.timeoutMs)
  const virtualTimeBudgetMs = options && options.virtualTimeBudgetMs !== undefined
    ? Number(options.virtualTimeBudgetMs)
    : DEFAULT_VIRTUAL_TIME_BUDGET_MS
  if (!Number.isFinite(virtualTimeBudgetMs) || virtualTimeBudgetMs < 0) {
    throw new Error('virtualTimeBudgetMs 必须为非负数值')
  }

  const targetPath = path.resolve(outPath)
  await mkdir(path.dirname(targetPath), { recursive: true })
  const pageCss = buildPageCss(options)

  // 先固化公式与图表，再打印静态页面，避免打印阶段抢在渲染完成之前
  const rendered = await prepareStandaloneDocument({
    bodyHtml,
    title,
    css: `${css === undefined || css === null ? '' : String(css)}\n${pageCss}`,
    lang: options && options.lang,
    themeId: options && options.themeId,
    resolveAsset: options && options.resolveAsset,
    chromePath,
    timeoutMs,
    dark: Boolean(options && options.dark)
  })
  const html = rendered.html

  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'typora-export-pdf-'))
  const htmlPath = path.join(temporaryDirectory, 'document.html')
  const chromeProfileDirectory = path.join(temporaryDirectory, 'chrome-profile')
  try {
    await mkdir(chromeProfileDirectory, { recursive: true })
    await writeFile(htmlPath, html, 'utf8')
    await rm(targetPath, { force: true })
    const argumentsList = [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      `--user-data-dir=${chromeProfileDirectory}`,
      '--allow-file-access-from-files',
      '--run-all-compositor-stages-before-draw',
      `--virtual-time-budget=${Math.round(virtualTimeBudgetMs)}`,
      `--print-to-pdf=${targetPath}`,
      '--no-pdf-header-footer',
      '--no-first-run',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      toFileUrl(htmlPath)
    ]
    const result = await runProcess(chromePath, argumentsList, {
      timeoutMs,
      timeoutMessage: `Chrome 导出 PDF 超时（${timeoutMs} 毫秒）`
    })
    if (result.code !== 0) {
      throw new Error(`Chrome 导出 PDF 失败，退出码 ${result.code}：${formatProcessError(result)}`)
    }
    const generated = await waitForNonEmptyFile(targetPath, timeoutMs)
    if (!generated) throw new Error(`Chrome 未生成 PDF 文件：${targetPath}`)
    return targetPath
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

export async function exportHtmlFile({ bodyHtml, title, css, outPath } = {}) {
  if (!outPath) throw new Error('导出 HTML 需要提供 outPath')
  const targetPath = path.resolve(outPath)
  await mkdir(path.dirname(targetPath), { recursive: true })
  const html = buildExportHtml({ bodyHtml, title, css })
  await writeFile(targetPath, html, 'utf8')
  const written = await stat(targetPath)
  if (!written.isFile() || written.size === 0) throw new Error(`HTML 文件写入失败：${targetPath}`)
  return targetPath
}

// 导出 HTML 时固化公式与图表，并内嵌主题字体，生成可独立打开的文件
export async function exportStandaloneHtml({
  bodyHtml,
  title,
  css,
  outPath,
  themeId,
  resolveAsset,
  chromePath,
  lang,
  dark = false,
  timeoutMs
} = {}) {
  if (!outPath) throw new Error('导出 HTML 需要提供 outPath')
  const targetPath = path.resolve(outPath)
  await mkdir(path.dirname(targetPath), { recursive: true })
  const resolvedChrome = chromePath || (await findChrome())
  const resolvedTimeout = normalizeTimeout(timeoutMs)
  const rendered = await prepareStandaloneDocument({
    bodyHtml,
    title,
    css,
    lang,
    themeId,
    resolveAsset,
    chromePath: resolvedChrome,
    timeoutMs: resolvedTimeout,
    dark
  })
  await writeFile(targetPath, rendered.html, 'utf8')
  const written = await stat(targetPath)
  if (!written.isFile() || written.size === 0) throw new Error(`HTML 文件写入失败：${targetPath}`)
  return targetPath
}

// 拼接导出文档：内嵌主题资源、可选固化公式与图表
async function prepareStandaloneDocument({
  bodyHtml,
  title,
  css,
  lang,
  themeId,
  resolveAsset,
  chromePath,
  timeoutMs,
  dark
}) {
  const baseCss = css === undefined || css === null ? '' : String(css)
  if (!themeId || typeof resolveAsset !== 'function') {
    return { html: buildExportHtml({ bodyHtml, title, css: baseCss, lang }), summary: null }
  }

  const { inlineThemeAssets, buildRenderableExportHtml, renderExportDom } = await import('./export-render.js')
  const inlinedCss = await inlineThemeAssets(baseCss, themeId, resolveAsset)
  const renderable = await buildRenderableExportHtml({
    bodyHtml,
    title,
    css: inlinedCss,
    lang,
    dark
  })
  const rendered = await renderExportDom({ html: renderable, chromePath, timeoutMs })
  return { html: rendered.html, summary: rendered.summary }
}

// 生成打印页面：内嵌主题资源与渲染 bundle，由 Chrome 在打印前完成公式与图表渲染
async function preparePrintDocument({ bodyHtml, title, css, lang, themeId, resolveAsset, dark }) {
  const baseCss = css === undefined || css === null ? '' : String(css)
  if (!themeId || typeof resolveAsset !== 'function') {
    return { html: buildExportHtml({ bodyHtml, title, css: baseCss, lang }), summary: null }
  }

  const { inlineThemeAssets, buildRenderableExportHtml } = await import('./export-render.js')
  const inlinedCss = await inlineThemeAssets(baseCss, themeId, resolveAsset)
  const html = await buildRenderableExportHtml({
    bodyHtml,
    title,
    css: inlinedCss,
    lang,
    dark
  })
  return { html, summary: null }
}

export async function exportViaPandoc({ markdown, to, outPath, options } = {}) {
  if (typeof markdown !== 'string') throw new Error('导出文档需要提供 markdown 字符串')
  if (!to) throw new Error('导出文档需要提供目标格式 to')
  if (!outPath) throw new Error('导出文档需要提供 outPath')
  const pandocPath = options && options.pandocPath ? await assertExecutable(options.pandocPath, 'pandoc') : await findPandoc()
  const timeoutMs = normalizeTimeout(options && options.timeoutMs)
  const targetPath = path.resolve(outPath)
  await mkdir(path.dirname(targetPath), { recursive: true })
  await rm(targetPath, { force: true })

  const argumentsList = ['-f', 'gfm+footnotes+pipe_tables+strikeout+task_lists+tex_math_dollars+raw_html+emoji', '-t', String(to), '-o', targetPath]
  if (options && Array.isArray(options.extraArgs)) argumentsList.push(...options.extraArgs.map(String))

  const result = await runProcess(pandocPath, argumentsList, {
    timeoutMs,
    input: markdown,
    timeoutMessage: `pandoc 导出超时（${timeoutMs} 毫秒）`
  })
  if (result.code !== 0) {
    throw new Error(`pandoc 导出失败，退出码 ${result.code}：${formatProcessError(result)}`)
  }
  const written = await stat(targetPath).catch((error) => {
    if (error && error.code === 'ENOENT') return null
    throw error
  })
  if (!written || !written.isFile() || written.size === 0) {
    throw new Error(`pandoc 未生成导出文件：${targetPath}`)
  }
  return targetPath
}

function buildPageCss(options) {
  const pageSize = normalizePageSize(options && options.pageSize)
  const margin = normalizeMargin(options && options.margin)
  const lines = [
    '@page {',
    `  size: ${millimetersToInches(pageSize.width)}in ${millimetersToInches(pageSize.height)}in;`,
    `  margin: ${millimetersToInches(margin.top)}in ${millimetersToInches(margin.right)}in ${millimetersToInches(margin.bottom)}in ${millimetersToInches(margin.left)}in;`,
    '}'
  ]
  return lines.join('\n')
}

function millimetersToInches(millimeters) {
  return Number((millimeters / 25.4).toFixed(6))
}

function normalizePageSize(pageSize) {
  if (pageSize === undefined || pageSize === null || pageSize === '') return { ...PAPER_SIZES_MM.a4 }
  if (typeof pageSize === 'string') {
    const normalized = pageSize.trim().toLowerCase()
    const paper = PAPER_SIZES_MM[normalized]
    if (!paper) throw new Error(`不支持的页面尺寸：${pageSize}`)
    return { ...paper }
  }
  if (typeof pageSize !== 'object') throw new Error('pageSize 必须为字符串或 { width, height } 对象')
  const width = Number(pageSize.width)
  const height = Number(pageSize.height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('pageSize 的 width 与 height 必须为正数毫米值')
  }
  return { width, height }
}

function normalizeMargin(margin) {
  if (margin === undefined || margin === null) return { top: 16, right: 16, bottom: 16, left: 16 }
  if (typeof margin === 'number') {
    if (!Number.isFinite(margin) || margin < 0) throw new Error('margin 必须为非负数值')
    return { top: margin, right: margin, bottom: margin, left: margin }
  }
  if (typeof margin !== 'object') throw new Error('margin 必须为数值或 { top, right, bottom, left } 对象')
  const defaultMargin = 16
  const normalized = {
    top: margin.top === undefined ? defaultMargin : Number(margin.top),
    right: margin.right === undefined ? defaultMargin : Number(margin.right),
    bottom: margin.bottom === undefined ? defaultMargin : Number(margin.bottom),
    left: margin.left === undefined ? defaultMargin : Number(margin.left)
  }
  for (const [name, value] of Object.entries(normalized)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`margin.${name} 必须为非负数值`)
  }
  return normalized
}

function normalizeTimeout(timeoutMs) {
  if (timeoutMs === undefined || timeoutMs === null) return DEFAULT_TIMEOUT_MS
  const value = Number(timeoutMs)
  if (!Number.isFinite(value) || value <= 0) throw new Error('timeoutMs 必须为正数')
  return value
}

function formatProcessError(result) {
  const stderr = (result.stderr || '').trim()
  const stdout = (result.stdout || '').trim()
  if (stderr) return stderr
  if (stdout) return stdout
  if (result.stdinError) return `标准输入写入失败：${result.stdinError}`
  return result.signal ? `进程被信号 ${result.signal} 终止` : '没有收到标准错误输出'
}

async function waitForNonEmptyFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    try {
      const fileStat = await stat(filePath)
      if (fileStat.isFile() && fileStat.size > 0) return true
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error
    }
    await delay(50)
  }
  return false
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function isExecutableFile(filePath) {
  if (!filePath) return false
  try {
    const fileStat = await stat(filePath)
    if (!fileStat.isFile()) return false
    await access(filePath, fsConstants.X_OK)
    return true
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'EACCES')) return false
    throw error
  }
}

async function assertExecutable(filePath, label) {
  const resolved = path.resolve(filePath)
  if (!(await isExecutableFile(resolved))) throw new Error(`${label} 可执行文件不可用：${resolved}`)
  return resolved
}

async function resolveExecutableOnPath(commandName) {
  const pathValue = process.env.PATH || ''
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue
    const candidate = path.join(directory, commandName)
    if (await isExecutableFile(candidate)) return path.resolve(candidate)
  }
  return null
}

function toFileUrl(filePath) {
  const resolved = path.resolve(filePath)
  const normalized = resolved.split(path.sep).map((segment) => encodeURIComponent(segment)).join('/')
  return `file://${normalized}`
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function escapeAttribute(value) {
  return escapeHtml(value)
}
