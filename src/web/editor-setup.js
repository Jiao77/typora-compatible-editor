import { EditorState, StateField, StateEffect, RangeSetBuilder, Prec } from '@codemirror/state';
import { EditorView, keymap, drawSelection, highlightActiveLine, Decoration, WidgetType } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language';
import { highlightSelectionMatches } from '@codemirror/search';

// 全篇与行级编辑器的外观：排版交由外层 Typora 主题接管，保证透明背景、继承字体与无边框
export const BLOCK_EDITOR_THEME = EditorView.theme({
  '&': { fontSize: 'inherit', backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: 'inherit', overflow: 'visible' },
  '.cm-content': { padding: '0', caretColor: 'var(--text-color, currentColor)', fontFamily: 'inherit' },
  '.cm-line': { padding: '0', minHeight: '1.5em' },
  '.cm-cursor': { borderLeftWidth: '2px' },
  '.cm-selectionBackground': { backgroundColor: 'var(--select-text-bg-color, #b5d6fc80)' }
});

// 构建全篇单实例编辑器的核心扩展集
export function createEditorExtensions({ onDocChange, onSelectionChange, onEscape, keymapExtra = [], extraPlugins = [] }) {
  const lineKeymap = [
    {
      key: 'Enter',
      run: (view) => {
        const { from, to } = view.state.selection.main;
        const line = view.state.doc.lineAt(from);
        const text = line.text;
        const relativeStart = from - line.from;

        const taskMatch = /^\s*([-*+])\s+\[[ xX]\]\s*/.exec(text);
        const orderedMatch = /^\s*(\d+)\.\s+/.exec(text);
        const unorderedMatch = /^\s*([-*+])\s+/.exec(text);
        const marker = taskMatch || orderedMatch || unorderedMatch;

        // 如果光标在空列表标记处按回车，清除该标记并退出列表
        if (marker && text.trim() === marker[0].trim() && relativeStart <= marker[0].length) {
          view.dispatch({
            changes: { from: line.from, to: line.to, insert: '' },
            selection: { anchor: line.from }
          });
          return true;
        }

        // 如果在带有内容的列表项中按回车，自动接续列表标号
        if (marker && relativeStart >= marker[0].length) {
          let prefix = '';
          if (taskMatch) {
            prefix = taskMatch[1] + ' [ ] ';
          } else if (orderedMatch) {
            prefix = (Number(orderedMatch[1]) + 1) + '. ';
          } else if (unorderedMatch) {
            prefix = unorderedMatch[1] + ' ';
          }
          view.dispatch({
            changes: { from, to, insert: '\n' + prefix },
            selection: { anchor: from + 1 + prefix.length }
          });
          return true;
        }

        // 普通行：标准换行，插入单换行符
        view.dispatch({
          changes: { from, to, insert: '\n' },
          selection: { anchor: from + 1 }
        });
        return true;
      }
    },
    {
      key: 'Shift-Enter',
      run: (view) => {
        const { from, to } = view.state.selection.main;
        view.dispatch({
          changes: { from, to, insert: '\n' },
          selection: { anchor: from + 1 }
        });
        return true;
      }
    },
    {
      key: 'ArrowUp',
      run: (view) => {
        const { head } = view.state.selection.main;
        const line = view.state.doc.lineAt(head);
        if (line.number <= 1) return false;
        const prevLine = view.state.doc.line(line.number - 1);
        const col = head - line.from;
        const targetPos = Math.min(prevLine.from + col, prevLine.to);
        view.dispatch({
          selection: { anchor: targetPos },
          scrollIntoView: true
        });
        return true;
      }
    },
    {
      key: 'Shift-ArrowUp',
      run: (view) => {
        const { anchor, head } = view.state.selection.main;
        const line = view.state.doc.lineAt(head);
        if (line.number <= 1) return false;
        const prevLine = view.state.doc.line(line.number - 1);
        const col = head - line.from;
        const targetPos = Math.min(prevLine.from + col, prevLine.to);
        view.dispatch({
          selection: { anchor, head: targetPos },
          scrollIntoView: true
        });
        return true;
      }
    },
    {
      key: 'Shift-ArrowDown',
      run: (view) => {
        const { anchor, head } = view.state.selection.main;
        const line = view.state.doc.lineAt(head);
        if (line.number >= view.state.doc.lines) return false;
        const nextLine = view.state.doc.line(line.number + 1);
        const col = head - line.from;
        const targetPos = Math.min(nextLine.from + col, nextLine.to);
        view.dispatch({
          selection: { anchor, head: targetPos },
          scrollIntoView: true
        });
        return true;
      }
    },
    {
      key: 'ArrowDown',
      run: (view) => {
        const { head } = view.state.selection.main;
        const line = view.state.doc.lineAt(head);
        if (line.number >= view.state.doc.lines) return false;
        const nextLine = view.state.doc.line(line.number + 1);
        const col = head - line.from;
        const targetPos = Math.min(nextLine.from + col, nextLine.to);
        view.dispatch({
          selection: { anchor: targetPos },
          scrollIntoView: true
        });
        return true;
      }
    },
    {
      key: 'Escape',
      run: () => {
        if (onEscape) onEscape();
        return true;
      }
    },
    {
      key: 'Mod-Enter',
      run: () => {
        if (onEscape) onEscape();
        return true;
      }
    }
  ];

  return [
    history(),
    drawSelection(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    bracketMatching(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    Prec.highest(keymap.of([...keymapExtra, ...lineKeymap])),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    BLOCK_EDITOR_THEME,
    ...extraPlugins,
    EditorView.updateListener.of((update) => {
      if (update.docChanged && onDocChange) {
        onDocChange(update.state.doc.toString(), update);
      }
      if ((update.selectionSet || update.docChanged) && onSelectionChange) {
        onSelectionChange(update.state, update);
      }
    })
  ];
}

// 保持向下兼容的构造函数包装
export function blockEditorExtensions({ onInput, onEscape, onBlur, keymapExtra = [] }) {
  return createEditorExtensions({
    onDocChange: onInput,
    onEscape,
    keymapExtra
  });
}

export function createBlockEditorState(doc, extensions) {
  return EditorState.create({ doc, extensions });
}

export {
  EditorState,
  EditorView,
  StateField,
  StateEffect,
  RangeSetBuilder,
  Decoration,
  WidgetType,
  Prec
};
