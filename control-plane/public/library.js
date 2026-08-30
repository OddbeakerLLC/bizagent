/* BizAgent Library — named-tab repo accordion browser */
'use strict';

let libraryRepos = [];
let libraryTrees = Object.create(null); // repoId -> tree payload
let libraryExpandedId = ''; // expanded project repo id (or hub)
let libraryExpandedProduct = ''; // expanded product slug ('' when only hub open)
let librarySelected = null; // { repoId, path, id }
let libraryFilterTimer = null;

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  if (res.status === 401) {
    showAuthGate(true);
    throw new Error('Login required');
  }
  if (!res.ok) {
    const bodyText = await res.text();
    let message = bodyText || 'Request failed';
    try {
      const body = JSON.parse(bodyText);
      message = body.error || message;
    } catch (_err) {
      /* keep text */
    }
    throw new Error(message);
  }
  return res.json();
}

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
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const htmlParts = [];
  let paragraphBuffer = [];
  // Nested lists: stack of { type: 'ul'|'ol', items: [{ text, children }] }
  // children is null or a nested list node { type, items }.
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
      const nested = item.children ? renderListNode(item.children) : '';
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
        if (!parent.items.length) {
          // No parent item to hang a nested list on — treat as same-level
          break;
        }
        const lastItem = parent.items[parent.items.length - 1];
        if (!lastItem.children || lastItem.children.type !== parsed.type) {
          lastItem.children = { type: parsed.type, items: [] };
        }
        listStack.push(lastItem.children);
      }
      // If we still couldn't nest (no parent item), fall back to top-level sibling
      if (listStack.length === 0) {
        listStack.push({ type: parsed.type, items: [] });
      }
    }

    const cur = listStack[listStack.length - 1];
    // Type change at same level: close this list and start a sibling of the other type
    // under the same parent (or new top-level).
    if (cur.type !== parsed.type) {
      if (listStack.length === 1) {
        // Top-level type switch: flush previous list, start new
        flushList();
        listStack.push({ type: parsed.type, items: [] });
      } else {
        // Nested type switch: replace children on parent last item
        listStack.pop();
        const parent = listStack[listStack.length - 1];
        const lastItem = parent.items[parent.items.length - 1];
        lastItem.children = { type: parsed.type, items: [] };
        listStack.push(lastItem.children);
      }
    }

    listStack[listStack.length - 1].items.push({ text: parsed.text, children: null });
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      flushParagraph();
      flushList();
      const codeLines = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
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
  return htmlParts.join('\n') || '<p class="company-file-empty">(empty)</p>';
}


function showAuthGate(on) {
  const gate = document.getElementById('libraryAuthGate');
  const main = document.getElementById('libraryMain');
  const label = document.getElementById('libraryAuthLabel');
  if (gate) gate.hidden = !on;
  if (main) main.hidden = !!on;
  if (label) {
    label.textContent = on ? 'Login required' : 'Signed in';
    label.dataset.kind = on ? 'warn' : 'ok';
  }
}

function setLibraryStatus(message, kind = 'neutral') {
  const status = document.getElementById('libraryStatus');
  if (!status) return;
  if (!message) {
    status.hidden = true;
    status.textContent = '';
    return;
  }
  status.hidden = false;
  status.textContent = message;
  status.dataset.kind = kind;
}

function setLibraryDownloadEnabled(on) {
  const btn = document.getElementById('libraryDownloadBtn');
  if (btn) btn.disabled = !on;
}

function setLibrarySourceVisible(on) {
  const btn = document.getElementById('librarySourceBtn');
  if (btn) {
    btn.hidden = !on;
    btn.disabled = !on;
  }
}

function libraryFilterQuery() {
  const el = document.getElementById('libraryFilter');
  return ((el && el.value) || '').trim().toLowerCase();
}

function libraryEntryKind(doc) {
  if (!doc) return 'document';
  const k = String(doc.kind || doc.type || '').toLowerCase();
  if (k === 'diagram' || k === 'image') return 'diagram';
  if (k === 'plantuml') return 'plantuml';
  const p = String(doc.path || doc.name || '').toLowerCase();
  if (p.endsWith('.svg') || p.endsWith('.png')) return 'diagram';
  if (p.endsWith('.puml') || p.endsWith('.plantuml')) return 'plantuml';
  return 'document';
}

function librarySourceBlock(doc) {
  const sourceText = doc.source_content
    || ((String(doc.ext || doc.path || '').toLowerCase().match(/\.puml$|\.plantuml$/))
      ? doc.content
      : '');
  if (!sourceText) return '';
  return `<details class="library-diagram-source"><summary>View PlantUML source</summary>`
    + `<pre class="library-source-pre">${escapeHtml(sourceText)}</pre></details>`;
}

function fileApiUrl(repoId, filePath, extra = {}) {
  const qs = new URLSearchParams();
  qs.set('repo', repoId);
  qs.set('path', filePath);
  for (const [k, v] of Object.entries(extra)) {
    if (v != null && v !== '') qs.set(k, String(v));
  }
  return `/api/library/file?${qs.toString()}`;
}

function nodeMatchesFilter(node, q) {
  if (!q) return true;
  if (node.type === 'file') {
    return String(node.name || '').toLowerCase().includes(q)
      || String(node.path || '').toLowerCase().includes(q);
  }
  const kids = Array.isArray(node.children) ? node.children : [];
  return kids.some((c) => nodeMatchesFilter(c, q));
}

function filterTree(nodes, q) {
  if (!q) return nodes || [];
  const out = [];
  for (const n of nodes || []) {
    if (n.type === 'file') {
      if (nodeMatchesFilter(n, q)) out.push(n);
      continue;
    }
    if (!nodeMatchesFilter(n, q)) continue;
    const kids = filterTree(n.children || [], q);
    if (kids.length) out.push({ ...n, children: kids });
  }
  return out;
}

function renderTreeNodes(nodes, repoId, depth) {
  const ul = document.createElement('ul');
  ul.className = depth === 0 ? 'library-tree library-tree-root' : 'library-tree';
  for (const node of nodes || []) {
    const li = document.createElement('li');
    if (node.type === 'dir') {
      li.className = 'library-tree-dir';
      const label = document.createElement('div');
      label.className = 'library-tree-dir-label';
      label.textContent = node.name;
      li.appendChild(label);
      li.appendChild(renderTreeNodes(node.children || [], repoId, depth + 1));
    } else {
      li.className = 'library-tree-file';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'library-tree-file-btn';
      btn.dataset.repo = repoId;
      btn.dataset.path = node.path;
      const kind = libraryEntryKind(node);
      const badge = (kind === 'plantuml' || kind === 'diagram') ? ' · diagram' : '';
      btn.innerHTML = `<span class="library-tree-file-name">${escapeHtml(node.name)}</span>`
        + `<span class="library-tree-file-meta">${escapeHtml(badge.trim())}</span>`;
      if (
        librarySelected
        && librarySelected.repoId === repoId
        && librarySelected.path === node.path
      ) {
        btn.classList.add('is-selected');
      }
      btn.addEventListener('click', () => openLibraryFile(repoId, node.path));
      li.appendChild(btn);
    }
    ul.appendChild(li);
  }
  return ul;
}

function isHubRepo(repo) {
  return !!(repo && (repo.kind === 'hub' || repo.kind === 'hub-library'
    || repo.id === 'hub' || repo.id === 'hub-library'));
}

function productKey(repo) {
  if (isHubRepo(repo)) return 'hub';
  return String(repo.product || repo.product_name || 'product');
}

function productLabel(repo) {
  if (isHubRepo(repo)) return 'Hub';
  return String(repo.product_name || repo.product || 'Product');
}

/** Group flat API repos into Hub + products (each with projects). Order preserved from API. */
function groupLibraryRepos(repos) {
  const hub = [];
  const products = [];
  const byKey = Object.create(null);
  for (const repo of repos || []) {
    if (isHubRepo(repo)) {
      hub.push(repo);
      continue;
    }
    const key = productKey(repo);
    if (!byKey[key]) {
      const group = {
        key,
        name: productLabel(repo),
        projects: [],
      };
      byKey[key] = group;
      products.push(group);
    }
    byKey[key].projects.push(repo);
  }
  return { hub, products };
}

/** True when repo has ≥1 file whose name/path matches q. Product/project labels do not match. */
function repoTreeMatchesFilter(repo, q) {
  if (!q) return true;
  const cached = libraryTrees[repo.id];
  if (!cached || cached.error) return false;
  return filterTree(cached.tree || [], q).length > 0;
}

/** Prefetch viewable-file trees so filter can hide empty products/projects. */
async function ensureLibraryTreesLoaded(repoIds) {
  const ids = repoIds || libraryRepos.map((r) => r.id);
  const missing = ids.filter((id) => id && !libraryTrees[id]);
  if (!missing.length) return;
  await Promise.all(missing.map(async (repoId) => {
    try {
      const data = await api(`/api/library/tree?repo=${encodeURIComponent(repoId)}`);
      libraryTrees[repoId] = data;
    } catch (err) {
      libraryTrees[repoId] = { error: err.message || 'Failed to load tree', tree: [] };
    }
  }));
}

/** Debounced filter path: load trees when querying, then re-render (hides non-matches). */
async function applyLibraryFilter() {
  const q = libraryFilterQuery();
  if (q) await ensureLibraryTreesLoaded();
  renderAccordion();
}

function fillRepoBody(body, repo, q) {
  const cached = libraryTrees[repo.id];
  if (!cached) {
    body.innerHTML = '<p class="company-file-empty">Loading…</p>';
    return;
  }
  if (cached.error) {
    body.innerHTML = `<p class="company-file-empty">${escapeHtml(cached.error)}</p>`;
    return;
  }
  const tree = filterTree(cached.tree || [], q);
  if (!tree.length) {
    body.innerHTML = q
      ? '<p class="company-file-empty">No viewable files match this filter.</p>'
      : '<p class="company-file-empty">No viewable files in this repo.</p>';
    return;
  }
  body.appendChild(renderTreeNodes(tree, repo.id, 0));
  if (cached.truncated) {
    const note = document.createElement('p');
    note.className = 'library-tree-truncated';
    note.textContent = 'Tree truncated (too many nodes).';
    body.appendChild(note);
  }
}

function renderProjectItem(repo, q) {
  const item = document.createElement('div');
  item.className = 'library-acc-item library-acc-project';
  item.dataset.repoId = repo.id;
  // While filtering, open every project that still has matching files so hits are reachable.
  const projectOpen = q
    ? repoTreeMatchesFilter(repo, q)
    : libraryExpandedId === repo.id;
  if (projectOpen) item.classList.add('is-expanded');

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'library-acc-head library-acc-project-head';
  head.setAttribute('aria-expanded', projectOpen ? 'true' : 'false');
  const avail = repo.available === false ? ' · offline' : '';
  head.innerHTML = `<span class="library-acc-chevron" aria-hidden="true"></span>`
    + `<span class="library-acc-title">${escapeHtml(repo.label || repo.name)}</span>`
    + `<span class="library-acc-meta">${escapeHtml(avail.trim())}</span>`;
  head.addEventListener('click', () => toggleRepo(repo.id));
  item.appendChild(head);

  const body = document.createElement('div');
  body.className = 'library-acc-body';
  if (projectOpen) fillRepoBody(body, repo, q);
  item.appendChild(body);
  return item;
}

function renderAccordion() {
  const root = document.getElementById('libraryAccordion');
  if (!root) return;
  root.innerHTML = '';
  if (!libraryRepos.length) {
    root.innerHTML = '<p class="company-file-empty">No project repos found in registry.</p>';
    return;
  }
  const q = libraryFilterQuery();
  const { hub, products } = groupLibraryRepos(libraryRepos);

  for (const repo of hub) {
    if (q && !repoTreeMatchesFilter(repo, q)) continue;
    const item = document.createElement('div');
    item.className = 'library-acc-item library-acc-hub';
    item.dataset.repoId = repo.id;
    const hubOpen = q
      ? repoTreeMatchesFilter(repo, q)
      : libraryExpandedId === repo.id;
    if (hubOpen) item.classList.add('is-expanded');

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'library-acc-head';
    head.setAttribute('aria-expanded', hubOpen ? 'true' : 'false');
    head.innerHTML = `<span class="library-acc-chevron" aria-hidden="true"></span>`
      + `<span class="library-acc-title">${escapeHtml(repo.label || repo.name || 'Hub')}</span>`
      + `<span class="library-acc-meta">Hub</span>`;
    head.addEventListener('click', () => toggleRepo(repo.id));
    item.appendChild(head);

    const body = document.createElement('div');
    body.className = 'library-acc-body';
    if (hubOpen) fillRepoBody(body, repo, q);
    item.appendChild(body);
    root.appendChild(item);
  }

  for (const product of products) {
    const visibleProjects = product.projects.filter((p) => repoTreeMatchesFilter(p, q));
    if (q && !visibleProjects.length) continue;

    const item = document.createElement('div');
    item.className = 'library-acc-item library-acc-product';
    item.dataset.product = product.key;
    const productOpen = libraryExpandedProduct === product.key
      || (!!q && visibleProjects.length > 0);
    if (productOpen) item.classList.add('is-expanded');

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'library-acc-head library-acc-product-head';
    head.setAttribute('aria-expanded', productOpen ? 'true' : 'false');
    const count = visibleProjects.length;
    const meta = count === 1 ? '1 project' : `${count} projects`;
    head.innerHTML = `<span class="library-acc-chevron" aria-hidden="true"></span>`
      + `<span class="library-acc-title">${escapeHtml(product.name)}</span>`
      + `<span class="library-acc-meta">${escapeHtml(meta)}</span>`;
    head.addEventListener('click', () => toggleProduct(product.key));
    item.appendChild(head);

    const body = document.createElement('div');
    body.className = 'library-acc-body library-acc-product-body';
    if (productOpen) {
      const nest = document.createElement('div');
      nest.className = 'library-acc-nested';
      for (const proj of visibleProjects) {
        nest.appendChild(renderProjectItem(proj, q));
      }
      body.appendChild(nest);
    }
    item.appendChild(body);
    root.appendChild(item);
  }
}

function toggleProduct(key) {
  if (libraryExpandedProduct === key) {
    libraryExpandedProduct = '';
    // Collapse nested project if it belonged to this product.
    const open = libraryRepos.find((r) => r.id === libraryExpandedId);
    if (open && !isHubRepo(open) && productKey(open) === key) {
      libraryExpandedId = '';
    }
    renderAccordion();
    return;
  }
  libraryExpandedProduct = key;
  // Closing other products is implicit (single expanded product).
  // Keep hub file pane independent; clear project expand if switching products.
  const open = libraryRepos.find((r) => r.id === libraryExpandedId);
  if (open && !isHubRepo(open) && productKey(open) !== key) {
    libraryExpandedId = '';
  }
  renderAccordion();
}

async function toggleRepo(repoId) {
  if (libraryExpandedId === repoId) {
    libraryExpandedId = '';
    renderAccordion();
    return;
  }
  libraryExpandedId = repoId;
  const repo = libraryRepos.find((r) => r.id === repoId);
  if (repo && !isHubRepo(repo)) {
    libraryExpandedProduct = productKey(repo);
  }
  renderAccordion();
  if (!libraryTrees[repoId]) {
    try {
      const data = await api(`/api/library/tree?repo=${encodeURIComponent(repoId)}`);
      libraryTrees[repoId] = data;
    } catch (err) {
      libraryTrees[repoId] = { error: err.message || 'Failed to load tree', tree: [] };
    }
    if (libraryExpandedId === repoId) renderAccordion();
  }
}

async function openLibraryFile(repoId, filePath) {
  const titleEl = document.getElementById('libraryPreviewTitle');
  const bodyEl = document.getElementById('libraryPreviewBody');
  if (!bodyEl) return;
  librarySelected = { repoId, path: filePath, id: `${repoId}:${filePath}` };
  bodyEl.innerHTML = '<p class="company-file-empty">Loading…</p>';
  setLibraryDownloadEnabled(false);
  setLibrarySourceVisible(false);
  document.querySelectorAll('.library-tree-file-btn').forEach((el) => {
    el.classList.toggle(
      'is-selected',
      el.dataset.repo === repoId && el.dataset.path === filePath,
    );
  });

  try {
    const kindHint = libraryEntryKind({ path: filePath });
    const qs = kindHint === 'plantuml'
      ? fileApiUrl(repoId, filePath, { render: '1', format: 'svg' })
      : fileApiUrl(repoId, filePath);
    const doc = await api(qs);
    if (titleEl) {
      const repo = libraryRepos.find((r) => r.id === repoId);
      let prefix = '';
      if (repo) {
        if (isHubRepo(repo)) {
          prefix = `${repo.label || repo.name || 'Hub'} / `;
        } else {
          const prod = productLabel(repo);
          const proj = repo.label || repo.name || '';
          prefix = prod && proj ? `${prod} / ${proj} / ` : `${proj} / `;
        }
      }
      titleEl.textContent = `${prefix}${doc.title || doc.path || filePath}`;
    }
    const kind = libraryEntryKind(doc);
    const metaPath = doc.source_path
      ? `${doc.path} (source ${doc.source_path})`
      : (doc.path || filePath);
    const sourceHtml = librarySourceBlock(doc);
    if (kind === 'plantuml' && doc.svg) {
      bodyEl.innerHTML = `<div class="library-diagram">${doc.svg}</div>`
        + `<p class="library-diagram-meta"><code>${escapeHtml(metaPath)}</code> · rendered SVG</p>`
        + sourceHtml;
    } else if (kind === 'diagram' || kind === 'plantuml') {
      const ext = String(doc.ext || doc.path || '').toLowerCase();
      if (ext.endsWith('.svg') && doc.content && /<svg/i.test(doc.content)) {
        bodyEl.innerHTML = `<div class="library-diagram">${doc.content}</div>`
          + `<p class="library-diagram-meta"><code>${escapeHtml(metaPath)}</code></p>`
          + sourceHtml;
      } else {
        const rawUrl = fileApiUrl(repoId, filePath, { raw: '1' });
        bodyEl.innerHTML = `<div class="library-diagram"><img class="library-diagram-img" src="${rawUrl}" alt="${escapeHtml(doc.title || doc.path || 'diagram')}"></div>`
          + `<p class="library-diagram-meta"><code>${escapeHtml(metaPath)}</code></p>`
          + sourceHtml;
      }
    } else {
      bodyEl.innerHTML = renderMarkdown(doc.content || '');
    }
    setLibraryDownloadEnabled(true);
    const hasSource = !!(doc.source_path || kind === 'plantuml' || doc.source_content);
    setLibrarySourceVisible(hasSource);
  } catch (err) {
    bodyEl.innerHTML = `<p class="company-file-empty">${escapeHtml(err.message || 'Failed to load')}</p>`;
  }
}

function downloadLibraryDoc() {
  if (!librarySelected) return;
  const a = document.createElement('a');
  a.href = fileApiUrl(librarySelected.repoId, librarySelected.path, { download: '1' });
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function downloadLibrarySource() {
  if (!librarySelected) return;
  const a = document.createElement('a');
  a.href = fileApiUrl(librarySelected.repoId, librarySelected.path, {
    source: '1',
    download: '1',
  });
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function refreshLibraryRepos() {
  setLibraryStatus('');
  const root = document.getElementById('libraryAccordion');
  if (root) root.innerHTML = '<p class="company-file-empty">Loading…</p>';
  try {
    const data = await api('/api/library/repos');
    libraryRepos = Array.isArray(data.repos) ? data.repos : [];
    // Drop cached trees so Refresh re-reads disk.
    libraryTrees = Object.create(null);
    const keep = libraryExpandedId;
    const keepProduct = libraryExpandedProduct;
    libraryExpandedId = '';
    libraryExpandedProduct = '';
    renderAccordion();
    if (keepProduct) libraryExpandedProduct = keepProduct;
    if (keep) await toggleRepo(keep);
    else if (keepProduct) renderAccordion();
  } catch (err) {
    if (root) root.innerHTML = '';
    libraryRepos = [];
    setLibraryStatus(err.message || 'Failed to list repos', 'warn');
  }
}

async function initLibraryPage() {
  document.title = 'BizAgent Library';
  try {
    await api('/api/state');
    showAuthGate(false);
  } catch (_err) {
    showAuthGate(true);
    return;
  }

  const refreshBtn = document.getElementById('libraryRefresh');
  if (refreshBtn) refreshBtn.addEventListener('click', () => refreshLibraryRepos());
  const dlBtn = document.getElementById('libraryDownloadBtn');
  if (dlBtn) dlBtn.addEventListener('click', () => downloadLibraryDoc());
  const srcBtn = document.getElementById('librarySourceBtn');
  if (srcBtn) srcBtn.addEventListener('click', () => downloadLibrarySource());
  const filter = document.getElementById('libraryFilter');
  if (filter) {
    filter.addEventListener('input', () => {
      clearTimeout(libraryFilterTimer);
      libraryFilterTimer = setTimeout(() => {
        applyLibraryFilter().catch(() => renderAccordion());
      }, 120);
    });
  }

  await refreshLibraryRepos();
  // Auto-expand Hub (filtered docs/company/reports) for a useful first view.
  const hubId = libraryRepos.some((r) => r.id === 'hub')
    ? 'hub'
    : (libraryRepos.some((r) => r.id === 'hub-library') ? 'hub-library' : '');
  if (hubId) await toggleRepo(hubId);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initLibraryPage());
  } else {
    initLibraryPage();
  }
}
