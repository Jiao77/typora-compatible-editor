// 图表渲染：Mermaid 负责 mermaid 围栏，flowchart.js 负责 flow 围栏
// js-sequence-diagrams 负责 sequence 围栏，与 Typora 的真实实现保持一致

import mermaid from 'mermaid';

export const MERMAID_LANGS = new Set(['mermaid']);
export const FLOW_LANGS = new Set(['flow', 'flowchart']);
export const SEQUENCE_LANGS = new Set(['sequence']);
export const DIAGRAM_LANGS = new Set([...MERMAID_LANGS, ...FLOW_LANGS, ...SEQUENCE_LANGS]);

const VENDOR_BASE = '/vendor/diagrams';

function buildConfig(dark) {
  return {
    startOnLoad: false,
    securityLevel: 'loose',
    theme: dark ? 'dark' : 'default',
    fontFamily: 'inherit',
    flowchart: { htmlLabels: true, useMaxWidth: true },
    sequence: { useMaxWidth: true },
    gantt: { useMaxWidth: true }
  };
}

let initialized = false;
let counter = 0;
let vendorLoading = null;

export function initMermaid({ dark = false } = {}) {
  mermaid.initialize(buildConfig(dark));
  initialized = true;
  return mermaid;
}

// 按需加载 flowchart.js 与 js-sequence-diagrams 及其 Raphael 依赖
function loadVendor() {
  if (window.TyporaFlowchart && window.Diagram) return Promise.resolve();
  if (vendorLoading) return vendorLoading;

  const scripts = [
    `${VENDOR_BASE}/jquery.js`,
    `${VENDOR_BASE}/underscore.js`,
    `${VENDOR_BASE}/raphael.js`,
    `${VENDOR_BASE}/flowchart.js`,
    `${VENDOR_BASE}/sequence-diagram.js`
  ];

  vendorLoading = scripts.reduce(
    (chain, src) =>
      chain.then(
        () =>
          new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.async = false;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error(`图表依赖加载失败：${src}`));
            document.head.append(script);
          })
      ),
    Promise.resolve()
  );
  return vendorLoading;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderInto(preview, svgSource, id) {
  preview.innerHTML = svgSource;
  const svg = preview.querySelector('svg');
  if (svg && !svg.id) svg.id = id;
}

// 逐个渲染图表容器，失败时把真实错误写入面板而不是静默忽略
export async function renderDiagrams(root, { dark = false } = {}) {
  if (!initialized) initMermaid({ dark });
  const nodes = [...root.querySelectorAll('.md-diagram')];
  const results = [];
  const needsVendor = nodes.some((node) => {
    const lang = (node.getAttribute('lang') || '').toLowerCase();
    return FLOW_LANGS.has(lang) || SEQUENCE_LANGS.has(lang);
  });
  if (needsVendor) await loadVendor();

  for (const node of nodes) {
    const source = node.querySelector('.md-diagram-source');
    const preview = node.querySelector('.md-diagram-panel-preview');
    if (!source || !preview) continue;

    const lang = (node.getAttribute('lang') || 'mermaid').toLowerCase();
    const code = source.textContent || '';
    counter += 1;
    const id = `typora-diagram-${counter}`;

    try {
      if (FLOW_LANGS.has(lang)) {
        const chart = window.TyporaFlowchart.parse(code);
        chart.drawSVG(preview, { 'font-family': 'inherit' });
        node.classList.add('md-diagram-rendered');
        results.push({ id, ok: true });
        continue;
      }
      if (SEQUENCE_LANGS.has(lang)) {
        const diagram = window.Diagram.parse(code);
        const container = document.createElement('div');
        preview.append(container);
        diagram.drawSVG(container, { theme: dark ? 'hand' : 'simple' });
        node.classList.add('md-diagram-rendered');
        results.push({ id, ok: true });
        continue;
      }
      const { svg } = await mermaid.render(id, code);
      renderInto(preview, svg, id);
      node.classList.add('md-diagram-rendered');
      results.push({ id, ok: true });
    } catch (error) {
      preview.innerHTML = `<div class="md-diagram-panel-error">${escapeHtml(error.message)}</div>`;
      node.classList.add('md-diagram-error');
      results.push({ id, ok: false, message: error.message });
    }
  }

  return results;
}
