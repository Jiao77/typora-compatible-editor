import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CHROME_PATH,
  buildExportHtml,
  exportPdf,
  exportHtmlFile,
  exportViaPandoc,
  findChrome,
  findPandoc
} from '../src/server/export.js'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const temporaryDirectory = path.join(testDirectory, '.tmp')

before(async () => {
  await mkdir(temporaryDirectory, { recursive: true })
})

after(async () => {
  const entries = await readdir(temporaryDirectory, { withFileTypes: true })
  for (const entry of entries) {
    await rm(path.join(temporaryDirectory, entry.name), { recursive: true, force: true })
  }
  await rm(temporaryDirectory, { recursive: true, force: true })
})

test('findChrome 返回真实存在的 Chrome 可执行文件', async () => {
  const chromePath = await findChrome()
  assert.equal(chromePath, CHROME_PATH)
  assert.equal(path.isAbsolute(chromePath), true)
  const chromeStat = await stat(chromePath)
  assert.equal(chromeStat.isFile(), true)
})

test('findPandoc 返回真实存在的 pandoc 可执行文件', async () => {
  const pandocPath = await findPandoc()
  assert.equal(path.isAbsolute(pandocPath), true)
  const pandocStat = await stat(pandocPath)
  assert.equal(pandocStat.isFile(), true)
})

test('buildExportHtml 生成完整文档并转义标题', () => {
  const html = buildExportHtml({
    bodyHtml: '<p class="md-p">正文</p>',
    title: '标题 <script>alert(1)</script>',
    css: '.md-p { color: rgb(1, 2, 3); }'
  })
  assert.equal(html.includes('<!DOCTYPE html>'), true)
  assert.equal(html.includes('<meta charset="UTF-8">'), true)
  assert.equal(html.includes('name="viewport"'), true)
  assert.equal(html.includes('<style>'), true)
  assert.equal(html.includes('.md-p { color: rgb(1, 2, 3); }'), true)
  assert.equal(html.includes('<p class="md-p">正文</p>'), true)
  assert.equal(html.includes('标题 &lt;script&gt;alert(1)&lt;/script&gt;'), true)
  assert.equal(html.includes('<script>alert(1)</script>'), false)
  assert.equal(html.includes('<html lang="zh-CN">'), true)
})

test('exportPdf 真实生成 PDF 文件', async () => {
  const outPath = path.join(temporaryDirectory, 'document.pdf')
  await exportPdf({
    bodyHtml: '<h1 class="md-heading">导出测试</h1><p class="md-p">这是用于验证 PDF 导出的正文。</p>',
    title: '导出测试',
    css: 'body { font-family: sans-serif; } .md-heading { color: #222; }',
    outPath,
    options: {
      pageSize: { width: 210, height: 297 },
      margin: { top: 20, right: 18, bottom: 20, left: 18 },
      virtualTimeBudgetMs: 4_000,
      timeoutMs: 120_000
    }
  })
  const pdfStat = await stat(outPath)
  assert.equal(pdfStat.isFile(), true)
  assert.equal(pdfStat.size > 1000, true)
  const header = await readFile(outPath)
  assert.equal(header.subarray(0, 5).toString('latin1'), '%PDF-')
})

test('exportViaPandoc 真实生成 DOCX 文件', async () => {
  const outPath = path.join(temporaryDirectory, 'document.docx')
  await exportViaPandoc({
    markdown: '# 标题\n\n正文 **粗体**',
    to: 'docx',
    outPath,
    options: { timeoutMs: 120_000 }
  })
  const docxStat = await stat(outPath)
  assert.equal(docxStat.isFile(), true)
  assert.equal(docxStat.size > 1000, true)
  const signature = await readFile(outPath)
  assert.equal(signature.subarray(0, 2).toString('latin1'), 'PK')
})

test('exportHtmlFile 写入完整 HTML 文档', async () => {
  const outPath = path.join(temporaryDirectory, 'document.html')
  await exportHtmlFile({
    bodyHtml: '<p class="md-p">HTML 导出</p>',
    title: 'HTML 导出',
    css: '.md-p { color: rgb(10, 20, 30); }',
    outPath
  })
  const html = await readFile(outPath, 'utf8')
  assert.equal(html.includes('<!DOCTYPE html>'), true)
  assert.equal(html.includes('HTML 导出'), true)
  assert.equal(html.includes('.md-p { color: rgb(10, 20, 30); }'), true)
})
