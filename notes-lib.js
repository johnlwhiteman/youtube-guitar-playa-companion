// YouTube Guitar Playa Companion — notes library
// Pure helpers used by content.js (no DOM access, no YouTube access):
//   - a small, safe Markdown renderer (all text is HTML-escaped; links are http(s)/mailto only)
//   - clickable timestamps:  [1:23]  jumps there,  [1:23-1:31]  loops that part
//   - guitar tab: ```tab fenced blocks of plain ASCII tab, plus parse/format for the grid tab editor
(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : window;
  if (root.__ygcNotesLib) return;

  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

  // ---------- time ----------
  const TIME = String.raw`(?:\d{1,2}:)?\d{1,2}:\d{2}(?:\.\d{1,2})?`;
  function parseTime(str) {
    const parts = String(str).trim().split(":").map(Number);
    if (!parts.length || parts.some((p) => !isFinite(p))) return null;
    return parts.reduce((acc, p) => acc * 60 + p, 0);
  }
  // 83.4 -> "1:23.4"; whole seconds -> "1:23"
  function fmtTime(t) {
    if (t == null || !isFinite(t)) return "";
    t = Math.max(0, Math.round(t * 10) / 10);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t - h * 3600 - m * 60;
    const ss = (Number.isInteger(s) ? String(s) : s.toFixed(1)).padStart(Number.isInteger(s) ? 2 : 4, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
  }

  // ---------- tab detection ----------
  const TAB_LANGS = new Set(["tab", "tabs", "tablature", "guitar", "bass"]);
  const CHORD_LANGS = new Set(["chords", "chordpro", "lyrics", "song"]);
  const STRING_LINE = /^\s*([A-Ga-g](?:#|b)?)\s*\|(.*)$/;
  function isTabLine(t) {
    const m = String(t).match(STRING_LINE);
    if (!m) return false;
    if (!/^[-\w\s\/\\~^().<>*=+|]*$/.test(m[2])) return false;
    return (m[2].match(/-/g) || []).length >= 3;
  }

  // ---------- inline markdown ----------
  function inline(src) {
    const held = [];
    const hold = (html) => "\u0001" + (held.push(html) - 1) + "\u0002";
    let s = String(src);
    // code spans first, so nothing inside them is touched
    s = s.replace(/`([^`\n]+)`/g, (_, c) => hold(`<code>${esc(c)}</code>`));
    s = esc(s);
    // [text](url)
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (all, text, url) => {
      const u = url.replace(/&amp;/g, "&");
      if (/^(https?:\/\/|mailto:)/i.test(u)) return hold(`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${emph(text)}</a>`);
      return emph(text);
    });
    // [1:23-1:31] loop link, [1:23] timestamp
    s = s.replace(new RegExp(String.raw`\[(${TIME})\s*(?:-|–|—|to)\s*(${TIME})\](?!\()`, "g"), (all, a, b) => {
      const ta = parseTime(a), tb = parseTime(b);
      if (ta == null || tb == null || tb <= ta) return all;
      return hold(`<a href="#" class="ts loop" data-a="${ta}" data-b="${tb}" title="Loop ${a}–${b}">⟲ ${a}–${b}</a>`);
    });
    s = s.replace(new RegExp(String.raw`\[(${TIME})\](?!\()`, "g"), (all, a) => {
      const t = parseTime(a);
      return t == null ? all : hold(`<a href="#" class="ts" data-t="${t}" title="Jump to ${a}">▶ ${a}</a>`);
    });
    // <https://…> and bare links
    s = s.replace(/&lt;(https?:\/\/[^\s<]+?)&gt;/g, (all, url) => {
      const u = url.replace(/&amp;/g, "&");
      return hold(`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${url}</a>`);
    });
    s = s.replace(/\bhttps?:\/\/(?:(?!&gt;|&lt;|&quot;|&#39;)[^\s<])*[^\s<.,;:!?)\]'"&]/g, (url) => {
      const u = url.replace(/&amp;/g, "&");
      return hold(`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${url}</a>`);
    });
    s = emph(s);
    while (/\u0001\d+\u0002/.test(s)) s = s.replace(/\u0001(\d+)\u0002/g, (_, i) => held[+i]);
    return s;
  }
  function emph(s) {
    return s
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
      .replace(/__(?=\S)([\s\S]*?\S)__/g, "<strong>$1</strong>")
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>")
      .replace(/%%\{([a-z0-9:;. -]+)\}(?=\S)([^%\n]*?\S)%%/g, (all, c, t) => {
        const st = spanStyle(c);
        return `<span${st.cls ? ` class="${st.cls}"` : ""}${st.css ? ` style="${st.css}"` : ""}>${t}</span>`;
      })
      .replace(/==(?:\{(yellow|green|blue|pink|orange|purple)\})?(?=\S)([^=\n]*?\S)==/g, (all, c, t) => `<mark class="hl-${c || "yellow"}">${t}</mark>`)
      .replace(/\*(?=\S)([^*\n]*?\S)\*/g, "<em>$1</em>")
      .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1<em>$2</em>");
  }

  // ---------- block markdown ----------
  const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
  const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
  const QUOTE = /^\s{0,3}>/;
  const LIST = /^(\s*)([-*+]|\d{1,9}[.)])(\s+|$)(.*)$/;
  const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;

  function isFenceClose(t, fence) {
    const m = t.match(/^\s*(`{3,}|~{3,})\s*$/);
    return !!m && m[1][0] === fence[0] && m[1].length >= fence.length;
  }
  function startsBlock(L, i) {
    const t = L[i].t;
    return (
      FENCE.test(t) ||
      HEADING.test(t) ||
      HR.test(t) ||
      QUOTE.test(t) ||
      LIST.test(t) ||
      (isTabLine(t) && i + 1 < L.length && isTabLine(L[i + 1].t)) ||
      (t.includes("|") && i + 1 < L.length && TABLE_SEP.test(L[i + 1].t))
    );
  }
  // tab is stored as plain text, but shown drawn like the tab editor (falls back to the text if it can't be read)
  const tabHtml = (text, line) => {
    const model = parseTab(text);
    const body = model && !model.lost ? staffHtml(model) : `<pre class="tab">${esc(text)}</pre>`;
    return `<div class="tabblk" data-line="${line}" title="Click to edit this tab">${body}</div>`;
  };
  const splitRow = (t) => {
    let s = t.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
    return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
  };

  function renderLines(L) {
    const out = [];
    let i = 0;
    while (i < L.length) {
      const t = L[i].t;
      if (!t.trim()) {
        i++;
        continue;
      }
      let m = t.match(FENCE);
      if (m) {
        const fence = m[2], lang = m[3].toLowerCase(), indent = m[1].length, start = L[i].n;
        i++;
        const body = [];
        while (i < L.length && !isFenceClose(L[i].t, fence)) {
          const lt = L[i].t;
          body.push(lt.slice(Math.min(indent, lt.match(/^\s*/)[0].length)));
          i++;
        }
        i++; // closing fence
        out.push(
          TAB_LANGS.has(lang)
            ? tabHtml(body.join("\n"), start)
            : CHORD_LANGS.has(lang)
              ? `<div class="chordblk" data-line="${start}" title="Click to edit this song">${songHtml(body.join("\n"))}</div>`
              : `<pre class="code"><code>${esc(body.join("\n"))}</code></pre>`
        );
        continue;
      }
      if (isTabLine(t) && i + 1 < L.length && isTabLine(L[i + 1].t)) {
        const start = L[i].n, body = [];
        while (i < L.length && isTabLine(L[i].t)) body.push(L[i++].t);
        out.push(tabHtml(body.join("\n"), start));
        continue;
      }
      if ((m = t.match(HEADING))) {
        const n = m[1].length;
        out.push(`<h${n}>${inline(m[2])}</h${n}>`);
        i++;
        continue;
      }
      if (HR.test(t)) {
        out.push("<hr>");
        i++;
        continue;
      }
      if (QUOTE.test(t)) {
        const inner = [];
        while (i < L.length && QUOTE.test(L[i].t)) {
          inner.push({ t: L[i].t.replace(/^\s{0,3}> ?/, ""), n: L[i].n });
          i++;
        }
        out.push(`<blockquote>${renderLines(inner)}</blockquote>`);
        continue;
      }
      if (t.includes("|") && i + 1 < L.length && TABLE_SEP.test(L[i + 1].t)) {
        const head = splitRow(t);
        const aligns = splitRow(L[i + 1].t).map((c) => (/^:-+:$/.test(c) ? "center" : /-:$/.test(c) ? "right" : /^:-/.test(c) ? "left" : ""));
        i += 2;
        const rows = [];
        while (i < L.length && L[i].t.trim() && L[i].t.includes("|")) rows.push(splitRow(L[i++].t));
        const cell = (tag, c, k) => `<${tag}${aligns[k] ? ` style="text-align:${aligns[k]}"` : ""}>${inline(c || "")}</${tag}>`;
        out.push(
          `<div class="tblwrap"><table><thead><tr>${head.map((c, k) => cell("th", c, k)).join("")}</tr></thead><tbody>` +
            rows.map((r) => `<tr>${head.map((_, k) => cell("td", r[k], k)).join("")}</tr>`).join("") +
            "</tbody></table></div>"
        );
        continue;
      }
      if (LIST.test(t)) {
        i = renderList(L, i, out);
        continue;
      }
      const para = [];
      while (i < L.length && L[i].t.trim() && (!para.length || !startsBlock(L, i))) para.push(L[i++].t.trim());
      out.push(`<p>${inline(para.join("\n")).replace(/\n/g, "<br>")}</p>`);
    }
    return out.join("\n");
  }

  function renderList(L, i, out) {
    const m0 = L[i].t.match(LIST);
    const base = m0[1].length;
    const ordered = /\d/.test(m0[2]);
    const startNum = ordered ? parseInt(m0[2], 10) : 1;
    const items = [];
    while (i < L.length) {
      const t = L[i].t;
      const m = t.match(LIST);
      if (m && m[1].length === base) {
        if (/\d/.test(m[2]) !== ordered) break;
        items.push({ first: m[4], n: L[i].n, rest: [], ci: m[1].length + m[2].length + Math.max(1, m[3].length) });
        i++;
        continue;
      }
      const cur = items[items.length - 1];
      if (!t.trim()) {
        let j = i + 1;
        while (j < L.length && !L[j].t.trim()) j++;
        if (j < L.length) {
          const nt = L[j].t, nm = nt.match(LIST), ind = nt.match(/^\s*/)[0].length;
          if (ind > base || (nm && nm[1].length === base && /\d/.test(nm[2]) === ordered)) {
            cur.rest.push({ t: "", n: L[i].n });
            i++;
            continue;
          }
        }
        break;
      }
      const ind = t.match(/^\s*/)[0].length;
      if (ind > base) {
        cur.rest.push({ t: t.slice(Math.min(ind, cur.ci)), n: L[i].n });
        i++;
        continue;
      }
      if (!cur.rest.length && !startsBlock(L, i)) {
        cur.first += "\n" + t.trim(); // lazy continuation of the item's text
        i++;
        continue;
      }
      break;
    }
    const isTask = (it) => /^\[[ xX]\](\s|$)/.test(it.first);
    const tag = ordered ? "ol" : "ul";
    const attrs = (ordered && startNum !== 1 ? ` start="${startNum}"` : "") + (items.some(isTask) ? ' class="tasks"' : "");
    out.push(
      `<${tag}${attrs}>` +
        items
          .map((it) => {
            const rest = it.rest.length ? renderLines(it.rest) : "";
            const tm = it.first.match(/^\[([ xX])\]\s?([\s\S]*)$/);
            if (tm) {
              const done = tm[1] !== " ";
              return `<li class="task${done ? " done" : ""}"><input type="checkbox" data-line="${it.n}"${done ? " checked" : ""}><span>${inline(tm[2]).replace(/\n/g, "<br>")}</span>${rest}</li>`;
            }
            return `<li>${inline(it.first).replace(/\n/g, "<br>")}${rest}</li>`;
          })
          .join("") +
        `</${tag}>`
    );
    return i;
  }

  function renderMarkdown(src) {
    const L = String(src || "")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((t, n) => ({ t: t.replace(/\t/g, "    "), n }));
    return renderLines(L);
  }

  // tick / untick the task on source line n
  function toggleTask(src, n) {
    const lines = String(src).split("\n");
    if (lines[n] == null) return src;
    lines[n] = lines[n].replace(/^(\s*(?:>\s*)*(?:[-*+]|\d{1,9}[.)])\s+)\[([ xX])\]/, (_, pre, x) => `${pre}[${x === " " ? "x" : " "}]`);
    return lines.join("\n");
  }

  // ---------- tab blocks in the source (top level), for "edit this tab" ----------
  // -> [{ startLine, endLine, fenced, lang, inner, startOff, endOff }]
  function tabBlocks(src) {
    const lines = String(src || "").split("\n");
    const offs = [];
    let o = 0;
    for (const l of lines) {
      offs.push(o);
      o += l.length + 1;
    }
    const endOf = (n) => offs[n] + lines[n].length;
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(FENCE);
      if (m) {
        const fence = m[2], lang = m[3].toLowerCase(), start = i;
        i++;
        while (i < lines.length && !isFenceClose(lines[i], fence)) i++;
        const end = Math.min(i, lines.length - 1);
        if (TAB_LANGS.has(lang))
          out.push({ startLine: start, endLine: end, fenced: true, lang, inner: lines.slice(start + 1, i).join("\n"), startOff: offs[start], endOff: endOf(end) });
        continue;
      }
      if (isTabLine(lines[i]) && i + 1 < lines.length && isTabLine(lines[i + 1])) {
        const start = i;
        while (i + 1 < lines.length && isTabLine(lines[i + 1])) i++;
        out.push({ startLine: start, endLine: i, fenced: false, lang: "", inner: lines.slice(start, i + 1).join("\n"), startOff: offs[start], endOff: endOf(i) });
      }
    }
    return out;
  }
  const tabBlockAt = (src, pos) => tabBlocks(src).find((b) => pos >= b.startOff && pos <= b.endOff) || null;
  // ```chords blocks (top level): [{ startLine, endLine, lang, inner, startOff, endOff }]
  function chordBlocks(src) {
    const lines = String(src || "").split("\n");
    const offs = [];
    let o = 0;
    for (const l of lines) {
      offs.push(o);
      o += l.length + 1;
    }
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(FENCE);
      if (!m) continue;
      const fence = m[2], lang = m[3].toLowerCase(), start = i;
      i++;
      while (i < lines.length && !isFenceClose(lines[i], fence)) i++;
      const end = Math.min(i, lines.length - 1);
      if (CHORD_LANGS.has(lang)) out.push({ startLine: start, endLine: end, fenced: true, lang, inner: lines.slice(start + 1, i).join("\n"), startOff: offs[start], endOff: offs[end] + lines[end].length });
    }
    return out;
  }
  const chordBlockAt = (src, pos) => chordBlocks(src).find((b) => pos >= b.startOff && pos <= b.endOff) || null;

  // ---------- tab model: parse / format ----------
  // model = { names: ["e","B","G","D","A","E"] (top line first), measures: [ [ col, col, … ] ], perLine,
  //           pre: "text above the staff", post: "text below", lost: true if text between staves was dropped }
  // col = array of cell strings, one per string ("" = empty)
  // midi: the pitch of each open string (MIDI note number), top line first like the names
  // tunings, low to high in `low` ("E2 A2 D3 G3 B3 E4"); strings are kept high to low (the top string lower case on guitar)
  const tun = (id, name, instr, group, low) => {
    const notes = low.split(" ");
    const midi = notes.map((n) => {
      const m = n.match(/^([A-G][#b]?)(-?\d)$/);
      const pc = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1][0]] + (m[1][1] === "#" ? 1 : m[1][1] === "b" ? -1 : 0);
      return 12 * (+m[2] + 1) + pc;
    });
    const strings = notes.map((n) => n.replace(/-?\d$/, ""));
    if (instr === "guitar") strings[strings.length - 1] = strings[strings.length - 1].toLowerCase();
    return { id, name, instr, group, strings: strings.reverse(), midi: midi.reverse() };
  };
  const TUNINGS = [
    tun("std", "Guitar: Standard (EADGBE)", "guitar", "Standard & Drop", "E2 A2 D3 G3 B3 E4"),
    tun("half", "Guitar: Half Step Down", "guitar", "Standard & Drop", "Eb2 Ab2 Db3 Gb3 Bb3 Eb4"),
    tun("whole", "Guitar: Whole Step Down (DGCFAD)", "guitar", "Standard & Drop", "D2 G2 C3 F3 A3 D4"),
    tun("dropd", "Guitar: Drop D (DADGBE)", "guitar", "Standard & Drop", "D2 A2 D3 G3 B3 E4"),
    tun("dropcs", "Guitar: Drop C# (C#G#C#F#A#D#)", "guitar", "Standard & Drop", "C#2 G#2 C#3 F#3 A#3 D#4"),
    tun("dropc", "Guitar: Drop C (CGCFAD)", "guitar", "Standard & Drop", "C2 G2 C3 F3 A3 D4"),
    tun("dropb", "Guitar: Drop B (BF#BEG#C#)", "guitar", "Standard & Drop", "B1 F#2 B2 E3 G#3 C#4"),
    tun("ddropd", "Guitar: Double Drop D (DADGBD)", "guitar", "Standard & Drop", "D2 A2 D3 G3 B3 D4"),
    tun("openg", "Guitar: Open G (DGDGBD)", "guitar", "Open", "D2 G2 D3 G3 B3 D4"),
    tun("opend", "Guitar: Open D (DADF#AD)", "guitar", "Open", "D2 A2 D3 F#3 A3 D4"),
    tun("opene", "Guitar: Open E (EBEG#BE)", "guitar", "Open", "E2 B2 E3 G#3 B3 E4"),
    tun("opena", "Guitar: Open A (EAEAC#E)", "guitar", "Open", "E2 A2 E3 A3 C#4 E4"),
    tun("openc", "Guitar: Open C (CGCGCE)", "guitar", "Open", "C2 G2 C3 G3 C4 E4"),
    tun("openf", "Guitar: Open F (CFCFAF)", "guitar", "Open", "C2 F2 C3 F3 A3 F4"),
    tun("opendm", "Guitar: Open D Minor (DADFAD)", "guitar", "Open", "D2 A2 D3 F3 A3 D4"),
    tun("opengm", "Guitar: Open G Minor (DGDGBbD)", "guitar", "Open", "D2 G2 D3 G3 Bb3 D4"),
    tun("openem", "Guitar: Open E Minor (EBEGBE)", "guitar", "Open", "E2 B2 E3 G3 B3 E4"),
    tun("openam", "Guitar: Open A Minor (EAEACE)", "guitar", "Open", "E2 A2 E3 A3 C4 E4"),
    tun("openc6", "Guitar: Open C6 (CACGCE)", "guitar", "Open", "C2 A2 C3 G3 C4 E4"),
    tun("dadgad", "Guitar: DADGAD", "guitar", "Other", "D2 A2 D3 G3 A3 D4"),
    tun("cgdgcd", "Guitar: CGDGCD", "guitar", "Other", "C2 G2 D3 G3 C4 D4"),
    tun("seven", "Guitar: 7-String Standard (BEADGBE)", "guitar", "7-String", "B1 E2 A2 D3 G3 B3 E4"),
    tun("seven_dropa", "Guitar: 7-String Drop A (AEADGBE)", "guitar", "7-String", "A1 E2 A2 D3 G3 B3 E4"),
    tun("seven_half", "Guitar: 7-String Half Step Down", "guitar", "7-String", "Bb1 Eb2 Ab2 Db3 Gb3 Bb3 Eb4"),
    tun("bass4", "Bass: Standard (EADG)", "bass", "4-String", "E1 A1 D2 G2"),
    tun("bassdropd", "Bass: Drop D (DADG)", "bass", "4-String", "D1 A1 D2 G2"),
    tun("basshalf", "Bass: Half Step Down", "bass", "4-String", "Eb1 Ab1 Db2 Gb2"),
    tun("bassdstd", "Bass: D Standard (DGCF)", "bass", "4-String", "D1 G1 C2 F2"),
    tun("bass5", "Bass: 5-String Standard (BEADG)", "bass", "5-String", "B0 E1 A1 D2 G2"),
    tun("bass5c", "Bass: 5-String High C (EADGC)", "bass", "5-String", "E1 A1 D2 G2 C3"),
    tun("bass5dropa", "Bass: 5-String Drop A (AEADG)", "bass", "5-String", "A0 E1 A1 D2 G2"),
    { id: "uke", name: "Ukulele (GCEA)", strings: ["A", "E", "C", "G"], midi: [69, 64, 60, 67], instr: "uke", group: "Ukulele" },
  ];
  const tuningFor = (names) => TUNINGS.find((t) => t.strings.join(",") === names.join(",")) || null;
  const emptyCol = (n) => Array.from({ length: n }, () => "");
  const newMeasure = (n, cols) => Array.from({ length: cols }, () => emptyCol(n));
  function newTab(names = TUNINGS[0].strings, measures = 4, cols = 8) {
    return { names: names.slice(), measures: Array.from({ length: measures }, () => newMeasure(names.length, cols)), perLine: 4, pre: "", post: "" };
  }
  // anything except dashes and spaces may go in a cell (fret numbers, h p / \ b r ~ x …)
  // ----- guess the key from the chords -----
  // every chord in the song, in order, repeats included (your own chords count as the chord they came from)
  function songChords(text) {
    const out = [];
    const add = (c) => {
      if (!c || c === "N.C." || c === "NC") return;
      if (parseChord(c)) return out.push(c);
      const mine = Object.prototype.hasOwnProperty.call(customChords, c) ? customChords[c] : null;
      if (mine && mine.from && parseChord(mine.from)) out.push(mine.from);
    };
    for (const line of String(text || "").split("\n")) {
      if (isSectionLine(line)) continue;
      if (isChordLine(line)) for (const t of line.trim().split(/\s+/)) add(bareChord(t));
      else for (const m of line.matchAll(/\[([^\]]+)\]/g)) add(m[1].trim());
    }
    return out;
  }
  // the triad a chord is built on: maj, min, dim, aug, or "any" (sus and power chords fit either)
  function triadOf(c) {
    const q = c.quality, s = c.suffix;
    if (/dim|°|o|ø|m7b5|m7\(b5\)/.test(s) || /dim|m7b5/.test(q)) return "dim";
    if (/aug|\+/.test(s) || q === "aug") return "aug";
    if (/^5$|sus/.test(s) || /sus|^5$/.test(q)) return "any";
    if (/^m(?!aj)/.test(q) || /^(m|min|-)(?!aj)/.test(s)) return "min";
    return "maj";
  }
  const KEY_MAJOR = [[0, "maj"], [2, "min"], [4, "min"], [5, "maj"], [7, "maj"], [9, "min"], [11, "dim"]];
  const KEY_MINOR = [[0, "min"], [2, "dim"], [3, "maj"], [5, "min"], [7, "min"], [7, "maj"], [8, "maj"], [10, "maj"], [11, "dim"]];
  // the likeliest keys for a list of chords: [{ root, minor, score, share }], best first
  function guessKey(chords) {
    const items = (chords || []).map((n) => parseChord(n)).filter(Boolean).map((c) => ({ pc: parseNote(c.root).pc, tri: triadOf(c) }));
    if (!items.length) return [];
    const w = items.map((_, i) => 1 + (i === 0 ? 1.5 : 0) + (i === items.length - 1 ? 1.5 : 0));
    const total = w.reduce((a, b) => a + b, 0);
    const out = [];
    for (let k = 0; k < 12; k++)
      for (const minor of [false, true]) {
        const table = minor ? KEY_MINOR : KEY_MAJOR;
        const scale = new Set(table.map(([d]) => d));
        let score = 0, fit = 0;
        items.forEach((it, i) => {
          const d = (it.pc - k + 12) % 12;
          const exact = table.some(([dd, t]) => dd === d && (t === it.tri || it.tri === "any"));
          const v = exact ? 1 : scale.has(d) ? 0.3 : -0.6;
          if (exact) fit += w[i];
          score += v * w[i];
          // home chord: the key's own chord, most of all at the start and the end
          const tonic = d === 0 && (it.tri === (minor ? "min" : "maj") || it.tri === "any");
          if (tonic) score += 0.6 * w[i];
          // the V chord leading home
          if (d === 7 && it.tri === "maj") score += 0.15 * w[i];
        });
        const ring = minor ? CIRCLE.find((c) => parseNote(c.minor).pc === k).minor : CIRCLE.find((c) => parseNote(c.major).pc === k).major;
        out.push({ root: ring, minor, score: Math.round(score * 100) / 100, share: Math.round((fit / total) * 100) / 100 });
      }
    return out.sort((a, b) => b.score - a.score);
  }
  // ----- tuner -----
  const midiFreq = (midi, a4 = 440) => a4 * Math.pow(2, (midi - 69) / 12);
  const midiName = (midi) => SHARP_NAMES[((Math.round(midi) % 12) + 12) % 12] + (Math.floor(Math.round(midi) / 12) - 1);
  // a frequency as the nearest note: { midi, name ("E"), octave, cents (−50…+50) }
  function noteForFreq(f, a4 = 440) {
    if (!(f > 0)) return null;
    const m = 69 + 12 * Math.log2(f / a4), r = Math.round(m);
    return { midi: r, name: SHARP_NAMES[((r % 12) + 12) % 12], octave: Math.floor(r / 12) - 1, cents: Math.round((m - r) * 100), exact: m };
  }
  // the pitch of a sound (YIN): samples, sample rate, lowest and highest frequency to look for.
  // Returns the frequency, or 0 when it's too quiet or there's no clear pitch.
  function detectPitch(buf, sr, minF = 35, maxF = 1200) {
    const n = buf.length;
    let rms = 0;
    for (let i = 0; i < n; i++) rms += buf[i] * buf[i];
    if (Math.sqrt(rms / n) < 0.008) return 0;
    const maxLag = Math.min(Math.floor(sr / minF), Math.floor(n / 2)), minLag = Math.max(2, Math.floor(sr / maxF));
    const W = n - maxLag;
    const d = new Float32Array(maxLag + 2);
    for (let tau = 1; tau <= maxLag + 1; tau++) {
      let sum = 0;
      for (let i = 0; i < W; i++) {
        const x = buf[i] - buf[i + tau];
        sum += x * x;
      }
      d[tau] = sum;
    }
    // cumulative mean normalised difference
    let run = 0;
    const c = new Float32Array(maxLag + 2);
    c[0] = 1;
    for (let tau = 1; tau <= maxLag + 1; tau++) {
      run += d[tau];
      c[tau] = run ? (d[tau] * tau) / run : 1;
    }
    let tau = -1;
    for (let t = minLag; t <= maxLag; t++) {
      if (c[t] < 0.15) {
        while (t + 1 <= maxLag && c[t + 1] < c[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau < 0) {
      let best = 1;
      for (let t = minLag; t <= maxLag; t++) if (c[t] < best) (best = c[t]), (tau = t);
      if (best > 0.35) return 0;
    }
    // a little more exact, between samples
    const a = c[tau - 1] ?? c[tau], b = c[tau], z = c[tau + 1] ?? c[tau];
    const den = a - 2 * b + z;
    const shift = den ? (a - z) / (2 * den) : 0;
    return sr / (tau + (Math.abs(shift) < 1 ? shift : 0));
  }
  // ----- lyrics from a video's captions -----
  // events: [{ t: start seconds, d: duration seconds, text }] from YouTube's captions or transcript.
  // Sound labels ([Music], (applause), ♪) are dropped, each caption line is a lyric line, and a
  // pause longer than `gap` seconds starts a new verse, which begins with its time so you can jump there.
  function captionsToLyrics(events, opts = {}) {
    const gap = opts.gap ?? 3.5, times = opts.times !== false;
    const ent = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };
    const clean = (x) =>
      String(x || "")
        .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, k) => ent[k])
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
        .replace(/\[[^\]]*\]|\((?:music|applause|laughter|instrumental|cheering|singing|inaudible)[^)]*\)/gi, "")
        .replace(/[♪♫♬♩]+/g, "")
        .replace(/^\s*(>>|-)\s*/, "")
        .replace(/\s+/g, " ")
        .trim();
    const evs = (Array.isArray(events) ? events : [])
      .map((e) => ({ t: +e.t || 0, d: +e.d || 0, lines: String(e.text || "").split(/\n/).map(clean).filter(Boolean) }))
      .filter((e) => e.lines.length)
      .sort((a, b) => a.t - b.t);
    const out = [];
    let end = null, lastT = null, last = "";
    for (const e of evs) {
      const pause = end == null ? true : e.d ? e.t - end > gap : e.t - lastT > gap * 2;
      if (pause && out.length) out.push("");
      e.lines.forEach((ln, i) => {
        if (i === 0 && e.t === lastT && ln === last) return; // the same caption twice
        out.push(i === 0 && pause && times ? `[${fmtTime(Math.floor(e.t))}] ${ln}` : ln);
        last = ln;
      });
      lastT = e.t;
      end = Math.max(end ?? 0, e.t + (e.d || 0));
    }
    // captions in CAPITALS (or mostly) read better in lower case, with a capital at the start of each line and for "I"
    const letters = out.join("").replace(/\[[^\]]*\]/g, "").replace(/[^A-Za-z]/g, "");
    const upper = letters.replace(/[^A-Z]/g, "").length;
    if (opts.fixCase !== false && letters.length >= 8 && upper / letters.length > 0.6)
      return out
        .map((ln) => {
          const m = ln.match(/^(\[[^\]]*\]\s*)?(.*)$/);
          const t = m[2].toLowerCase().replace(/\bi\b/g, "I").replace(/\bi'/g, "I'").replace(/^([^A-Za-z]*)([a-z])/, (_, a, b) => a + b.toUpperCase());
          return (m[1] || "") + t;
        })
        .join("\n");
    return out.join("\n");
  }
  // json3 captions from YouTube -> events for captionsToLyrics
  function json3Events(data) {
    return ((data && data.events) || [])
      .filter((e) => Array.isArray(e.segs))
      .map((e) => ({ t: (e.tStartMs || 0) / 1000, d: (e.dDurationMs || 0) / 1000, text: e.segs.map((g) => g.utf8 || "").join("") }))
      .filter((e) => e.text.trim());
  }
  // which caption track to use: one written by people beats automatic ones; "lyrics" tracks and your language first
  function pickCaptionTrack(tracks, lang) {
    const L = String(lang || "en").slice(0, 2).toLowerCase();
    const score = (t) => (t.kind === "asr" ? 0 : 100) + (/lyric/i.test(t.name || "") ? 20 : 0) + (String(t.languageCode || "").toLowerCase().startsWith(L) ? 10 : 0);
    return (tracks || []).slice().sort((a, b) => score(b) - score(a))[0] || null;
  }
  // frets in a tab cell kept to 0..max ("27" -> "24", "5h30" -> "5h24")
  function clampCell(cell, max) {
    return String(cell || "").replace(/\d+/g, (d) => String(Math.min(+d, max)));
  }
  // the notes a tab cell plays: each fret number becomes the note it sounds on that string
  // (open: the string's name, add: a capo on this string), e.g. "5h7" on A -> "DhE"
  function tabCellNotes(cell, open, add, flats) {
    const pc = parseNote(open).pc;
    const names = flats ? FLAT_NAMES : SHARP_NAMES;
    return String(cell || "").replace(/\d+/g, (d) => names[(pc + +d + (add || 0)) % 12]);
  }
  const cleanCell = (s) => String(s || "").replace(/[-\s|]/g, "").slice(0, 6);

  // the lines of a tab: [first measure, end) pairs. perLine measures to a line; model.breaks (measure indexes)
  // also start a new line, so each part (e.g. each scale pattern) begins on its own line
  function tabSystems(model) {
    const per = Math.max(1, model.perLine || 4), total = model.measures.length;
    const starts = [...new Set([0, ...(Array.isArray(model.breaks) ? model.breaks : [])])].filter((b) => b >= 0 && b < total).sort((a, b) => a - b);
    const out = [];
    starts.forEach((a, i) => {
      const end = i + 1 < starts.length ? starts[i + 1] : total;
      for (let s = a; s < end; s += per) out.push([s, Math.min(end, s + per)]);
    });
    return out;
  }
  function formatTab(model) {
    const n = model.names.length;
    const w = Math.max(...model.names.map((x) => x.length));
    const systems = [];
    for (const [s, e] of tabSystems(model)) {
      const ms = model.measures.slice(s, e);
      const widths = ms.map((m) => m.map((col) => 1 + Math.max(2, ...col.map((c) => cleanCell(c).length))));
      const lines = [];
      for (let i = 0; i < n; i++) {
        const body = ms
          .map((m, mi) =>
            m
              .map((col, ci) => {
                const c = cleanCell(col[i]);
                return "-" + c + "-".repeat(widths[mi][ci] - 1 - c.length);
              })
              .join("")
          )
          .join("|");
        lines.push(model.names[i].padEnd(w) + "|" + body + "|");
      }
      systems.push(lines.join("\n"));
    }
    return [model.pre, systems.join("\n\n"), model.post].filter((x) => x && x.trim()).join("\n");
  }

  function parseTab(text) {
    const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
    const groups = [];
    let preEnd = -1, postStart = lines.length, lost = false;
    for (let i = 0; i < lines.length; i++) {
      if (!isTabLine(lines[i])) continue;
      const g = [];
      while (i < lines.length && isTabLine(lines[i])) g.push(lines[i++]);
      i--;
      if (g.length < 2) continue;
      if (!groups.length) preEnd = i - g.length;
      else if (lines.slice(postStart, i - g.length + 1).some((l) => l.trim())) lost = true;
      groups.push(g);
      postStart = i + 1;
    }
    if (!groups.length) return null;
    const n = groups[0].length;
    const names = groups[0].map((l) => l.match(STRING_LINE)[1]);
    const measures = [];
    let perLine = 0;
    for (const g of groups) {
      if (g.length !== n) {
        lost = true;
        continue;
      }
      const bodies = g.map((l) => {
        let b = l.match(STRING_LINE)[2].replace(/\s+$/, "");
        if (b.endsWith("|")) b = b.slice(0, -1);
        return b.split("|");
      });
      const mCount = Math.max(...bodies.map((b) => b.length));
      perLine = Math.max(perLine, mCount);
      for (let mi = 0; mi < mCount; mi++) {
        const segs = bodies.map((b) => (b[mi] || "").replace(/\s/g, "-"));
        const len = Math.max(...segs.map((s) => s.length));
        const padded = segs.map((s) => s.padEnd(len, "-"));
        const isCol = Array.from({ length: len }, (_, p) => padded.some((s) => s[p] !== "-"));
        const cols = [];
        let p = 0, last = -1;
        while (p < len) {
          if (!isCol[p]) {
            p++;
            continue;
          }
          const start = p;
          while (p < len && isCol[p]) p++;
          const gap = start - (last + 1);
          const empties = Math.max(0, Math.floor((gap - 1) / 3));
          for (let k = 0; k < empties; k++) cols.push(emptyCol(n));
          cols.push(padded.map((s) => cleanCell(s.slice(start, p))));
          last = p - 1;
        }
        const tail = len - (last + 1);
        const tailEmpties = cols.length ? Math.floor(tail / 3) : Math.max(1, Math.round(len / 3));
        for (let k = 0; k < tailEmpties; k++) cols.push(emptyCol(n));
        if (!cols.length) cols.push(emptyCol(n));
        measures.push(cols);
      }
    }
    return {
      names,
      measures,
      perLine: perLine || 4,
      pre: lines.slice(0, preEnd + 1).join("\n").replace(/^\n+|\n+$/g, ""),
      post: lines.slice(postStart).join("\n").replace(/^\n+|\n+$/g, ""),
      lost,
    };
  }

  // a tab drawn as staff lines with fret numbers on them, bars-per-line like the editor
  function staffHtml(model) {
    const n = model.names.length;
    const o = ['<div class="staff">'];
    if (model.pre) o.push(`<div class="st-txt">${esc(model.pre)}</div>`);
    for (const [s, e] of tabSystems(model)) {
      const lab = model.labels && model.labels[s];
      if (lab) o.push(`<div class="st-lab">${esc(lab)}</div>`);
      o.push('<div class="st-sys"><div class="st-names">' + model.names.map((x) => `<span>${esc(x)}</span>`).join("") + '</div><div class="st-bars">');
      model.measures.slice(s, e).forEach((m, k) => {
        o.push(`<div class="st-m"><div class="st-num">${s + k + 1}</div><div class="st-bar" style="grid-template-columns:repeat(${m.length}, auto)">`);
        for (let i = 0; i < n; i++)
          for (const col of m) {
            const c = cleanCell(col[i]);
            o.push(c ? `<span class="f">${esc(c)}</span>` : "<span></span>");
          }
        o.push("</div></div>");
      });
      o.push("</div></div>");
    }
    if (model.post) o.push(`<div class="st-txt">${esc(model.post)}</div>`);
    o.push("</div>");
    return o.join("");
  }

  // move every fret number in a tab up or down (n half steps); returns false if a note would go below the nut
  function transposeTab(model, n) {
    const shift = (c) => String(c).replace(/\d+/g, (d) => String(+d + n));
    let ok = true;
    model.measures.forEach((m) => m.forEach((col) => col.forEach((c) => c && String(c).replace(/\d+/g, (d) => (+d + n < 0 && (ok = false), d)))));
    if (!ok) return false;
    model.measures = model.measures.map((m) => m.map((col) => col.map((c) => (c ? cleanCell(shift(c)) : c))));
    return true;
  }
  // a root name n half steps away (sharps going up, flats going down, like most charts)
  const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
  const transposeRoot = (name, n) => {
    const pc = (((parseNote(name).pc + n) % 12) + 12) % 12;
    return (n > 0 ? SHARP_NAMES : FLAT_NAMES)[pc];
  };

  // change the number of strings (new tuning): keep what fits, top strings first
  function retune(model, names) {
    const n = names.length;
    model.measures = model.measures.map((m) => m.map((col) => Array.from({ length: n }, (_, i) => col[i] || "")));
    model.names = names.slice();
    return model;
  }

  // ---------- scales ----------
  // Formulas are intervals from the root (1 = root, b3 = minor third …). The degree number also picks
  // the letter, so every scale is spelled properly (A minor pentatonic: A C D E G; F major: F G A Bb C D E).
  const SCALES = [
    { id: "major", name: "Major (Ionian)", group: "Most Used", formula: "1 2 3 4 5 6 7" },
    { id: "minor", name: "Natural Minor (Aeolian)", group: "Most Used", formula: "1 2 b3 4 5 b6 b7" },
    { id: "minpent", name: "Minor Pentatonic", group: "Most Used", formula: "1 b3 4 5 b7" },
    { id: "majpent", name: "Major Pentatonic", group: "Most Used", formula: "1 2 3 5 6" },
    { id: "blues", name: "Blues", group: "Most Used", formula: "1 b3 4 b5 5 b7", aka: "minor blues" },
    { id: "majblues", name: "Major Blues", group: "Most Used", formula: "1 2 b3 3 5 6" },
    { id: "dompent", name: "Dominant Pentatonic", group: "Most Used", formula: "1 2 3 5 b7" },
    { id: "min6pent", name: "Minor 6th Pentatonic", group: "Most Used", formula: "1 b3 4 5 6", aka: "dorian pentatonic" },
    { id: "harmmin", name: "Harmonic Minor", group: "Most Used", formula: "1 2 b3 4 5 b6 7" },
    { id: "melmin", name: "Melodic Minor", group: "Most Used", formula: "1 2 b3 4 5 6 7", aka: "jazz minor" },
    { id: "dorian", name: "Dorian", group: "Modes", formula: "1 2 b3 4 5 6 b7" },
    { id: "phrygian", name: "Phrygian", group: "Modes", formula: "1 b2 b3 4 5 b6 b7" },
    { id: "lydian", name: "Lydian", group: "Modes", formula: "1 2 3 #4 5 6 7" },
    { id: "mixolydian", name: "Mixolydian", group: "Modes", formula: "1 2 3 4 5 6 b7" },
    { id: "locrian", name: "Locrian", group: "Modes", formula: "1 b2 b3 4 b5 b6 b7" },
    { id: "phrygdom", name: "Phrygian Dominant", group: "Minor-Key Modes", formula: "1 b2 3 4 5 b6 b7", aka: "spanish flamenco freygish hijaz arabic jewish" },
    { id: "lyddom", name: "Lydian Dominant", group: "Minor-Key Modes", formula: "1 2 3 #4 5 6 b7", aka: "acoustic overtone" },
    { id: "altered", name: "Altered (Super Locrian)", group: "Minor-Key Modes", formula: "1 b2 b3 b4 b5 b6 b7" },
    { id: "locnat2", name: "Locrian ♮2", group: "Minor-Key Modes", formula: "1 2 b3 4 b5 b6 b7", aka: "half diminished" },
    { id: "dorsharp4", name: "Dorian ♯4", group: "Minor-Key Modes", formula: "1 2 b3 #4 5 6 b7", aka: "ukrainian romanian" },
    { id: "mixob6", name: "Hindu (Mixolydian ♭6)", group: "Minor-Key Modes", formula: "1 2 3 4 5 b6 b7", aka: "hindu indian aeolian dominant" },
    { id: "harmmaj", name: "Harmonic Major", group: "Minor-Key Modes", formula: "1 2 3 4 5 b6 7" },
    { id: "ionaug", name: "Ionian ♯5", group: "Minor-Key Modes", formula: "1 2 3 4 #5 6 7", aka: "ionian augmented" },
    { id: "lydaug", name: "Lydian Augmented", group: "Minor-Key Modes", formula: "1 2 3 #4 #5 6 7" },
    { id: "ultraloc", name: "Ultralocrian", group: "Minor-Key Modes", formula: "1 b2 b3 b4 b5 b6 bb7", aka: "superlocrian bb7" },
    { id: "majloc", name: "Arabian (Major Locrian)", group: "Minor-Key Modes", formula: "1 2 3 4 b5 b6 b7", aka: "arabian arabic" },
    { id: "bebopdom", name: "Bebop Dominant", group: "Jazz", formula: "1 2 3 4 5 6 b7 7" },
    { id: "bebopmaj", name: "Bebop Major", group: "Jazz", formula: "1 2 3 4 5 #5 6 7" },
    { id: "bebopmin", name: "Bebop Minor (Dorian Bebop)", group: "Jazz", formula: "1 2 b3 3 4 5 6 b7" },
    { id: "dimwh", name: "Diminished (Whole–Half)", group: "Symmetric", formula: "1 2 b3 4 b5 b6 6 7" },
    { id: "dimhw", name: "Diminished (Half–Whole)", group: "Symmetric", formula: "1 b2 b3 3 #4 5 6 b7", aka: "dominant diminished octatonic" },
    { id: "whole", name: "Whole Tone", group: "Symmetric", formula: "1 2 3 #4 #5 b7" },
    { id: "augmented", name: "Augmented", group: "Symmetric", formula: "1 #2 3 5 #5 7", aka: "hexatonic" },
    { id: "chromatic", name: "Chromatic", group: "Symmetric", formula: "1 b2 2 b3 3 4 b5 5 b6 6 b7 7" },
    { id: "hungmin", name: "Hungarian Minor", group: "World", formula: "1 2 b3 #4 5 b6 7", aka: "gypsy" },
    { id: "dblharm", name: "Arabic (Double Harmonic)", group: "World", formula: "1 b2 3 4 5 b6 7", aka: "byzantine arabic arab hijaz kar kurd gypsy major" },
    { id: "neapmin", name: "Neapolitan Minor", group: "World", formula: "1 b2 b3 4 5 b6 7" },
    { id: "neapmaj", name: "Neapolitan Major", group: "World", formula: "1 b2 b3 4 5 6 7" },
    { id: "hirajoshi", name: "Hirajoshi", group: "World", formula: "1 2 b3 5 b6", aka: "japanese" },
    { id: "insen", name: "In-sen", group: "World", formula: "1 b2 4 5 b7", aka: "japanese" },
    { id: "egyptian", name: "Egyptian (Suspended Pentatonic)", group: "World", formula: "1 2 4 5 b7" },
    { id: "prometheus", name: "Prometheus", group: "World", formula: "1 2 3 #4 6 b7" },
    { id: "pelog", name: "Balinese (Pelog)", group: "Indonesian (Gamelan)", formula: "1 b2 b3 5 b6", aka: "bali indonesia indonesian gamelan pelog selisir" },
    { id: "balinese7", name: "Balinese, 7-note (Full Pelog)", group: "Indonesian (Gamelan)", formula: "1 b2 b3 4 5 b6 7", aka: "bali indonesia indonesian gamelan pelog" },
    { id: "slendro", name: "Slendro", group: "Indonesian (Gamelan)", formula: "1 2 4 5 6", aka: "bali java javanese indonesia indonesian gamelan salendro" },
    { id: "javanese", name: "Javanese", group: "Indonesian (Gamelan)", formula: "1 b2 b3 4 5 6 b7", aka: "java indonesia indonesian gamelan" },
    { id: "persian", name: "Persian", group: "World", formula: "1 b2 3 4 b5 b6 7" },
    { id: "enigmatic", name: "Enigmatic", group: "World", formula: "1 b2 3 #4 #5 #6 7" },
    { id: "spanish8", name: "Spanish 8-tone", group: "World", formula: "1 b2 b3 3 4 b5 b6 b7", aka: "flamenco" },
    { id: "kumoi", name: "Kumoi", group: "World", formula: "1 2 b3 5 6", aka: "japanese" },
    { id: "iwato", name: "Iwato", group: "World", formula: "1 b2 4 b5 b7", aka: "japanese" },
  ];
  const LETTERS = ["C", "D", "E", "F", "G", "A", "B"];
  const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];
  const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
  const ROOTS = ["C", "C#", "Db", "D", "D#", "Eb", "E", "F", "F#", "Gb", "G", "G#", "Ab", "A", "A#", "Bb", "B"];
  const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  // note names and intervals only (they have no other lowercase b): Bb -> B♭, b3 -> ♭3, #4 -> ♯4
  const pretty = (x) => String(x).replace(/b/g, "♭").replace(/#/g, "♯");
  function parseNote(n) {
    const L = LETTERS.indexOf(String(n)[0].toUpperCase());
    let acc = 0;
    for (const ch of String(n).slice(1)) acc += ch === "#" ? 1 : ch === "b" ? -1 : 0;
    return { letter: L, pc: (((LETTER_PC[L] + acc) % 12) + 12) % 12 };
  }
  function parseFormula(f) {
    return String(f)
      .trim()
      .split(/\s+/)
      .map((tok) => {
        const m = tok.match(/^([b#]*)(\d+)$/);
        const acc = [...m[1]].reduce((a, c) => a + (c === "#" ? 1 : -1), 0);
        const deg = +m[2];
        return { tok, deg, semi: MAJOR_STEPS[(deg - 1) % 7] + acc };
      });
  }
  // your own scales: { id, name, formula } — they join the list under "My Scales"
  function setCustomScales(list) {
    for (let i = SCALES.length - 1; i >= 0; i--) if (SCALES[i].group === "My Scales") SCALES.splice(i, 1);
    for (const x of Array.isArray(list) ? list : [])
      if (x && x.id && x.name && x.formula) SCALES.push({ ...x, id: String(x.id), name: String(x.name), group: "My Scales", formula: String(x.formula), mine: true });
  }
  function scaleInfo(rootName, scale) {
    const r = parseNote(rootName);
    const degs = parseFormula(scale.formula);
    const notes = degs.map((d) => {
      const letter = (r.letter + d.deg - 1) % 7;
      const pc = (((r.pc + d.semi) % 12) + 12) % 12;
      let acc = (((pc - LETTER_PC[letter]) % 12) + 12) % 12;
      if (acc > 6) acc -= 12;
      const name = Math.abs(acc) > 2 ? SHARP_NAMES[pc] : LETTERS[letter] + (acc > 0 ? "#".repeat(acc) : "b".repeat(-acc));
      return { pc, name, interval: d.tok, semi: (((d.semi % 12) + 12) % 12) };
    });
    return { rootPc: r.pc, notes, byPc: new Map(notes.map((n) => [n.pc, n])) };
  }

  // Patterns on the neck. strings are low to high here: midiLow = open-string pitches, lowest string first.
  //  "positions": the five patterns (CAGED system). Every scale gets the same five 5-fret boxes, anchored on
  //               the five notes of its pentatonic (minor pentatonic if the scale has a ♭3 and no 3, else major),
  //               each filled with that scale's notes: the 5 pentatonic boxes, blues boxes, CAGED major shapes…
  //  "nps":       3 notes per string (2 for pentatonic scales, 4 for chromatic), one pattern per degree
  //  "neck":      every note of the scale on the whole neck
  // width: how many frets each of the five patterns spans on every string (5 = the usual CAGED boxes)
  // per:   notes per string for the "nps" system (1–12; 2 or 3 if not given)
  function scalePatterns(midiLow, info, system, maxFret = 22, width = 5, per) {
    const pcs = new Set(info.notes.map((n) => n.pc));
    const inScale = (p) => pcs.has(((p % 12) + 12) % 12);
    const low = midiLow[0];
    const fretOf = (pc) => (((pc - low) % 12) + 12) % 12;
    const rootF = fretOf(info.rootPc);
    const startFret = (n) => {
      let f = fretOf(n.pc);
      // patterns go up the neck in order (5 above 4); one only drops an octave when it would run off the neck
      if (f < rootF) f += 12;
      if (f + 4 > maxFret && f >= 12) f -= 12;
      return f;
    };
    const mk = (s, f) => ({ s, f, p: midiLow[s] + f });
    if (system === "open") {
      // open position: every note of the scale from the open strings up to the 4th fret
      const notes = [];
      midiLow.forEach((o, s) => {
        for (let f = 0; f <= 4; f++) if (inScale(o + f)) notes.push(mk(s, f));
      });
      return [{ label: "Open position", anchor: 0, notes, lo: 0, hi: 4 }];
    }
    if (system === "neck") {
      const notes = [];
      midiLow.forEach((o, s) => {
        for (let f = 0; f <= maxFret; f++) if (inScale(o + f)) notes.push(mk(s, f));
      });
      return [{ label: "Whole neck", notes }];
    }
    const out = [];
    const seen = new Set();
    const semis = new Set(info.notes.map((n) => n.semi));
    const minorish = semis.has(3) && !semis.has(4);
    const anchors =
      system === "nps"
        ? info.notes
        : (minorish ? [0, 3, 5, 7, 10] : [0, 2, 4, 7, 9]).map((semi) => {
            const pc = (info.rootPc + semi) % 12;
            return info.byPc.get(pc) || { pc, name: SHARP_NAMES[pc], semi };
          });
    anchors.forEach((n) => {
      const f = startFret(n);
      let notes = [];
      if (system === "nps") {
        // each string carries on the scale where the last one stopped, as long as that stays within reach of
        // the starting fret (a fret below to four above); otherwise the string starts again at the starting fret.
        // Up to 3 per string that gives the usual patterns; more per string fills a wider part of every string.
        const k = info.notes.length;
        const n = Math.max(1, Math.min(12, per || (k <= 6 ? 2 : 3)));
        const base = f;
        let next = low + f;
        midiLow.forEach((o, s) => {
          let p = next;
          while (!inScale(p)) p++;
          const fr = p - o;
          if (s > 0 && (fr < Math.max(0, base - 1) || fr > base + 4)) {
            p = o + Math.max(0, base - 1);
            while (!inScale(p)) p++;
          }
          for (let c = 0; c < n; c++) {
            if (p - o <= 24) notes.push(mk(s, p - o)); // a guitar or bass neck ends at fret 24
            p++;
            while (!inScale(p)) p++;
          }
          next = p;
        });
      } else {
        const w = Math.max(1, Math.min(12, width || 5));
        const start = f - (w >= 4 ? 1 : 0); // a fret below the anchor, like the CAGED boxes
        const lo = Math.max(0, start), hi = start + w - 1;
        const have = new Set();
        midiLow.forEach((o, s) => {
          for (let fr = lo; fr <= hi; fr++) {
            const p = o + fr;
            // in a box of up to 5 frets each note is played once; wider boxes show every place it can be played
            if (inScale(p) && (w > 5 || !have.has(p))) {
              have.add(p);
              notes.push(mk(s, fr));
            }
          }
        });
      }
      const key = notes.map((x) => `${x.s}:${x.f}`).join(",");
      if (!notes.length || seen.has(key)) return;
      seen.add(key);
      const frets = notes.map((x) => x.f);
      out.push({ label: `Pattern ${out.length + 1}`, from: n, anchor: f, notes, lo: Math.min(...frets), hi: Math.max(...frets) });
    });
    return out;
  }
  // n notes on each string that's switched on (on[s], lowest string first), starting at fret `anchor`:
  // each string carries on the scale where the last one stopped while that stays within reach of the anchor
  // (a fret below to four above); otherwise it starts again at the anchor. Stops at maxFret.
  function perStringRun(midiLow, info, anchor, n, on, maxFret = 24) {
    const pcs = new Set(info.notes.map((x) => x.pc));
    const inScale = (p) => pcs.has(((p % 12) + 12) % 12);
    const low = Math.max(0, anchor - 1);
    const notes = [];
    let next = null;
    midiLow.forEach((o, s) => {
      if (on && !on[s]) return;
      let p = next == null ? o + anchor : next;
      while (!inScale(p)) p++;
      if (next != null && (p - o < low || p - o > anchor + 4)) {
        p = o + low;
        while (!inScale(p)) p++;
      }
      for (let c = 0; c < n; c++) {
        if (p - o <= maxFret) notes.push({ s, f: p - o, p });
        p++;
        while (!inScale(p)) p++;
      }
      next = p;
    });
    const fs = notes.map((x) => x.f);
    return { notes, lo: fs.length ? Math.min(...fs) : 0, hi: fs.length ? Math.max(...fs) : 0 };
  }

  // tab for a pattern: low to high (and back down), 8 notes a bar
  // byString: play every note of each string in turn (per-string patterns); otherwise each pitch once, low to high
  function patternTab(pattern, names, upDown, perBar = 8, byString = false) {
    const n = names.length;
    const asc = byString
      ? pattern.notes.slice().sort((a, b) => a.s - b.s || a.f - b.f)
      : pattern.notes.slice().sort((a, b) => a.p - b.p || a.f - b.f).filter((x, i, arr) => !i || arr[i - 1].p !== x.p);
    const seq = upDown ? asc.concat(asc.slice(0, -1).reverse()) : asc;
    const cols = seq.map((x) => {
      const c = emptyCol(n);
      c[n - 1 - x.s] = String(x.f);
      return c;
    });
    const measures = [];
    for (let i = 0; i < cols.length; i += perBar) measures.push(cols.slice(i, i + perBar));
    return { names: names.slice(), measures, perLine: 2, pre: "", post: "" };
  }

  // ---------- keys: circle of fifths ----------
  // Clockwise from the top: each step is a fifth up (one more sharp, or one flat fewer).
  const CIRCLE = [
    { major: "C", minor: "A" },
    { major: "G", minor: "E" },
    { major: "D", minor: "B" },
    { major: "A", minor: "F#" },
    { major: "E", minor: "C#" },
    { major: "B", minor: "G#", alt: "Cb", altMinor: "Ab" },
    { major: "F#", minor: "D#", alt: "Gb", altMinor: "Eb" },
    { major: "Db", minor: "Bb", alt: "C#", altMinor: "A#" },
    { major: "Ab", minor: "F" },
    { major: "Eb", minor: "C" },
    { major: "Bb", minor: "G" },
    { major: "F", minor: "D" },
  ];
  const SHARP_ORDER = ["F", "C", "G", "D", "A", "E", "B"];
  const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII"];
  const QUAL = { "4,7": "maj", "3,7": "min", "3,6": "dim", "4,8": "aug" };
  // triads on each degree of a 7-note scale
  function diatonicChords(info) {
    const ns = info.notes;
    return ns.map((n, i) => {
      const third = (ns[(i + 2) % 7].pc - n.pc + 12) % 12;
      const fifth = (ns[(i + 4) % 7].pc - n.pc + 12) % 12;
      const q = QUAL[`${third},${fifth}`] || "maj";
      const r = q === "min" || q === "dim" ? ROMAN[i].toLowerCase() : ROMAN[i];
      return {
        degree: i,
        roman: r + (q === "dim" ? "°" : q === "aug" ? "+" : ""),
        name: n.name + (q === "min" ? "m" : q === "dim" ? "°" : q === "aug" ? "+" : ""),
        quality: q,
      };
    });
  }
  // everything about a key: signature, notes, chords, relative and neighbouring keys, common progressions
  function keyInfo(rootName, minor) {
    const scale = SCALES.find((x) => x.id === (minor ? "minor" : "major"));
    const info = scaleInfo(rootName, scale);
    const acc = info.notes.filter((n) => n.name.length > 1);
    const sharps = acc.filter((n) => n.name.includes("#"));
    const flats = acc.filter((n) => n.name.includes("b"));
    const list = (sharps.length ? sharps : flats).map((n) => n.name);
    const order = sharps.length ? SHARP_ORDER : SHARP_ORDER.slice().reverse();
    list.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
    const chords = diatonicChords(info);
    const idx = CIRCLE.findIndex((c) => parseNote(minor ? c.minor : c.major).pc === info.rootPc);
    const at = (k) => CIRCLE[(idx + k + 12) % 12];
    const relative = minor ? at(0).major : at(0).minor;
    const name = (r, m) => `${r} ${m ? "minor" : "major"}`;
    const C = (...d) => d.map((i) => chords[i]);
    const progressions = minor
      ? [
          { roman: "i – iv – v", chords: C(0, 3, 4) },
          { roman: "i – VI – III – VII", chords: C(0, 5, 2, 6) },
          { roman: "i – VII – VI – VII", chords: C(0, 6, 5, 6) },
          { roman: "i – iv – VII – III", chords: C(0, 3, 6, 2) },
          // in minor keys the V chord is usually made major (from harmonic minor)
          { roman: "ii° – V – i", chords: [chords[1], { roman: "V", name: info.notes[4].name, quality: "maj" }, chords[0]] },
        ]
      : [
          { roman: "I – IV – V", chords: C(0, 3, 4) },
          { roman: "I – V – vi – IV", chords: C(0, 4, 5, 3) },
          { roman: "I – vi – IV – V", chords: C(0, 5, 3, 4) },
          { roman: "ii – V – I", chords: C(1, 4, 0) },
          { roman: "vi – IV – I – V", chords: C(5, 3, 0, 4) },
        ];
    return {
      root: rootName,
      minor: !!minor,
      title: name(rootName, minor),
      info,
      signature: { count: list.length, type: sharps.length ? "sharps" : flats.length ? "flats" : "", accidentals: list },
      chords,
      relative: name(relative, !minor),
      relativeRoot: relative,
      neighbours: [
        { roman: minor ? "iv" : "IV", key: name(minor ? at(-1).minor : at(-1).major, minor), root: minor ? at(-1).minor : at(-1).major },
        { roman: minor ? "v" : "V", key: name(minor ? at(1).minor : at(1).major, minor), root: minor ? at(1).minor : at(1).major },
      ],
      circleIndex: idx,
      progressions,
    };
  }

  // ---------- key signature: the start of a score (treble clef + sharps or flats) ----------
  // sharps (+) or flats (−) for each key as it is usually written; keys that would need double sharps
  // or double flats (D# major, D♭ minor …) use the key that sounds the same
  const KEY_SIG = {
    maj: { C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, "F#": 6, "C#": 7, F: -1, Bb: -2, Eb: -3, Ab: -4, Db: -5, Gb: -6, Cb: -7, "D#": -3, "G#": -4, "A#": -2 },
    min: { A: 0, E: 1, B: 2, "F#": 3, "C#": 4, "G#": 5, "D#": 6, "A#": 7, D: -1, G: -2, C: -3, F: -4, Bb: -5, Eb: -6, Ab: -7, Db: 4, Gb: 3 },
  };
  const SIG_SHARPS = ["F", "C", "G", "D", "A", "E", "B"];
  // where each accidental sits, in half staff spaces down from the top line (F5)
  const SIG_SHARP_STEPS = [0, 3, -1, 2, 5, 1, 4];
  const SIG_FLAT_STEPS = [4, 1, 5, 2, 6, 3, 7];
  // "Key: G Major", "key: Bbm", "Key - F# minor" … near the top of a page → { root, minor } or null
  const KEY_LINE_RE = /^\s*key\s*:\s*([A-Ga-g])([#b♯♭]?)\s*(major|minor|maj|min|m)?\b/i;
  function parseKeyLine(line) {
    const m = String(line).match(KEY_LINE_RE);
    if (!m) return null;
    const root = m[1].toUpperCase() + m[2].replace("♯", "#").replace("♭", "b");
    if (!ROOTS.includes(root) && root !== "Cb") return null;
    return { root, minor: /^(minor|min|m)$/i.test(m[3] || "") };
  }
  function keySignature(root, minor) {
    const n = (minor ? KEY_SIG.min : KEY_SIG.maj)[root] ?? 0;
    const names = n > 0 ? SIG_SHARPS.slice(0, n).map((x) => x + "#") : SIG_SHARPS.slice().reverse().slice(0, -n).map((x) => x + "b");
    return { count: Math.abs(n), type: n > 0 ? "sharps" : n < 0 ? "flats" : "", accidentals: names };
  }
  const TREBLE_CLEF =
    '<path stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M8.6 44.5 C10.8 46 13.4 44.6 12.9 41.6 L10.2 4.6 C9.9 1.2 12.6 -0.6 13.8 1.6 C15.4 4.6 11.6 10 8.4 13.6 C4.6 17.8 2.4 21.6 2.6 26.6 C2.9 32.4 7.6 35.4 12.2 34.4 C16.4 33.4 17.4 27.6 14 25.6 C11.2 24 7.8 25.8 8.2 29 C8.4 30.6 9.6 31.4 10.8 31.3"/>';
  // a small picture (SVG text) of the staff's beginning; `color` is the ink
  function keySignatureSvg(root, minor, color = "#222") {
    const sig = keySignature(root, minor);
    const g = 3, top = 12, x0 = 24, dx = 7.5;
    const W = x0 + sig.count * dx + 14, H = 50;
    const f = (x) => +x.toFixed(2);
    const o = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><g stroke="${color}" fill="none">`];
    for (let i = 0; i < 5; i++) o.push(`<line x1="0" x2="${W}" y1="${top + i * 2 * g}" y2="${top + i * 2 * g}" stroke-width=".8"/>`);
    o.push(`<line x1=".4" x2=".4" y1="${top}" y2="${top + 8 * g}" stroke-width=".8"/>`);
    o.push(`<g transform="translate(3 ${top - 12})">${TREBLE_CLEF}<circle cx="8.4" cy="43.4" r="2.2" fill="${color}" stroke="none"/></g>`);
    for (let i = 0; i < sig.count; i++) {
      const x = x0 + i * dx, y = top + (sig.type === "sharps" ? SIG_SHARP_STEPS[i] : SIG_FLAT_STEPS[i]) * g;
      if (sig.type === "sharps")
        o.push(
          `<path d="M${f(x - 1.2)} ${y - 6} V${y + 7} M${f(x + 1.2)} ${y - 7} V${y + 6}" stroke-width=".8"/>`,
          `<path d="M${x - 3} ${f(y - 1.2)} L${x + 3} ${f(y - 2.8)} M${x - 3} ${f(y + 2.8)} L${x + 3} ${f(y + 1.2)}" stroke-width="1.6"/>`
        );
      else
        o.push(
          `<path d="M${x - 2} ${y - 9} V${y + 3} C${x + 1} ${y + 1} ${x + 4} ${y - 1} ${x + 3} ${f(y - 2.6)} C${x + 2} ${y - 4} ${f(x - 0.5)} ${f(y - 2.5)} ${x - 2} ${f(y - 0.8)}" stroke-width="1.1" stroke-linejoin="round"/>`
        );
    }
    o.push("</g></svg>");
    return o.join("");
  }
  // the key signature a scale is written in: a mode uses its parent major key (D Dorian → C major);
  // other scales use the major or minor key of their root (A minor pentatonic → A minor)
  function scaleKeySignature(info) {
    const pcs = new Set(info.notes.map((n) => n.pc));
    const names = info.notes.map((n) => n.name).join("");
    const root = info.notes[0].name;
    if (pcs.size === 7) {
      const MAJ = [0, 2, 4, 5, 7, 9, 11];
      const cands = Object.entries(KEY_SIG.maj).filter(([k]) => !["D#", "G#", "A#"].includes(k) && MAJ.every((iv) => pcs.has((parseNote(k).pc + iv) % 12)));
      if (cands.length) {
        // spell it the way the scale's notes are spelled (sharps or flats), else the fewest accidentals
        const want = /#/.test(names) ? 1 : /b/.test(names) ? -1 : 0;
        cands.sort((a, b) => (want && Math.sign(a[1]) !== want) - (want && Math.sign(b[1]) !== want) || Math.abs(a[1]) - Math.abs(b[1]));
        const key = cands[0][0];
        // natural minor (Aeolian): its own minor key, the relative of that major
        if ((parseNote(key).pc + 9) % 12 === info.rootPc && KEY_SIG.min[root] != null && KEY_SIG.min[root] === KEY_SIG.maj[key])
          return { root, minor: true, parent: false, ...keySignature(root, true) };
        return { root: key, minor: false, parent: parseNote(key).pc !== info.rootPc, ...keySignature(key, false) };
      }
    }
    const semis = new Set(info.notes.map((n) => n.semi));
    const minor = semis.has(3) && !semis.has(4);
    const r = (minor ? KEY_SIG.min : KEY_SIG.maj)[root] != null ? root : ROOTS.find((x) => parseNote(x).pc === info.rootPc) || "C";
    return { root: r, minor, parent: false, ...keySignature(r, minor) };
  }
  // the same as an <img> (it adds no text, so the editor's text positions don't change)
  function keySignatureImg(root, minor) {
    const sig = keySignature(root, minor);
    const what = sig.count ? `${sig.count} ${sig.count === 1 ? sig.type.slice(0, -1) : sig.type} (${sig.accidentals.map(pretty).join(" ")})` : "no sharps or flats";
    const label = `Key signature: ${pretty(root)} ${minor ? "minor" : "major"}, ${what}`;
    const src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(keySignatureSvg(root, minor));
    return `<img class="keysig" src="${src}" alt="${esc(label)}" title="${esc(label)}" contenteditable="false" draggable="false">`;
  }

  // ---------- CAGED: the five open chord shapes, moved up the neck ----------
  // frets are for the strings from low E to high e (null = not played), in the open-chord key `root`.
  const CAGED = {
    major: [
      { name: "C", root: 0, frets: [null, 3, 2, 0, 1, 0] },
      { name: "A", root: 9, frets: [null, 0, 2, 2, 2, 0] },
      { name: "G", root: 7, frets: [3, 2, 0, 0, 0, 3] },
      { name: "E", root: 4, frets: [0, 2, 2, 1, 0, 0] },
      { name: "D", root: 2, frets: [null, null, 0, 2, 3, 2] },
    ],
    minor: [
      { name: "C", root: 0, frets: [null, 3, 1, 0, 1, null] },
      { name: "A", root: 9, frets: [null, 0, 2, 2, 1, 0] },
      { name: "G", root: 7, frets: [3, 1, 0, 0, 3, 3] },
      { name: "E", root: 4, frets: [0, 2, 2, 0, 0, 0] },
      { name: "D", root: 2, frets: [null, null, 0, 2, 3, 1] },
    ],
  };
  const STD_LOW = [40, 45, 50, 55, 59, 64];
  // the five shapes for a chord, in the order they come up the neck, each with the scale pattern it sits in
  function cagedShapes(rootName, minor) {
    const pc = parseNote(rootName).pc;
    const scale = SCALES.find((x) => x.id === (minor ? "minor" : "major"));
    const pats = scalePatterns(STD_LOW, scaleInfo(rootName, scale), "positions");
    return CAGED[minor ? "minor" : "major"]
      .map((sh) => {
        const off = (pc - sh.root + 12) % 12;
        const frets = sh.frets.map((f) => (f == null ? null : f + off));
        const notes = [];
        frets.forEach((f, s) => f != null && notes.push({ s, f, p: STD_LOW[s] + f }));
        const fs = notes.map((x) => x.f);
        const lowestRoot = notes.find((x) => x.p % 12 === pc);
        // the scale pattern that holds most of the shape (an octave up or down counts: open C = pattern at fret 12)
        let best = 0, bestN = -1;
        pats.forEach((p, i) => {
          const have = new Set(p.notes.map((x) => `${x.s}:${x.f % 12}`));
          const n = notes.filter((x) => have.has(`${x.s}:${x.f % 12}`)).length;
          if (n > bestN) (bestN = n), (best = i);
        });
        return { name: sh.name, frets, notes, lo: Math.min(...fs), hi: Math.max(...fs), rootString: lowestRoot ? 6 - lowestRoot.s : null, pattern: best };
      })
      .sort((a, b) => a.lo - b.lo || a.hi - b.hi);
  }

  // ---------- chords: names, shapes (fingerings) and chord sheets ----------
  // A chord name: root (A–G with # or b), a quality (m, 7, maj7, sus4 …) and an optional bass note (G/B).
  const CHORD_RE = /^([A-G])([#b]?)([^/\s]*)(?:\/([A-G][#b]?))?$/;
  const QUALITY_ALIASES = {
    "": "", M: "", maj: "", major: "",
    m: "m", min: "m", "-": "m", minor: "m",
    "7": "7", dom7: "7",
    m7: "m7", min7: "m7", "-7": "m7",
    maj7: "maj7", M7: "maj7", "Δ": "maj7", "Δ7": "maj7", ma7: "maj7",
    sus2: "sus2", sus4: "sus4", sus: "sus4",
    "5": "5", "6": "6", m6: "m6", "9": "9", add9: "add9", add2: "add9",
    "7sus4": "7sus4", "7sus": "7sus4",
    dim: "dim", "°": "dim", o: "dim", dim7: "dim7", "°7": "dim7", o7: "dim7",
    m7b5: "m7b5", "ø": "m7b5", "ø7": "m7b5", "m7-5": "m7b5",
    aug: "aug", "+": "aug",
  };
  for (const t of ["madd9", "69", "m(maj7)", "7b5", "7#5", "maj9", "m9", "9sus4", "7b9", "7#9", "11", "m11", "add11", "7#11", "13", "maj13", "m13"]) if (!(t in QUALITY_ALIASES)) QUALITY_ALIASES[t] = t;
  function parseChord(name) {
    const m = String(name || "").trim().match(CHORD_RE);
    if (!m) return null;
    const suffix = m[3] || "";
    // the suffix may only be made of chord words and numbers (so "[Amazing]" or "[Bridge]" isn't a chord)
    if (suffix.replace(/madd|major|minor|maj|min|dim|aug|sus|add|dom|ma|ø|°|Δ|M|m|o|\+|-|\d|\(|\)|b|#/g, "") !== "") return null;
    const quality = QUALITY_ALIASES[suffix] ?? (suffix.startsWith("m") && !suffix.startsWith("maj") ? "m" : ""); // unknown extras: closest triad
    return { root: m[1] + m[2], suffix, quality, exact: suffix in QUALITY_ALIASES, bass: m[4] || "" };
  }
  // a chord name, or the name of one of your own chords (one word)
  const isChord = (t) => t === "N.C." || t === "NC" || !!parseChord(t) || (typeof customChords === "object" && !!t && !/\s/.test(t) && Object.prototype.hasOwnProperty.call(customChords, t));
  function transposeChord(name, n) {
    const c = parseChord(name);
    if (!c || !n) return name;
    return transposeRoot(c.root, n) + c.suffix + (c.bass ? "/" + transposeRoot(c.bass, n) : "");
  }

  // Shapes: frets from the low E string to the high e (null = not played, 0 = open), fingers 0–4 (0 = none).
  const OPEN_CHORDS = {
    C: ["x32010", "032010"], D: ["xx0232", "000132"], E: ["022100", "023100"], G: ["320003", "210003"], A: ["x02220", "001230"],
    Am: ["x02210", "002310"], Dm: ["xx0231", "000231"], Em: ["022000", "023000"],
    E7: ["020100", "020100"], A7: ["x02020", "002030"], D7: ["xx0212", "000213"], G7: ["320001", "320001"], C7: ["x32310", "032410"], B7: ["x21202", "021304"],
    Am7: ["x02010", "002010"], Em7: ["022030", "012030"], Dm7: ["xx0211", "000211"],
    Cmaj7: ["x32000", "032000"], Fmaj7: ["xx3210", "003210"], Amaj7: ["x02120", "002130"], Dmaj7: ["xx0222", "000111"], Gmaj7: ["320002", "320001"], Emaj7: ["021100", "031200"],
    Asus2: ["x02200", "001200"], Asus4: ["x02230", "001230"], Dsus2: ["xx0230", "000130"], Dsus4: ["xx0233", "000134"], Esus4: ["022200", "023400"],
    E5: ["022xxx", "011000"], A5: ["x022xx", "001100"], D5: ["xx023x", "000130"],
    Cadd9: ["x32030", "021030"], E6: ["022120", "023140"], A6: ["x02222", "001111"],
  };
  // movable shapes: offsets from the root's fret, for a root on the 6th string (E shape) or the 5th (A shape)
  const MOVABLE = {
    E: {
      "": ["022100", "134211"], m: ["022000", "134111"], "7": ["020100", "131211"], m7: ["020000", "131111"], maj7: ["0x110x", "1x342x"],
      sus4: ["022200", "134411"], "5": ["022xxx", "134xxx"], "6": ["022120", ""], m6: ["022020", ""], "9": ["020102", ""],
      "7sus4": ["020200", "131411"], aug: ["032110", ""], dim7: ["x12020", ""], m7b5: ["x1003x", ""],
    },
    A: {
      "": ["x02220", "x13331"], m: ["x02210", "x13421"], "7": ["x02020", "x13141"], m7: ["x02010", "x13121"], maj7: ["x02120", "x13241"],
      sus2: ["x02200", "x13411"], sus4: ["x02230", "x13341"], "5": ["x022xx", "x134xx"], "6": ["x02222", "x13333"], m6: ["x02212", ""],
      add9: ["x02420", ""], "7sus4": ["x02030", "x13141"], dim: ["x0121x", ""], dim7: ["x01212", ""], m7b5: ["x0101x", ""],
      aug: ["x03221", ""],
    },
  };
  const toArr = (str) => [...String(str).replace(/[^x\d]/g, "")].map((ch) => (ch === "x" ? null : +ch));
  const fingersArr = (str) => (str ? [...String(str)].map((ch) => (ch === "x" ? 0 : +ch || 0)) : [0, 0, 0, 0, 0, 0]);
  // every shape we know for a chord, the usual one first: [{ frets, fingers, base? }]
  function chordShapes(name) {
    const c = parseChord(name);
    if (!c) return [];
    // a chord type the built-in shapes don't cover (9, 13, 7#9 …): shapes found on the neck
    if (!(c.suffix in QUALITY_ALIASES) || c.bass) {
      const v = chordVoicings(name);
      if (v.length) return v;
    }
    const pc = parseNote(c.root).pc;
    const out = [];
    // open chord under any spelling (C# = Db …)
    for (const [nm, [fr, fi]] of Object.entries(OPEN_CHORDS)) {
      const oc = parseChord(nm);
      if (oc && parseNote(oc.root).pc === pc && QUALITY_ALIASES[oc.suffix] === c.quality) out.push({ frets: toArr(fr), fingers: fingersArr(fi) });
    }
    // barre shapes (root on the 6th or 5th string), the one lower on the neck first
    const moves = [];
    for (const [shape, open] of [["E", 4], ["A", 9]]) {
      const t = MOVABLE[shape][c.quality];
      if (!t) continue;
      const r = (pc - open + 12) % 12 || (out.length ? 12 : 0);
      const frets = toArr(t[0]).map((f) => (f == null ? null : f + r));
      const fingers = r === 0 ? toArr(t[0]).map(() => 0) : fingersArr(t[1]);
      moves.push({ frets, fingers, low: Math.min(...frets.filter((f) => f != null)) });
    }
    moves.sort((a, b) => a.low - b.low).forEach(({ frets, fingers }) => out.push({ frets, fingers }));
    // drop repeats
    const seen = new Set();
    return out.filter((s) => {
      const k = s.frets.join(",");
      return !seen.has(k) && seen.add(k);
    });
  }
  // ---------- the chord library: every chord type, its notes, and playable shapes found on the neck ----------
  // semitones above the root; "need" = the notes a shape must have (the 5th, and the 9th/11th under a 13th, can be left out)
  const CHORD_TYPES = [
    { s: "", name: "Major", group: "Triads", iv: [0, 4, 7] },
    { s: "m", name: "Minor", group: "Triads", iv: [0, 3, 7] },
    { s: "dim", name: "Diminished", group: "Triads", iv: [0, 3, 6] },
    { s: "aug", name: "Augmented", group: "Triads", iv: [0, 4, 8] },
    { s: "5", name: "Power chord (5)", group: "Triads", iv: [0, 7] },
    { s: "sus2", name: "Suspended 2nd", group: "Suspended & Added", iv: [0, 2, 7] },
    { s: "sus4", name: "Suspended 4th", group: "Suspended & Added", iv: [0, 5, 7] },
    { s: "add9", name: "Added 9th", group: "Suspended & Added", iv: [0, 4, 7, 14] },
    { s: "madd9", name: "Minor added 9th", group: "Suspended & Added", iv: [0, 3, 7, 14] },
    { s: "6", name: "Major 6th", group: "Suspended & Added", iv: [0, 4, 7, 9] },
    { s: "m6", name: "Minor 6th", group: "Suspended & Added", iv: [0, 3, 7, 9] },
    { s: "69", name: "6/9", group: "Suspended & Added", iv: [0, 4, 7, 9, 14] },
    { s: "7", name: "Dominant 7th", group: "Sevenths", iv: [0, 4, 7, 10] },
    { s: "maj7", name: "Major 7th", group: "Sevenths", iv: [0, 4, 7, 11] },
    { s: "m7", name: "Minor 7th", group: "Sevenths", iv: [0, 3, 7, 10] },
    { s: "m(maj7)", name: "Minor major 7th", group: "Sevenths", iv: [0, 3, 7, 11] },
    { s: "7sus4", name: "7th suspended 4th", group: "Sevenths", iv: [0, 5, 7, 10] },
    { s: "dim7", name: "Diminished 7th", group: "Sevenths", iv: [0, 3, 6, 9] },
    { s: "m7b5", name: "Half-diminished (m7♭5)", group: "Sevenths", iv: [0, 3, 6, 10] },
    { s: "7b5", name: "7th flat 5", group: "Sevenths", iv: [0, 4, 6, 10] },
    { s: "7#5", name: "7th sharp 5 (augmented 7th)", group: "Sevenths", iv: [0, 4, 8, 10] },
    { s: "9", name: "Dominant 9th", group: "Extended", iv: [0, 4, 7, 10, 14] },
    { s: "maj9", name: "Major 9th", group: "Extended", iv: [0, 4, 7, 11, 14] },
    { s: "m9", name: "Minor 9th", group: "Extended", iv: [0, 3, 7, 10, 14] },
    { s: "9sus4", name: "9th suspended 4th", group: "Extended", iv: [0, 5, 7, 10, 14] },
    { s: "7b9", name: "7th flat 9", group: "Extended", iv: [0, 4, 7, 10, 13] },
    { s: "7#9", name: "7th sharp 9 (Hendrix)", group: "Extended", iv: [0, 4, 7, 10, 15] },
    { s: "11", name: "Dominant 11th", group: "Extended", iv: [0, 7, 10, 14, 17], need: [0, 10, 17] },
    { s: "m11", name: "Minor 11th", group: "Extended", iv: [0, 3, 7, 10, 14, 17], need: [0, 3, 10, 17] },
    { s: "add11", name: "Added 11th", group: "Extended", iv: [0, 4, 7, 17] },
    { s: "7#11", name: "7th sharp 11", group: "Extended", iv: [0, 4, 7, 10, 18], need: [0, 4, 10, 18] },
    { s: "13", name: "Dominant 13th", group: "Extended", iv: [0, 4, 7, 10, 14, 21], need: [0, 4, 10, 21] },
    { s: "maj13", name: "Major 13th", group: "Extended", iv: [0, 4, 7, 11, 14, 21], need: [0, 4, 11, 21] },
    { s: "m13", name: "Minor 13th", group: "Extended", iv: [0, 3, 7, 10, 14, 21], need: [0, 3, 10, 21] },
  ];
  const IV_NAMES = { 0: "1", 1: "♭2", 2: "2", 3: "♭3", 4: "3", 5: "4", 6: "♭5", 7: "5", 8: "♯5", 9: "6", 10: "♭7", 11: "7", 13: "♭9", 14: "9", 15: "♯9", 17: "11", 18: "♯11", 21: "13" };
  const chordType = (suffix) => CHORD_TYPES.find((t) => t.s === suffix) || CHORD_TYPES.find((t) => t.s === QUALITY_ALIASES[suffix]) || null;
  // a chord's notes and formula, spelled from its root (G7: G B D F)
  function chordInfo(name) {
    const c = parseChord(name);
    if (!c) return null;
    const t = chordType(c.suffix);
    if (!t) return null;
    const r = parseNote(c.root);
    const letterOf = { 0: 0, 1: 1, 2: 1, 3: 2, 4: 2, 5: 3, 6: 4, 7: 4, 8: 4, 9: 5, 10: 6, 11: 6, 13: 1, 14: 1, 15: 1, 17: 3, 18: 3, 21: 5 };
    const notes = t.iv.map((iv) => {
      const pc = (r.pc + iv) % 12;
      const letter = (r.letter + (letterOf[iv] ?? 0)) % 7;
      let acc = (((pc - LETTER_PC[letter]) % 12) + 12) % 12;
      if (acc > 6) acc -= 12;
      return Math.abs(acc) > 2 ? SHARP_NAMES[pc] : LETTERS[letter] + (acc > 0 ? "#".repeat(acc) : "b".repeat(-acc));
    });
    return { root: c.root, type: t, notes, formula: t.iv.map((iv) => IV_NAMES[iv] || iv) };
  }
  // fingers for a shape: the lowest fret is finger 1 (a barre if it needs one), then 2, 3, 4 going up
  function autoFingers(frets) {
    const fr = frets.map((f, s) => ({ f, s })).filter((x) => x.f != null && x.f > 0);
    const out = [0, 0, 0, 0, 0, 0];
    if (!fr.length) return out;
    const lo = Math.min(...fr.map((x) => x.f));
    const atLo = fr.filter((x) => x.f === lo);
    const barre = fr.length > 4 && atLo.length > 1;
    let rest = fr;
    let next = 1;
    if (barre) {
      atLo.forEach((x) => (out[x.s] = 1));
      rest = fr.filter((x) => x.f !== lo);
      next = 2;
    }
    rest.sort((a, b) => a.f - b.f || a.s - b.s).forEach((x) => (out[x.s] = Math.min(4, Math.max(next++, x.f - lo + 1))));
    return out;
  }
  // playable shapes for any chord type, found by trying every 4-fret window on the neck (standard tuning)
  const voicingCache = new Map();
  // shapes for a chord on any tuning (low: the open strings' MIDI notes, lowest first; standard guitar by default)
  function chordVoicings(name, max = 10, low = STD_LOW) {
    const c = parseChord(name);
    const t = c && chordType(c.suffix);
    if (!t) return [];
    const N = low.length;
    const key = c.root + "|" + t.s + "|" + (c.bass || "") + "|" + low.join(",");
    if (voicingCache.has(key)) return voicingCache.get(key);
    const rpc = parseNote(c.root).pc;
    const bassPc = c.bass ? parseNote(c.bass).pc : rpc;
    const tones = new Set(t.iv.map((iv) => (rpc + iv) % 12));
    if (c.bass) tones.add(bassPc);
    const need = new Set((t.need || (t.iv.length >= 4 ? t.iv.filter((iv) => iv !== 7) : t.iv)).map((iv) => (rpc + iv) % 12));
    if (c.bass) need.add(bassPc);
    const found = [];
    for (let lo = 0; lo <= 12; lo++) {
      const opts = low.map((open) => {
        const o = [null];
        for (let f = lo === 0 ? 0 : lo; f <= (lo === 0 ? 4 : lo + 3); f++) if (tones.has((open + f) % 12)) o.push(f);
        if (lo > 0 && lo <= 4 && tones.has(open % 12)) o.push(0);
        return o;
      });
      const cur = [];
      const walk = (s) => {
        if (s === N) {
          const played = cur.map((f, i) => ({ f, i })).filter((x) => x.f != null);
          if (played.length < Math.min(3, N)) return;
          // no gaps: only the low and the high strings can be left out (one gap allowed in between)
          const first = played[0].i, last = played[played.length - 1].i;
          if (last - first + 1 - played.length > 1) return;
          if ((low[first] + cur[first]) % 12 !== bassPc) return; // the bass note is the root (or the slash note)
          const pcs = new Set(played.map((x) => (low[x.i] + x.f) % 12));
          for (const n of need) if (!pcs.has(n)) return;
          const fretted = played.filter((x) => x.f > 0);
          if (fretted.length) {
            const fs = fretted.map((x) => x.f), mn = Math.min(...fs), mx = Math.max(...fs);
            if (mx - mn > 3) return;
            const atMin = fretted.filter((x) => x.f === mn).length;
            const fingers = fretted.length - (fretted.length > 4 && atMin > 1 ? atMin - 1 : 0);
            if (fingers > 4) return;
            // a barre must lie flat: open strings can't sit under it
            if (fretted.length > 4 && atMin > 1 && played.some((x) => x.f === 0 && x.i > first)) return;
          }
          found.push(cur.slice());
          return;
        }
        for (const f of opts[s]) {
          cur[s] = f;
          walk(s + 1);
        }
      };
      walk(0);
    }
    const seen = new Set();
    const scored = found
      .filter((f) => {
        const k = f.join(",");
        return !seen.has(k) && seen.add(k);
      })
      .map((frets) => {
        const played = frets.filter((f) => f != null);
        const fr = played.filter((f) => f > 0);
        const pcs = new Set(frets.map((f, i) => (f == null ? null : (low[i] + f) % 12)).filter((x) => x != null));
        const lo = fr.length ? Math.min(...fr) : 0;
        const score = played.length * 3 + [...tones].filter((p) => pcs.has(p)).length * 2 - lo * 0.6 - (frets[N - 1] == null ? 1.5 : 0) - (fr.length ? Math.max(...fr) - lo : 0) * 0.5;
        return { frets, low: lo, score };
      })
      .sort((a, b) => b.score - a.score);
    // the best shape in each part of the neck, then lower on the neck first
    const picked = [];
    for (const v of scored) {
      if (picked.length >= max) break;
      if (picked.some((p) => Math.abs(p.low - v.low) <= 1 && p.frets.filter((f, i) => f === v.frets[i]).length >= Math.max(3, N - 2))) continue;
      picked.push(v);
    }
    const out = picked.sort((a, b) => a.low - b.low).map((v) => ({ frets: v.frets, fingers: autoFingers(v.frets) }));
    voicingCache.set(key, out);
    return out;
  }
  // your own fingerings (set by the page): { "G": { frets, fingers } }
  let customChords = {};
  const setCustomChords = (map) => (customChords = map && typeof map === "object" ? map : {});
  const chordKey = (name) => {
    const c = parseChord(name);
    return c ? c.root + c.suffix : String(name);
  };
  const chordShape = (name) => customChords[chordKey(name)] || chordShapes(name)[0] || null;

  // a chord diagram (SVG): strings left to right low E → high e, finger numbers in the dots, barres drawn as a bar
  function chordDiagramSvg(name, shape, opts = {}) {
    const ns = shape && shape.frets ? shape.frets.length : 6, low = opts.low || STD_LOW;
    const W = Math.round((opts.width || 86) * Math.max(1, (ns - 1) / 5)), sx = (W - 30) / Math.max(1, ns - 1), fy = 18, L = 22, T = 34;
    const span = (ns - 1) * sx, mid = L + span / 2;
    const played = shape ? shape.frets.filter((f) => f != null && f > 0) : [];
    const maxF = played.length ? Math.max(...played) : 0;
    const minF = played.length ? Math.min(...played) : 0;
    const start = shape && shape.base ? shape.base : maxF <= 4 ? 1 : minF;
    const rows = Math.max(4, maxF - start + 1);
    const capoN = shape ? +shape.capo || 0 : 0;
    // a capo higher than the shape's own position is written under the diagram
    const H = T + rows * fy + 8 + (capoN && start !== 1 ? 12 : 0);
    const o = [`<svg class="cd" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(name)} chord">`];
    const label = String(name).replace(/b(?=\d|$|\/|m|M|s|a|d)/g, "♭").replace(/#/g, "♯");
    // a long name (your own chords) is squeezed to fit
    const fit = label.length * 7.4 > W - 6 ? ` textLength="${W - 8}" lengthAdjust="spacingAndGlyphs"` : "";
    o.push(`<text class="cd-name" x="${fit ? W / 2 : mid}" y="13"${fit}>${esc(label)}</text>`);
    if (!shape) {
      o.push(`<text class="cd-mark" x="${mid}" y="${T + 30}">?</text></svg>`);
      return o.join("");
    }
    const capo = capoN;
    // the usual way: the capo is a bar in place of the nut, with its fret beside it ("3fr")
    if (capo) o.push(`<title>Capo at fret ${capo}</title>`);
    if (start === 1 && capo)
      o.push(`<rect class="cd-capo" x="${L - 4}" y="${T - 5}" width="${span + 8}" height="5" rx="2"/><text class="cd-capofr" x="${L - 6}" y="${T + 1}">${capo}fr</text>`);
    else if (capo) o.push(`<text class="cd-capol cd-capob" x="${mid}" y="${H - 3}">Capo ${capo}</text>`);
    else if (start === 1) o.push(`<rect class="cd-nut" x="${L - 1}" y="${T - 3}" width="${span + 2}" height="3"/>`);
    else o.push(`<text class="cd-fr" x="${L - 11}" y="${T + fy / 2 + 4}">${start}</text>`);
    for (let r = 0; r <= rows; r++) o.push(`<line class="cd-line" x1="${L}" y1="${T + r * fy}" x2="${L + span}" y2="${T + r * fy}"/>`);
    for (let s = 0; s < ns; s++) o.push(`<line class="cd-line" x1="${L + s * sx}" y1="${T}" x2="${L + s * sx}" y2="${T + rows * fy}"/>`);
    const fingers = shape.fingers || [];
    // barre: one finger holding the same fret on several strings
    const byFinger = {};
    shape.frets.forEach((f, s) => {
      const fi = fingers[s];
      if (f && fi) (byFinger[`${fi}:${f}`] = byFinger[`${fi}:${f}`] || []).push(s);
    });
    for (const [k, ss] of Object.entries(byFinger)) {
      if (ss.length < 2) continue;
      const f = +k.split(":")[1];
      const y = T + (f - start + 0.5) * fy;
      o.push(`<rect class="cd-barre" x="${L + Math.min(...ss) * sx - 6}" y="${y - 6}" width="${(Math.max(...ss) - Math.min(...ss)) * sx + 12}" height="12" rx="6"/>`);
    }
    const rootPc = opts.rootPc;
    shape.frets.forEach((f, s) => {
      const x = L + s * sx;
      if (f == null) o.push(`<text class="cd-mark" x="${x}" y="${T - 7}">×</text>`);
      else if (f === 0) o.push(`<circle class="cd-open" cx="${x}" cy="${T - 11}" r="3.6"/>`);
      else {
        const y = T + (f - start + 0.5) * fy;
        const isRoot = rootPc != null && (low[s] + f) % 12 === rootPc;
        o.push(`<circle class="cd-dot${isRoot ? " root" : ""}" cx="${x}" cy="${y}" r="6.5"/>`);
        if (fingers[s]) o.push(`<text class="cd-fi${isRoot ? " root" : ""}" x="${x}" y="${y + 3.5}">${fingers[s] === 5 ? "T" : fingers[s]}</text>`);
      }
    });
    o.push("</svg>");
    return o.join("");
  }
  // a chord shape as text, strings left to right low to high:
  //   Am
  //   E A D G B e
  //   x o       o
  //   ===========
  //   | | | | 1 |  1
  //   | | 2 3 | |  2
  function chordText(name, shape, names) {
    if (!shape) return `${name}\n(no shape)`;
    const ns = shape.frets.length;
    const nm = (names || TUNINGS[0].strings).slice().reverse().slice(0, ns);
    const played = shape.frets.filter((f) => f != null && f > 0);
    const maxF = played.length ? Math.max(...played) : 0, minF = played.length ? Math.min(...played) : 0;
    const start = shape.base ? shape.base : maxF <= 4 ? 1 : minF;
    const rows = Math.max(4, maxF - start + 1);
    const w = (ns - 1) * 2 + 1;
    const out = [String(name).replace(/#/g, "♯").replace(/b(?=\d|$|\/|m|M|s|a|d)/g, "♭")];
    out.push(nm.map((x) => x.padEnd(2).slice(0, 2)).join("").trimEnd());
    out.push(shape.frets.map((f) => (f == null ? "x" : f === 0 ? "o" : " ")).join(" "));
    const capo = +shape.capo || 0;
    out.push(start === 1 ? (capo ? `${"=".repeat(w)}  capo ${capo}` : "=".repeat(w)) : "-".repeat(w));
    const fi = shape.fingers || [];
    for (let r = 0; r < rows; r++) {
      const fret = start + r;
      out.push(shape.frets.map((f, s) => (f === fret ? (fi[s] ? String(fi[s] === 5 ? "T" : fi[s]) : "●") : "|")).join(" ") + `  ${fret}`);
    }
    if (capo && start !== 1) out.push(`capo ${capo}`);
    return out.join("\n");
  }
  // text blocks side by side (chord shapes in a row)
  function sideBySide(blocks, gap = 4, per = 4) {
    const out = [];
    for (let i = 0; i < blocks.length; i += per) {
      const row = blocks.slice(i, i + per).map((b) => b.split("\n"));
      const wd = row.map((ls) => Math.max(...ls.map((l) => [...l].length)));
      const h = Math.max(...row.map((ls) => ls.length));
      for (let y = 0; y < h; y++) out.push(row.map((ls, k) => { const l = ls[y] || ""; return l + " ".repeat(wd[k] - [...l].length); }).join(" ".repeat(gap)).trimEnd());
      out.push("");
    }
    return out.join("\n").trimEnd();
  }
  // the root of a chord; your own chords keep the root of the chord they were made from
  // (a "C#m7__Custom" from C#m7 has C# roots), or the note their name starts with
  const chordRootPc = (name) => {
    const c = parseChord(name);
    if (c) return parseNote(c.root).pc;
    const mine = Object.prototype.hasOwnProperty.call(customChords, name) ? customChords[name] : null;
    const from = mine && mine.from && parseChord(mine.from);
    if (from) return parseNote(from.root).pc;
    const m = /^([A-G])([#b]?)/.exec(String(name || ""));
    return mine && m ? parseNote(m[1] + m[2]).pc : null;
  };

  // ----- chord sheets: lyrics with [chords] in them, and [Section] lines -----
  const SECTION_RE = /^\s*\[([^\]]+)\]\s*$/;
  const isSectionLine = (line) => {
    const m = String(line).match(SECTION_RE);
    return !!m && !isChord(m[1].trim());
  };
  // a line of chords (and bar marks like | or x2), the kind that sits above the words
  const bareChord = (t) => t.replace(/^\(|\)$/g, "");
  function isChordLine(l) {
    if (isSectionLine(l)) return false;
    const toks = String(l).trim().split(/\s+/).filter(Boolean);
    return toks.length > 0 && toks.every((t) => isChord(bareChord(t)) || /^[|x\d/().*-]+$/.test(t)) && toks.some((t) => isChord(bareChord(t)));
  }
  // the chords in a song, in the order they first appear (chord lines, or [chords] in the words)
  function sheetChords(text) {
    const out = [];
    const add = (c) => isChord(c) && c !== "N.C." && c !== "NC" && !out.includes(c) && out.push(c);
    for (const line of String(text || "").split("\n")) {
      if (isSectionLine(line)) continue;
      if (isChordLine(line)) for (const t of line.trim().split(/\s+/)) add(bareChord(t));
      else for (const m of line.matchAll(/\[([^\]]+)\]/g)) add(m[1].trim());
    }
    return out;
  }
  // [chords] inside the words → a chord line above each line of words
  function inlineToOver(text) {
    return String(text)
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .flatMap((line) => {
        if (isSectionLine(line) || !/\[[^\]]+\]/.test(line)) return [line];
        let words = "", chords = "", last = 0, any = false;
        for (const m of line.matchAll(/\[([^\]]+)\]/g)) {
          const c = m[1].trim();
          if (!isChord(c)) continue;
          words += line.slice(last, m.index);
          const at = Math.max(words.length, chords.length ? chords.length + 1 : 0);
          chords = chords.padEnd(at) + c;
          last = m.index + m[0].length;
          any = true;
        }
        if (!any) return [line];
        words += line.slice(last);
        return words.trim() ? [chords, words.replace(/\s+$/, "")] : [chords];
      })
      .join("\n");
  }
  // move every chord n half steps, keeping each chord over the same word
  function transposeSong(text, n) {
    return String(text)
      .split("\n")
      .map((line) => {
        if (isSectionLine(line)) return line;
        if (!isChordLine(line)) return line.replace(/\[([^\]]+)\]/g, (all, c) => (isChord(c.trim()) ? `[${transposeChord(c.trim(), n)}]` : all));
        let out = "";
        for (const m of line.matchAll(/\S+/g)) {
          const t = isChord(bareChord(m[0])) ? m[0].replace(bareChord(m[0]), transposeChord(bareChord(m[0]), n)) : m[0];
          out = out.padEnd(Math.max(m.index, out.length ? out.length + 1 : 0)) + t;
        }
        return out;
      })
      .join("\n");
  }
  // rename a chord everywhere in a song (chord lines and [chords]), keeping each over its word
  function renameChordInSong(text, from, to) {
    return String(text)
      .split("\n")
      .map((line) => {
        if (isSectionLine(line)) return line;
        if (!isChordLine(line)) return line.replace(/\[([^\]]+)\]/g, (all, c) => (c.trim() === from ? `[${to}]` : all));
        let out = "";
        for (const m of line.matchAll(/\S+/g)) {
          const t = bareChord(m[0]) === from ? m[0].replace(from, to) : m[0];
          out = out.padEnd(Math.max(m.index, out.length ? out.length + 1 : 0)) + t;
        }
        return out;
      })
      .join("\n");
  }
  // put a chord above the cursor: on the chord line over the words (made if there isn't one), at the cursor's column
  function addChordAt(text, pos, name) {
    const lines = String(text).split("\n");
    let L = 0, rest = pos;
    while (L < lines.length - 1 && rest > lines[L].length) rest -= lines[L].length + 1, L++;
    const col = Math.max(0, rest);
    let target = L, caretLine = L;
    if (!isChordLine(lines[L]) || !lines[L].trim()) {
      if (L > 0 && isChordLine(lines[L - 1])) target = L - 1;
      else if (lines[L].trim() && !isSectionLine(lines[L])) {
        lines.splice(L, 0, "");
        target = L;
        caretLine = L + 1;
      }
    }
    let line = lines[target].padEnd(col);
    const free = !line.slice(col, col + name.length + 1).trim();
    line = free ? line.slice(0, col) + name + line.slice(col + name.length) : line.slice(0, col) + name + " " + line.slice(col);
    lines[target] = line.replace(/\s+$/, "");
    const caret = lines.slice(0, caretLine).reduce((a, l) => a + l.length + 1, 0) + Math.min(col, lines[caretLine].length);
    return { text: lines.join("\n"), caret };
  }
  // a song drawn as text: chord lines in colour over the words, sections in bold, the title on top
  function songHtml(text, opts = {}) {
    let t = String(text || "").replace(/\r\n?/g, "\n");
    if (t.split("\n").some((l) => !isSectionLine(l) && /\[[^\]]+\]/.test(l) && !isChordLine(l))) t = inlineToOver(t);
    const lines = t.split("\n");
    const o = ['<div class="csheet">'];
    const used = sheetChords(t);
    if (used.length && opts.diagrams !== false)
      o.push(
        '<div class="cs-diags">' +
          used.map((c) => `<span class="cs-dg" data-chord="${esc(c)}" title="${esc(c)}: click to change the shape">${chordDiagramSvg(c, chordShape(c), { rootPc: chordRootPc(c) })}</span>`).join("") +
          "</div>"
      );
    const pc = (c) => String(c).replace(/b(?=\d|$|\/|m|M|s|a|d|\))/g, "♭").replace(/#/g, "♯");
    const first = lines.findIndex((l) => l.trim());
    const titled = first === 0 && !isChordLine(lines[0]) && !isSectionLine(lines[0]) && (lines.length === 1 || !lines[1].trim());
    const body = lines.map((l, i) => {
      if (titled && i === 0) return `<span class="sg-title">${esc(l)}</span>`;
      if (isSectionLine(l)) return `<span class="sg-sec">${esc(l.trim())}</span>`;
      if (isChordLine(l))
        return `<span class="sg-ch">${l.replace(/\S+/g, (tok) => {
          const c = bareChord(tok);
          return isChord(c) && c !== "N.C." && c !== "NC" ? `<b data-chord="${esc(c)}">${esc(pc(tok))}</b>` : esc(tok);
        })}</span>`;
      return esc(l);
    });
    o.push(`<pre class="song">${body.join("\n")}</pre></div>`);
    return o.join("");
  }
  function transposeSheet(text, n) {
    return String(text)
      .split("\n")
      .map((line) => (isSectionLine(line) ? line : line.replace(/\[([^\]]+)\]/g, (all, c) => (isChord(c.trim()) ? `[${transposeChord(c.trim(), n)}]` : all))))
      .join("\n");
  }
  // "chords above lyrics" (a line of chords, then the words) → [chords] inside the words
  function chordsOverToInline(text) {
    const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
    const isChordLine = (l) => {
      const toks = l.trim().split(/\s+/).filter(Boolean);
      return toks.length > 0 && toks.every((t) => isChord(t.replace(/^\(|\)$/g, "")) || /^[|x\d/-]+$/.test(t)) && toks.some((t) => isChord(t.replace(/^\(|\)$/g, "")));
    };
    const out = [];
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (!isChordLine(l) || isSectionLine(l)) {
        out.push(l);
        continue;
      }
      changed = true;
      const chords = [...l.matchAll(/\S+/g)].filter((m) => isChord(m[0].replace(/^\(|\)$/g, "")));
      const next = lines[i + 1];
      if (next != null && next.trim() && !isChordLine(next) && !isSectionLine(next)) {
        let lyr = next.replace(/\s+$/, "");
        for (let k = chords.length - 1; k >= 0; k--) {
          const at = chords[k].index;
          if (lyr.length < at) lyr = lyr.padEnd(at, " ");
          lyr = lyr.slice(0, at) + `[${chords[k][0].replace(/^\(|\)$/g, "")}]` + lyr.slice(at);
        }
        out.push(lyr.replace(/\s+$/, ""));
        i++;
      } else out.push(chords.map((m) => `[${m[0].replace(/^\(|\)$/g, "")}]`).join(" "));
    }
    return changed ? out.join("\n") : text;
  }
  // a sheet drawn with each chord above the word it's played on, and the chord diagrams on top
  function chordSheetHtml(text, opts = {}) {
    const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
    const o = ['<div class="csheet">'];
    const used = sheetChords(text);
    if (used.length && opts.diagrams !== false)
      o.push(
        '<div class="cs-diags">' +
          used.map((c) => `<span class="cs-dg" data-chord="${esc(c)}" title="${esc(c)}: click to change the fingering">${chordDiagramSvg(c, chordShape(c), { rootPc: chordRootPc(c) })}</span>`).join("") +
          "</div>"
      );
    const pc = (c) => esc(String(c).replace(/b(?=\d|$|\/|m|M|s|a|d)/g, "♭").replace(/#/g, "♯"));
    let blank = 0;
    for (const line of lines) {
      if (!line.trim()) {
        if (!blank++) o.push('<div class="cs-gap"></div>');
        continue;
      }
      blank = 0;
      if (isSectionLine(line)) {
        o.push(`<div class="cs-sec">${esc(line.match(SECTION_RE)[1].trim())}</div>`);
        continue;
      }
      const parts = [];
      let last = 0, pending = null, any = false;
      const push = (chord, words) => parts.push({ chord, words });
      for (const m of line.matchAll(/\[([^\]]+)\]/g)) {
        const c = m[1].trim();
        if (!isChord(c)) continue;
        const words = line.slice(last, m.index);
        if (pending !== null || words) push(pending, words);
        pending = c;
        last = m.index + m[0].length;
        any = true;
      }
      push(pending, line.slice(last));
      if (!any) {
        o.push(`<div class="cs-line cs-lyr">${esc(line)}</div>`);
        continue;
      }
      o.push(
        '<div class="cs-line">' +
          parts
            .filter((p) => p.chord || p.words)
            .map(
              (p) =>
                `<span class="cs-seg"><span class="cs-ch">${p.chord ? `<b data-chord="${esc(p.chord)}">${pc(p.chord)}</b>` : "&nbsp;"}</span><span class="cs-ly">${
                  p.words ? esc(p.words) : "&nbsp;"
                }</span></span>`
            )
            .join("") +
          "</div>"
      );
    }
    o.push("</div>");
    return o.join("");
  }


  // ----- the editor's live view: the text stays Markdown, but the marks (**, #, [](…) …) are hidden -----
  // Returns { html, hidden }. The html's text is exactly the input text (so caret offsets match);
  // hidden holds [start, end, atomic] ranges of marks that are not shown. Atomic marks (a list bullet,
  // a heading's #) are deleted as a whole.
  const LIVE_INLINE = new RegExp(
    [
      "`([^`\\n]+)`", // 1 code
      "\\[([^\\]\\n]+)\\]\\((https?:\\/\\/[^)\\s/][^)\\s]*)\\)", // 2 text 3 url
      "\\*\\*([^*\\n]+?)\\*\\*", // 4 bold
      "__([^_\\n]+?)__", // 5 bold
      "~~([^~\\n]+?)~~", // 6 strike
      "==(?:\\{(yellow|green|blue|pink|orange|purple)\\})?([^=\\n]+?)==", // 7 colour 8 highlight
      "(?<![\\w*])\\*([^*\\s](?:[^*\\n]*?[^*\\s])?)\\*(?![\\w*])", // 9 italic
      "(?<![\\w_])_([^_\\s](?:[^_\\n]*?[^_\\s])?)_(?![\\w_])", // 10 italic
      `\\[(${TIME}(?:\\s*(?:-|–)\\s*${TIME})?)\\](?!\\()`, // 11 time
      "(https?:\\/\\/[^\\s<>\"')\\]]+)", // 12 bare link
      "%%\\{([a-z0-9:;. -]+)\\}([^%\\n]+?)%%", // 13 style (colour; size; font) 14 text
      "\\^\\^([^^\\n]+?)\\^\\^", // 15 superscript
      ",,([^,\\n]+?),,", // 16 subscript
    ].join("|"),
    "g"
  );
  // %%{red;size:18;font:serif}text%% — text colour, size (px) and font for a bit of text
  const SPAN_COLORS = ["red", "blue", "green", "orange", "purple", "gray"];
  function parseSpanStyle(spec) {
    const o = {};
    for (const part of String(spec || "").split(";")) {
      const t = part.trim();
      if (!t) continue;
      const kv = t.match(/^(size|font):\s*([a-z0-9.]+)$/);
      if (kv) o[kv[1]] = kv[2];
      else if (SPAN_COLORS.includes(t)) o.color = t;
    }
    return o;
  }
  function spanSpec(o) {
    return [o.color, o.size && `size:${o.size}`, o.font && `font:${o.font}`].filter(Boolean).join(";");
  }
  function spanStyle(spec) {
    const o = parseSpanStyle(spec);
    const css = [];
    const n = +o.size;
    if (n >= 6 && n <= 96) css.push(`font-size:${n}px`);
    if (o.font && /^[a-z]+$/.test(o.font)) css.push(`font-family:var(--ff-${o.font}, inherit)`);
    return { cls: o.color ? `fc-${o.color}` : "", css: css.join(";") };
  }
  function liveInline(src, base, hidden) {
    let out = "", last = 0, m;
    const re = new RegExp(LIVE_INLINE.source, "g");
    const mk = (t, at, close) => {
      hidden.push([base + at, base + at + t.length, false, !!close]);
      return `<span class="mk">${esc(t)}</span>`;
    };
    while ((m = re.exec(src))) {
      out += esc(src.slice(last, m.index));
      const at = m.index, all = m[0];
      const wrap = (open, inner, close, tag, attrs = "") =>
        mk(open, at) + `<${tag}${attrs}>` + liveInline(inner, base + at + open.length, hidden) + `</${tag}>` + mk(close, at + open.length + inner.length, true);
      if (m[1] != null) out += mk("`", at) + `<code>${esc(m[1])}</code>` + mk("`", at + 1 + m[1].length, true);
      else if (m[2] != null) {
        const tail = `](${m[3]})`;
        out += mk("[", at) + `<a class="lk" data-href="${esc(m[3])}">` + liveInline(m[2], base + at + 1, hidden) + `</a>` + mk(tail, at + 1 + m[2].length, true);
      } else if (m[4] != null) out += wrap("**", m[4], "**", "strong");
      else if (m[5] != null) out += wrap("__", m[5], "__", "strong");
      else if (m[6] != null) out += wrap("~~", m[6], "~~", "s");
      else if (m[8] != null) out += wrap(m[7] ? `=={${m[7]}}` : "==", m[8], "==", "mark", ` class="hl-${m[7] || "yellow"}"`);
      else if (m[9] != null) out += wrap("*", m[9], "*", "em");
      else if (m[10] != null) out += wrap("_", m[10], "_", "em");
      else if (m[11] != null) out += `<span class="tm">${esc(all)}</span>`;
      else if (m[15] != null) out += wrap("^^", m[15], "^^", "sup");
      else if (m[16] != null) out += wrap(",,", m[16], ",,", "sub");
      else if (m[14] != null) {
        const st = spanStyle(m[13]);
        out += wrap(`%%{${m[13]}}`, m[14], "%%", "span", `${st.cls ? ` class="${st.cls}"` : ""}${st.css ? ` style="${st.css}"` : ""}`);
      }
      else out += `<span class="url">${esc(all)}</span>`;
      last = at + all.length;
    }
    return out + esc(src.slice(last));
  }
  // each chord on a chord line in its own span (the text stays the same), so pointing at it can show its shape
  const chordTokensHtml = (line) =>
    String(line)
      .split(/(\s+)/)
      .map((t) => {
        const c = bareChord(t);
        return t && !/^\s+$/.test(t) && c !== "N.C." && c !== "NC" && isChord(c) ? `<span class="chd" data-chord="${esc(c)}">${esc(t)}</span>` : esc(t);
      })
      .join("");
  function liveMarkup(text) {
    const hidden = [];
    const lines = String(text).split("\n");
    let pos = 0, fence = false;
    let keyShown = false;
    const html = lines
      .map((line, idx) => {
        const out = liveLine(line);
        // "Key: G Major" near the top: the key signature drawn after it
        if (!keyShown && !fence && idx < 8) {
          const k = parseKeyLine(line);
          if (k) {
            keyShown = true;
            return out.replace(/<\/span>$/, keySignatureImg(k.root, k.minor) + "</span>");
          }
        }
        return out;
      })
      .join("\n");
    return { html, hidden };
    function liveLine(line) {
        const base = pos;
        pos += line.length + 1;
        const ln = (cls, inner) => `<span class="ln${cls ? " " + cls : ""}">${inner}</span>`;
        if (/^\s*```/.test(line)) {
          fence = !fence;
          return ln("fence", esc(line));
        }
        if (fence) return ln("cb", esc(line));
        if (!line.trim()) return esc(line);
        // a picture on its own line: ![name](img:id) or ![name|320](img:id) (320 px wide)
        const im = line.match(/^\s*!\[([^\]\n|]*)(?:\|(\d{2,4}))?\]\(img:([a-z0-9]+)\)\s*$/);
        if (im) {
          hidden.push([base, base + line.length, true, false, "img"]);
          const w = im[2] ? ` style="width:${Math.min(+im[2], 2000)}px"` : "";
          return ln("imgln", `<span class="mk">${esc(line)}</span><img class="pimg" data-img="${im[3]}" alt="${esc(im[1])}"${w} contenteditable="false" draggable="false">`);
        }
        if (isTabLine(line)) return ln("tab", esc(line));
        if (isSectionLine(line) && !new RegExp(`^\\s*\\[${TIME}`).test(line)) return ln("sec", esc(line));
        if (isChordLine(line)) return ln("chl", chordTokensHtml(line));
        if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
          hidden.push([base, base + line.length, true]);
          return ln("hr", `<span class="mk">${esc(line)}</span>`);
        }
        let m = line.match(/^(#{1,3})(\s+)/);
        if (m) {
          const n = m[0].length;
          hidden.push([base, base + n, true]);
          return ln("h" + m[1].length, `<span class="mk">${esc(m[0])}</span>` + liveInline(line.slice(n), base + n, hidden));
        }
        m = line.match(/^>\s?/);
        if (m) {
          const n = m[0].length;
          hidden.push([base, base + n, true]);
          return ln("q", `<span class="mk">${esc(m[0])}</span>` + liveInline(line.slice(n), base + n, hidden));
        }
        m = line.match(/^(\s*)([-*+]\s+\[([ xX])\]\s+)/);
        if (m) {
          const i = m[1].length, n = m[2].length;
          hidden.push([base + i, base + i + n, true]);
          const done = m[3] !== " ";
          return ln("li" + (done ? " done" : ""), esc(m[1]) + `<span class="bul ${done ? "tick" : "box"}">${esc(m[2])}</span>` + liveInline(line.slice(i + n), base + i + n, hidden));
        }
        m = line.match(/^(\s*)([-*+]\s+)(?=\S)/);
        if (m) {
          const i = m[1].length, n = m[2].length;
          hidden.push([base + i, base + i + n, true]);
          return ln("li", esc(m[1]) + `<span class="bul dot">${esc(m[2])}</span>` + liveInline(line.slice(i + n), base + i + n, hidden));
        }
        return ln("", liveInline(line, base, hidden));
    }
  }
  root.__ygcNotesLib = {
    CHORD_TYPES,
    chordInfo,
    chordVoicings,
    autoFingers,
    setCustomScales,
    liveMarkup,
    parseSpanStyle,
    spanSpec,
    parseChord,
    chordBlocks,
    chordBlockAt,
    isChord,
    transposeChord,
    chordShapes,
    chordShape,
    chordKey,
    setCustomChords,
    chordDiagramSvg,
    chordRootPc,
    sheetChords,
    transposeSheet,
    chordsOverToInline,
    isChordLine,
    inlineToOver,
    transposeSong,
    addChordAt,
    renameChordInSong,
    songHtml,
    chordSheetHtml,
    isSectionLine,
    CIRCLE,
    keyInfo,
    keySignature,
    keySignatureSvg,
    keySignatureImg,
    scaleKeySignature,
    tabSystems,
    parseKeyLine,
    diatonicChords,
    cagedShapes,
    SCALES,
    ROOTS,
    pretty,
    scaleInfo,
    scalePatterns,
    patternTab,
    perStringRun,
    esc,
    inline,
    renderMarkdown,
    toggleTask,
    parseTime,
    fmtTime,
    isTabLine,
    tabBlocks,
    tabBlockAt,
    TUNINGS,
    tuningFor,
    newTab,
    newMeasure,
    emptyCol,
    cleanCell,
    clampCell,
    chordText,
    sideBySide,
    songChords,
    guessKey,
    midiFreq,
    midiName,
    noteForFreq,
    detectPitch,
    captionsToLyrics,
    json3Events,
    pickCaptionTrack,
    tabCellNotes,
    formatTab,
    parseTab,
    staffHtml,
    transposeTab,
    transposeRoot,
    retune,
  };
})();
