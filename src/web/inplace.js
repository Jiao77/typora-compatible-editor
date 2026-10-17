import {
  EditorState,
  EditorView,
  StateField,
  StateEffect,
  RangeSetBuilder,
  Decoration,
  WidgetType,
  createEditorExtensions
} from './editor-setup.js';
import { renderDiagrams } from './mermaid.js';
import { typesetMath } from './mathjax.js';
import { resolveDocumentImages } from './document-images.js';
import { parseBlocks } from '../server/blocks.js';
import { markdownIt } from '../server/render.js';

// 用于向 CodeMirror 事务注入最新解析的语法块集合
const setBlocksEffect = StateEffect.define();

// 预览部件：将非活动行或语法块替换为标准渲染 DOM
class BlockPreviewWidget extends WidgetType {
  constructor(editor, block, html, lineStart, lineEnd) {
    super();
    this.editor = editor;
    this.block = block;
    this.html = html;
    this.lineStart = lineStart;
    this.lineEnd = lineEnd;
  }

  eq(other) {
    return (
      this.block.source === other.block.source &&
      this.html === other.html &&
      this.lineStart === other.lineStart &&
      this.lineEnd === other.lineEnd
    );
  }

  toDOM(view) {
    const wrap = document.createElement('div');
    const primaryType = (this.block.type || 'block').split(' ')[0];
    wrap.className = `md-block md-block-${primaryType}`;
    wrap.dataset.blockIndex = String(this.block.index);
    wrap.dataset.blockType = primaryType;
    wrap.dataset.lineStart = String(this.lineStart);
    wrap.dataset.lineEnd = String(this.lineEnd);
    wrap.innerHTML = this.html;

    // 同步改写图片本地路径为 HTTP
    if (typeof resolveDocumentImages === 'function') {
      resolveDocumentImages(wrap, this.editor.documentPath);
    }

    // 对新挂载的图表与数学公式进行防抖去重增强
    const blockType = this.block.type || '';
    if (
      blockType.startsWith('diagram') ||
      blockType === 'math-block' ||
      wrap.querySelector('.md-diagram, .md-inline-math, .md-math-block, .md-rawblock-container, .math-jax-preprocess')
    ) {
      this.editor.scheduleEnhancement(wrap);
    }

    // 解除渲染器默认附带的 disabled 属性以允许交互
    const checkboxes = Array.from(wrap.querySelectorAll('input[type="checkbox"]'));
    for (const cb of checkboxes) {
      cb.disabled = false;
    }

    // 点击复选框时支持在源码中切换对应项状态
    wrap.addEventListener('change', (event) => {
      const checkbox = event.target.closest('input[type="checkbox"]');
      if (!checkbox) return;
      let targetLine = this.lineStart;
      if (this.lineStart === this.lineEnd) {
        targetLine = this.lineStart;
      } else {
        const allBoxes = Array.from(wrap.querySelectorAll('input[type="checkbox"]'));
        const boxIndex = allBoxes.indexOf(checkbox);
        if (boxIndex >= 0 && this.block.taskLines && this.block.taskLines[boxIndex]) {
          targetLine = this.block.taskLines[boxIndex];
        }
      }
      const docLines = view.state.doc.lines;
      if (targetLine >= 1 && targetLine <= docLines) {
        const line = view.state.doc.line(targetLine);
        const text = line.text;
        const taskMatch = /^(\s*[-*+]\s+\[)([ xX])(\]\s*)/.exec(text);
        if (taskMatch) {
          const nextChar = checkbox.checked ? 'x' : ' ';
          const from = line.from + taskMatch[1].length;
          const to = from + 1;
          view.dispatch({
            changes: { from, to, insert: nextChar }
          });
        }
      }
    });

    // 点击预览区域自动聚焦并切换到源码行
    wrap.addEventListener('mousedown', (event) => {
      // 仅响应鼠标左键点击；右键交由菜单处理
      if (event.button !== 0 || event.target.closest('a') || event.target.closest('input[type="checkbox"]')) {
        return;
      }
      event.preventDefault();
      this.editor.isFocused = true;
      const docLines = view.state.doc.lines;
      if (this.lineStart >= 1 && this.lineStart <= docLines) {
        const line = view.state.doc.line(this.lineStart);
        view.dispatch({
          selection: { anchor: line.from },
          scrollIntoView: true
        });
        view.focus();
      }
    });

    return wrap;
  }
}

// 基于当前光标位置计算全篇预览装饰器
function computeDecorations(state, editor) {
  const builder = new RangeSetBuilder();
  const doc = state.doc;
  const docLines = doc.lines;
  if (docLines === 0) return builder.finish();

  const selection = state.selection.main;
  const cursorHead = selection.head;
  const selFrom = selection.from;
  const selTo = selection.to;

  const cursorLine = doc.lineAt(cursorHead).number;
  const selStartLine = doc.lineAt(selFrom).number;
  const selEndLine = doc.lineAt(selTo).number;

  // 初始无焦点时整篇显示完整渲染预览；通过实际 focus 状态保持一致
  const isFocused = (editor.view ? editor.view.hasFocus : editor.isFocused) && editor.enabled;
  editor.isFocused = isFocused;

  // 同步计算语法块，共享整篇 parse 的 env 以保障跨行引用与脚注
  const docText = doc.toString();
  const env = {};
  const parsed = parseBlocks(docText, env);
  const blocks = parsed.blocks || [];
  editor.blocks = blocks;

  for (const block of blocks) {
    // 校验块在当前文档中的行号有效性
    const bStartLine = block.startLine + 1; // 转换为 1-based
    const bEndLine = Math.min(block.endLine, docLines);

    if (bStartLine > docLines || bStartLine > bEndLine) continue;

    // 空行始终保持原生 CodeMirror 行，保留光标高度，不附加装饰器
    if (block.type === 'empty' || (bStartLine === bEndLine && doc.line(bStartLine).text.trim() === '')) {
      continue;
    }

    const isBlockActive = isFocused && selStartLine <= bEndLine && selEndLine >= bStartLine;

    // 当整个语义块不包含光标时：
    // 普通多行段落按物理行独立生成预览部件，确保点击各行时能够精确进入对应行；
    // 其它结构（复杂块、单行标题、TOC等）整块替换为单次完整预览
    if (!isBlockActive) {
      if (bEndLine > bStartLine && (block.type === 'paragraph' || block.type.startsWith('paragraph'))) {
        for (let lineNum = bStartLine; lineNum <= bEndLine; lineNum++) {
          const line = doc.line(lineNum);
          const lineText = line.text;
          if (lineText.trim() === '') continue;
          const from = line.from;
          const to = line.to;
          const lineHtml = `<p class="md-end-block md-p">${markdownIt.renderInline(lineText, env)}</p>`;
          if (from < to) {
            builder.add(
              from,
              to,
              Decoration.replace({
                widget: new BlockPreviewWidget(editor, block, lineHtml, lineNum, lineNum),
                block: true,
                inclusive: false,
                inclusiveStart: false,
                inclusiveEnd: false
              })
            );
          }
        }
        continue;
      }

      const from = doc.line(bStartLine).from;
      const to = doc.line(bEndLine).to;
      if (from < to) {
        builder.add(
          from,
          to,
          Decoration.replace({
            widget: new BlockPreviewWidget(editor, block, block.html, bStartLine, bEndLine),
            block: true,
            inclusive: false,
            inclusiveStart: false,
            inclusiveEnd: false
          })
        );
      }
      continue;
    }

    // 当语义块处于活动状态时：仅光标所在行展开为源码，块内其余非光标行显示行级渲染预览
    const isComplex =
      block.type === 'math-block' ||
      block.type === 'table' ||
      block.type.startsWith('diagram') ||
      block.type.startsWith('code');

    if (isComplex && bEndLine > bStartLine) {
      // 复杂语义块不逐行拆分破坏公式与表格；保留整块完整渲染预览，仅展开选中的物理行源码
      const previewTargetLine = selStartLine > bStartLine ? bStartLine : bEndLine;
      for (let lineNum = bStartLine; lineNum <= bEndLine; lineNum++) {
        const isLineActive = selStartLine <= lineNum && selEndLine >= lineNum;
        if (isLineActive) continue;

        const line = doc.line(lineNum);
        const from = line.from;
        const to = line.to;

        if (from < to) {
          const html = lineNum === previewTargetLine ? block.html : '<div class="md-complex-placeholder"></div>';
          builder.add(
            from,
            to,
            Decoration.replace({
              widget: new BlockPreviewWidget(editor, block, html, lineNum, lineNum),
              block: true,
              inclusive: false,
              inclusiveStart: false,
              inclusiveEnd: false
            })
          );
        }
      }
      continue;
    }

    for (let lineNum = bStartLine; lineNum <= bEndLine; lineNum++) {
      const isLineActive = selStartLine <= lineNum && selEndLine >= lineNum;
      if (isLineActive) {
        continue;
      }

      const line = doc.line(lineNum);
      const lineText = line.text;
      if (lineText.trim() === '') {
        continue;
      }

      let lineHtml = '';
      if (block.type.startsWith('list')) {
        lineHtml = markdownIt.render(lineText, {});
      } else if (block.type.startsWith('heading')) {
        lineHtml = markdownIt.render(lineText, {});
      } else if (block.type.startsWith('quote') || block.type.startsWith('alert')) {
        lineHtml = markdownIt.render(lineText, {});
      } else if (block.type.startsWith('code') || block.type.startsWith('diagram')) {
        lineHtml = `<pre class="md-fences mock-cm md-end-block"><code>${escapeHtml(lineText)}</code></pre>`;
      } else {
        lineHtml = `<p class="md-end-block md-p">${markdownIt.renderInline(lineText, {})}</p>`;
      }

      const from = line.from;
      const to = line.to;

      if (from < to) {
        builder.add(
          from,
          to,
          Decoration.replace({
            widget: new BlockPreviewWidget(editor, block, lineHtml, lineNum, lineNum),
            block: true,
            inclusive: false,
            inclusiveStart: false,
            inclusiveEnd: false
          })
        );
      }
    }
  }

  return builder.finish();
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export class InPlaceEditor {
  constructor({ root, theme, onChange, onStatus, documentPath }) {
    if (!root) throw new Error('就地编辑器需要 root 容器');
    this.root = root;
    this.theme = theme || 'github';
    this.documentPath = documentPath || null;
    this.source = '';
    this.blocks = [];
    this.view = null;
    this.onChange = onChange || (() => {});
    this.onStatus = onStatus || (() => {});
    this.enabled = true;
    this.isFocused = false;
    this.enhanceTimer = null;
    this.pendingRoots = new Set();
    this.activeEnhancePromise = null;
    this.hasPendingEnhance = false;
    this.currentActiveIndex = 0;

    // 创建持久化的 StateField 驱动块级渲染装饰
    const self = this;
    this.previewField = StateField.define({
      create(state) {
        return computeDecorations(state, self);
      },
      update(decos, tr) {
      let hasEffect = false;
        for (const effect of tr.effects) {
        if (effect.is(setBlocksEffect)) hasEffect = true;
        }
      if (tr.docChanged || tr.selection || hasEffect) {
          return computeDecorations(tr.state, self);
        }
        return decos;
      },
      provide: (field) => EditorView.decorations.from(field)
    });
  }

  setDocumentPath(path) {
    this.documentPath = path || null;
    if (this.root && typeof resolveDocumentImages === 'function') {
    resolveDocumentImages(this.root, this.documentPath);
    }
  }

  setTheme(theme) {
    this.theme = theme;
  }

  async setEnabled(enabled) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
  if (this.view) {
    this.view.dispatch({ effects: setBlocksEffect.of(null) });
  }
  }

  getSource() {
    return this.view ? this.view.state.doc.toString() : this.source;
  }

  // 供 toolbar insertText 以及外部访问当前活动的 CodeMirror 实例
  get blockEditor() {
    return this.view;
  }

  get activeIndex() {
    if (!this.view) return this.currentActiveIndex;
  const head = this.view.state.selection.main.head;
  const line = this.view.state.doc.lineAt(head).number - 1; // 0-based
  const found = this.blocks.find((b) => line >= b.startLine && line < b.endLine);
  return found ? found.index : 0;
  }

  async load(source) {
    this.source = String(source ?? '');
  this.isFocused = Boolean(this.view && this.view.hasFocus);
  this.blocks = parseBlocks(this.source).blocks || [];

    if (!this.view) {
      this.initView(this.source);
    } else {
      const currentDoc = this.view.state.doc.toString();
      if (currentDoc !== this.source) {
        this.view.dispatch({
          changes: { from: 0, to: currentDoc.length, insert: this.source },
          selection: { anchor: 0 }
        });
      }
    this.view.dispatch({ effects: setBlocksEffect.of(null) });
    }

    await this.enhanceRendered();
  }

  initView(docText) {
    this.root.innerHTML = '';
  const self = this;
    const extensions = createEditorExtensions({
      onDocChange: (text) => {
        this.source = text;
        this.onChange(text);
      },
    onSelectionChange: () => {},
      onEscape: () => {
      this.isFocused = false;
      if (this.view) {
        this.view.dispatch({ effects: setBlocksEffect.of(null) });
        this.view.contentDOM.blur();
      }
      },
    extraPlugins: [
      this.previewField,
      EditorView.domEventHandlers({
        focus: (event, view) => {
          if (!self.isFocused) {
            self.isFocused = true;
            view.dispatch({ effects: setBlocksEffect.of(null) });
          }
          return false;
        },
        blur: (event, view) => {
          if (self.isFocused) {
            self.isFocused = false;
            view.dispatch({ effects: setBlocksEffect.of(null) });
          }
          return false;
        }
      })
    ]
    });

    this.view = new EditorView({
      parent: this.root,
      state: EditorState.create({
        doc: docText,
        extensions
      })
    });
  }

  scheduleEnhancement(targetRoot) {
    if (targetRoot) {
      this.pendingRoots.add(targetRoot);
    } else if (this.root) {
      this.pendingRoots.add(this.root);
    }
    this.hasPendingEnhance = true;
    if (this.enhanceTimer) clearTimeout(this.enhanceTimer);
    this.enhanceTimer = setTimeout(() => {
      this.enhanceTimer = null;
      this.drainEnhanceQueue();
    }, 50);
  }

  async enhanceRendered(targetRoot) {
    if (targetRoot) {
      this.pendingRoots.add(targetRoot);
    } else if (this.root) {
      this.pendingRoots.add(this.root);
    }
    this.hasPendingEnhance = true;
    if (this.enhanceTimer) {
      clearTimeout(this.enhanceTimer);
      this.enhanceTimer = null;
    }
    return this.drainEnhanceQueue();
  }

  async drainEnhanceQueue() {
    if (this.activeEnhancePromise) {
      return this.activeEnhancePromise;
    }
    this.activeEnhancePromise = (async () => {
      while (this.hasPendingEnhance || this.pendingRoots.size > 0) {
        if (this.enhanceTimer) {
          clearTimeout(this.enhanceTimer);
          this.enhanceTimer = null;
        }
        this.hasPendingEnhance = false;
        const roots = Array.from(this.pendingRoots);
        this.pendingRoots.clear();

        const targets = roots.length === 0 || roots.includes(this.root)
          ? [this.root]
          : roots;

        const dark = /night|dark/i.test(this.theme);
        const withTimeout = (promise, ms, label) =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              reject(new Error(`${label} 渲染超时（超过 ${ms}ms）`));
            }, ms);
            promise.then(
              (val) => { clearTimeout(timer); resolve(val); },
              (err) => { clearTimeout(timer); reject(err); }
            );
          });

        for (const target of targets) {
          if (!target || (target.isConnected === false && target !== this.root)) continue;

          const hasDiagram = (target.classList && target.classList.contains('md-diagram'))
            ? !target.classList.contains('md-diagram-rendered')
            : target.querySelector('.md-diagram:not(.md-diagram-rendered)');

          if (hasDiagram) {
            try {
              await withTimeout(renderDiagrams(target, { dark }), 15000, 'diagram');
            } catch (error) {
              this.onStatus(`图表渲染失败：${error.message}`, 'warn');
            }
          }

          const hasMath = target.querySelector('.md-inline-math, .md-math-block, .md-rawblock-container, .math-jax-preprocess') ||
            (target.classList && (target.classList.contains('md-inline-math') || target.classList.contains('md-math-block')));

          if (hasMath) {
            try {
              await withTimeout(typesetMath(target), 20000, 'math');
            } catch (error) {
              this.onStatus(`公式渲染失败：${error.message}`, 'warn');
            }
          }

          if (typeof resolveDocumentImages === 'function') {
            resolveDocumentImages(target, this.documentPath);
          }
        }
      }
    })().finally(() => {
      this.activeEnhancePromise = null;
    });

    return this.activeEnhancePromise;
  }

  async commitActiveBlock() {
    if (this.view && this.view.contentDOM) {
      this.view.contentDOM.blur();
    }
    this.isFocused = false;
    if (this.enhanceTimer) {
      clearTimeout(this.enhanceTimer);
      this.enhanceTimer = null;
    }
    if (this.view) {
      this.view.dispatch({ effects: setBlocksEffect.of(null) });
      await this.enhanceRendered();
    }
  }

  dispose() {
    if (this.enhanceTimer) {
      clearTimeout(this.enhanceTimer);
      this.enhanceTimer = null;
    }
    this.pendingRoots.clear();
    this.hasPendingEnhance = false;
    if (this.view) {
      this.view.destroy();
      this.view = null;
    }
    this.enabled = false;
  }
}

// 保持 replaceRange 导出以保证测试兼容
export function replaceRange(source, startLine, endLine, replacement) {
  const lines = source.split('\n');
  const head = lines.slice(0, startLine);
  const tail = lines.slice(endLine);
  return [...head, ...replacement.split('\n'), ...tail].join('\n');
}

export default InPlaceEditor;
