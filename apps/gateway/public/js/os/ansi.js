// ansi.js — a small terminal screen, now with a proper grid.
//
// Command Central loads xterm.js from a CDN and falls back to stripping escapes
// when that fails. The OS cannot make that trade: a desktop that needs the public
// internet to draw its own terminal is not an operating system, it is a web page.
// So this is ours, with no dependency — and since Phase 30 it is a real screen:
// a grid the cursor can be addressed on, a scroll region, an alternate buffer.
// `vim`, `htop`, `less` and a TUI you wrote paint. What it still is not: a full
// VT with every DEC private mode, sixel, or a character set other than UTF-8.
//
// Model: a buffer is an array of lines; the visible screen is the last `rows` of
// it (the main buffer keeps scrollback above the screen, the alternate buffer is
// exactly `rows` lines and keeps nothing). Cursor addressing is relative to the
// top of the screen, so "row 1" on a busy shell is not "line 1 of history".

const MAX_SCROLLBACK = 3000;
const MAX_COLS = 500;

const SGR_CLASS = {
  1: "b", 2: "d", 3: "i", 4: "u", 7: "r",
  30: "c0", 31: "c1", 32: "c2", 33: "c3", 34: "c4", 35: "c5", 36: "c6", 37: "c7",
  90: "c8", 91: "c9", 92: "c10", 93: "c11", 94: "c12", 95: "c13", 96: "c14", 97: "c15",
};
const BG_CLASS = {
  40: "bg0", 41: "bg1", 42: "bg2", 43: "bg3", 44: "bg4", 45: "bg5", 46: "bg6", 47: "bg7",
  100: "bg8", 101: "bg9", 102: "bg10", 103: "bg11", 104: "bg12", 105: "bg13", 106: "bg14", 107: "bg15",
};

/** One styled screen. `write()` accepts raw terminal bytes as a string. */
export function createScreen(host, { cols = 80, rows = 24 } = {}) {
  const newLine = () => ({ chars: [], cls: [], node: null });

  /** A buffer: lines, the index of the screen's first row, and the cursor. */
  function newBuffer(keepScrollback) {
    const b = { lines: [], top: 0, row: 0, col: 0, scrollback: keepScrollback, savedRow: 0, savedCol: 0, scrollTop: 0, scrollBottom: rows - 1 };
    for (let i = 0; i < rows; i += 1) b.lines.push(newLine());
    return b;
  }

  const main = newBuffer(true);
  let alt = null;
  let buf = main;

  let style = null;          // the class string in force
  let pending = "";          // a partial escape sequence split across frames
  let dirty = new Set();
  let frame = null;
  let autowrap = true;
  let cursorVisible = true;
  let wrapPending = false;   // the cursor sits past the last column, waiting for the next char
  const line = (r) => buf.lines[buf.top + r];
  const markDirty = (r) => dirty.add(buf.top + r);
  /** Lines changed position: forget their nodes so paint re-inserts them in order. */
  function reflow() {
    for (let r = 0; r < rows; r += 1) { const l = line(r); l.node?.remove(); l.node = null; markDirty(r); }
  }

  // ── editing primitives ────────────────────────────────────────────────────

  function putChar(ch) {
    if (wrapPending) {
      if (autowrap) { buf.col = 0; lineFeed(); }
      wrapPending = false;
    }
    const l = line(buf.row);
    while (l.chars.length < buf.col) { l.chars.push(" "); l.cls.push(null); }
    l.chars[buf.col] = ch;
    l.cls[buf.col] = style;
    markDirty(buf.row);
    if (buf.col + 1 >= cols) { wrapPending = true; buf.col = cols - 1; return; }
    buf.col += 1;
  }

  /** Move the screen down one line inside the scroll region. */
  function scrollUp(n = 1) {
    for (let i = 0; i < n; i += 1) {
      if (buf.scrollTop === 0 && buf.scrollBottom === rows - 1 && buf.scrollback) {
        // Whole screen: the top line becomes scrollback, a fresh line arrives.
        buf.lines.push(newLine());
        buf.top += 1;
        if (buf.lines.length > MAX_SCROLLBACK + rows) {
          const drop = buf.lines.length - (MAX_SCROLLBACK + rows);
          for (let k = 0; k < drop; k += 1) buf.lines[k].node?.remove();
          buf.lines.splice(0, drop);
          buf.top -= drop;
          dirty = new Set([...dirty].map((r) => r - drop).filter((r) => r >= 0));
        }
        for (let r = 0; r < rows; r += 1) markDirty(r);
      } else {
        // Inside a region (or the alt buffer): lines shift, nothing is kept.
        const removed = buf.lines.splice(buf.top + buf.scrollTop, 1)[0];
        removed?.node?.remove();
        buf.lines.splice(buf.top + buf.scrollBottom, 0, newLine());
        reflow();
      }
    }
  }
  function scrollDown(n = 1) {
    for (let i = 0; i < n; i += 1) {
      const removed = buf.lines.splice(buf.top + buf.scrollBottom, 1)[0];
      removed?.node?.remove();
      buf.lines.splice(buf.top + buf.scrollTop, 0, newLine());
      reflow();
    }
  }

  function lineFeed() {
    wrapPending = false;
    if (buf.row === buf.scrollBottom) scrollUp();
    else if (buf.row < rows - 1) buf.row += 1;
    markDirty(buf.row);
  }
  function reverseIndex() {
    if (buf.row === buf.scrollTop) scrollDown();
    else if (buf.row > 0) buf.row -= 1;
  }

  function eraseInLine(mode) {
    const l = line(buf.row);
    if (mode === 1) { for (let i = 0; i <= buf.col; i += 1) { l.chars[i] = " "; l.cls[i] = style; } }
    else if (mode === 2) { l.chars.length = 0; l.cls.length = 0; }
    else { l.chars.length = Math.min(l.chars.length, buf.col); l.cls.length = Math.min(l.cls.length, buf.col); }
    markDirty(buf.row);
  }
  function eraseInDisplay(mode) {
    if (mode === 2 || mode === 3) {
      for (let r = 0; r < rows; r += 1) { const l = line(r); l.chars.length = 0; l.cls.length = 0; markDirty(r); }
      if (mode === 3 && buf.scrollback) {
        for (let k = 0; k < buf.top; k += 1) buf.lines[k].node?.remove();
        buf.lines.splice(0, buf.top); buf.top = 0;
      }
      return;
    }
    if (mode === 1) {
      for (let r = 0; r < buf.row; r += 1) { const l = line(r); l.chars.length = 0; l.cls.length = 0; markDirty(r); }
      eraseInLine(1);
      return;
    }
    eraseInLine(0);
    for (let r = buf.row + 1; r < rows; r += 1) { const l = line(r); l.chars.length = 0; l.cls.length = 0; markDirty(r); }
  }
  function eraseChars(n) {
    const l = line(buf.row);
    for (let i = buf.col; i < buf.col + n; i += 1) { if (i < l.chars.length) { l.chars[i] = " "; l.cls[i] = null; } }
    markDirty(buf.row);
  }
  function deleteChars(n) { const l = line(buf.row); l.chars.splice(buf.col, n); l.cls.splice(buf.col, n); markDirty(buf.row); }
  function insertChars(n) {
    const l = line(buf.row);
    while (l.chars.length < buf.col) { l.chars.push(" "); l.cls.push(null); }
    for (let i = 0; i < n; i += 1) { l.chars.splice(buf.col, 0, " "); l.cls.splice(buf.col, 0, null); }
    l.chars.length = Math.min(l.chars.length, cols); l.cls.length = Math.min(l.cls.length, cols);
    markDirty(buf.row);
  }
  function insertLines(n) {
    if (buf.row < buf.scrollTop || buf.row > buf.scrollBottom) return;
    for (let i = 0; i < n; i += 1) {
      const removed = buf.lines.splice(buf.top + buf.scrollBottom, 1)[0];
      removed?.node?.remove();
      buf.lines.splice(buf.top + buf.row, 0, newLine());
    }
    reflow();
  }
  function deleteLines(n) {
    if (buf.row < buf.scrollTop || buf.row > buf.scrollBottom) return;
    for (let i = 0; i < n; i += 1) {
      const removed = buf.lines.splice(buf.top + buf.row, 1)[0];
      removed?.node?.remove();
      buf.lines.splice(buf.top + buf.scrollBottom, 0, newLine());
    }
    reflow();
  }

  function setCursor(r, c) {
    buf.row = Math.max(0, Math.min(rows - 1, r));
    buf.col = Math.max(0, Math.min(cols - 1, c));
    wrapPending = false;
  }

  function applySgr(params) {
    const codes = (params || "0").split(";").map((p) => Number(p || 0));
    for (let i = 0; i < codes.length; i += 1) {
      const code = codes[i];
      if (code === 0) { style = null; continue; }
      if (code === 38 || code === 48) {
        // 256-colour / truecolour: fold to the nearest of our sixteen.
        const kind = code === 38 ? "c" : "bg";
        if (codes[i + 1] === 5) { const n = codes[i + 2] ?? 0; add(`${kind}${n < 16 ? n : n >= 232 ? (n > 243 ? 15 : 8) : 7}`); i += 2; }
        else if (codes[i + 1] === 2) { i += 4; add(`${kind}7`); }
        continue;
      }
      if (code === 39) { drop(/^c\d+$/); continue; }
      if (code === 49) { drop(/^bg\d+$/); continue; }
      if (code === 22) { drop(/^[bd]$/); continue; }
      if (code === 23) { drop(/^i$/); continue; }
      if (code === 24) { drop(/^u$/); continue; }
      if (code === 27) { drop(/^r$/); continue; }
      const cls = SGR_CLASS[code] ?? BG_CLASS[code];
      if (cls) { if (/^c\d/.test(cls)) drop(/^c\d+$/); if (/^bg/.test(cls)) drop(/^bg\d+$/); add(cls); }
    }
    function add(cls) { const set = new Set((style ?? "").split(" ").filter(Boolean)); set.add(cls); style = [...set].join(" "); }
    function drop(re) { const set = (style ?? "").split(" ").filter((c) => c && !re.test(c)); style = set.length ? set.join(" ") : null; }
  }

  function switchAlt(on) {
    if (on && buf === main) {
      alt = newBuffer(false);
      alt.scrollBottom = rows - 1;
      for (const l of main.lines) l.node?.remove();
      buf = alt;
      host.replaceChildren();
      dirty = new Set();
      for (let r = 0; r < rows; r += 1) markDirty(r);
    } else if (!on && buf === alt) {
      for (const l of alt.lines) l.node?.remove();
      alt = null;
      buf = main;
      host.replaceChildren();
      for (const l of main.lines) l.node = null;
      dirty = new Set(main.lines.map((_, i) => i));
    }
  }

  function setMode(params, on) {
    for (const p of params.split(";")) {
      const n = Number(p.replace("?", ""));
      const priv = p.startsWith("?");
      if (!priv) continue;
      if (n === 1049) { if (on) { main.savedRow = buf.row; main.savedCol = buf.col; switchAlt(true); eraseInDisplay(2); setCursor(0, 0); } else { switchAlt(false); buf.row = main.savedRow; buf.col = main.savedCol; } }
      else if (n === 47 || n === 1047) switchAlt(on);
      else if (n === 25) cursorVisible = on;
      else if (n === 7) autowrap = on;
      // 1 (application cursor keys), 2004 (bracketed paste), 1000-1006 (mouse): accepted silently.
    }
  }

  // ── the parser ────────────────────────────────────────────────────────────

  /** Feed raw terminal output in. Escape sequences may split across calls. */
  function write(data) {
    let text = pending + String(data);
    pending = "";
    let i = 0;
    while (i < text.length) {
      const ch = text[i];

      if (ch === "\x1b") {
        const rest = text.slice(i);
        const csi = /^\x1b\[([0-9;?>=!]*)([ -/]*)([@-~])/.exec(rest);
        if (csi) {
          const [, params, , final] = csi;
          handleCsi(params, final);
          i += csi[0].length;
          continue;
        }
        const osc = /^\x1b\][^\x07\x1b]*(\x07|\x1b\\)/.exec(rest);
        if (osc) { i += osc[0].length; continue; }
        const charset = /^\x1b[()*+][0-9A-Za-z]/.exec(rest);
        if (charset) { i += charset[0].length; continue; }
        const short = /^\x1b([@-Z\\-_])/.exec(rest);
        if (short) {
          const c = short[1];
          if (c === "7") { buf.savedRow = buf.row; buf.savedCol = buf.col; }
          else if (c === "8") setCursor(buf.savedRow, buf.savedCol);
          else if (c === "D") lineFeed();
          else if (c === "M") reverseIndex();
          else if (c === "E") { buf.col = 0; lineFeed(); }
          else if (c === "c") { switchAlt(false); eraseInDisplay(2); setCursor(0, 0); style = null; buf.scrollTop = 0; buf.scrollBottom = rows - 1; }
          i += short[0].length;
          continue;
        }
        if (rest.length < 32) { pending = rest; break; }
        i += 1;
        continue;
      }

      if (ch === "\n" || ch === "\x0b" || ch === "\x0c") { lineFeed(); i += 1; continue; }
      if (ch === "\r") { buf.col = 0; wrapPending = false; i += 1; continue; }
      if (ch === "\b") { if (buf.col > 0) buf.col -= 1; wrapPending = false; i += 1; continue; }
      if (ch === "\t") { const next = Math.min(cols - 1, (Math.floor(buf.col / 8) + 1) * 8); buf.col = next; i += 1; continue; }
      if (ch === "\x07" || ch < " " || ch === "\x7f") { i += 1; continue; }

      putChar(ch);
      i += 1;
    }
    schedule();
  }

  function handleCsi(params, final) {
    const nums = params.replace(/^[?>=!]/, "").split(";").map((p) => (p === "" ? null : Number(p)));
    const n1 = nums[0] ?? 1, n0 = nums[0] ?? 0;
    switch (final) {
      case "m": applySgr(params); break;
      case "H": case "f": setCursor((nums[0] ?? 1) - 1, (nums[1] ?? 1) - 1); break;
      case "A": setCursor(Math.max(buf.scrollTop, buf.row - Math.max(1, n1)), buf.col); break;
      case "B": setCursor(Math.min(buf.scrollBottom, buf.row + Math.max(1, n1)), buf.col); break;
      case "C": setCursor(buf.row, buf.col + Math.max(1, n1)); break;
      case "D": setCursor(buf.row, buf.col - Math.max(1, n1)); break;
      case "E": setCursor(buf.row + Math.max(1, n1), 0); break;
      case "F": setCursor(buf.row - Math.max(1, n1), 0); break;
      case "G": case "`": setCursor(buf.row, Math.max(1, n1) - 1); break;
      case "d": setCursor(Math.max(1, n1) - 1, buf.col); break;
      case "J": eraseInDisplay(n0); break;
      case "K": eraseInLine(n0); break;
      case "L": insertLines(Math.max(1, n1)); break;
      case "M": deleteLines(Math.max(1, n1)); break;
      case "P": deleteChars(Math.max(1, n1)); break;
      case "X": eraseChars(Math.max(1, n1)); break;
      case "@": insertChars(Math.max(1, n1)); break;
      case "S": scrollUp(Math.max(1, n1)); break;
      case "T": scrollDown(Math.max(1, n1)); break;
      case "r": {
        const top = (nums[0] ?? 1) - 1, bottom = (nums[1] ?? rows) - 1;
        if (top >= 0 && bottom < rows && top < bottom) { buf.scrollTop = top; buf.scrollBottom = bottom; setCursor(0, 0); }
        break;
      }
      case "s": buf.savedRow = buf.row; buf.savedCol = buf.col; break;
      case "u": setCursor(buf.savedRow, buf.savedCol); break;
      case "h": setMode(params, true); break;
      case "l": setMode(params, false); break;
      default: break; // device attributes, tab clears and friends: accepted, ignored
    }
  }

  // ── painting ──────────────────────────────────────────────────────────────
  // Batched into an animation frame: a chatty build can emit thousands of
  // writes a second, and each one repainting is how a terminal becomes the
  // slowest thing on the desktop.

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = null; paint(); });
  }

  function paint() {
    const atBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 40;
    const visibleFrom = buf.scrollback ? 0 : buf.top;
    // Lines are painted in order; an absent node is created and inserted at its
    // index so scroll-region edits (which reorder lines) stay correct.
    for (const idx of [...dirty].sort((a, b) => a - b)) {
      const l = buf.lines[idx];
      if (!l || idx < visibleFrom) continue;
      if (!l.node) {
        l.node = document.createElement("div");
        l.node.className = "t-line";
        const before = buf.lines.slice(idx + 1).find((x) => x.node)?.node ?? null;
        host.insertBefore(l.node, before);
      }
      renderLine(l, idx === buf.top + buf.row ? buf.col : -1);
    }
    dirty.clear();
    if (atBottom || buf === alt) host.scrollTop = host.scrollHeight;
  }

  let lastCursorLine = null;
  function renderLine(l, cursorCol) {
    l.node.replaceChildren();
    let runStart = 0;
    const len = Math.max(l.chars.length, cursorCol >= 0 && cursorVisible ? cursorCol + 1 : 0);
    for (let i = 0; i <= len; i += 1) {
      const changed = i === len || (l.cls[i] ?? null) !== (l.cls[runStart] ?? null) || i === cursorCol || runStart === cursorCol;
      if (!changed) continue;
      const text = l.chars.slice(runStart, i).map((c) => c ?? " ").join("").padEnd(i - runStart, " ");
      if (text) {
        const cls = l.cls[runStart];
        const isCursor = runStart === cursorCol && cursorVisible;
        if (cls || isCursor) {
          const span = document.createElement("span");
          span.className = `${cls ?? ""}${isCursor ? " t-cursor" : ""}`.trim();
          span.textContent = text;
          l.node.append(span);
        } else {
          l.node.append(document.createTextNode(text));
        }
      }
      runStart = i;
    }
    if (!l.node.childNodes.length) l.node.append(document.createTextNode(cursorCol >= 0 && cursorVisible ? " " : ""));
    if (cursorCol >= 0) { if (lastCursorLine && lastCursorLine !== l) dirty.add(buf.lines.indexOf(lastCursorLine)); lastCursorLine = l; }
  }

  /** Resize the grid. Lines are kept; the alternate buffer is re-fitted. */
  function resize(nextCols, nextRows) {
    cols = Math.max(20, Math.min(MAX_COLS, nextCols | 0));
    const r = Math.max(4, nextRows | 0);
    for (const b of [main, alt].filter(Boolean)) {
      const screenLen = b.lines.length - b.top;
      if (r > screenLen) { for (let i = screenLen; i < r; i += 1) b.lines.push(newLine()); }
      else if (r < screenLen) {
        // Shrink from the top of the screen into scrollback (main) or drop (alt).
        const extra = screenLen - r;
        if (b.scrollback) b.top += extra;
        else { for (const l of b.lines.splice(0, extra)) l.node?.remove(); b.top = 0; }
      }
      b.scrollTop = 0; b.scrollBottom = r - 1;
      b.row = Math.min(b.row, r - 1);
      b.col = Math.min(b.col, cols - 1);
    }
    rows = r;
    for (let i = 0; i < rows; i += 1) markDirty(i);
    schedule();
  }

  return {
    write,
    clear() { switchAlt(false); eraseInDisplay(3); setCursor(0, 0); host.replaceChildren(); for (const l of main.lines) l.node = null; dirty = new Set(main.lines.map((_, i) => i)); schedule(); },
    resize,
    get alt() { return buf === alt; },
    get size() { return { cols, rows }; },
    /** Rough terminal geometry, from the measured size of one character. */
    measure(sample) {
      const rect = sample.getBoundingClientRect();
      const cw = rect.width / 10 || 7;
      const ch = rect.height || 18;
      return {
        cols: Math.max(20, Math.floor((host.clientWidth - 20) / cw)),
        rows: Math.max(6, Math.floor((host.clientHeight - 12) / ch)),
      };
    },
  };
}
