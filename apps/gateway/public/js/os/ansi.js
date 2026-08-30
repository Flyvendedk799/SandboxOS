// ansi.js — a small terminal screen.
//
// Command Central loads xterm.js from a CDN and falls back to stripping escapes
// when that fails. The OS cannot make that trade: a desktop that needs the public
// internet to draw its own terminal is not an operating system, it is a web page.
// So this renders the vocabulary a shell session actually uses — carriage returns
// that redraw a progress line, backspace, erase-to-end-of-line, colours, bold —
// with no dependency and no CDN.
//
// What it is not: a full VT100. There is no alternate screen buffer and no cursor
// addressing, so `vim` and `htop` will not paint. That limit is stated in the app
// rather than hidden, and `sbx` or Command Central's Shell remain there for the
// full thing.

const MAX_LINES = 3000;
const MAX_COLS = 4000;

const SGR_CLASS = {
  1: "b", 2: "d", 3: "i", 4: "u",
  30: "c0", 31: "c1", 32: "c2", 33: "c3", 34: "c4", 35: "c5", 36: "c6", 37: "c7",
  90: "c8", 91: "c9", 92: "c10", 93: "c11", 94: "c12", 95: "c13", 96: "c14", 97: "c15",
};

/** One styled screen. `write()` accepts raw terminal bytes as a string. */
export function createScreen(host) {
  /** Each line is {chars: string[], cls: (string|null)[], node: Element|null}. */
  let lines = [newLine()];
  let row = 0;
  let col = 0;
  let style = null;          // the class string in force
  let pending = "";          // a partial escape sequence split across frames
  let dirty = new Set([0]);
  let frame = null;

  function newLine() { return { chars: [], cls: [], node: null }; }

  function cur() { return lines[row]; }

  function putChar(ch) {
    const line = cur();
    while (line.chars.length < col) { line.chars.push(" "); line.cls.push(null); }
    if (col >= MAX_COLS) return;
    line.chars[col] = ch;
    line.cls[col] = style;
    col += 1;
    dirty.add(row);
  }

  function newline() {
    row += 1;
    col = 0;
    if (row >= lines.length) lines.push(newLine());
    if (lines.length > MAX_LINES) {
      const drop = lines.length - MAX_LINES;
      for (let i = 0; i < drop; i += 1) lines[i].node?.remove();
      lines = lines.slice(drop);
      row -= drop;
      dirty = new Set([...dirty].map((r) => r - drop).filter((r) => r >= 0));
    }
    dirty.add(row);
  }

  function eraseInLine(mode) {
    const line = cur();
    if (mode === 1) {
      for (let i = 0; i < col && i < line.chars.length; i += 1) { line.chars[i] = " "; line.cls[i] = null; }
    } else if (mode === 2) {
      line.chars.length = 0; line.cls.length = 0;
    } else {
      line.chars.length = Math.min(line.chars.length, col);
      line.cls.length = Math.min(line.cls.length, col);
    }
    dirty.add(row);
  }

  function clearAll() {
    for (const l of lines) l.node?.remove();
    lines = [newLine()];
    row = 0; col = 0;
    dirty = new Set([0]);
  }

  function applySgr(params) {
    const codes = params.split(";").map((p) => Number(p || 0));
    for (const code of codes) {
      if (code === 0) { style = null; continue; }
      if (code === 39 || code === 22 || code === 24 || code === 23) {
        // Reset one attribute: our style is a single class, so the honest move is
        // to drop it rather than pretend to track each independently.
        style = null;
        continue;
      }
      const cls = SGR_CLASS[code];
      if (cls) style = style && style !== cls ? `${style} ${cls}` : cls;
    }
  }

  /** Feed raw terminal output in. Escape sequences may split across calls. */
  function write(data) {
    let text = pending + String(data);
    pending = "";
    let i = 0;
    while (i < text.length) {
      const ch = text[i];

      if (ch === "\x1b") {
        const rest = text.slice(i);
        // CSI: ESC [ params final
        const csi = /^\x1b\[([0-9;?]*)([@-~])/.exec(rest);
        if (csi) {
          const [, params, final] = csi;
          if (final === "m") applySgr(params);
          else if (final === "K") eraseInLine(Number(params || 0));
          else if (final === "J" && (params === "2" || params === "3")) clearAll();
          else if (final === "C") col = Math.min(MAX_COLS, col + (Number(params) || 1));
          else if (final === "D") col = Math.max(0, col - (Number(params) || 1));
          else if (final === "G") col = Math.max(0, (Number(params) || 1) - 1);
          // Everything else (cursor addressing, scroll regions) is out of scope.
          i += csi[0].length;
          continue;
        }
        // OSC: ESC ] ... BEL | ST — window titles and the like.
        const osc = /^\x1b\][^\x07\x1b]*(\x07|\x1b\\)/.exec(rest);
        if (osc) { i += osc[0].length; continue; }
        // A single-character escape we do not model.
        const short = /^\x1b[@-Z\\-_]/.exec(rest);
        if (short) { i += short[0].length; continue; }
        // Truncated sequence: keep it for the next frame rather than printing junk.
        if (rest.length < 24) { pending = rest; break; }
        i += 1;
        continue;
      }

      if (ch === "\n") { newline(); i += 1; continue; }
      if (ch === "\r") { col = 0; i += 1; continue; }
      if (ch === "\b") { col = Math.max(0, col - 1); i += 1; continue; }
      if (ch === "\t") { const next = (Math.floor(col / 8) + 1) * 8; while (col < next) putChar(" "); i += 1; continue; }
      if (ch === "\x07" || ch < " ") { i += 1; continue; }

      putChar(ch);
      i += 1;
    }
    schedule();
  }

  // Painting is batched into an animation frame: a chatty build can emit
  // thousands of writes a second, and each one repainting is how a terminal
  // becomes the slowest thing on the desktop.
  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = null; paint(); });
  }

  function paint() {
    const atBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 40;
    for (const r of dirty) {
      const line = lines[r];
      if (!line) continue;
      if (!line.node) {
        line.node = document.createElement("div");
        line.node.className = "t-line";
        // Lines always arrive in order, so appending is correct and cheap.
        host.append(line.node);
      }
      renderLine(line);
    }
    dirty.clear();
    if (atBottom) host.scrollTop = host.scrollHeight;
  }

  function renderLine(line) {
    line.node.replaceChildren();
    let runStart = 0;
    for (let i = 0; i <= line.chars.length; i += 1) {
      const changed = i === line.chars.length || line.cls[i] !== line.cls[runStart];
      if (!changed) continue;
      const text = line.chars.slice(runStart, i).join("");
      if (text) {
        const cls = line.cls[runStart];
        if (cls) {
          const span = document.createElement("span");
          span.className = cls;
          span.textContent = text;
          line.node.append(span);
        } else {
          line.node.append(document.createTextNode(text));
        }
      }
      runStart = i;
    }
    if (!line.node.childNodes.length) line.node.append(document.createTextNode(""));
  }

  return {
    write,
    clear() { clearAll(); host.replaceChildren(); schedule(); },
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
