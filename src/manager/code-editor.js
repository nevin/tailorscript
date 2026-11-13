// The script editor: CodeMirror with JavaScript support plus userscript-aware completions, problems, docs and hints.
import {
  autocompletion, bracketMatching, closeBrackets, closeBracketsKeymap, completeFromList, completionKeymap, crosshairCursor,
  Decoration, defaultKeymap, drawSelection, dropCursor, EditorState, EditorView, foldGutter, foldKeymap, forceLinting,
  highlightActiveLine, highlightActiveLineGutter, highlightSelectionMatches, highlightSpecialChars, HighlightStyle, history,
  historyKeymap, hoverTooltip, ifNotIn, indentOnInput, indentUnit, indentWithTab, javascript, keymap, lineNumbers, linter,
  lintGutter, lintKeymap, localCompletionSource, openLintPanel, openSearchPanel, rectangularSelection, scopeCompletionSource,
  search, searchKeymap, showTooltip, snippetCompletion, snippets, StateField, syntaxHighlighting, syntaxTree, tags, ViewPlugin
} from "../vendor/codemirror/codemirror.js";
import { userscriptSnippets } from "./gm-api.js";
import { completeAt, diagnose, hoverAt, metadataLines, minimalChange, signatureAt } from "./intellisense.js";

const notCode = ["LineComment", "BlockComment", "String", "TemplateString", "RegExp"];

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function userscriptSource(context) {
  const result = completeAt(context.state.doc.toString(), context.pos, context.explicit);
  if (!result) return null;
  if (result.kind === "api" && notCode.includes(syntaxTree(context.state).resolveInner(context.pos, -1).name)) return null;
  return { from: result.from, options: result.options, validFor: /^[\w$.-]*$/ };
}

const snippetSource = ifNotIn(notCode, completeFromList([
  ...snippets,
  ...userscriptSnippets.map(({ label, detail, template }) => snippetCompletion(template, { label, detail, type: "text" }))
]));

const highlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--syntax-keyword)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "var(--syntax-string)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--syntax-number)" },
  { tag: [tags.lineComment, tags.blockComment], color: "var(--syntax-comment)", fontStyle: "italic" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "var(--syntax-function)" },
  { tag: [tags.definition(tags.variableName), tags.definition(tags.propertyName)], color: "var(--syntax-definition)" },
  { tag: tags.propertyName, color: "var(--syntax-property)" },
  { tag: [tags.className, tags.typeName], color: "var(--syntax-type)" },
  { tag: [tags.operator, tags.punctuation], color: "var(--syntax-punctuation)" }
]);

// Marks the metadata block so keys and values read like settings rather than plain comments.
const metadataDecorations = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = this.build(view.state);
  }

  update(update) {
    if (update.docChanged) this.decorations = this.build(update.state);
  }

  build(state) {
    const { block, lines } = metadataLines(state.doc.toString());
    if (!block) return Decoration.none;
    const marks = [Decoration.line({ class: "cm-meta-fence" }).range(state.doc.lineAt(block.from).from)];
    for (const line of lines) {
      marks.push(Decoration.mark({ class: "cm-meta-key" }).range(line.keyFrom - 1, line.keyTo));
      if (line.valueTo > line.valueFrom) marks.push(Decoration.mark({ class: "cm-meta-value" }).range(line.valueFrom, line.valueTo));
    }
    const closing = state.doc.lineAt(block.to);
    if (/==\/UserScript==/.test(closing.text)) marks.push(Decoration.line({ class: "cm-meta-fence" }).range(closing.from));
    return Decoration.set(marks, true);
  }
}, { decorations: plugin => plugin.decorations });

function docTooltip(title, doc) {
  const dom = element("div", "cm-doc-tooltip");
  dom.append(element("code", "cm-doc-title", title));
  if (doc) dom.append(element("p", "cm-doc-body", doc));
  return { dom };
}

const hovers = hoverTooltip((view, pos) => {
  const info = hoverAt(view.state.doc.toString(), pos);
  return info && { pos: info.from, end: info.to, above: true, create: () => docTooltip(info.title, info.doc) };
});

// Shows the parameters of the GM call the cursor is in, with the current one emphasised.
function signatureTooltip(state) {
  const { main } = state.selection;
  if (!main.empty) return null;
  const help = signatureAt(state.doc.toString(), main.head);
  if (!help) return null;
  return {
    pos: main.head,
    above: true,
    create() {
      const title = element("code", "cm-doc-title");
      title.append(`${help.name}(`);
      help.params.forEach((param, index) => {
        if (index) title.append(", ");
        title.append(index === help.active ? element("strong", "cm-active-param", param) : param);
      });
      title.append(`): ${help.returns}`);
      const dom = element("div", "cm-doc-tooltip cm-signature");
      dom.append(title, element("p", "cm-doc-body", help.doc));
      return { dom };
    }
  };
}

const signatureHints = StateField.define({
  create: signatureTooltip,
  update: (value, transaction) => transaction.docChanged || transaction.selection ? signatureTooltip(transaction.state) : value,
  provide: field => showTooltip.from(field)
});

export function createCodeEditor(parent, { onChange, onCursor, onDiagnostics } = {}) {
  let runError = null;

  const problems = linter(view => {
    const length = view.state.doc.length;
    const found = diagnose(view.state.doc.toString(), { runError }).map(({ from, to, severity, message, actions }) => ({
      from: Math.min(from, length),
      to: Math.min(Math.max(to, from), length),
      severity,
      message,
      actions: actions?.map(({ name, change }) => ({ name, apply: target => target.dispatch({ changes: change }) }))
    }));
    onDiagnostics?.(found);
    return found;
  }, { delay: 300 });

  const extensions = [
    lineNumbers(), highlightActiveLineGutter(), foldGutter(), lintGutter(), highlightSpecialChars(), history(), drawSelection(),
    dropCursor(), EditorState.allowMultipleSelections.of(true), indentOnInput(), indentUnit.of("  "), EditorState.tabSize.of(2),
    syntaxHighlighting(highlightStyle), bracketMatching(), closeBrackets(), rectangularSelection(), crosshairCursor(),
    highlightActiveLine(), highlightSelectionMatches(), search({ top: true }), javascript(), metadataDecorations,
    autocompletion({
      override: [userscriptSource, localCompletionSource, ifNotIn(notCode, scopeCompletionSource(globalThis)), snippetSource],
      icons: true
    }),
    problems, hovers, signatureHints,
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap,
      ...lintKeymap, indentWithTab]),
    EditorView.contentAttributes.of({ "aria-label": "Script source", spellcheck: "false", autocapitalize: "off" }),
    EditorView.updateListener.of(update => {
      if (update.docChanged) onChange?.();
      if (update.docChanged || update.selectionSet) {
        const { head } = update.state.selection.main;
        const line = update.state.doc.lineAt(head);
        onCursor?.({ line: line.number, column: head - line.from + 1 });
      }
    })
  ];

  const view = new EditorView({ parent, state: EditorState.create({ doc: "", extensions }) });

  return {
    view,
    get value() {
      return view.state.doc.toString();
    },
    get hasFocus() {
      return view.hasFocus;
    },
    // Opens a different script: a fresh state, so undo can't step back into the previous one.
    load(text) {
      view.setState(EditorState.create({ doc: text, extensions }));
      view.scrollDOM.scrollTop = 0;
      view.scrollDOM.scrollLeft = 0;
      onCursor?.({ line: 1, column: 1 });
    },
    // Replaces the text as one undoable edit and puts the cursor after the changed part.
    replace(text) {
      const change = minimalChange(view.state.doc.toString(), text);
      view.dispatch({ changes: change, selection: { anchor: change.from + change.insert.length }, scrollIntoView: true });
    },
    focus() {
      view.focus();
    },
    goToLine(number) {
      const line = view.state.doc.line(Math.min(Math.max(1, number), view.state.doc.lines));
      view.dispatch({ selection: { anchor: line.from, head: line.to }, scrollIntoView: true });
      view.focus();
    },
    setRunError(error) {
      if (runError?.line === error?.line && runError?.message === error?.message) return;
      runError = error?.line ? error : null;
      forceLinting(view);
    },
    openSearch() {
      openSearchPanel(view);
    },
    openProblems() {
      openLintPanel(view);
    }
  };
}
