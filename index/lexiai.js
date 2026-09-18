// ── Config ────────────────────────────────────────────────────────────────────
const LT_URL     = 'http://localhost:8081/v2/check';
const OLLAMA_URL = 'http://localhost:11434/api/generate';
const DEBOUNCE   = 800;

// ── State ─────────────────────────────────────────────────────────────────────
let docs = JSON.parse(localStorage.getItem('lexi_docs') || '[]');
let currentDocId = null;
let ltMatches = [];
let checkTimer = null;
let aiLastResult = '';
let savedEditorSelection = null;

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, dur = 2200) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), dur);
}

// ── Doc management ────────────────────────────────────────────────────────────
function saveDocs() {
  localStorage.setItem('lexi_docs', JSON.stringify(docs));
}

function newDoc(name = 'Untitled Document') {
  const doc = { id: Date.now().toString(), name, content: '', created: Date.now() };
  docs.unshift(doc);
  saveDocs();
  loadDoc(doc.id);
  renderDocList();
}

function loadDoc(id) {
  // Save current before switching
  if (currentDocId) saveCurrentDoc();

  currentDocId = id;
  const doc = docs.find(d => d.id === id);
  if (!doc) return;

  document.getElementById('doc-title').value = doc.name;
  document.getElementById('editor').innerText = doc.content;
  renderDocList();
  updateStats();
  // Run grammar check on load
  clearTimeout(checkTimer);
  checkTimer = setTimeout(runGrammarCheck, 600);
}

function saveCurrentDoc() {
  if (!currentDocId) return;
  const doc = docs.find(d => d.id === currentDocId);
  if (!doc) return;
  doc.name = document.getElementById('doc-title').value.trim() || 'Untitled';
  doc.content = document.getElementById('editor').innerText;
  doc.updated = Date.now();
  saveDocs();
}

function deleteDoc(id) {
  docs = docs.filter(d => d.id !== id);
  saveDocs();
  if (currentDocId === id) {
    currentDocId = null;
    document.getElementById('editor').innerText = '';
    document.getElementById('doc-title').value = 'Untitled Document';
    ltMatches = [];
    renderIssues();
  }
  renderDocList();
  toast('Document deleted.');
}

function renderDocList() {
  const list = document.getElementById('doc-list');
  if (!docs.length) {
    list.innerHTML = '<div class="doc-empty">No documents yet.</div>';
    return;
  }
  list.innerHTML = '';
  docs.forEach(doc => {
    const el = document.createElement('div');
    el.className = 'doc-item' + (doc.id === currentDocId ? ' active-doc' : '');

    const name = document.createElement('span');
    name.className = 'doc-item-name';
    name.textContent = doc.name;
    name.title = doc.name;
    name.addEventListener('click', () => loadDoc(doc.id));

    const del = document.createElement('button');
    del.className = 'doc-item-del';
    del.textContent = '×';
    del.title = 'Delete';
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteDoc(doc.id); });

    el.appendChild(name);
    el.appendChild(del);
    list.appendChild(el);
  });
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function updateStats() {
  const text = document.getElementById('editor').innerText || '';
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const chars = text.length;
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0).length;
  const readTime = Math.max(1, Math.round(words / 200));

  document.getElementById('stat-words').textContent = words;
  document.getElementById('stat-chars').textContent = chars;
  document.getElementById('stat-sentences').textContent = sentences;
  document.getElementById('stat-readtime').textContent = readTime + ' min';
  document.getElementById('stat-issues').textContent = ltMatches.length;

  updateReadability(text, words, sentences);
}

// ── Readability ───────────────────────────────────────────────────────────────
function syllableCount(word) {
  word = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!word) return 1;
  const m = word.match(/[aeiouy]+/g);
  let count = m ? m.length : 1;
  if (word.endsWith('e') && count > 1) count--;
  return Math.max(1, count);
}

function updateReadability(text, words, sentences) {
  if (words < 10) {
    document.getElementById('read-ring').textContent = '—';
    document.getElementById('read-label').textContent = 'Need more text';
    ['rs-sent-len','rs-word-len','rs-long-sents','rs-passive','rs-grade'].forEach(id => {
      document.getElementById(id).textContent = '—';
    });
    return;
  }

  const wordList = text.trim().split(/\s+/);
  const totalSyllables = wordList.reduce((sum, w) => sum + syllableCount(w), 0);

  // Flesch Reading Ease
  const asl = words / Math.max(1, sentences); // avg sentence length
  const asw = totalSyllables / Math.max(1, words); // avg syllables per word
  const fre = Math.round(206.835 - 1.015 * asl - 84.6 * asw);
  const fre_clamped = Math.max(0, Math.min(100, fre));

  // Grade level (Flesch-Kincaid)
  const grade = Math.max(0, (0.39 * asl + 11.8 * asw - 15.59)).toFixed(1);

  // Long sentences (>30 words)
  const sents = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
  const longSents = sents.filter(s => s.trim().split(/\s+/).length > 30).length;

  // Passive voice rough estimate (was/were/is/are + -ed pattern)
  const passiveMatches = (text.match(/\b(was|were|is|are|been|being)\s+\w+ed\b/gi) || []).length;

  // Ring class
  let ringClass = 'poor', readLabel = 'Very Difficult';
  if (fre_clamped >= 70) { ringClass = 'excellent'; readLabel = 'Easy to Read'; }
  else if (fre_clamped >= 50) { ringClass = 'good'; readLabel = 'Fairly Easy'; }
  else if (fre_clamped >= 30) { ringClass = 'fair'; readLabel = 'Difficult'; }

  const ring = document.getElementById('read-ring');
  ring.textContent = fre_clamped;
  ring.className = 'score-ring ' + ringClass;
  document.getElementById('read-label').textContent = readLabel;

  document.getElementById('rs-sent-len').textContent = asl.toFixed(1) + ' words';
  document.getElementById('rs-word-len').textContent = (wordList.reduce((s,w) => s + w.replace(/[^a-zA-Z]/g,'').length, 0) / words).toFixed(1) + ' chars';
  document.getElementById('rs-long-sents').textContent = longSents;
  document.getElementById('rs-passive').textContent = passiveMatches + ' instance' + (passiveMatches !== 1 ? 's' : '');
  document.getElementById('rs-grade').textContent = 'Grade ' + grade;
}

// ── Grammar check ─────────────────────────────────────────────────────────────
async function runGrammarCheck() {
  const text = document.getElementById('editor').innerText || '';
  if (text.trim().length < 3) {
    ltMatches = [];
    renderIssues();
    updateStats();
    return;
  }

  const lang = localStorage.getItem('lexi_lang') || 'en-CA';
  const ignoreList = JSON.parse(localStorage.getItem('lexi_ignore') || '[]');

  const payload = new URLSearchParams({
    text,
    language: lang,
    enabledCategories: [
      'GRAMMAR','PUNCTUATION','TYPOGRAPHY','STYLE','SEMANTICS',
      'CASING','REDUNDANCY','COLLOCATIONS','CONFUSED_WORDS','COMPOUNDING','MISC'
    ].join(','),
    enabledRules: [
      'PASSIVE_VOICE','EN_WORDINESS_REPLACE','EN_WORDINESS','WEASEL_WORDS',
      'REDUNDANT_PHRASES','DOUBLE_PUNCTUATION','COMMA_PARENTHESIS_WHITESPACE',
      'SENT_START_CONJUNCTION','UPPERCASE_SENTENCE_START',
      'ENGLISH_WORD_REPEAT_RULE','EN_UNPAIRED_BRACKETS',
      'TOO_LONG_SENTENCE','EN_COMPOUNDS','OXFORD_SPELLING'
    ].join(','),
    enabledOnly: 'false'
  });

  if (ignoreList.length) payload.set('dontCheckWords', ignoreList.join('\n'));

  try {
    const res = await fetch(LT_URL, { method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'}, body: payload });
    const data = await res.json();
    ltMatches = data.matches || [];
  } catch {
    ltMatches = [];
  }

  renderIssues();
  updateStats();
}

// ── Issue category helpers ────────────────────────────────────────────────────
function getIssueType(match) {
  const issueType = match.rule?.issueType || '';
  const catId = match.rule?.category?.id || '';
  if (issueType === 'misspelling') return 'spelling';
  if (catId === 'PUNCTUATION' || catId === 'TYPOGRAPHY') return 'punct';
  if (catId === 'STYLE' || catId === 'REDUNDANCY' || issueType === 'style') return 'style';
  return 'grammar';
}

// ── Render issues ─────────────────────────────────────────────────────────────
// ── Highlight a match in the editor and scroll to it ─────────────────────────
// Shared: walk editor text nodes and return a Range for a match offset/length
function getRangeForMatch(match) {
  const editorEl = document.getElementById('editor');
  let charCount = 0;
  let startNode = null, endNode = null, startOff = 0, endOff = 0;
  const target = match.offset;
  const targetEnd = match.offset + match.length;

  function walk(node) {
    if (startNode && endNode) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const len = node.nodeValue.length;
      if (!startNode && charCount + len > target) {
        startNode = node; startOff = target - charCount;
      }
      if (startNode && !endNode && charCount + len >= targetEnd) {
        endNode = node; endOff = targetEnd - charCount;
      }
      charCount += len;
    } else {
      for (const child of node.childNodes) walk(child);
    }
  }
  walk(editorEl);

  if (startNode && endNode) {
    try {
      const range = document.createRange();
      range.setStart(startNode, startOff);
      range.setEnd(endNode, endOff);
      return range;
    } catch { return null; }
  }
  return null;
}

// Click: select text in editor and scroll to it
function highlightMatchInEditor(match) {
  const range = getRangeForMatch(match);
  if (!range) return;
  try {
    document.getElementById('editor').focus();
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const rect = range.getBoundingClientRect();
    const scrollEl = document.querySelector('.editor-scroll');
    const scrollRect = scrollEl.getBoundingClientRect();
    if (rect.top < scrollRect.top || rect.bottom > scrollRect.bottom) {
      scrollEl.scrollBy({ top: rect.top - scrollRect.top - 80, behavior: 'smooth' });
    }
  } catch { }
}

// Hover: draw a floating highlight box over the matched text without touching selection
let hoverHighlightEl = null;

function showHoverHighlight(match) {
  removeHoverHighlight();
  const range = getRangeForMatch(match);
  if (!range) return;
  const rects = range.getClientRects();
  if (!rects.length) return;

  const container = document.createElement('div');
  container.id = 'hover-highlight-container';
  container.style.cssText = 'position:fixed;top:0;left:0;pointer-events:none;z-index:8000;';

  for (const rect of rects) {
    const mark = document.createElement('div');
    mark.style.cssText = [
      'position:fixed',
      'pointer-events:none',
      'border-radius:3px',
      'background:rgba(83,74,183,0.15)',
      'outline:2px solid rgba(83,74,183,0.45)',
      `top:${rect.top}px`,
      `left:${rect.left}px`,
      `width:${rect.width}px`,
      `height:${rect.height}px`,
      'transition:opacity 0.1s'
    ].join(';');
    container.appendChild(mark);
  }

  document.body.appendChild(container);
  hoverHighlightEl = container;
}

function removeHoverHighlight() {
  if (hoverHighlightEl) { hoverHighlightEl.remove(); hoverHighlightEl = null; }
}

function renderIssues() {
  const panel = document.getElementById('panel-issues');
  document.getElementById('stat-issues').textContent = ltMatches.length;

  if (!ltMatches.length) {
    panel.innerHTML = '<div class="no-issues"><div class="check-icon">✅</div>No issues found — looking great!</div>';
    return;
  }

  panel.innerHTML = '';
  ltMatches.forEach((match, idx) => {
    const type = getIssueType(match);

    const card = document.createElement('div');
    card.className = 'issue-card';
    card.title = 'Click to locate in editor';

    // Clicking the card selects and scrolls to the issue in the editor
    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('issue-fix-btn')) return;
      highlightMatchInEditor(match);
    });

    // Hovering the card shows a highlight box over the matched text in the editor
    card.addEventListener('mouseenter', () => showHoverHighlight(match));
    card.addEventListener('mouseleave', removeHoverHighlight);

    const typeEl = document.createElement('div');
    typeEl.className = 'issue-type ' + type;
    typeEl.textContent = {
      spelling: '🔴 Spelling',
      grammar:  '🔵 Grammar',
      style:    '🟡 Style',
      punct:    '🟣 Punctuation'
    }[type];
    card.appendChild(typeEl);

    const msg = document.createElement('div');
    msg.className = 'issue-msg';
    msg.textContent = match.message;

    // Show the flagged text itself, not just the surrounding context
    const flaggedText = (editor.innerText || '').slice(match.offset, match.offset + match.length);
    if (flaggedText) {
      const ctx = document.createElement('div');
      ctx.style.cssText = 'font-size:11px;color:var(--muted);margin-top:4px;';
      const chip = document.createElement('span');
      chip.style.cssText = 'background:var(--panel);border:1px solid var(--border);border-radius:4px;padding:1px 6px;font-family:monospace;color:var(--danger);';
      chip.textContent = flaggedText;
      ctx.appendChild(document.createTextNode('Flagged: '));
      ctx.appendChild(chip);
      msg.appendChild(ctx);
    }

    card.appendChild(msg);

    if (match.replacements?.length) {
      const fixes = document.createElement('div');
      fixes.className = 'issue-fixes';
      match.replacements.slice(0, 3).forEach(rep => {
        const btn = document.createElement('button');
        btn.className = 'issue-fix-btn';
        btn.textContent = rep.value;
        card.addEventListener('click', (e) => {
          e.stopPropagation();
          applyFix(match.offset, match.length, rep.value, idx);
        });
        fixes.appendChild(btn);
      });
      card.appendChild(fixes);
    }

    panel.appendChild(card);
  });
}

// ── Apply fix ─────────────────────────────────────────────────────────────────
function applyFix(offset, length, replacement, matchIdx) {
  const editor = document.getElementById('editor');
  const text = editor.innerText;
  const newText = text.slice(0, offset) + replacement + text.slice(offset + length);
  editor.innerText = newText;

  // Offset all subsequent matches
  const diff = replacement.length - length;
  ltMatches.splice(matchIdx, 1);
  for (let i = matchIdx; i < ltMatches.length; i++) {
    ltMatches[i].offset += diff;
  }

  renderIssues();
  updateStats();
  // Re-check after a short delay
  clearTimeout(checkTimer);
  checkTimer = setTimeout(runGrammarCheck, 1200);
  toast('Fix applied.');
}

// ── Editor events ─────────────────────────────────────────────────────────────
const editor = document.getElementById('editor');

editor.addEventListener('input', () => {
  updateStats();
  clearTimeout(checkTimer);
  checkTimer = setTimeout(runGrammarCheck, DEBOUNCE);
});

// Save selection for AI replace
editor.addEventListener('mouseup', saveEditorSelection);
editor.addEventListener('keyup', saveEditorSelection);

function saveEditorSelection() {
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0 && sel.toString().trim()) {
    savedEditorSelection = sel.getRangeAt(0).cloneRange();
    // Also pre-fill AI input with selected text
    const aiInput = document.getElementById('ai-input');
    if (document.getElementById('panel-ai').style.display !== 'none') {
      aiInput.value = sel.toString().trim();
    }
  }
}

// ── Panel tabs ────────────────────────────────────────────────────────────────
document.querySelectorAll('.panel-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.panel;
    document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    ['issues','readability','ai','plagiarism'].forEach(p => {
      document.getElementById('panel-' + p).style.display = p === target ? '' : 'none';
    });
  });
});

// ── Toggle panel ─────────────────────────────────────────────────────────────
document.getElementById('btn-toggle-panel').addEventListener('click', function() {
  const panel = document.getElementById('right-panel');
  panel.classList.toggle('collapsed');
  this.classList.toggle('active');
});

// ── Save / new doc buttons ────────────────────────────────────────────────────
document.getElementById('btn-save').addEventListener('click', () => {
  if (!currentDocId) {
    newDoc(document.getElementById('doc-title').value || 'Untitled Document');
  } else {
    saveCurrentDoc();
    renderDocList();
    toast('Saved.');
  }
});

document.getElementById('btn-new-doc').addEventListener('click', () => {
  saveCurrentDoc();
  newDoc();
});

document.getElementById('btn-check').addEventListener('click', () => {
  toast('Running grammar check…');
  runGrammarCheck();
});

// ── Title sync ────────────────────────────────────────────────────────────────
document.getElementById('doc-title').addEventListener('input', () => {
  if (currentDocId) saveCurrentDoc();
});

// ── Export ────────────────────────────────────────────────────────────────────
function downloadFile(content, filename, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

document.getElementById('btn-export-txt').addEventListener('click', () => {
  const name = (document.getElementById('doc-title').value || 'document') + '.txt';
  downloadFile(editor.innerText, name, 'text/plain');
  toast('Exported as .txt');
});

// ── Pure-browser .docx export (Open XML + ZIP) ──────────────────────────────
// Builds a valid .docx entirely in the browser — no server, no CDN needed.
// Uses a hand-rolled ZIP writer (DEFLATE via DecompressionStream) and raw OOXML.

async function exportDocx() {
  const titleVal = document.getElementById('doc-title').value.trim() || 'Document';
  const rawText  = editor.innerText || '';

  // ── Build word/document.xml ──
  function escXml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
            .replace(/"/g,'&quot;').replace(/'/g,'&apos;');
  }

  const lines = rawText.split('\n');
  let bodyXml = '';
  for (const line of lines) {
    const t = line.trim();
    let styleId = 'Normal';
    let text = t;
    if (t.startsWith('### ')) { styleId = 'Heading3'; text = t.slice(4); }
    else if (t.startsWith('## '))  { styleId = 'Heading2'; text = t.slice(3); }
    else if (t.startsWith('# '))   { styleId = 'Heading1'; text = t.slice(2); }

    bodyXml += `<w:p><w:pPr><w:pStyle w:val="${styleId}"/></w:pPr>` +
               `<w:r><w:t xml:space="preserve">${escXml(text)}</w:t></w:r></w:p>`;
  }

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>${bodyXml}<w:sectPr/></w:body></w:document>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:rPr><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:pPr><w:outlineLvl w:val="0"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:pPr><w:outlineLvl w:val="1"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading3">
    <w:name w:val="heading 3"/>
    <w:pPr><w:outlineLvl w:val="2"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr>
  </w:style>
</w:styles>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const appRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml"  ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml"   ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

  // ── Tiny ZIP builder (stored, no compression — Word accepts it fine) ──
  function strToBytes(str) {
    return new TextEncoder().encode(str);
  }

  function u16le(n) { return [n & 0xff, (n >> 8) & 0xff]; }
  function u32le(n) { return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]; }

  function crc32(data) {
    let c = 0xFFFFFFFF;
    const table = crc32.table || (crc32.table = (() => {
      const t = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let v = i;
        for (let j = 0; j < 8; j++) v = (v & 1) ? (0xEDB88320 ^ (v >>> 1)) : (v >>> 1);
        t[i] = v;
      }
      return t;
    })());
    for (let i = 0; i < data.length; i++) c = table[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function buildZip(files) {
    // files: [{name, data: Uint8Array}]
    const parts = [];
    const centralDir = [];
    let offset = 0;

    for (const f of files) {
      const nameBytes = new TextEncoder().encode(f.name);
      const crc = crc32(f.data);
      const size = f.data.length;

      // Local file header
      const lfh = new Uint8Array([
        0x50,0x4B,0x03,0x04,       // signature
        0x14,0x00,                  // version needed: 2.0
        0x00,0x00,                  // flags
        0x00,0x00,                  // compression: stored
        0x00,0x00,0x00,0x00,        // mod time/date
        ...u32le(crc),
        ...u32le(size),
        ...u32le(size),
        ...u16le(nameBytes.length),
        0x00,0x00                   // extra field length
      ]);

      parts.push(lfh, nameBytes, f.data);

      // Central directory entry
      centralDir.push({
        nameBytes, crc, size, offset
      });

      offset += lfh.length + nameBytes.length + size;
    }

    // Central directory
    const cdStart = offset;
    const cdParts = [];
    for (const e of centralDir) {
      const cd = new Uint8Array([
        0x50,0x4B,0x01,0x02,       // signature
        0x14,0x00,                  // version made by
        0x14,0x00,                  // version needed
        0x00,0x00,                  // flags
        0x00,0x00,                  // compression: stored
        0x00,0x00,0x00,0x00,        // mod time/date
        ...u32le(e.crc),
        ...u32le(e.size),
        ...u32le(e.size),
        ...u16le(e.nameBytes.length),
        0x00,0x00,                  // extra
        0x00,0x00,                  // comment
        0x00,0x00,                  // disk start
        0x00,0x00,                  // int attr
        0x00,0x00,0x00,0x00,        // ext attr
        ...u32le(e.offset)
      ]);
      cdParts.push(cd, e.nameBytes);
    }

    const cdSize = cdParts.reduce((s,p) => s + p.length, 0);

    // End of central directory
    const eocd = new Uint8Array([
      0x50,0x4B,0x05,0x06,
      0x00,0x00,0x00,0x00,
      ...u16le(centralDir.length),
      ...u16le(centralDir.length),
      ...u32le(cdSize),
      ...u32le(cdStart),
      0x00,0x00
    ]);

    // Concat everything
    const all = [...parts, ...cdParts, eocd];
    const total = all.reduce((s,p) => s + p.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const p of all) { out.set(p, pos); pos += p.length; }
    return out;
  }

  const enc = s => strToBytes(s);

  const zipBytes = buildZip([
    { name: '[Content_Types].xml',        data: enc(contentTypesXml) },
    { name: '_rels/.rels',                data: enc(appRelsXml) },
    { name: 'word/document.xml',          data: enc(documentXml) },
    { name: 'word/styles.xml',            data: enc(stylesXml) },
    { name: 'word/_rels/document.xml.rels', data: enc(relsXml) },
  ]);

  const blob = new Blob([zipBytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = titleVal + '.docx';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Exported as .docx');
}

document.getElementById('btn-export-docx').addEventListener('click', exportDocx);

document.getElementById('btn-copy-all').addEventListener('click', () => {
  navigator.clipboard.writeText(editor.innerText).then(() => toast('Copied to clipboard.'));
});

// ── AI panel ─────────────────────────────────────────────────────────────────
const aiPrompts = {
  fix:       'Fix all grammar, spelling, and punctuation errors. Keep the original wording and style. Output the corrected text only.',
  formal:    'Fix all errors and rewrite in a formal, professional tone. Output only the rewritten text.',
  casual:    'Fix all errors and rewrite in a friendly, conversational tone. Output only the rewritten text.',
  concise:   'Fix all errors and cut unnecessary words to make it as concise as possible without losing meaning. Output only the result.',
  expand:    'Expand this text with more detail, examples, or context while keeping the same meaning and tone. Output only the expanded text.',
  summarize: 'Summarize this text in 2–3 concise sentences. Output only the summary.',
  rephrase:  'Rephrase this text in a completely different way while keeping the same meaning. Output only the rephrased version.'
};

async function runAI(action) {
  const input = document.getElementById('ai-input').value.trim();
  if (!input) { toast('Paste or select some text first.'); return; }
  const resultBox = document.getElementById('ai-result');
  resultBox.textContent = 'Thinking…';

  const prompt = `You are a text editing API. ${aiPrompts[action]}\n\nText:\n${input}\n\nResult:`;

  try {
    const res = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama3', prompt, stream: false })
    });
    const data = await res.json();
    let reply = data.response?.trim() || 'No response.';
    reply = reply.replace(/^(here is|here's|sure,|certainly,)[^:]*:\s*/gi, '').replace(/^"|"$/g,'').trim();
    aiLastResult = reply;
    resultBox.textContent = reply;
  } catch {
    resultBox.textContent = 'Could not reach Ollama. Make sure it is running locally.';
  }
}

document.querySelectorAll('.ai-quick-btn').forEach(btn => {
  btn.addEventListener('click', () => runAI(btn.dataset.action));
});

document.getElementById('ai-copy-btn').addEventListener('click', () => {
  if (aiLastResult) navigator.clipboard.writeText(aiLastResult).then(() => toast('Copied.'));
});

document.getElementById('ai-replace-btn').addEventListener('click', () => {
  if (!aiLastResult) return;
  if (savedEditorSelection) {
    try {
      editor.focus();
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(savedEditorSelection);
      if (!document.execCommand('insertText', false, aiLastResult)) {
        savedEditorSelection.deleteContents();
        savedEditorSelection.insertNode(document.createTextNode(aiLastResult));
      }
      sel.removeAllRanges();
      savedEditorSelection = null;
      toast('Selection replaced.');
      clearTimeout(checkTimer);
      checkTimer = setTimeout(runGrammarCheck, 800);
    } catch { toast('Could not replace — try copying instead.'); }
  } else {
    toast('No selection saved — select text in the editor first.');
  }
});

// ── Plagiarism ────────────────────────────────────────────────────────────────
document.getElementById('plag-run-btn').addEventListener('click', async () => {
  const text = editor.innerText.trim();
  if (text.length < 30) { toast('Write more text first.'); return; }

  const btn = document.getElementById('plag-run-btn');
  const results = document.getElementById('plag-results');
  btn.disabled = true;
  btn.textContent = 'Analyzing…';
  results.innerHTML = '';

  const prompt = `You are a plagiarism and originality checker. Analyze the text below.

Respond using EXACTLY this format. No extra words, no preamble, no brackets:

RISK: Low
REASON: One or two plain sentences explaining the assessment.
SUGGESTION: The rewritten text only, or the single word None if risk is Low.

Rules:
- RISK must be exactly one word: Low, Medium, or High
- SUGGESTION must be ONLY the rewritten text — no intro phrase like "Here is" or "Here's a rewrite". Just the text itself. If Low risk, write None.

Text to analyze:
${text.slice(0, 2000)}`;

  try {
    const res = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama3', prompt, stream: false })
    });
    const data = await res.json();
    const raw = data.response?.trim() || '';

    const risk = raw.match(/RISK:\s*(Low|Medium|High)/i)?.[1] || 'Unknown';
    const reason = raw.match(/REASON:\s*(.+?)(?=\nSUGGESTION:|$)/si)?.[1]?.trim() || '';
    let suggestion = raw.match(/SUGGESTION:\s*([\s\S]+)/i)?.[1]?.trim() || '';
    // Strip any llama preamble the model adds despite instructions
    suggestion = suggestion.replace(/^(here'?s?(?: is)?(?:\s+a)?(?:\s+rewritten)?(?:\s+version)?[^:]*:?\s*)/i, '').trim();
    suggestion = suggestion.replace(/^(the rewritten text(?: is)?:?\s*)/i, '').trim();
    // Treat "None" / "None needed" as no suggestion
    if (/^none\.?$/i.test(suggestion) || /^none needed\.?$/i.test(suggestion)) suggestion = '';

    const colors = { Low: '#22c55e', Medium: '#f59e0b', High: '#ef4444', Unknown: '#94a3b8' };

    const badge = document.createElement('div');
    badge.className = 'plag-risk-badge';
    badge.style.background = colors[risk] || '#94a3b8';
    badge.textContent = risk + ' Risk';
    results.appendChild(badge);

    if (reason) {
      const r = document.createElement('div');
      r.className = 'plag-reason';
      r.textContent = reason;
      results.appendChild(r);
    }

    if (suggestion && suggestion.toLowerCase() !== 'none needed') {
      const l = document.createElement('div');
      l.className = 'plag-sugg-label';
      l.textContent = 'Suggested rewrite:';
      results.appendChild(l);

      const s = document.createElement('div');
      s.className = 'plag-sugg-text';
      s.textContent = suggestion;
      results.appendChild(s);
    }
  } catch {
    results.textContent = 'Could not reach Ollama. Make sure it is running.';
  }

  btn.disabled = false;
  btn.textContent = '🔍 Analyze Document';
});

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    document.getElementById('btn-save').click();
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
renderDocList();
if (docs.length) {
  loadDoc(docs[0].id);
} else {
  updateStats();
}
