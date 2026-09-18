const OLLAMA_URL = 'http://localhost:11434/api/generate';
const LT_URL = 'http://localhost:8081/v2/check';

// ── Tab switching ─────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const tabName = tab.getAttribute('data-tab');
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('panel-' + tabName).classList.add('active');
  });
});

// ── Status checks ─────────────────────────────────────────────
async function checkStatus() {
  try {
    const r = await fetch(`${LT_URL}?language=en-CA&text=test`);
    document.getElementById('lt-dot').className = 'status-dot ' + (r.ok ? 'online' : 'offline');
  } catch { document.getElementById('lt-dot').className = 'status-dot offline'; }

  try {
    const r = await fetch('http://localhost:11434');
    document.getElementById('ol-dot').className = 'status-dot ' + (r.ok ? 'online' : 'offline');
  } catch { document.getElementById('ol-dot').className = 'status-dot offline'; }
}
checkStatus();

// ── Settings load/save ────────────────────────────────────────
const defaults = {
  language: 'en-CA',
  enablePunctuation: true,
  enableStyle: true,
  enablePassiveVoice: true,
  enableWordiness: true,
  enableRedundancy: true,
  aiTone: 'Original',
  ignoreList: []
};

chrome.storage.sync.get(defaults, (s) => {
  document.getElementById('sel-language').value = s.language;
  document.getElementById('sel-tone').value = s.aiTone;
  renderIgnoreTags(s.ignoreList || []);
});

function saveSetting(key, value) {
  chrome.storage.sync.set({ [key]: value });
}

document.getElementById('sel-language').addEventListener('change', e => saveSetting('language', e.target.value));
document.getElementById('sel-tone').addEventListener('change', e => saveSetting('aiTone', e.target.value));

// ── Ignore list ───────────────────────────────────────────────
function renderIgnoreTags(list) {
  const container = document.getElementById('ignore-tags');
  container.innerHTML = '';
  list.forEach(word => {
    const tag = document.createElement('div');
    tag.className = 'ignore-tag';
    tag.innerHTML = `${word}<button class="ignore-tag-remove" data-word="${word}">×</button>`;
    tag.querySelector('.ignore-tag-remove').addEventListener('click', () => removeIgnoreWord(word));
    container.appendChild(tag);
  });
}

function addIgnoreWord() {
  const input = document.getElementById('ignore-input');
  const word = input.value.trim();
  if (!word) return;
  chrome.storage.sync.get({ ignoreList: [] }, (s) => {
    if (s.ignoreList.includes(word)) { input.value = ''; return; }
    const updated = [...s.ignoreList, word];
    chrome.storage.sync.set({ ignoreList: updated }, () => renderIgnoreTags(updated));
    input.value = '';
  });
}

function removeIgnoreWord(word) {
  chrome.storage.sync.get({ ignoreList: [] }, (s) => {
    const updated = s.ignoreList.filter(w => w !== word);
    chrome.storage.sync.set({ ignoreList: updated }, () => renderIgnoreTags(updated));
  });
}

document.getElementById('ignore-add').addEventListener('click', addIgnoreWord);
document.getElementById('ignore-input').addEventListener('keydown', e => { if (e.key === 'Enter') addIgnoreWord(); });

// ── AI Chat ───────────────────────────────────────────────────
let chatHistory = [];
const messagesEl = document.getElementById('chat-messages');
const inputEl = document.getElementById('chat-input');
const sendBtn = document.getElementById('chat-send');

// Load persisted chat history on open
chrome.storage.local.get({ chatHistory: [] }, (s) => {
  chatHistory = s.chatHistory;
  if (chatHistory.length === 0) {
    // Pass true for isSystem
    addMessage('assistant', "Hi! I'm your local AI writing assistant. Ask me anything — grammar questions, rewrites, tone changes, or just paste text you want improved.", false, true);
  } else {
    // Pass stored m.isSystem so reloaded history respects it
    chatHistory.forEach(m => addMessage(m.role, m.content, false, m.isSystem));
  }
});

// Add isSystem parameter (defaults to false)
function addMessage(role, text, save = true, isSystem = false) {
  const msg = document.createElement('div');
  msg.className = `chat-msg ${role}`;

  const textNode = document.createElement('span');
  textNode.textContent = text;
  msg.appendChild(textNode);

  // Copy button on assistant messages, but SKIPPED if it's a system message
  if (role === 'assistant' && !isSystem) {
    const copyBtn = document.createElement('button');
    copyBtn.className = 'chat-copy-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => copyBtn.textContent = 'Copy', 1500);
      });
    });
    msg.appendChild(copyBtn);
  }

  messagesEl.appendChild(msg);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  if (save && role !== 'thinking') {
    // Save the isSystem flag into storage so it remembers next time!
    chatHistory.push({ role, content: text, isSystem });
    if (chatHistory.length > 40) chatHistory = chatHistory.slice(-40);
    chrome.storage.local.set({ chatHistory });
  }

  return msg;
}

async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text) return;

  inputEl.value = '';
  inputEl.style.height = '38px';
  sendBtn.disabled = true;

  addMessage('user', text);

  const thinking = document.createElement('div');
  thinking.className = 'chat-msg thinking';
  thinking.textContent = 'Thinking...';
  messagesEl.appendChild(thinking);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  // Exclude the current message (last entry) from history context since we append it explicitly
  const context = chatHistory.slice(-9, -1).filter(m => !m.isSystem).map(m =>
    `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`
  ).join('\n');

  const prompt = `You are a general-purpose AI assistant embedded in a writing tool. You can answer questions, write content from scratch, help with grammar, or rewrite text — whatever the user actually asks for.

CRITICAL RULES:
- Read the user's intent carefully. If they ask you to WRITE, GENERATE, CREATE, or DRAFT something, produce that content from scratch. Do NOT treat their message as text to improve.
- If the user gives context like "write me an email about X", "based on this write a paragraph", "give me 3 bullet points about Y" — they want NEW generated content, not a rewrite of what they typed.
- ONLY improve/fix the user's text if they explicitly say: improve, fix, rewrite, proofread, correct, or similar.
- If the user asks a question, answer it directly and concisely.
- Output ONLY the final result. No intro phrases like "Here is...", "Sure!", "Certainly". No quotes around output.
- Never explain what you changed unless explicitly asked.
${context ? `\nConversation so far:\n${context}` : ''}
User: ${text}
Assistant:`;

  try {
    const res = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama3', prompt, stream: false })
    });
    const data = await res.json();
    let reply = data.response?.trim() || 'No response.';

    // Strip any preamble Llama might still add
    reply = reply.replace(/^(here is|here's|sure,|certainly,|of course,)[^:]*:\s*/gi, '').trim();
    reply = reply.replace(/^"|"$/g, '').trim();

    thinking.remove();
    addMessage('assistant', reply);
  } catch {
    thinking.remove();
    addMessage('assistant', 'Could not reach Ollama. Make sure it is running.');
  }

  sendBtn.disabled = false;
}

sendBtn.addEventListener('click', sendMessage);
inputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

inputEl.addEventListener('input', () => {
  inputEl.style.height = '38px';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 100) + 'px';
});

document.getElementById('chat-clear').addEventListener('click', () => {
  chatHistory = [];
  chrome.storage.local.set({ chatHistory: [] });
  messagesEl.innerHTML = '';
  // Pass true for isSystem here too
  addMessage('assistant', 'Chat cleared! How can I help?', false, true);
});

// --- Math / LaTeX Converter Logic ---
const mathInput = document.getElementById('math-input');
const mathOutput = document.getElementById('math-output');
const btnToText = document.getElementById('btn-to-text');
const btnToLatex = document.getElementById('btn-to-latex');
const mathCopyBtn = document.getElementById('math-copy-btn');

async function convertMath(direction) {
  const text = mathInput.value.trim();
  if (!text) return;

  mathOutput.value = 'Converting...';

  let prompt = '';
  if (direction === 'toText') {
    prompt = `You are a math assistant. Given a LaTeX expression or formula, do TWO things:

1. IDENTIFY: If this is a well-known formula or mathematical definition (e.g. limit definition of a derivative, Euler's identity, quadratic formula, Pythagorean theorem, etc.), name it clearly on the first line like: "This is: [name]"
   If it is not a named formula, skip this line entirely.

2. SIMPLIFY: Write a compact, note-friendly plain text version suitable for pasting into notes. Use simple notation like sqrt(x), x^2, 1/2, lim(h->0), integral(a,b), sum(i=1,n), etc. Keep it on ONE line if possible. Do NOT use full sentences or lengthy explanations.

Output format (use exactly this):
This is: [formula name]   ← only if it's a known formula
[compact plain-text version]

LaTeX input:
${text}`;
  } else {
    prompt = `You are a strict mathematical LaTeX converter.

Your ONLY output must be valid LaTeX mathematical notation that can be directly rendered by a LaTeX math renderer.

IMPORTANT RULES:

1. NEVER output plain-text math.
2. NEVER use Unicode mathematical symbols when a LaTeX command exists.
3. Use actual LaTeX commands.
4. Use {} correctly for LaTeX command arguments.
5. Do NOT wrap the answer in $...$, $$...$$, or begin{equation}...end{equation}.
6. Do NOT provide explanations, descriptions, or prose outside the mathematical expression.
7. Do NOT use Markdown code fences.
8. When the user asks for a named mathematical formula, theorem, law, identity, or definition, return its standard mathematical expression in valid LaTeX.
9. If multiple mathematical expressions are required, use an appropriate LaTeX structure.
10. Preserve the mathematical meaning of the user's request. Do not guess or change mathematical values, variables, signs, exponents, or operations.

Before returning your answer, internally verify that:

* Every LaTeX command begins with \.
* All {} are properly matched.
* All frac commands have two arguments.
* All sqrt commands have a valid argument.
* Subscripts and superscripts are correctly formatted.
* No Unicode mathematical symbols remain when a LaTeX equivalent exists.
* The mathematical meaning has not been changed.
* The result can be directly passed to a LaTeX renderer.

Return ONLY the final LaTeX expression.
.\n\n${text}`;
  }

  try {
    const res = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama3', prompt, stream: false })
    });
    const data = await res.json();
    let reply = data.response?.trim() || 'Conversion failed.';
    
    reply = reply.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
    mathOutput.value = reply;
  } catch {
    mathOutput.value = 'Error: Could not reach Ollama.';
  }
}

btnToText.addEventListener('click', () => convertMath('toText'));
btnToLatex.addEventListener('click', () => convertMath('toLatex'));

mathCopyBtn.addEventListener('click', () => {
  if (!mathOutput.value) return;
  navigator.clipboard.writeText(mathOutput.value).then(() => {
    mathCopyBtn.textContent = 'Copied!';
    setTimeout(() => mathCopyBtn.textContent = 'Copy Result', 1500);
  });
});