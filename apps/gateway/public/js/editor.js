// editor.js — a small, dependency-free code editor.
//
// Two layers share one box: a <pre> paints highlighted tokens, and a transparent
// <textarea> on top of it owns the caret, the selection, undo, and scrolling.
// The textarea's scroll offsets are mirrored onto the paint layer and the line
// gutter on every scroll, so all three stay locked together.
//
// It is not CodeMirror, and it does not need to be. It gives you syntax colour,
// line numbers, real indentation behaviour, bracket/quote pairing, comment
// toggling and a save shortcut — which is the whole job for editing a config
// file or a script inside your Sandbox.

import { h, esc, clear } from "./core.js";

// ── Languages ────────────────────────────────────────────────────────────────

const KW_JS = "await|async|break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|from|function|get|if|import|in|instanceof|let|new|of|return|set|static|super|switch|this|throw|try|typeof|var|void|while|with|yield|true|false|null|undefined|NaN";
const KW_PY = "and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|try|while|with|yield";
const KW_SH = "if|then|else|elif|fi|for|while|do|done|case|esac|function|return|in|export|local|readonly|source|alias|set|unset|echo|cd|exit";

/** Ordered rules. Earlier rules win, so comments and strings must come first. */
const LANGS = {
  js: [
    { cls: "com", re: /\/\*[\s\S]*?\*\/|\/\/[^\n]*/ },
    { cls: "str", re: /`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/ },
    { cls: "num", re: /\b0[xX][0-9a-fA-F]+n?\b|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?n?\b/ },
    { cls: "key", re: new RegExp(`\\b(?:${KW_JS})\\b`) },
    { cls: "fn", re: /\b[A-Za-z_$][\w$]*(?=\s*\()/ },
    { cls: "pun", re: /[{}()[\];,.]|=>|[-+*/%!<>=&|?:]+/ },
  ],
  json: [
    { cls: "str", re: /"(?:\\.|[^"\\])*"(?=\s*:)/, as: "att" },
    { cls: "str", re: /"(?:\\.|[^"\\])*"/ },
    { cls: "num", re: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/ },
    { cls: "key", re: /\b(?:true|false|null)\b/ },
    { cls: "pun", re: /[{}[\]:,]/ },
  ],
  css: [
    { cls: "com", re: /\/\*[\s\S]*?\*\// },
    { cls: "str", re: /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/ },
    { cls: "key", re: /@[\w-]+|:{1,2}[a-z-]+(?:\([^)]*\))?/ },
    { cls: "att", re: /--[\w-]+|\b[a-z-]+(?=\s*:)/ },
    { cls: "num", re: /#[0-9a-fA-F]{3,8}\b|\b-?\d*\.?\d+(?:px|rem|em|vh|vw|%|s|ms|fr|deg)?\b/ },
    { cls: "pun", re: /[{};:,]/ },
  ],
  html: [
    { cls: "com", re: /<!--[\s\S]*?-->/ },
    { cls: "str", re: /"[^"]*"|'[^']*'/ },
    { cls: "tag", re: /<\/?[a-zA-Z][\w:-]*|\/?>/ },
    { cls: "att", re: /\b[a-zA-Z-][\w:-]*(?==)/ },
  ],
  py: [
    { cls: "com", re: /#[^\n]*/ },
    { cls: "str", re: /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/ },
    { cls: "num", re: /\b\d[\d_]*(?:\.\d+)?\b/ },
    { cls: "key", re: new RegExp(`\\b(?:${KW_PY})\\b`) },
    { cls: "fn", re: /\b[A-Za-z_][\w]*(?=\s*\()/ },
    { cls: "pun", re: /[{}()[\];,.:]|[-+*/%!<>=&|]+/ },
  ],
  sh: [
    { cls: "com", re: /#[^\n]*/ },
    { cls: "str", re: /"(?:\\.|[^"\\])*"|'[^']*'/ },
    { cls: "att", re: /\$\{[^}]*\}|\$\w+/ },
    { cls: "key", re: new RegExp(`\\b(?:${KW_SH})\\b`) },
    { cls: "pun", re: /[|&;()<>]/ },
  ],
  yaml: [
    { cls: "com", re: /#[^\n]*/ },
    { cls: "str", re: /"(?:\\.|[^"\\\n])*"|'[^'\n]*'/ },
    { cls: "att", re: /^\s*-?\s*[\w.$-]+(?=\s*:)/m },
    { cls: "num", re: /\b-?\d+(?:\.\d+)?\b/ },
    { cls: "key", re: /\b(?:true|false|null|yes|no|on|off)\b/ },
  ],
  md: [
    { cls: "com", re: /^```[\s\S]*?^```/m },
    { cls: "key", re: /^#{1,6} [^\n]*/m },
    { cls: "str", re: /`[^`\n]+`/ },
    { cls: "fn", re: /\[[^\]\n]*\]\([^)\n]*\)/ },
    { cls: "att", re: /\*\*[^*\n]+\*\*|__[^_\n]+__/ },
    { cls: "pun", re: /^\s*[-*+>] |^\s*\d+\. /m },
  ],
  txt: [],
};

const EXT_LANG = {
  ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "js", ".ts": "js", ".tsx": "js",
  ".json": "json", ".jsonc": "json", ".webmanifest": "json",
  ".css": "css", ".scss": "css", ".less": "css",
  ".html": "html", ".htm": "html", ".xml": "html", ".svg": "html", ".vue": "html",
  ".py": "py", ".pyi": "py",
  ".sh": "sh", ".bash": "sh", ".zsh": "sh", ".env": "sh",
  ".yml": "yaml", ".yaml": "yaml", ".toml": "yaml", ".ini": "yaml", ".conf": "yaml",
  ".md": "md", ".markdown": "md",
};

/** Pick a highlighter for a path. Unknown extensions render as plain text. */
export function languageFor(path) {
  const name = String(path).split("/").pop() ?? "";
  if (/^(Dockerfile|Makefile)$/i.test(name)) return "sh";
  if (name === "Sandboxfile.json") return "json";
  const i = name.lastIndexOf(".");
  return EXT_LANG[i <= 0 ? "" : name.slice(i).toLowerCase()] ?? "txt";
}

/** Files above this size render unhighlighted — regex scanning stops being free. */
const HIGHLIGHT_LIMIT = 200_000;

const _compiled = new Map();
function compiled(lang) {
  if (_compiled.has(lang)) return _compiled.get(lang);
  const rules = LANGS[lang] ?? LANGS.txt;
  const entry = rules.length
    ? { rules, re: new RegExp(rules.map((r) => `(${r.re.source})`).join("|"), "gm") }
    : null;
  _compiled.set(lang, entry);
  return entry;
}

/** Tokenize `code` into highlighted HTML. Everything not matched is escaped text. */
export function highlight(code, lang) {
  const c = compiled(lang);
  if (!c || code.length > HIGHLIGHT_LIMIT) return esc(code);
  let out = "";
  let last = 0;
  let m;
  c.re.lastIndex = 0;
  while ((m = c.re.exec(code)) !== null) {
    if (m[0] === "") { c.re.lastIndex += 1; continue; }
    out += esc(code.slice(last, m.index));
    const idx = m.slice(1).findIndex((x) => x !== undefined);
    const rule = c.rules[idx] ?? { cls: "pun" };
    out += `<span class="tk-${rule.as ?? rule.cls}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(code.slice(last));
}

// ── The editor ───────────────────────────────────────────────────────────────

const PAIRS = { "(": ")", "[": "]", "{": "}", '"': '"', "'": "'", "`": "`" };
const LINE_COMMENT = { js: "//", json: "//", css: null, html: null, py: "#", sh: "#", yaml: "#", md: null, txt: "#" };
const INDENT = "  ";

/**
 * Mount an editor into `host`.
 * @returns {{getValue, setValue, focus, setLanguage, destroy, el}}
 */
export function createEditor(host, { value = "", language = "txt", onChange, onSave, readOnly = false } = {}) {
  let lang = language;

  const gutter = h("div.ed-gutter");
  const paint = h("pre.ed-layer.ed-hl");
  const input = h("textarea.ed-layer.ed-input", {
    spellcheck: "false", autocapitalize: "off", autocomplete: "off", wrap: "off",
    readonly: readOnly || undefined,
  });
  const scroll = h("div.ed-scroll", null, paint, input);
  const root = h("div.ed", null, gutter, scroll);
  clear(host).append(root);

  input.value = value;

  let raf = 0;
  const schedulePaint = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; repaint(); });
  };

  function repaint() {
    const text = input.value;
    // A trailing newline would otherwise collapse and shift the last painted line.
    paint.innerHTML = highlight(text, lang) + "\n";
    const lines = text.split("\n").length;
    if (gutter.childElementCount !== lines) {
      clear(gutter);
      const frag = document.createDocumentFragment();
      for (let i = 1; i <= lines; i += 1) frag.append(h("div", String(i)));
      gutter.append(frag);
    }
    markCurrentLine();
    syncScroll();
  }

  function markCurrentLine() {
    const line = input.value.slice(0, input.selectionStart).split("\n").length;
    const prev = gutter.querySelector(".cur");
    if (prev) prev.classList.remove("cur");
    gutter.children[line - 1]?.classList.add("cur");
  }

  function syncScroll() {
    paint.scrollTop = input.scrollTop;
    paint.scrollLeft = input.scrollLeft;
    gutter.scrollTop = input.scrollTop;
  }

  /** Replace the selection, keeping the browser's native undo stack intact. */
  function insert(text, { selectStart, selectEnd } = {}) {
    input.setRangeText(text, input.selectionStart, input.selectionEnd, "end");
    if (selectStart != null) input.setSelectionRange(selectStart, selectEnd ?? selectStart);
    fireChange();
  }

  function fireChange() {
    schedulePaint();
    onChange?.(input.value);
  }

  function lineBoundsOfSelection() {
    const v = input.value;
    const start = v.lastIndexOf("\n", input.selectionStart - 1) + 1;
    let end = v.indexOf("\n", input.selectionEnd);
    if (end === -1) end = v.length;
    return { start, end };
  }

  function indentSelection(dedent) {
    const { start, end } = lineBoundsOfSelection();
    const block = input.value.slice(start, end);
    const next = block.split("\n").map((line) => (dedent
      ? line.replace(new RegExp(`^(?:${INDENT}|\\t| {1,${INDENT.length}})`), "")
      : INDENT + line)).join("\n");
    input.setSelectionRange(start, end);
    input.setRangeText(next, start, end, "select");
    fireChange();
  }

  function toggleComment() {
    const token = LINE_COMMENT[lang];
    if (!token) return;
    const { start, end } = lineBoundsOfSelection();
    const lines = input.value.slice(start, end).split("\n");
    const allCommented = lines.every((l) => !l.trim() || l.trimStart().startsWith(token));
    const next = lines.map((l) => {
      if (!l.trim()) return l;
      if (allCommented) return l.replace(new RegExp(`^(\\s*)${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} ?`), "$1");
      const indent = l.match(/^\s*/)[0];
      return `${indent}${token} ${l.slice(indent.length)}`;
    }).join("\n");
    input.setSelectionRange(start, end);
    input.setRangeText(next, start, end, "select");
    fireChange();
  }

  function onKeyDown(e) {
    const meta = e.metaKey || e.ctrlKey;

    if (meta && e.key.toLowerCase() === "s") { e.preventDefault(); onSave?.(input.value); return; }
    if (meta && e.key === "/") { e.preventDefault(); toggleComment(); return; }

    if (e.key === "Tab") {
      e.preventDefault();
      if (e.shiftKey) return indentSelection(true);
      if (input.selectionStart !== input.selectionEnd) return indentSelection(false);
      return insert(INDENT);
    }

    if (e.key === "Enter") {
      const v = input.value;
      const lineStart = v.lastIndexOf("\n", input.selectionStart - 1) + 1;
      const line = v.slice(lineStart, input.selectionStart);
      const indent = line.match(/^\s*/)[0];
      const before = v[input.selectionStart - 1];
      const after = v[input.selectionEnd];
      e.preventDefault();
      // Opening a block: indent the new line, and push a matching closer down.
      if (before && PAIRS[before] && PAIRS[before] === after && before !== '"' && before !== "'" && before !== "`") {
        const pos = input.selectionStart + 1 + indent.length + INDENT.length;
        return insert(`\n${indent}${INDENT}\n${indent}`, { selectStart: pos });
      }
      if (/[{[(:]$/.test(line.trimEnd())) return insert(`\n${indent}${INDENT}`);
      return insert(`\n${indent}`);
    }

    // Wrap a selection in the pair rather than replacing it.
    if (PAIRS[e.key] && input.selectionStart !== input.selectionEnd) {
      e.preventDefault();
      const s = input.selectionStart, en = input.selectionEnd;
      const sel = input.value.slice(s, en);
      insert(`${e.key}${sel}${PAIRS[e.key]}`, { selectStart: s + 1, selectEnd: en + 1 });
      return;
    }
    // Auto-close, but only when the next character is not a word character.
    if (PAIRS[e.key] && input.selectionStart === input.selectionEnd) {
      const after = input.value[input.selectionStart] ?? "";
      if (!/[\w$]/.test(after)) {
        e.preventDefault();
        const pos = input.selectionStart + 1;
        return insert(`${e.key}${PAIRS[e.key]}`, { selectStart: pos });
      }
    }
    // Typing the closer that is already there just steps over it.
    if (Object.values(PAIRS).includes(e.key) && input.value[input.selectionStart] === e.key
        && input.selectionStart === input.selectionEnd) {
      e.preventDefault();
      input.setSelectionRange(input.selectionStart + 1, input.selectionStart + 1);
      return;
    }

    if (e.key === "Backspace" && input.selectionStart === input.selectionEnd) {
      const before = input.value[input.selectionStart - 1];
      const after = input.value[input.selectionStart];
      if (before && PAIRS[before] === after) {
        e.preventDefault();
        input.setSelectionRange(input.selectionStart - 1, input.selectionStart + 1);
        insert("");
      }
    }
  }

  input.addEventListener("input", fireChange);
  input.addEventListener("keydown", onKeyDown);
  input.addEventListener("scroll", syncScroll, { passive: true });
  input.addEventListener("click", markCurrentLine);
  input.addEventListener("keyup", markCurrentLine);

  repaint();

  return {
    el: root,
    getValue: () => input.value,
    setValue(next, nextLang) {
      if (nextLang) lang = nextLang;
      input.value = next;
      input.scrollTop = 0;
      repaint();
    },
    setLanguage(next) { lang = next; repaint(); },
    get language() { return lang; },
    focus: () => input.focus(),
    /** 1-based caret position, for the status bar. */
    caret() {
      const upto = input.value.slice(0, input.selectionStart);
      const lines = upto.split("\n");
      return { line: lines.length, col: lines.at(-1).length + 1 };
    },
    onCaret(fn) {
      const handler = () => fn(this.caret());
      input.addEventListener("keyup", handler);
      input.addEventListener("click", handler);
      return handler;
    },
    destroy() {
      cancelAnimationFrame(raf);
      root.remove();
    },
  };
}
