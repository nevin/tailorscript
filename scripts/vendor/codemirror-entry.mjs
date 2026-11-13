// Everything the manager's editor imports from CodeMirror, bundled into src/vendor/codemirror/ by scripts/vendor.mjs.
export { EditorState, EditorSelection, Compartment, StateEffect, StateField, RangeSetBuilder } from "@codemirror/state";
export {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, drawSelection,
  dropCursor, rectangularSelection, crosshairCursor, hoverTooltip, showTooltip, Decoration, ViewPlugin, placeholder
} from "@codemirror/view";
export {
  defaultKeymap, history, historyKeymap, indentWithTab, toggleComment, indentMore, indentLess
} from "@codemirror/commands";
export {
  syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, foldGutter, foldKeymap, syntaxTree, indentUnit
} from "@codemirror/language";
export { tags } from "@lezer/highlight";
export {
  autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, snippetCompletion, ifNotIn, completeFromList,
  startCompletion, CompletionContext
} from "@codemirror/autocomplete";
export { linter, lintGutter, lintKeymap, setDiagnostics, forceLinting, openLintPanel } from "@codemirror/lint";
export { search, searchKeymap, highlightSelectionMatches, openSearchPanel, gotoLine } from "@codemirror/search";
export { javascript, javascriptLanguage, localCompletionSource, scopeCompletionSource, snippets } from "@codemirror/lang-javascript";
