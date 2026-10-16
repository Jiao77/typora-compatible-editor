// 导出用渲染脚本，由 Chrome 无头模式加载后执行公式排版与图表渲染
// 渲染完成后写入标记，供导出流程判定 DOM 已经稳定

const MERMAID_LANGS = new Set(['mermaid']);
const FLOW_LANGS = new Set(['flow', 'flowchart']);
const SEQUENCE_LANGS = new Set(['sequence']);

function isDark() {
  return document.documentElement.dataset.dark === 'true';
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function renderDiagrams() {
  const mermaid = window.mermaid;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    theme: isDark() ? 'dark' : 'default',
    fontFamily: 'inherit',
    flowchart: { htmlLabels: true, useMaxWidth: true },
    sequence: { useMaxWidth: true },
    gantt: { useMaxWidth: true }
  });

  const nodes = document.querySelectorAll('.md-diagram');
  let index = 0;

  for (const node of nodes) {
    const source = node.querySelector('.md-diagram-source');
    const preview = node.querySelector('.md-diagram-panel-preview');
    if (!source || !preview) continue;

    const lang = (node.getAttribute('lang') || 'mermaid').toLowerCase();
    const code = source.textContent || '';
    index += 1;

    if (FLOW_LANGS.has(lang)) {
      const chart = window.TyporaFlowchart.parse(code);
      chart.drawSVG(preview, { 'font-family': 'inherit' });
    } else if (SEQUENCE_LANGS.has(lang)) {
      const diagram = window.Diagram.parse(code);
      const container = document.createElement('div');
      preview.append(container);
      diagram.drawSVG(container, { theme: isDark() ? 'hand' : 'simple' });
    } else {
      const { svg } = await mermaid.render(`export-mermaid-${index}`, code);
      preview.innerHTML = svg;
    }

    node.classList.add('md-diagram-rendered');
    // 导出结果只保留固化图表，移除围栏源码
    const fence = node.querySelector('pre.md-fences');
    if (fence) fence.remove();
    else source.remove();
  }
  return index;
}

async function typesetMath() {
  if (!window.MathJax) return 0;
  const mathJax = window.MathJax;
  await mathJax.startup.promise;
  const root = document.querySelector('#write') || document.body;
  mathJax.typesetClear([root]);
  await mathJax.typesetPromise([root]);
  return root.querySelectorAll('mjx-container').length;
}

async function run() {
  const summary = { math: 0, diagrams: 0, errors: [] };
  try {
    summary.diagrams = await renderDiagrams();
  } catch (error) {
    summary.errors.push(`图表渲染失败：${error.message}`);
  }
  try {
    summary.math = await typesetMath();
  } catch (error) {
    summary.errors.push(`公式渲染失败：${error.message}`);
  }
  document.documentElement.dataset.renderState = summary.errors.length ? 'partial' : 'complete';
  document.documentElement.dataset.renderSummary = JSON.stringify(summary);
}

run();
