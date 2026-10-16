import { EditorView } from './editor-setup.js';
import { blockEditorExtensions, createBlockEditorState } from './editor-setup.js';
import { renderDiagrams } from './mermaid.js';
import { typesetMath } from './mathjax.js';

// Typora 式就地编辑：正文整体按块渲染，光标所在块切换为源码编辑器
// 文档源码是唯一数据源，切换块或按 Escape 时把块源码写回并重新拆分渲染

export class InPlaceEditor {
  constructor({ root, theme, onChange, onStatus }) {
    if (!root) throw new Error('就地编辑器需要 root 容器');
    this.root = root;
    this.theme = theme || 'github';
    this.source = '';
    this.blocks = [];
    this.activeIndex = null;
    this.blockEditor = null;
    this.onChange = onChange || (() => {});
    this.onStatus = onStatus || (() => {});
    this.renderVersion = 0;
    this.switching = false;
    this.composing = false;
    // 提交块之后需要恢复编辑状态时使用
    this.pendingActivate = null;
    this.pendingCaret = null;
    this.pendingCaretOffset = null;
    this.enabled = true;

    // 点击其它块时先提交当前块，再激活目标块，避免丢失未提交的编辑
    this.root.addEventListener('mousedown', (event) => {
      // 源码模式下由 textarea 接管输入，此处不再响应
      if (!this.enabled || this.composing) return;
      const element = event.target.closest('.md-block');
      if (!element) {
        if (this.activeIndex === null) return;
        event.preventDefault();
        this.commitActiveBlock();
        return;
      }
      const index = Number(element.dataset.blockIndex);
      if (!Number.isInteger(index) || index === this.activeIndex) return;
      event.preventDefault();
      element.dataset.pendingFocus = 'true';
      this.commitActiveBlock().then(() => {
        const target = this.root.querySelector(`.md-block[data-block-index="${index}"]`);
        if (target) delete target.dataset.pendingFocus;
        this.activateBlock(index);
      });
    });
  }

  setTheme(theme) {
    this.theme = theme;
  }

  // 切换就地编辑是否响应交互；关闭时先提交未保存内容
  async setEnabled(enabled) {
    if (this.enabled === enabled) return;
    if (!enabled) await this.commitActiveBlock();
    this.enabled = enabled;
  }

  async load(source) {
    this.source = String(source ?? '');
    this.activeIndex = null;
    this.destroyBlockEditor();
    await this.renderAll();
  }

  getSource() {
    return this.source;
  }

  // 从服务端获取块结构并渲染整篇文档
  async renderAll() {
    const version = ++this.renderVersion;
    const response = await fetch('/api/render-blocks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: this.source })
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `块渲染失败，状态码 ${response.status}`);
    }
    const payload = await response.json();
    if (version !== this.renderVersion) return;

    this.blocks = payload.blocks;
    this.paintBlocks();
    await this.enhanceRendered();

    // 提交后需要回到原块继续编辑时，恢复该块的编辑状态
    if (this.pendingActivate !== null && this.pendingActivate !== undefined) {
      const index = this.pendingActivate;
      const caret = this.pendingCaret;
      const offset = this.pendingCaretOffset;
      this.pendingActivate = null;
      this.pendingCaret = null;
      this.pendingCaretOffset = null;
      this.activateBlock(index, { caret, offset });
    }
  }

  // 把块渲染为 DOM：活动块替换为编辑器，其余块显示渲染结果
  paintBlocks() {
    this.destroyBlockEditor();
    this.root.innerHTML = '';

    for (const block of this.blocks) {
      const element = document.createElement('div');
      const primaryType = block.type.split(' ')[0];
      element.className = `md-block md-block-${primaryType}`;
      element.dataset.blockIndex = String(block.index);
      element.dataset.blockType = primaryType;
      element.dataset.blockTypeFull = block.type;

      if (block.index === this.activeIndex) {
        element.classList.add('md-block-active');
        element.dataset.source = block.source;
      } else {
        element.innerHTML = block.html;
      }
      this.root.append(element);
    }
  }

  // 对已渲染块补齐公式与图表
  // 每项都加超时保护：任一渲染器异常都不得阻塞整个界面初始化
  async enhanceRendered() {
    const dark = /night|dark/i.test(this.theme);
    const withTimeout = (promise, ms, label) =>
      Promise.race([
        promise,
        new Promise((resolve) => setTimeout(() => resolve(`${label}-timeout`), ms))
      ]);
    try {
      await withTimeout(renderDiagrams(this.root, { dark }), 15000, 'diagram');
    } catch (error) {
      this.onStatus(`图表渲染失败：${error.message}`, 'warn');
    }
    try {
      await withTimeout(typesetMath(this.root), 20000, 'math');
    } catch (error) {
      this.onStatus(`公式渲染失败：${error.message}`, 'warn');
    }
  }

  // 激活指定块：把渲染结果替换为源码编辑器
  activateBlock(index, { caret = 'end', offset = null } = {}) {
    if (index < 0 || index >= this.blocks.length) return;
    this.activeIndex = index;

    const element = this.root.querySelector(`.md-block[data-block-index="${index}"]`);
    if (!element) return;

    const block = this.blocks[index];
    element.classList.add('md-block-active');
    element.dataset.source = block.source;
    element.innerHTML = '';

    const keymapExtra = this.buildKeymap(index, element);

    this.blockEditor = new EditorView({
      parent: element,
      state: createBlockEditorState(
        block.source,
        blockEditorExtensions({
          onInput: (text) => {
            // 只更新待提交内容，不改写 blocks 里的原始源码
            // 否则提交时会误判为未修改，导致改写内容丢失
            element.dataset.source = text;
          },
          onEscape: () => this.commitActiveBlock(),
          onBlur: () => {
            // 输入法组合期间失焦不提交，避免打断中文输入
            if (this.composing) return;
            this.commitActiveBlock();
          },
          keymapExtra
        })
      )
    });

    this.blockEditor.focus();
    const docLength = this.blockEditor.state.doc.length;
    let position = caret === 'start' ? 0 : docLength;
    if (caret === 'custom' && Number.isInteger(offset)) {
      position = Math.min(offset, docLength);
    }
    this.blockEditor.dispatch({ selection: { anchor: position } });
    element.scrollIntoView({ block: 'nearest' });
  }

  // Enter 在当前块内分段并接续列表编号，Backspace 在块首合并到上一块
  buildKeymap(index, element) {
    return [
      {
        key: 'Enter',
        run: (view) => {
          const { from, to } = view.state.selection.main;
          const doc = view.state.doc.toString();
          const before = doc.slice(0, from);
          const after = doc.slice(to);
          const block = this.blocks[index];

          // 段落与标题：直接插入空行，提交时自然拆分为独立块
          // 不在按键过程中触发重绘，避免异步渲染期间丢失后续按键
          if (block.type === 'paragraph' || block.type.startsWith('heading') || block.type === 'block') {
            view.dispatch({
              changes: { from, to, insert: '\n\n' },
              selection: { anchor: from + 2 }
            });
            return true;
          }

          // 光标位于空行时参考上一行，保证列表末尾继续回车仍能接续标记
          let currentLine = view.state.doc.lineAt(from);
          let text = currentLine.text;
          let lineStart = currentLine.from;
          if (text.trim() === '' && currentLine.number > 1) {
            const previous = view.state.doc.line(currentLine.number - 1);
            if (previous.text.trim() !== '' && from === currentLine.from) {
              currentLine = previous;
              text = previous.text;
              lineStart = previous.from;
            }
          }
          const relativeStart = from - lineStart;
          const ordered = /^\s*(\d+)\.\s+/.exec(text);
          const unordered = /^\s*([-*+])\s+/.exec(text);
          const task = /^\s*([-*+])\s+\[[ xX]\]\s+/.exec(text);
          const marker = task || ordered || unordered;

          // 在列表标记前按回车时清除标记，结束当前列表
          if (marker && relativeStart < marker[0].length) {
            view.dispatch({
              changes: { from: lineStart, to: from, insert: '' },
              selection: { anchor: lineStart }
            });
            return true;
          }

          let prefix = '';
          if (task) prefix = `${task[1]} [ ] `;
          else if (ordered) prefix = `${Number(ordered[1]) + 1}. `;
          else if (unordered) prefix = `${unordered[1]} `;

          view.dispatch({
            changes: { from, to, insert: `\n${prefix}` },
            selection: { anchor: from + 1 + prefix.length }
          });
          return true;
        }
      },
      {
        key: 'Shift-Enter',
        run: (view) => {
          // 软换行：在段落内插入换行而不新建块
          const { from, to } = view.state.selection.main;
          view.dispatch({
            changes: { from, to, insert: '\n' },
            selection: { anchor: from + 1 }
          });
          return true;
        }
      },
      {
        key: 'Backspace',
        run: (view) => {
          const { from, to } = view.state.selection.main;
          if (from !== 0 || to !== 0) return false;
          const text = view.state.doc.toString();
          // 块非空时只删除字符，块为空时合并到上一块
          if (text.length > 0) return false;
          this.mergeWithPreviousBlock(index);
          return true;
        }
      },
      {
        key: 'ArrowUp',
        run: (view) => {
          const { from } = view.state.selection.main;
          if (from !== 0) return false;
          this.commitActiveBlock({ nextIndex: index - 1, nextCaret: 'end' });
          return true;
        }
      },
      {
        key: 'ArrowDown',
        run: (view) => {
          const { from } = view.state.selection.main;
          if (from !== view.state.doc.length) return false;
          this.commitActiveBlock({ nextIndex: index + 1, nextCaret: 'start' });
          return true;
        }
      }
    ];
  }

  // 把当前块合并到上一块，光标停在接缝处
  async mergeWithPreviousBlock(index) {
    if (index <= 0) return;
    const previous = this.blocks[index - 1];
    const current = this.blocks[index];
    const merged = `${previous.source}\n${current.source}`;
    const caret = previous.source.length + 1;

    this.activeIndex = null;
    this.destroyBlockEditor();
    // 两个块在源码中是连续区间，一次性替换，避免行号失效
    this.source = replaceRange(this.source, previous.startLine, current.endLine, merged);
    this.onChange(this.source);
    this.pendingActivate = index - 1;
    this.pendingCaret = 'custom';
    this.pendingCaretOffset = caret;
    await this.renderAll();
  }

  // 结束当前块编辑：把源码写回文档并重新渲染
  async commitActiveBlock({ nextIndex = null, nextCaret = 'end' } = {}) {
    if (this.activeIndex === null) {
      if (nextIndex !== null) this.activateBlock(nextIndex, { caret: nextCaret });
      return;
    }
    const index = this.activeIndex;
    const block = this.blocks[index];
    const element = this.root.querySelector(`.md-block[data-block-index="${index}"]`);
    const edited = element && element.dataset.source !== undefined
      ? element.dataset.source
      : (this.blockEditor ? this.blockEditor.state.doc.toString() : block.source);

    this.activeIndex = null;
    this.destroyBlockEditor();

    if (edited === block.source) {
      if (nextIndex !== null) {
        this.activateBlock(nextIndex, { caret: nextCaret });
        return;
      }
      await this.renderAll();
      return;
    }

    this.source = replaceRange(this.source, block.startLine, block.endLine, edited);
    this.onChange(this.source);
    this.pendingActivate = nextIndex;
    this.pendingCaret = nextCaret;
    await this.renderAll();
  }

  // 销毁编辑器实例，解除根容器上的监听
  dispose() {
    this.destroyBlockEditor();
    this.enabled = false;
  }

  destroyBlockEditor() {
    if (this.blockEditor) {
      this.blockEditor.destroy();
      this.blockEditor = null;
    }
  }

  handleCompositionStart() {
    this.composing = true;
  }

  handleCompositionEnd() {
    this.composing = false;
  }
}

// 用新内容替换源码中 [startLine, endLine) 的行区间
export function replaceRange(source, startLine, endLine, replacement) {
  const lines = source.split('\n');
  const head = lines.slice(0, startLine);
  const tail = lines.slice(endLine);
  return [...head, ...replacement.split('\n'), ...tail].join('\n');
}

export default InPlaceEditor;
