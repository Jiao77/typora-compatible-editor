import {
  EditorState,
  EditorView,
  StateField,
  StateEffect,
  RangeSetBuilder,
  Decoration,
  createEditorExtensions
} from './editor-setup.js';
import { renderDiagrams } from './mermaid.js';
import { typesetMath } from './mathjax.js';
import { resolveDocumentImages } from './document-images.js';
import { parseBlocks } from '../server/blocks.js';
import { markdownIt } from '../server/render.js';

// 用于控制当前活动编辑区间的 StateEffect
export const setActiveRangeEffect = StateEffect.define();

// 存储活动行/块在全篇 doc 中的起止字符位置
export const activeRangeField = StateField.define({
  create() {
    return null;
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setActiveRangeEffect)) {
        return effect.value;
      }
    }
    if (value && tr.docChanged) {
      return {
        from: tr.changes.mapPos(value.from, -1),
        to: tr.changes.mapPos(value.to, 1)
      };
    }
    return value;
  }
});

// 使用 Decoration.replace 将活动范围外的行完全隐藏，保留全篇 doc、状态与 undo 历史
export const hideRangeDecoField = StateField.define({
  create(state) {
    return buildRangeDecos(state, state.field(activeRangeField));
  },
  update(decos, tr) {
    return buildRangeDecos(tr.state, tr.state.field(activeRangeField));
  },
  provide: (field) => EditorView.decorations.from(field)
});

function buildRangeDecos(state, activeRange) {
  if (!activeRange) {
    return Decoration.none;
  }
  const builder = new RangeSetBuilder();
  const docLen = state.doc.length;
  const from = Math.max(0, Math.min(activeRange.from, docLen));
  const to = Math.max(from, Math.min(activeRange.to, docLen));

  const startLine = state.doc.lineAt(from);
  const endLine = state.doc.lineAt(to);

  if (startLine.number > 1) {
    const isStartEmpty = startLine.from === startLine.to;
    const topEnd = isStartEmpty ? state.doc.line(startLine.number - 1).to : from;
    if (topEnd > 0) {
      builder.add(0, topEnd, Decoration.replace({ block: true }));
    }
  }
  if (endLine.number < state.doc.lines) {
    const isEndEmpty = endLine.from === endLine.to;
    const bottomStart = isEndEmpty ? state.doc.line(endLine.number + 1).from : to;
    if (bottomStart < docLen) {
      builder.add(bottomStart, docLen, Decoration.replace({ block: true }));
    }
  }

  return builder.finish();
}

// 仅对用户鼠标点击选择（select.pointer）限制在当前活动槽区间内，防止落空时跳转全篇文档末尾
export const pointerClampFilter = EditorState.transactionFilter.of((tr) => {
  const activeRange = tr.startState.field(activeRangeField, false);
  if (!activeRange) return tr;
  if (!tr.isUserEvent('select.pointer')) return tr;
  if (!tr.selection) return tr;

  const from = activeRange.from;
  const to = activeRange.to;
  const sel = tr.newSelection.main;
  const anchor = Math.max(from, Math.min(sel.anchor, to));
  const head = Math.max(from, Math.min(sel.head, to));

  if (anchor !== sel.anchor || head !== sel.head) {
    return [tr, { selection: { anchor, head }, sequential: true }];
  }
  return tr;
});

function isComplexBlock(block) {
  const type = block.type || "";
  return (
    type === "math-block" ||
    type === "table" ||
    type === "html" ||
    type === "deflist" ||
    type === "footnote" ||
    type.startsWith("diagram") ||
    type.startsWith("code") ||
    type.startsWith("list")
  );
}

// 将 Markdown 文档拆分为槽位：普通文本按物理行划分，复杂块整体为一个槽位
function buildSlots(docText, env = {}) {
  const parsed = parseBlocks(docText, env);
  const blocks = parsed.blocks || [];
  const lines = docText.split('\n');
  const slots = [];

  for (const block of blocks) {
    let footnoteRefIndex = 0;
    const isComplex = isComplexBlock(block);
    const bStartLine = block.startLine; // 0-based
    const bEndLine = block.endLine;     // 0-based exclusive

    if (isComplex || bEndLine - bStartLine <= 1) {
      slots.push({
        id: `slot-${block.index}-${bStartLine}-${bEndLine}`,
        blockIndex: block.index,
        blockType: (block.type || 'block').split(' ')[0],
        fullType: block.type,
        startLine: bStartLine,
        endLine: bEndLine,
        isComplex,
        html: block.html,
        source: block.source,
        taskLines: block.taskLines,
        footnoteIndex: block.footnoteIndex,
        block
      });
    } else {
      for (let lineIdx = bStartLine; lineIdx < bEndLine; lineIdx++) {
        const lineText = lines[lineIdx] ?? '';
        let lineHtml = '';
        if (lineText.trim() === '') {
          lineHtml = '<div class="md-empty-line md-end-block"></div>';
        } else if (block.type === 'paragraph' || block.type.startsWith('paragraph')) {
          const localEnv = {
            ...env,
            footnotes: env.footnotes
              ? {
                  ...env.footnotes,
                  refs: { ...env.footnotes.refs },
                  list: env.footnotes.list?.map((note) => ({ ...note }))
                }
              : undefined
          };
          const inlineToken = markdownIt.parseInline(lineText, localEnv)[0];
          for (const child of inlineToken.children) {
            if (child.type === 'footnote_ref') {
              child.meta = { ...block.footnoteRefs[footnoteRefIndex++] };
            }
          }
          const renderedText = markdownIt.renderer.renderInline(inlineToken.children, markdownIt.options, localEnv);
          lineHtml = `<p class="md-end-block md-p">${renderedText}</p>`;
        } else if (block.type.startsWith('list')) {
          lineHtml = markdownIt.render(lineText, {});
        } else if (block.type.startsWith('quote') || block.type.startsWith('alert')) {
          lineHtml = markdownIt.render(lineText, {});
        } else {
          lineHtml = markdownIt.render(lineText, {});
        }

        slots.push({
          id: `slot-${block.index}-l-${lineIdx}`,
          blockIndex: block.index,
          blockType: (block.type || 'block').split(' ')[0],
          fullType: block.type,
          startLine: lineIdx,
          endLine: lineIdx + 1,
          isComplex: false,
          html: lineHtml,
          source: lineText,
          taskLines: block.taskLines,
          block
        });
      }
    }
  }

  if (slots.length === 0) {
    slots.push({
      id: 'slot-0-0-1',
      blockIndex: 0,
      blockType: 'empty',
      fullType: 'empty',
      startLine: 0,
      endLine: 1,
      isComplex: false,
      html: '<div class="md-empty-line md-end-block"></div>',
      source: '',
      taskLines: undefined,
      block: { index: 0, type: 'empty', startLine: 0, endLine: 1, source: '', html: '' }
    });
  }

  return { blocks, slots, lineCount: lines.length, footnotesHtml: parsed.footnotesHtml };
}

export class InPlaceEditor {
  constructor({ root, theme, onChange, onStatus, documentPath }) {
    if (!root) throw new Error('就地编辑器需要 root 容器');
    this.root = root;
    this.theme = theme || 'github';
    this.documentPath = documentPath || null;
    this.source = '';
    this.blocks = [];
    this.slots = [];
    this.view = null;
    this.onChange = onChange || (() => {});
    this.onStatus = onStatus || (() => {});
    this.enabled = true;

    this.activeSlot = null;
    this.activeSlotEl = null;
    this.activeSlotDirty = false;
    this.isSwitchingSlot = false;
    this.isSyncScheduled = false;
    this.isSelectionSyncScheduled = false;

    this.editorLayer = document.createElement('div');
    this.editorLayer.className = 'md-slot-editor-layer';

    this.stagingContainer = document.createElement('div');
    this.stagingContainer.style.display = 'none';
    document.body.appendChild(this.stagingContainer);

    this.enhanceTimer = null;
    this.pendingRoots = new Set();
    this.activeEnhancePromise = null;
    this.hasPendingEnhance = false;

    this.lastWheelTime = 0;
    this.wheelOwner = null;
    this.wheelDirection = 0;

    this.handleWheel = this.handleWheel.bind(this);
    this.handleSlotMouseDown = this.handleSlotMouseDown.bind(this);
    this.handleSlotChange = this.handleSlotChange.bind(this);

    this.mousedownTarget = this.root.closest('.scroll-host') || this.root;
    this.mousedownTarget.addEventListener('mousedown', this.handleSlotMouseDown);
    this.root.addEventListener('change', this.handleSlotChange);
    this.editorLayer.addEventListener('wheel', this.handleWheel, { passive: false });
  }

  get blockEditor() {
    return this.view;
  }

  get activeIndex() {
    if (this.activeSlot) return this.activeSlot.blockIndex;
    if (!this.view) return 0;
    const head = this.view.state.selection.main.head;
    const line = this.view.state.doc.lineAt(head).number - 1;
    const found = this.blocks.find((b) => line >= b.startLine && line < b.endLine);
    return found ? found.index : 0;
  }

  getSource() {
    return this.view ? this.view.state.doc.toString() : this.source;
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
    if (!this.enabled && this.activeSlot) {
      await this.commitActiveBlock();
    }
  }

  async load(source) {
    this.isSwitchingSlot = true;
    try {
      if (this.activeSlotEl) {
        this.activeSlotEl.classList.remove('is-active');
        this.activeSlotEl.style.height = '';
      }
      this.stagingContainer.appendChild(this.editorLayer);
      this.activeSlot = null;
      this.activeSlotEl = null;
      this.activeSlotDirty = false;

      this.source = String(source ?? '');
      const { blocks, slots, footnotesHtml } = buildSlots(this.source);
      this.blocks = blocks;
      this.slots = slots;
      this.footnotesHtml = footnotesHtml;

      if (!this.view) {
        this.initView(this.source);
      } else {
        const currentDoc = this.view.state.doc.toString();
        if (currentDoc !== this.source) {
          this.view.dispatch({
            changes: { from: 0, to: currentDoc.length, insert: this.source },
            effects: setActiveRangeEffect.of(null),
            selection: { anchor: 0 }
          });
        } else {
          this.view.dispatch({
            effects: setActiveRangeEffect.of(null)
          });
        }
      }

      this.renderSlots();
    } finally {
      this.isSwitchingSlot = false;
    }

    await this.enhanceRendered();
  }

  initView(docText) {
    const self = this;
    const extensions = createEditorExtensions({
      onDocChange: (text) => {
        self.source = text;
        self.onChange(text);

        if (!self.activeSlot) {
          // 无活跃槽位时的外部变更（如图片操作或全局派发）：刷新槽位与预览
          if (!self.isSyncScheduled) {
            self.isSyncScheduled = true;
            queueMicrotask(() => {
              self.isSyncScheduled = false;
              if (!self.view) return;
              const { blocks, slots, footnotesHtml } = buildSlots(self.view.state.doc.toString());
              self.blocks = blocks;
              self.slots = slots;
              self.footnotesHtml = footnotesHtml;
              self.renderSlots();
              self.enhanceRendered();
            });
          }
          return;
        }

        self.activeSlotDirty = true;

        // 检测行数结构变化
        const prevLines = self.slots.reduce((max, s) => Math.max(max, s.endLine), 0);
        const currLines = self.view ? self.view.state.doc.lines : prevLines;
        const diff = currLines - prevLines;

        if (diff !== 0) {
          if (self.activeSlot) {
            // 所有活动槽位内换行：先保持当前槽位活动状态，原地累加行偏移并平移后续槽位，不立即重构分块
            self.activeSlot.endLine += diff;
            const activeIdx = self.slots.indexOf(self.activeSlot);
            if (activeIdx >= 0) {
              for (let i = activeIdx + 1; i < self.slots.length; i++) {
                self.slots[i].startLine += diff;
                self.slots[i].endLine += diff;
              }
            }
            // 同步更新 DOM 节点上的 dataset.lineStart / lineEnd 以供外部精确映射
            for (const slotItem of self.slots) {
              const el = self.root.querySelector(`[data-slot-id="${slotItem.id}"]`);
              if (el) {
                el.dataset.lineStart = String(slotItem.startLine + 1);
                el.dataset.lineEnd = String(slotItem.endLine);
              }
            }
          }
        }
      },
      onSelectionChange: () => {
        if (self.isSwitchingSlot) return;
        if (!self.view) return;

        const currentHead = self.view.state.selection.main.head;
        const currentLine = self.view.state.doc.lineAt(currentHead).number; // 1-based

        // 选区移出当前槽位范围时触发槽位切换
        if (!self.activeSlot || currentLine < self.activeSlot.startLine + 1 || currentLine > self.activeSlot.endLine) {
          if (!self.isSelectionSyncScheduled) {
            self.isSelectionSyncScheduled = true;
            queueMicrotask(() => {
              self.isSelectionSyncScheduled = false;
              if (!self.view) return;
              const head = self.view.state.selection.main.head;
              const line = self.view.state.doc.lineAt(head).number;
              self.activateSlotByLine(line, self.view.state.selection.main);
            });
          }
        }
      },
      onEscape: () => {
        self.commitActiveBlock();
      },
      keymapExtra: [
        {
          key: "Enter",
          run: (view) => {
            if (!self.activeSlot) return false;
            const { from, to } = view.state.selection.main;
            if (from !== to) return false;

            const line = view.state.doc.lineAt(from);
            const text = line.text;
            const slot = self.activeSlot;
            const blockType = (slot.blockType || "").split(" ")[0];

            // 检查是否为列表空标记（如 "- ", "1. ", "- [ ] " 等仅有前缀而无实际内容）
            const taskMatch = /^(\s*[-*+]\s+\[[ xX]\]\s*)/.exec(text);
            const orderedMatch = /^(\s*\d+\.\s+)/.exec(text);
            const unorderedMatch = /^(\s*[-*+]\s+)/.exec(text);
            const marker = taskMatch || orderedMatch || unorderedMatch;
            const isEmptyListMarker = Boolean(
              blockType === "list" &&
              marker &&
              text.trim() === marker[0].trim() &&
              from - line.from <= marker[0].length
            );

            // 1. 列表块内：若当前为纯空标记行或纯空白行，第二次回车立即清除标记并分块退出
            if (blockType === "list" && (isEmptyListMarker || text.trim() === "")) {
              view.dispatch({
                changes: { from: line.from, to: line.to, insert: "\n" },
                selection: { anchor: line.from + 1 }
              });
              queueMicrotask(() => {
                self.syncSlotsStructure(line.from + 1);
              });
              return true;
            }

            // 2. 闭合代码块/数学公式/HTML/图表块内的空行退出：
            // 移除临时空行换行，并在闭合定界符末尾外插入独立空行，在单一事务中完成
            const isFencedBlock = (
              blockType === "code" ||
              blockType === "math-block" ||
              blockType === "html" ||
              blockType.startsWith("diagram")
            );

            if (isFencedBlock && slot.isComplex && text.trim() === "") {
              const delFrom = line.from > 0 ? line.from - 1 : line.from;
              const delTo = line.from > 0 ? line.to : (line.to < view.state.doc.length ? line.to + 1 : line.to);

              // 扣除已删除空行后定位闭合定界符末尾
              const currentBlockEndLine = slot.endLine;
              const endLineObj = view.state.doc.line(Math.min(currentBlockEndLine, view.state.doc.lines));
              const blockEndPos = endLineObj.to;

              const deleteLen = delTo - delFrom;
              const mappedInsertPos = blockEndPos > delTo ? blockEndPos - deleteLen : blockEndPos;

              view.dispatch({
                changes: [
                  { from: delFrom, to: delTo, insert: "" },
                  { from: blockEndPos, to: blockEndPos, insert: "\n" }
                ],
                selection: { anchor: mappedInsertPos + 1 }
              });

              queueMicrotask(() => {
                self.syncSlotsStructure(mappedInsertPos + 1);
              });
              return true;
            }

            // 3. 普通文本块或已扩展空行块：如果槽位行数已发生扩展且当前行为纯空行，二次回车退出为独立新空行
            if (slot.endLine - slot.startLine > 1 && text.trim() === "") {
              queueMicrotask(() => {
                self.syncSlotsStructure(line.from);
              });
              return true;
            }

            return false;
          }
        }
      ],
      extraPlugins: [
        activeRangeField,
        hideRangeDecoField,
        pointerClampFilter
      ]
    });

    this.view = new EditorView({
      parent: this.editorLayer,
      state: EditorState.create({
        doc: docText,
        extensions
      })
    });

    this.stagingContainer.appendChild(this.editorLayer);
  }

  renderSlots() {
    this.root.innerHTML = '';
    const frag = document.createDocumentFragment();

    for (const slot of this.slots) {
      if (slot.footnoteIndex !== undefined) continue;
      const slotEl = this.createSlotElement(slot);
      frag.appendChild(slotEl);
    }

    if (this.footnotesHtml) {
      const footnotesEl = document.createElement('div');
      footnotesEl.className = 'md-footnotes md-slot-preview';
      footnotesEl.innerHTML = this.footnotesHtml;

      const items = footnotesEl.querySelectorAll('li.footnote-item');
      for (const slot of this.slots) {
        if (slot.footnoteIndex !== undefined) {
          const slotEl = this.createSlotElement(slot);
          items[slot.footnoteIndex].replaceChildren(slotEl);
        }
      }

      frag.appendChild(footnotesEl);
    }

    this.root.appendChild(frag);
  }

  createSlotElement(slot) {
    const slotEl = document.createElement('div');
    slotEl.className = `md-slot md-block md-block-${slot.blockType}`;
    slotEl.dataset.slotId = slot.id;
    slotEl.dataset.blockIndex = String(slot.blockIndex);
    slotEl.dataset.blockType = slot.blockType;
    slotEl.dataset.lineStart = String(slot.startLine + 1);
    slotEl.dataset.lineEnd = String(slot.endLine);

    const previewEl = document.createElement('div');
    previewEl.className = 'md-slot-preview';
    previewEl.innerHTML = slot.html;

    if (typeof resolveDocumentImages === 'function') {
      resolveDocumentImages(previewEl, this.documentPath);
    }

    const checkboxes = Array.from(previewEl.querySelectorAll('input[type="checkbox"]'));
    for (const cb of checkboxes) {
      cb.disabled = false;
    }

    slotEl.appendChild(previewEl);

    if (
      slot.isComplex ||
      previewEl.querySelector('.md-diagram, .md-inline-math, .md-math-block, .md-rawblock-container, .math-jax-preprocess')
    ) {
      this.scheduleEnhancement(previewEl);
    }

    return slotEl;
  }


  handleWheel(event) {
    if (!this.view || !this.enabled) return;
    if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;

    let delta = event.deltaY;
    if (event.deltaMode === 1) delta *= 16;
    else if (event.deltaMode === 2) delta *= window.innerHeight;
    if (delta === 0) return;

    const dir = delta > 0 ? 1 : -1;
    const now = performance.now();
    const isNewGesture = (now - this.lastWheelTime > 200) || (this.wheelDirection !== dir);
    this.lastWheelTime = now;
    this.wheelDirection = dir;

    const scroller = this.view.scrollDOM;
    const canScrollDown = scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1;
    const canScrollUp = scroller.scrollTop > 1;
    const canScrollInDir = dir > 0 ? canScrollDown : canScrollUp;

    if (isNewGesture) {
      this.wheelOwner = canScrollInDir ? 'inner' : 'page';
    }

    if (this.wheelOwner === 'inner') {
      if (!canScrollInDir) {
        // 当前连续滚动手势触及内部边界：拦截事件并消耗剩余惯性，防止联动带动外层页面
        event.preventDefault();
      }
    } else {
      // 归属于页面手势：滚动外层页面
      event.preventDefault();
      const host = this.root.closest('.scroll-host');
      if (host) {
        host.scrollBy({ top: delta, behavior: 'instant' });
      }
    }
  }

  handleSlotMouseDown(event) {
    if (event.button !== 0 || !this.enabled) return;
    if (event.target.closest('a') || event.target.closest('input[type="checkbox"]')) {
      return;
    }

    // 若点击命中当前已挂载的编辑器层，直接放行交由 CodeMirror 原生处理及 pointerClampFilter 约束，保持原生拖选与 Shift 选区
    if (this.editorLayer.contains(event.target)) {
      return;
    }

    const slotEl = event.target.closest('.md-slot');
    if (!slotEl) {
      if (this.activeSlot) {
        this.commitActiveBlock();
      }
      return;
    }

    const slotId = slotEl.dataset.slotId;
    const slot = this.slots.find((s) => s.id === slotId);
    if (!slot) return;

    event.preventDefault();
    this.activateSlot(slot, slotEl, { clientX: event.clientX, clientY: event.clientY });
  }

  handleSlotChange(event) {
    const checkbox = event.target.closest('input[type="checkbox"]');
    if (!checkbox || !this.view) return;

    const slotEl = event.target.closest('.md-slot');
    if (!slotEl) return;
    const slotId = slotEl.dataset.slotId;
    const slot = this.slots.find((s) => s.id === slotId);
    if (!slot) return;

    let targetLine = slot.startLine + 1;
    if (slot.startLine + 1 !== slot.endLine) {
      const allBoxes = Array.from(slotEl.querySelectorAll('input[type="checkbox"]'));
      const boxIndex = allBoxes.indexOf(checkbox);
      if (boxIndex >= 0 && slot.taskLines && slot.taskLines[boxIndex]) {
        targetLine = slot.taskLines[boxIndex];
      }
    }

    const docLines = this.view.state.doc.lines;
    if (targetLine >= 1 && targetLine <= docLines) {
      const line = this.view.state.doc.line(targetLine);
      const text = line.text;
      const taskMatch = /^(\s*[-*+]\s+\[)([ xX])(\]\s*)/.exec(text);
      if (taskMatch) {
        const nextChar = checkbox.checked ? 'x' : ' ';
        const from = line.from + taskMatch[1].length;
        const to = from + 1;
        this.view.dispatch({
          changes: { from, to, insert: nextChar }
        });
        this.source = this.view.state.doc.toString();
        this.onChange(this.source);
      }
    }
  }

  // 统一的槽位激活方法：先 dispatch 新 range 生效，再 posAtCoords 拾取坐标
  activateSlot(slot, slotEl, options = {}) {
    if (this.activeSlot && this.activeSlot.id === slot.id && this.activeSlotEl === slotEl) {
      return;
    }

    if (this.activeSlot) {
      this.deactivateSlot();
    }

    // deactivateSlot 发生后，按目标行重新查取最新有效的 slot 对象与 DOM 元素
    const targetLine = slot.startLine + 1;
    const realSlot = this.slots.find((s) => targetLine >= s.startLine + 1 && targetLine <= s.endLine) || this.slots[this.slots.length - 1];
    if (!realSlot) return;
    const realSlotEl = this.root.querySelector(`[data-slot-id="${realSlot.id}"]`);
    if (!realSlotEl) return;

    this.activeSlot = realSlot;
    this.activeSlotEl = realSlotEl;
    this.activeSlotDirty = false;

    // 冻结槽容器物理高度
    const rect = realSlotEl.getBoundingClientRect();
    realSlotEl.style.height = `${rect.height}px`;
    realSlotEl.classList.add('is-active');

    // 挂载绝对定位的编辑器容器
    realSlotEl.appendChild(this.editorLayer);

    // 切换槽位时重置内部滚动偏移与滚轮手势归属
    this.lastWheelTime = 0;
    this.wheelOwner = null;
    this.wheelDirection = 0;
    if (this.view && this.view.scrollDOM) {
      this.view.scrollDOM.scrollTop = 0;
    }

    const docLines = this.view.state.doc.lines;
    const startLineNum = Math.min(Math.max(1, realSlot.startLine + 1), docLines);
    const endLineNum = Math.min(Math.max(startLineNum, realSlot.endLine), docLines);

    const startLineObj = this.view.state.doc.line(startLineNum);
    const endLineObj = this.view.state.doc.line(endLineNum);
    const fromPos = startLineObj.from;
    const toPos = endLineObj.to;

    let targetSelection = { anchor: fromPos };
    if (options.selection) {
      const s = options.selection;
      const docLen = this.view.state.doc.length;
      if (typeof s === 'number') {
        const p = Math.max(0, Math.min(s, docLen));
        targetSelection = { anchor: p };
      } else if (typeof s.anchor === 'number') {
        const anchor = Math.max(0, Math.min(s.anchor, docLen));
        const head = typeof s.head === 'number' ? Math.max(0, Math.min(s.head, docLen)) : anchor;
        targetSelection = { anchor, head };
      }
    }

    // 先 dispatch 新范围与初始选区，确保布局与替换部件就绪
    this.isSwitchingSlot = true;
    try {
      this.view.dispatch({
        effects: setActiveRangeEffect.of({
          from: fromPos,
          to: toPos
        }),
        selection: targetSelection
      });
    } finally {
      this.isSwitchingSlot = false;
    }

    // 范围生效后再通过 posAtCoords 获取点击落点并限制在当前槽位内
    if (options.clientX !== undefined && options.clientY !== undefined) {
      const coordsPos = this.view.posAtCoords({ x: options.clientX, y: options.clientY });
      if (coordsPos !== null) {
        const clampedPos = Math.max(fromPos, Math.min(coordsPos, toPos));
        this.view.dispatch({ selection: { anchor: clampedPos } });
      }
    }

    this.view.focus();
  }

  activateSlotByLine(lineNum, selection) {
    const slot = this.slots.find((s) => lineNum >= s.startLine + 1 && lineNum <= s.endLine) || this.slots[this.slots.length - 1];
    if (!slot) return;
    const slotEl = this.root.querySelector(`[data-slot-id="${slot.id}"]`);
    if (!slotEl) return;
    this.activateSlot(slot, slotEl, { selection });
  }

  deactivateSlot() {
    if (!this.activeSlot || !this.activeSlotEl) return;

    const slotEl = this.activeSlotEl;

    slotEl.classList.remove('is-active');
    slotEl.style.height = '';

    this.stagingContainer.appendChild(this.editorLayer);

    this.lastWheelTime = 0;
    this.wheelOwner = null;
    this.wheelDirection = 0;
    if (this.view && this.view.scrollDOM) {
      this.view.scrollDOM.scrollTop = 0;
    }

    if (this.activeSlotDirty && this.view) {
      this.source = this.view.state.doc.toString();
      const { blocks, slots, footnotesHtml } = buildSlots(this.source);
      this.blocks = blocks;
      this.slots = slots;
      this.footnotesHtml = footnotesHtml;
      this.renderSlots();
      this.activeSlotDirty = false;
    }

    this.activeSlot = null;
    this.activeSlotEl = null;

    if (this.view) {
      this.isSwitchingSlot = true;
      try {
        this.view.dispatch({
          effects: setActiveRangeEffect.of(null)
        });
      } finally {
        this.isSwitchingSlot = false;
      }
    }
  }

  syncSlotsStructure(preferredCursorHead) {
    if (!this.view) return;
    this.source = this.view.state.doc.toString();
    const { blocks, slots, footnotesHtml } = buildSlots(this.source);
    this.blocks = blocks;
    this.slots = slots;
    this.footnotesHtml = footnotesHtml;

    if (this.activeSlotEl) {
      this.activeSlotEl.classList.remove('is-active');
      this.activeSlotEl.style.height = '';
    }
    this.stagingContainer.appendChild(this.editorLayer);
    this.activeSlot = null;
    this.activeSlotEl = null;

    this.renderSlots();

    const head = typeof preferredCursorHead === 'number'
      ? preferredCursorHead
      : this.view.state.selection.main.head;
    const currentLine = Math.min(Math.max(1, this.view.state.doc.lineAt(head).number), this.view.state.doc.lines);
    const targetSlot = this.slots.find((s) => currentLine >= s.startLine + 1 && currentLine <= s.endLine) || this.slots[this.slots.length - 1];
    if (targetSlot) {
      const slotEl = this.root.querySelector(`[data-slot-id="${targetSlot.id}"]`);
      if (slotEl) {
        this.activateSlot(targetSlot, slotEl, { selection: { anchor: head } });
      }
    }
  }

  async commitActiveBlock() {
    if (this.view && this.view.contentDOM) {
      this.view.contentDOM.blur();
    }
    if (this.activeSlot) {
      this.deactivateSlot();
    }
    if (this.enhanceTimer) {
      clearTimeout(this.enhanceTimer);
      this.enhanceTimer = null;
    }
    await this.enhanceRendered();
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

  dispose() {
    if (this.mousedownTarget) {
      this.mousedownTarget.removeEventListener('mousedown', this.handleSlotMouseDown);
      this.mousedownTarget = null;
    }
    this.root.removeEventListener('change', this.handleSlotChange);
    this.editorLayer.removeEventListener('wheel', this.handleWheel);

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
    if (this.stagingContainer && this.stagingContainer.parentNode) {
      this.stagingContainer.parentNode.removeChild(this.stagingContainer);
    }
    this.enabled = false;
  }
}

export function replaceRange(source, startLine, endLine, replacement) {
  const lines = source.split('\n');
  const head = lines.slice(0, startLine);
  const tail = lines.slice(endLine);
  return [...head, ...replacement.split('\n'), ...tail].join('\n');
}

export default InPlaceEditor;
