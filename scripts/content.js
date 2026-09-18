// Change this line at the top of content.js
const LT_URL = 'http://localhost:8081/v2/check';
const OLLAMA_URL = 'http://localhost:11434/api/generate';
const DEBOUNCE_MS = 600;
const timers = new WeakMap();
const overlays = new WeakMap();

let activePopup = null;
let savedRange = null;
let savedTargetField = null;
let savedSelectionBounds = null;

// ── Settings (loaded from chrome.storage, with defaults) ─────────────────────

let settings = {
  language: 'en-CA',
  aiTone: 'Original'
};

chrome.storage.sync.get(settings, (saved) => { Object.assign(settings, saved); });
chrome.storage.onChanged.addListener((changes) => {
  Object.keys(changes).forEach(k => { settings[k] = changes[k].newValue; });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function removePopup() {
  if (activePopup) { activePopup.remove(); activePopup = null; }
}

function removeHighlights(field) {
  removePopup();
  const overlay = overlays.get(field);
  if (overlay) overlay.innerHTML = '';
}

function saveActiveSelection() {
  const activeEl = document.activeElement;
  savedTargetField = activeEl;

  if (activeEl && (activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'INPUT')) {
    // For plain inputs: snapshot character offsets — these never go stale
    savedSelectionBounds = { start: activeEl.selectionStart, end: activeEl.selectionEnd };
    savedRange = null;
  } else {
    // For contenteditable: cloneRange() keeps the Range object but the
    // underlying DOM positions can silently detach when focus moves to the
    // popup. So we also remember the exact container + offsets manually so
    // we can rebuild the range at apply-time if needed.
    const sel = window.getSelection();
    if (sel?.rangeCount > 0) {
      const r = sel.getRangeAt(0);
      savedRange = r.cloneRange();
      // Also stash a plain-object snapshot as a fallback
      savedRange._snapshot = {
        startContainer: r.startContainer,
        startOffset: r.startOffset,
        endContainer: r.endContainer,
        endOffset: r.endOffset
      };
    } else {
      savedRange = null;
    }
    savedSelectionBounds = null;
  }
}

function makeDraggable(popup, dragHandle) {
  let isDragging = false;
  let startX = 0, startY = 0, initialLeft = 0, initialTop = 0;

  dragHandle.addEventListener('mousedown', (e) => {
    if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = popup.getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;
    dragHandle.style.cursor = 'grabbing';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    e.preventDefault();
  });

  function onMouseMove(e) {
    if (!isDragging) return;
    const padding = 10;
    let newLeft = initialLeft + (e.clientX - startX);
    let newTop = initialTop + (e.clientY - startY);
    newLeft = Math.max(padding, Math.min(window.innerWidth - popup.offsetWidth - padding, newLeft));
    newTop = Math.max(padding, Math.min(window.innerHeight - popup.offsetHeight - padding, newTop));
    popup.style.left = `${newLeft}px`;
    popup.style.top = `${newTop}px`;
  }

  function onMouseUp() {
    isDragging = false;
    dragHandle.style.cursor = 'move';
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  }
}

function positionPopupElement(popup, targetX, targetY) {
  document.body.appendChild(popup);
  const padding = 15;
  const popupWidth = popup.offsetWidth;
  const popupHeight = popup.offsetHeight;
  let left = targetX;
  let top = targetY;
  if (top + popupHeight + padding > window.innerHeight) top = targetY - popupHeight - 15;
  top = Math.max(padding, Math.min(window.innerHeight - popupHeight - padding, top));
  left = Math.max(padding, Math.min(window.innerWidth - popupWidth - padding, left));
  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;
}

// FIX: use fixed positioning so overlay always aligns with visible field
function syncOverlay(field) {
  let overlay = overlays.get(field);
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'lt-overlay';
    document.body.appendChild(overlay);
    overlays.set(field, overlay);
  }

  const rect = field.getBoundingClientRect();
  const computed = window.getComputedStyle(field);

  // Fixed positioning — tracks the field's visual position directly
  overlay.style.position = 'fixed';
  overlay.style.top = `${rect.top}px`;
  overlay.style.left = `${rect.left}px`;
  overlay.style.width = `${rect.width}px`;
  overlay.style.height = `${rect.height}px`;

  const stylesToCopy = [
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
    'wordBreak', 'overflowWrap', 'whiteSpace', 'textAlign'
  ];
  stylesToCopy.forEach(prop => overlay.style[prop] = computed[prop]);
  overlay.scrollTop = field.scrollTop;
  overlay.scrollLeft = field.scrollLeft;

  return overlay;
}

function getRangeFromTextOffset(rootNode, startOffset, endOffset) {
  const range = document.createRange();
  let currentOffset = 0, foundStart = false, foundEnd = false;

  function walk(node) {
    if (foundEnd) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const len = node.nodeValue.length;
      if (!foundStart && currentOffset + len >= startOffset) {
        range.setStart(node, startOffset - currentOffset);
        foundStart = true;
      }
      if (foundStart && currentOffset + len >= endOffset) {
        range.setEnd(node, endOffset - currentOffset);
        foundEnd = true;
        return;
      }
      currentOffset += len;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.tagName === 'BR') currentOffset += 1;
      else for (let i = 0; i < node.childNodes.length; i++) {
        walk(node.childNodes[i]);
        if (foundEnd) return;
      }
    }
  }

  walk(rootNode);
  return (foundStart && foundEnd) ? range : null;
}

// ── LanguageTool layer ────────────────────────────────────────────────────────

function showLTPopup(match, x, y, field) {
  removePopup();

  const popup = document.createElement('div');
  popup.className = 'lt-popup lt-grammar-popup';
  popup.addEventListener('click', (e) => e.stopPropagation());

  const header = document.createElement('div');
  header.className = 'lt-popup-drag-handle';
  header.textContent = 'Grammar Suggestion';
  popup.appendChild(header);

  const content = document.createElement('div');
  content.className = 'lt-grammar-content';

  const msg = document.createElement('div');
  msg.className = 'lt-grammar-msg';
  msg.textContent = match.message;
  content.appendChild(msg);

  // Show rule category as a small badge
  if (match.rule?.category?.name) {
    const badge = document.createElement('div');
    badge.className = 'lt-grammar-badge';
    badge.textContent = match.rule.category.name;
    content.appendChild(badge);
  }

  if (match.replacements?.length > 0) {
    const row = document.createElement('div');
    row.className = 'lt-grammar-row';
    match.replacements.slice(0, 3).forEach(rep => {
      const btn = document.createElement('button');
      btn.className = 'lt-grammar-btn';
      btn.textContent = rep.value;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        applyFix(field, match.offset, match.length, rep.value);
        removePopup();
        removeHighlights(field);
        setTimeout(() => checkText(field), 300);
      });
      row.appendChild(btn);
    });
    content.appendChild(row);
  } else {
    const noFix = document.createElement('div');
    noFix.className = 'lt-grammar-empty';
    noFix.textContent = 'No suggestions available.';
    content.appendChild(noFix);
  }

  popup.appendChild(content);
  makeDraggable(popup, header);
  positionPopupElement(popup, x, y + 10);
  setTimeout(() => document.addEventListener('click', removePopup, { once: true }), 0);
  activePopup = popup;
}

function applyFix(field, offset, length, replacement) {
  field.focus();
  if (field.tagName === 'TEXTAREA' || field.tagName === 'INPUT') {
    const val = field.value;
    field.value = val.slice(0, offset) + replacement + val.slice(offset + length);
    const newPos = offset + replacement.length;
    field.setSelectionRange(newPos, newPos);
  } else {
    try {
      const range = getRangeFromTextOffset(field, offset, offset + length);
      if (range && field.contains(range.startContainer)) {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        if (!document.execCommand('insertText', false, replacement)) {
          range.deleteContents();
          range.insertNode(document.createTextNode(replacement));
        }
        sel.removeAllRanges();
      }
    } catch (err) {
      console.error('LT apply error:', err);
    }
  }
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

function drawHighlights(field, matches) {
  removeHighlights(field);
  if (!matches.length) return;

  const overlay = syncOverlay(field);
  const text = field.value || field.innerText || '';
  overlay.innerHTML = '';

  let lastIndex = 0;
  const sorted = [...matches].sort((a, b) => a.offset - b.offset);

  sorted.forEach(match => {
    if (match.offset > lastIndex) {
      overlay.appendChild(document.createTextNode(text.slice(lastIndex, match.offset)));
    }
    const mark = document.createElement('mark');
    mark.className = match.rule?.issueType === 'misspelling'
      ? 'lt-highlight lt-misspelling'
      : 'lt-highlight';
    mark.textContent = text.slice(match.offset, match.offset + match.length);
    mark.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = mark.getBoundingClientRect();
      showLTPopup(match, rect.left, rect.bottom, field);
    });
    overlay.appendChild(mark);
    lastIndex = match.offset + match.length;
  });

  if (lastIndex < text.length) overlay.appendChild(document.createTextNode(text.slice(lastIndex)));
}

async function checkText(field) {
  const text = field.value || field.innerText || '';
  if (text.trim().length < 3) { removeHighlights(field); return; }

  const payload = new URLSearchParams({
    text,
    language: settings.language,
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

  try {
    const res = await fetch(LT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: payload
    });
    const data = await res.json();
    drawHighlights(field, data.matches || []);
  } catch (e) {
    console.error('LT error:', e);
  }
}

function attachToField(field) {
  if (field.dataset.ltAttached) return;
  field.dataset.ltAttached = 'true';

  field.addEventListener('input', () => {
    clearTimeout(timers.get(field));
    timers.set(field, setTimeout(() => checkText(field), DEBOUNCE_MS));
  });

  const sync = () => syncOverlay(field);
  field.addEventListener('scroll', sync);
  window.addEventListener('scroll', sync, true);
  window.addEventListener('resize', sync);
}

document.querySelectorAll('textarea, [contenteditable="true"]').forEach(attachToField);

const observer = new MutationObserver(muts => {
  muts.forEach(m => m.addedNodes.forEach(n => {
    if (n.nodeType !== 1) return;
    if (n.matches('textarea, [contenteditable="true"]')) attachToField(n);
    n.querySelectorAll('textarea, [contenteditable="true"]').forEach(attachToField);
  }));
});
observer.observe(document.body, { childList: true, subtree: true });

// ── Keyboard shortcut Alt+G ───────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  if (e.altKey && e.key === 'g') {
    const sel = window.getSelection();
    const text = sel?.toString().trim();
    if (!text) return;
    e.preventDefault();
    saveActiveSelection();
    const range = sel.getRangeAt(0).getBoundingClientRect();
    showAIPopup(range.left, range.bottom, text);
  }
});

// ── Ollama layer ──────────────────────────────────────────────────────────────

function replaceSavedSelection(replacement) {
  if (savedTargetField && (savedTargetField.tagName === 'TEXTAREA' || savedTargetField.tagName === 'INPUT')) {
    savedTargetField.focus();
    if (savedSelectionBounds) {
      const { start, end } = savedSelectionBounds;
      const val = savedTargetField.value;
      savedTargetField.value = val.slice(0, start) + replacement + val.slice(end);
      savedTargetField.setSelectionRange(start + replacement.length, start + replacement.length);
      savedTargetField.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return;
  }
  if (savedRange) {
    try {
      // Rebuild from snapshot in case the cloned range detached when focus moved to popup
      let range = savedRange;
      if (savedRange._snapshot) {
        const s = savedRange._snapshot;
        try {
          const rebuilt = document.createRange();
          rebuilt.setStart(s.startContainer, s.startOffset);
          rebuilt.setEnd(s.endContainer, s.endOffset);
          range = rebuilt;
        } catch (_) { /* fall back to cloned range */ }
      }

      // Re-focus the original field so execCommand targets the right document
      if (savedTargetField && savedTargetField.focus) savedTargetField.focus();

      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      if (!document.execCommand('insertText', false, replacement)) {
        range.deleteContents();
        range.insertNode(document.createTextNode(replacement));
      }
      sel.removeAllRanges();
    } catch (e) {
      console.error('AI apply error:', e);
    }
  }
}

function showAIPopup(anchorX, anchorY, selectedText) {
  removePopup();

  const popup = document.createElement('div');
  popup.className = 'lt-popup lt-ai-popup';
  popup.addEventListener('click', (e) => e.stopPropagation());

  const header = document.createElement('div');
  header.className = 'lt-popup-drag-handle lt-ai-header';

  const title = document.createElement('span');
  title.textContent = 'AI Assistant';
  header.appendChild(title);

  // Shortcut hint in header
  const hint = document.createElement('span');
  hint.className = 'lt-ai-hint';
  hint.textContent = 'Alt+G';
  header.appendChild(hint);

  popup.appendChild(header);

  const body = document.createElement('div');
  body.className = 'lt-ai-body';

  const toneRow = document.createElement('div');
  toneRow.className = 'lt-ai-tones';
  const tones = ['Original', 'Formal', 'Casual', 'Concise'];
  let selectedTone = settings.aiTone || 'Original';

  tones.forEach(tone => {
    const btn = document.createElement('button');
    btn.className = `lt-ai-tone-btn${tone === selectedTone ? ' active' : ''}`;
    btn.textContent = tone;
    btn.addEventListener('click', () => {
      selectedTone = tone;
      toneRow.querySelectorAll('.lt-ai-tone-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      fetchSuggestion(selectedText, tone);
    });
    toneRow.appendChild(btn);
  });
  body.appendChild(toneRow);

  const result = document.createElement('div');
  result.className = 'lt-ai-result';
  result.textContent = 'Thinking...';
  body.appendChild(result);

  const actions = document.createElement('div');
  actions.className = 'lt-ai-actions';

  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'lt-ai-btn-dismiss';
  dismissBtn.textContent = 'Dismiss';
  dismissBtn.addEventListener('click', removePopup);

  const applyBtn = document.createElement('button');
  applyBtn.className = 'lt-ai-btn-apply';
  applyBtn.textContent = 'Apply';

  actions.appendChild(dismissBtn);
  actions.appendChild(applyBtn);
  body.appendChild(actions);
  popup.appendChild(body);

  makeDraggable(popup, header);
  positionPopupElement(popup, anchorX, anchorY + 10);
  activePopup = popup;

  async function fetchSuggestion(text, tone) {
    result.textContent = 'Thinking...';
    applyBtn.classList.remove('ready');

    const toneInstruction = {
      'Original': 'Fix all grammar, spelling, and punctuation errors. Keep the original wording and style.',
      'Formal': 'Fix all grammar and spelling errors, then rewrite in a formal, professional tone.',
      'Casual': 'Fix all grammar and spelling errors, then rewrite in a friendly, conversational tone.',
      'Concise': 'Fix all grammar and spelling errors, then cut unnecessary words to make it as concise as possible without losing meaning.'
    }[tone] || 'Fix all grammar, spelling, and punctuation errors.';

    const prompt = `You are a text correction API. Your ONLY job is to return the corrected version of the text.

Rules:
- ALWAYS return the corrected text, even if you think it looks fine — make at least minor improvements.
- Output the corrected text ONLY. No intro, no explanation, no "Here is the corrected version", no quotes.
- Do not add commentary before or after the text.

Instruction: ${toneInstruction}

Text to correct:
${text}

Corrected text:`;

    try {
      const res = await fetch(OLLAMA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'llama3', prompt, stream: false })
      });
      const data = await res.json();
      let suggestion = data.response?.trim() || '';
      suggestion = suggestion.replace(/^(here is|sure,|here's|certainly)[^:]*:\s*/gi, '').replace(/^"|"$/g, '').trim();

      if (suggestion) {
        result.textContent = suggestion;
        applyBtn.classList.add('ready');
        applyBtn.onclick = () => { replaceSavedSelection(suggestion); removePopup(); };
      } else {
        result.textContent = 'No suggestion returned.';
      }
    } catch (e) {
      result.textContent = 'Could not reach Ollama. Make sure it is running.';
    }
  }

  fetchSuggestion(selectedText, selectedTone);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'IMPROVE_SELECTION') {
    saveActiveSelection();
    const sel = window.getSelection();
    const range = sel?.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
    const x = range ? range.left : window.innerWidth / 2 - 180;
    const y = range ? range.bottom : window.innerHeight / 2;
    showAIPopup(x, y, msg.text);
  }
});