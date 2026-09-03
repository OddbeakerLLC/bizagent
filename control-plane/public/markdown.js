/** Shared markdown → HTML for console (app.js) and library (library.js). */
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isSafeHref(url) {
  return /^(https?:|mailto:|\/|#)/i.test(url);
}

function isSafeImageSrc(url) {
  return /^(https?:|\/)/i.test(url);
}

function parseTableCells(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((cell) => cell.trim());
}

function isTableSeparator(line) {
  const cells = parseTableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isTableRow(line) {
  const t = line.trim();
  return t.includes('|') && !/^```/.test(t);
}

/** CommonMark-ish thematic break: --- / *** / ___ alone on a line. */
function isThematicBreak(line) {
  return /^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(String(line || '').trim());
}

/** Light LaTeX → readable text (no KaTeX dependency). */
function prettifyLatex(src) {
  let s = String(src || '').replace(/\s+/g, ' ').trim();
  for (let n = 0; n < 6; n++) {
    const before = s;
    s = s.replace(/\\(?:text|mathrm|mathbf|boldsymbol|operatorname)\{([^{}]*)\}/g, '$1');
    s = s.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '($1)/($2)');
    s = s.replace(/\\sqrt\{([^{}]*)\}/g, '√($1)');
    if (s === before) break;
  }
  const symbols = [
    [/\\times\b/g, '×'], [/\\cdot\b/g, '·'], [/\\pm\b/g, '±'],
    [/\\leq\b/g, '≤'], [/\\geq\b/g, '≥'], [/\\neq\b/g, '≠'], [/\\approx\b/g, '≈'],
    [/\\infty\b/g, '∞'], [/\\sum\b/g, '∑'], [/\\prod\b/g, '∏'], [/\\int\b/g, '∫'],
    [/\\partial\b/g, '∂'], [/\\nabla\b/g, '∇'],
    [/\\lceil\b/g, '⌈'], [/\\rceil\b/g, '⌉'], [/\\lfloor\b/g, '⌊'], [/\\rfloor\b/g, '⌋'],
    [/\\langle\b/g, '⟨'], [/\\rangle\b/g, '⟩'],
    [/\\ldots\b/g, '…'], [/\\cdots\b/g, '⋯'], [/\\to\b/g, '→'], [/\\rightarrow\b/g, '→'],
    [/\\left\b/g, ''], [/\\right\b/g, ''],
    [/\\,/g, ' '], [/\\;/g, ' '], [/\\!/g, ''], [/\\quad\b/g, ' '], [/\\qquad\b/g, '  '],
  ];
  for (const [re, rep] of symbols) s = s.replace(re, rep);
  s = s.replace(/\\([a-zA-Z]+)/g, '$1');
  s = s.replace(/[{}]/g, '');
  return s.replace(/\s+/g, ' ').trim();
}

function mathBlockHtml(src, display) {
  const raw = String(src || '').trim();
  const pretty = prettifyLatex(raw) || raw;
  const title = escapeHtml(raw);
  const body = escapeHtml(pretty);
  if (display) {
    return `<div class="md-math md-math-block" title="${title}"><code>${body}</code></div>`;
  }
  return `<span class="md-math md-math-inline" title="${title}"><code>${body}</code></span>`;
}

/**
 * Try to consume a display-math block starting at lines[i].
 * Supports \[...\] and $$...$$ (single- or multi-line). Returns null if not math.
 */
function tryConsumeDisplayMath(lines, i) {
  const t = String(lines[i] || '').trim();
  let m = /^\\\[(.+)\\\]\s*$/.exec(t);
  if (m) return { end: i + 1, src: m[1] };
  m = /^\$\$([^$]+)\$\$\s*$/.exec(t);
  if (m) return { end: i + 1, src: m[1] };
  let closer = null;
  let first = '';
  if (t === '\\[' || t.startsWith('\\[')) {
    closer = '\\]';
    first = t === '\\[' ? '' : t.slice(2);
  } else if (t === '$$') {
    closer = '$$';
    first = '';
  } else if (t.startsWith('$$')) {
    closer = '$$';
    first = t.slice(2);
  } else {
    return null;
  }
  if (closer === '\\]' && first.includes('\\]')) {
    const idx = first.indexOf('\\]');
    return { end: i + 1, src: first.slice(0, idx) };
  }
  if (closer === '$$' && first.includes('$$')) {
    const idx = first.indexOf('$$');
    return { end: i + 1, src: first.slice(0, idx) };
  }
  const buf = [];
  if (first.trim()) buf.push(first);
  let j = i + 1;
  while (j < lines.length) {
    const lj = lines[j];
    const tj = String(lj || '').trim();
    if (closer === '\\]' && tj.includes('\\]')) {
      const idx = lj.indexOf('\\]');
      const before = idx >= 0 ? lj.slice(0, idx) : '';
      if (before.trim()) buf.push(before);
      return { end: j + 1, src: buf.join('\n') };
    }
    if (closer === '$$' && tj.includes('$$')) {
      const idx = lj.indexOf('$$');
      const before = idx >= 0 ? lj.slice(0, idx) : '';
      if (before.trim()) buf.push(before);
      return { end: j + 1, src: buf.join('\n') };
    }
    buf.push(lj);
    j++;
  }
  return null;
}

function renderInline(text) {
  const codeSpans = [];
  let s = text.replace(/`([^`]+)`/g, (_, code) => {
    codeSpans.push(escapeHtml(code));
    return `\x00CODESPAN:${codeSpans.length - 1}\x00`;
  });
  const maths = [];
  const pushMath = (src, display) => {
    maths.push(mathBlockHtml(src, display));
    return `\x00MATH:${maths.length - 1}\x00`;
  };
  s = s.replace(/\\\((.+?)\\\)/g, (_, src) => pushMath(src, false));
  s = s.replace(/\$\$([^$\n]+?)\$\$/g, (_, src) => pushMath(src, true));
  s = s.replace(/\$([^\s$][^$\n]*?[^\s$])\$/g, (_, src) => pushMath(src, false));
  s = s.replace(/\$([^\s$])\$/g, (_, src) => pushMath(src, false));
  s = escapeHtml(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/_([^_]+)_/g, '<em>$1</em>');
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (match, alt, url) => (
    isSafeImageSrc(url)
      ? `<img src="${url}" alt="${alt}" loading="lazy">`
      : match
  ));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, url) => (
    isSafeHref(url)
      ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`
      : match
  ));
  s = s.replace(/\x00CODESPAN:(\d+)\x00/g, (_, i) => `<code>${codeSpans[Number(i)]}</code>`);
  s = s.replace(/\x00MATH:(\d+)\x00/g, (_, i) => maths[Number(i)]);
  return s;
}

function renderMarkdown(text) {
  // Hub TTS markers (speak path reads raw body before render):
  // 1) Preferred: fenced ```tts block — drop the fence lines only; keep inner
  //    prose so it flows with the rest of the markdown (not a <pre><code>).
  // 2) Legacy: <tts-summary>…</tts-summary> — unwrap tags, keep inner text.
  const cleaned = String(text || '')
    .replace(/(^|\n)```\s*tts\b[^\n]*\n([\s\S]*?)\n```[ \t]*(?=\n|$)/gi, (m, lead, body) => {
      // Keep surrounding newlines so a blank line after the fence still
      // separates the spoken summary from the rest of the reply.
      const inner = String(body || '').replace(/^\n+/, '').replace(/\n+$/, '');
      return `${lead}${inner}`;
    })
    .replace(/<tts-summary\b[^>]*>([\s\S]*?)<\/tts-summary>/gi, '$1')
    .replace(/<\/?tts-summary\b[^>]*>/gi, '')
    .replace(/\r\n/g, '\n');
  const lines = cleaned.split('\n');
  const htmlParts = [];
  let paragraphBuffer = [];
  // Nested lists: stack of { type: 'ul'|'ol', items: [{ text, children: listNode[] }] }
  // children is an array so mixed ul+ol under one <li> both survive.
  let listStack = [];

  const flushParagraph = () => {
    if (paragraphBuffer.length) {
      htmlParts.push(`<p>${paragraphBuffer.map(renderInline).join('<br>')}</p>`);
      paragraphBuffer = [];
    }
  };

  const renderListNode = (node) => {
    const tag = node.type;
    const itemsHtml = node.items.map((item) => {
      const body = renderInline(item.text);
      const nested = (item.children || []).map(renderListNode).join('');
      return `<li>${body}${nested}</li>`;
    }).join('');
    return `<${tag}>${itemsHtml}</${tag}>`;
  };

  const flushList = () => {
    if (listStack.length) {
      htmlParts.push(renderListNode(listStack[0]));
      listStack = [];
    }
  };

  /** Parse a list item line. Indent = leading spaces/tabs (tab=4). Marker at col 0+indent. */
  const parseListItem = (line) => {
    let indent = 0;
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      if (ch === ' ') { indent += 1; i++; }
      else if (ch === '\t') { indent += 4; i++; }
      else break;
    }
    const rest = line.slice(i);
    let m = /^[-*+]\s+(.*)$/.exec(rest);
    if (m) return { indent, type: 'ul', text: m[1] };
    m = /^\d+\.\s+(.*)$/.exec(rest);
    if (m) return { indent, type: 'ol', text: m[1] };
    return null;
  };

  /**
   * Push item into nested list stack. indent units are spaces (2+ → nest).
   * CommonMark-ish: each 2 spaces of indent ≈ one nest level relative to parent marker.
   */
  const ensureChildList = (item, type) => {
    if (!item.children) item.children = [];
    const last = item.children[item.children.length - 1];
    if (last && last.type === type) return last;
    const node = { type, items: [] };
    item.children.push(node);
    return node;
  };

  const pushListItem = (parsed) => {
    const level = Math.floor(parsed.indent / 2);

    // Pop deeper levels
    while (listStack.length > level + 1) listStack.pop();

    // Need a list at this level
    if (listStack.length === 0) {
      listStack.push({ type: parsed.type, items: [] });
    } else if (listStack.length <= level) {
      // Open nested lists under the last item of the current deepest list
      while (listStack.length <= level) {
        const parent = listStack[listStack.length - 1];
        if (!parent.items.length) break;
        const lastItem = parent.items[parent.items.length - 1];
        const childList = ensureChildList(lastItem, parsed.type);
        listStack.push(childList);
      }
      if (listStack.length === 0) {
        listStack.push({ type: parsed.type, items: [] });
      }
    }

    const cur = listStack[listStack.length - 1];
    // Type change at same level: close this list and start a sibling of the other type
    // under the same parent (or new top-level).
    if (cur.type !== parsed.type) {
      if (listStack.length === 1) {
        flushList();
        listStack.push({ type: parsed.type, items: [] });
      } else {
        listStack.pop();
        const parent = listStack[listStack.length - 1];
        const lastItem = parent.items[parent.items.length - 1];
        const childList = ensureChildList(lastItem, parsed.type);
        listStack.push(childList);
      }
    }

    listStack[listStack.length - 1].items.push({ text: parsed.text, children: [] });
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      flushParagraph();
      flushList();
      const fenceOpen = line;
      const codeLines = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      // ```tts is a speak marker, not a code block — emit inner markdown only.
      if (/^```\s*tts\b/i.test(fenceOpen)) {
        const inner = codeLines.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
        if (inner.trim()) htmlParts.push(renderMarkdown(inner));
        continue;
      }
      htmlParts.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
      continue;
    }

    const displayMath = tryConsumeDisplayMath(lines, i);
    if (displayMath) {
      flushParagraph();
      flushList();
      htmlParts.push(mathBlockHtml(displayMath.src, true));
      i = displayMath.end;
      continue;
    }

    if (isThematicBreak(line)) {
      flushParagraph();
      flushList();
      htmlParts.push('<hr>');
      i++;
      continue;
    }

    if (i + 1 < lines.length && isTableRow(line) && isTableSeparator(lines[i + 1])) {
      flushParagraph();
      flushList();
      const headers = parseTableCells(line);
      i += 2;
      const bodyRows = [];
      while (i < lines.length && isTableRow(lines[i]) && !isTableSeparator(lines[i]) && lines[i].trim() !== '') {
        bodyRows.push(parseTableCells(lines[i]));
        i++;
      }
      const thead = `<thead><tr>${headers.map((h) => `<th>${renderInline(h)}</th>`).join('')}</tr></thead>`;
      const tbody = bodyRows.length
        ? `<tbody>${bodyRows.map((row) => `<tr>${row.map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`).join('')}</tbody>`
        : '';
      htmlParts.push(`<table>${thead}${tbody}</table>`);
      continue;
    }

    const headerMatch = /^(#{1,6})\s+(.*)/.exec(line);
    if (headerMatch) {
      flushParagraph();
      flushList();
      const level = headerMatch[1].length;
      htmlParts.push(`<h${level}>${renderInline(headerMatch[2])}</h${level}>`);
      i++;
      continue;
    }

    const listItem = parseListItem(line);
    if (listItem) {
      flushParagraph();
      pushListItem(listItem);
      i++;
      continue;
    }

    // Blockquote: lines starting with `>` (optional space). Blank `>` lines
    // separate paragraphs inside one <blockquote>. Nested `>>` via recursion.
    if (/^>/.test(line)) {
      flushParagraph();
      flushList();
      const bqInner = [];
      while (i < lines.length && /^>/.test(lines[i])) {
        const m = /^>\s?(.*)$/.exec(lines[i]);
        bqInner.push(m ? m[1] : lines[i].replace(/^>/, ''));
        i++;
      }
      const innerHtml = renderMarkdown(bqInner.join('\n'));
      htmlParts.push(`<blockquote>${innerHtml}</blockquote>`);
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      flushList();
      i++;
      continue;
    }

    flushList();
    paragraphBuffer.push(line);
    i++;
  }
  flushParagraph();
  flushList();
  return htmlParts.join('');
}
