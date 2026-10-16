import { EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap, drawSelection, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language';
import { highlightSelectionMatches } from '@codemirror/search';

// 块内编辑器的外观：排版交由外层 Typora 主题接管，这里只保证透明背景与继承字体
export const BLOCK_EDITOR_THEME = EditorView.theme({
  '&': { fontSize: 'inherit', backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: 'inherit', overflow: 'visible' },
  '.cm-content': { padding: '0', caretColor: 'var(--text-color, currentColor)', fontFamily: 'inherit' },
  '.cm-line': { padding: '0' },
  '.cm-cursor': { borderLeftWidth: '2px' },
  '.cm-selectionBackground': { backgroundColor: 'var(--select-text-bg-color, #b5d6fc80)' }
});

// 生成块内编辑器扩展
// keymapExtra 会优先于默认键位表，用于实现 Enter 分段与 Backspace 合并
export function blockEditorExtensions({ onInput, onEscape, onBlur, keymapExtra = [] }) {
  return [
    history(),
    drawSelection(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    bracketMatching(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    Prec.highest(keymap.of(keymapExtra)),
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
      indentWithTab,
      {
        key: 'Escape',
        run: () => {
          onEscape();
          return true;
        }
      },
      {
        key: 'Mod-Enter',
        run: () => {
          onEscape();
          return true;
        }
      }
    ]),
    BLOCK_EDITOR_THEME,
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      onInput(update.state.doc.toString());
    }),
    EditorView.domEventHandlers({
      blur: () => {
        onBlur();
        return false;
      }
    })
  ];
}

export function createBlockEditorState(doc, extensions) {
  return EditorState.create({ doc, extensions });
}

export { EditorView };
