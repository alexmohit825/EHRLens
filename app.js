// ============================================================
// EHRLens — AI Clinical Navigator  |  app.js
// Vanilla JS · No framework · Instant load
// Supports: camera capture · file upload · clipboard paste (Ctrl+V)
// ============================================================
'use strict';

const CONFIG = {
  WORKER_URL: 'https://ehrlens-api.YOUR_SUBDOMAIN.workers.dev', // ← replace after deploy
  MAX_SESSION_QUERIES: 10,
  IMAGE_QUALITY: 0.82,
  MODES: {
    epic:    { label: 'Epic',        badge: 'badge-epic' },
    cerner:  { label: 'Cerner',      badge: 'badge-cerner' },
    general: { label: 'General EHR', badge: 'badge-general' },
    other:   { label: 'Other',       badge: 'badge-other' },
  },
  QUICK_QUESTIONS: {
    epic: [
      'How do I add a new medication order?',
      'Where do I find lab results?',
      'How do I create a new note?',
      'What does this alert mean?',
      'How do I route this to a provider?',
      'How do I access the patient schedule?',
    ],
    cerner: [
      'How do I place an order here?',
      'Where are the patient results?',
      'How do I document a note?',
      'What does this flag mean?',
    ],
    general: [
      'What does this screen do?',
      'How do I navigate to a specific section?',
      'What does this field mean?',
      'How do I save my work?',
    ],
    other: [
      'Explain what I am looking at.',
      'How do I complete this task?',
      'What does this button do?',
    ],
  },
};

// ── State ─────────────────────────────────────────────────────
const state = {
  screen: 'welcome',
  stream: null,
  capturedImage: null,
  mode: 'epic',
  history: [],
  response: null,
  sessionQueryCount: 0,
  isListening: false,
  analyzeStart: null,
  timerInterval: null,
  recognition: null,
};

// ── DOM Helpers ───────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const $all = (sel, root = document) => [...root.querySelectorAll(sel)];

// ── Markdown Renderer (zero dependencies) ────────────────────
function md(text) {
  if (!text) return '';
  let h = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  h = h.replace(/^### (.+)$/gm,'<h3>$1</h3>');
  h = h.replace(/^## (.+)$/gm,'<h2>$1</h2>');
  h = h.replace(/^# (.+)$/gm,'<h1>$1</h1>');
  h = h.replace(/\*\*\*(.+?)\*\*\*/g,'<strong><em>$1</em></strong>');
  h = h.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');
  h = h.replace(/\*(.+?)\*/g,'<em>$1</em>');
  h = h.replace(/`([^`]+)`/g,'<code>$1</code>');
  h = h.replace(/^---+$/gm,'<hr>');
  h = h.replace(/^&gt; (.+)$/gm,'<blockquote>$1</blockquote>');
  h = h.replace(/^(\d+)\. (.+)$/gm,(_,n,c) =>
    `<div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:8px;"><span class="step-number">${n}</span><span>${c}</span></div>`);
  h = h.replace(/^[\*\-] (.+)$/gm,'<li>$1</li>');
  return h.split('\n').map(l => {
    const t = l.trim();
    if (!t) return '';
    if (/^<(h[123]|ul|ol|li|hr|blockquote|div|strong|em|p)/.test(t)) return t;
    return `<p>${t}</p>`;
  }).join('\n');
}

// ── Toast ─────────────────────────────────────────────────────
function toast(msg, ms = 2800) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms);
}

// ── Screen Nav ────────────────────────────────────────────────
function showScreen(name) {
  const prev = document.querySelector('.screen.active');
  if (prev) { prev.classList.add('exit'); prev.classList.remove('active'); setTimeout(() => prev.classList.remove('exit'), 300); }
  state.screen = name;
  requestAnimationFrame(() => $(`screen-${name}`)?.classList.add('active'));
}

// ── Camera ────────────────────────────────────────────────────
async function startCamera() {
  const video = $('video-feed');
  const errEl = $('camera-error');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    state.stream = stream;
    video.srcObject = stream;
    await video.play();
    errEl?.classList.add('hidden');
  } catch {
    errEl?.classList.remove('hidden');
    $('camera-upload-btn')?.classList.remove('hidden');
  }
}

function stopCamera() {
  state.stream?.getTracks().forEach(t => t.stop());
  state.stream = null;
}

function captureFrame() {
  const v = $('video-feed');
  if (!v?.videoWidth) return null;
  const c = document.createElement('canvas');
  c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0);
  return c.toDataURL('image/jpeg', CONFIG.IMAGE_QUALITY).split(',')[1];
}

// ── Voice ─────────────────────────────────────────────────────
function setupSpeech(inputEl, btn, onFinal) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { if(btn){btn.style.opacity='.4';btn.style.pointerEvents='none';} return null; }
  const r = new SR();
  r.lang = 'en-US'; r.interimResults = true; r.continuous = false;
  r.onstart = () => {
    state.isListening = true;
    if(btn){btn.classList.add('listening');btn.innerHTML='<div class="voice-waveform"><span class="bar"></span><span class="bar"></span><span class="bar"></span><span class="bar"></span><span class="bar"></span></div>Stop';}
    navigator.vibrate?.(40);
  };
  r.onresult = e => {
    let t = '';
    for(const res of e.results) t += res[0].transcript;
    if(inputEl){inputEl.value=t;inputEl.dispatchEvent(new Event('input'));}
    if(e.results[e.results.length-1].isFinal && onFinal) onFinal(t);
  };
  r.onerror = e => { stopListening(r,btn); if(e.error==='not-allowed') toast('🎤 Microphone permission denied'); };
  r.onend = () => stopListening(r, btn);
  return r;
}

function startListening(r) { if(!state.isListening) { try{r.start();}catch{} } }
function stopListening(r, btn) {
  state.isListening = false;
  if(btn){btn.classList.remove('listening');btn.innerHTML='🎤 Speak';}
  try{r.stop();}catch{}
}

// ── Mode ──────────────────────────────────────────────────────
function setMode(mode) {
  state.mode = mode;
  $all('.mode-chip').forEach(c => c.classList.toggle('active', c.dataset.mode === mode));
  renderQuickQuestions();
}

function renderQuickQuestions() {
  const c = $('quick-q-pills'); if(!c) return;
  const qs = CONFIG.QUICK_QUESTIONS[state.mode] || CONFIG.QUICK_QUESTIONS.general;
  c.innerHTML = qs.map(q => `<button class="quick-q-pill" data-q="${q.replace(/"/g,'&quot;')}">${q}</button>`).join('');
  c.querySelectorAll('.quick-q-pill').forEach(p => p.addEventListener('click', () => {
    const qi = $('question-input');
    if(qi){qi.value=p.dataset.q;qi.dispatchEvent(new Event('input'));qi.focus();}
  }));
}

// ── API ───────────────────────────────────────────────────────
async function analyzeImage(img, question, history) {
  const r = await fetch(`${CONFIG.WORKER_URL}/api/analyze`, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ image_base64: img, question: question.trim(), mode: state.mode, history }),
  });
  if(!r.ok){const e=await r.json().catch(()=>({error:`HTTP ${r.status}`}));throw new Error(e.error||`Server error ${r.status}`);}
  return r.json();
}

// ── Timer ─────────────────────────────────────────────────────
function startTimer() {
  state.analyzeStart = Date.now();
  const el = $('analyzing-timer');
  state.timerInterval = setInterval(() => { if(el) el.textContent = `${((Date.now()-state.analyzeStart)/1000).toFixed(1)}s`; }, 100);
}
function stopTimer() { clearInterval(state.timerInterval); state.timerInterval = null; }

// ── Query Flow ────────────────────────────────────────────────
async function runQuery(question) {
  if (!state.capturedImage) { toast('📷 No image captured yet. Please scan a screen first.'); return; }
  if (!question.trim()) { toast('Please enter or speak a question.'); return; }
  state.sessionQueryCount++;
  const ai = $('analyzing-img');
  if(ai) ai.src = `data:image/jpeg;base64,${state.capturedImage}`;
  showScreen('analyzing');
  startTimer();
  try {
    const data = await analyzeImage(state.capturedImage, question, state.history);
    stopTimer();
    state.history.push({role:'user',content:question});
    state.history.push({role:'model',content:data.answer});
    if(state.history.length > 12) state.history = state.history.slice(-12);
    state.response = data.answer;
    renderResponse(question, data.answer);
    showScreen('response');
    if(state.sessionQueryCount >= CONFIG.MAX_SESSION_QUERIES - 2) {
      setTimeout(() => toast(`${CONFIG.MAX_SESSION_QUERIES - state.sessionQueryCount} queries remaining this session.`), 1500);
    }
  } catch(err) {
    stopTimer();
    toast(`⚠️ ${err.message || 'Query failed. Check your connection.'}`);
    showScreen('preview');
  }
}

// ── Render Response ───────────────────────────────────────────
function renderResponse(question, answer) {
  const qEl = $('response-question'), contentEl = $('response-content'), imgEl = $('response-preview-img');
  if(qEl) qEl.textContent = question;
  if(contentEl) contentEl.innerHTML = md(answer);
  if(imgEl && state.capturedImage) imgEl.src = `data:image/jpeg;base64,${state.capturedImage}`;
  const badge = $('response-mode-badge');
  if(badge){const cfg=CONFIG.MODES[state.mode];badge.textContent=cfg.label;badge.className=`preview-image-badge ${cfg.badge}`;}
  const fi = $('followup-input'); if(fi){fi.value='';fi.style.height='auto';}
}

// ── File Upload Fallback ──────────────────────────────────────
function handleFile(file) {
  if(!file||!file.type.startsWith('image/')) { toast('Please select an image file.'); return; }
  const r = new FileReader();
  r.onload = e => { state.capturedImage = e.target.result.split(',')[1]; state.history=[]; showPreview(); };
  r.readAsDataURL(file);
}

// ── Clipboard Paste (Ctrl+V / PC side-by-side with Epic) ────
// Works on any screen — paste an Epic screenshot directly from clipboard
async function handleClipboardPaste(event) {
  // Try paste event items first (works without permission prompt)
  const items = event?.clipboardData?.items;
  if (items) {
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) { handleFile(file); toast('📋 Screenshot pasted!'); return; }
      }
    }
    toast('No image found in clipboard. Copy a screenshot first.');
    return;
  }
  // Fallback: Clipboard API (requires permission, HTTPS only)
  try {
    const clipItems = await navigator.clipboard.read();
    for (const ci of clipItems) {
      const imgType = ci.types.find(t => t.startsWith('image/'));
      if (imgType) {
        const blob = await ci.getType(imgType);
        handleFile(new File([blob], 'paste.png', { type: imgType }));
        toast('📋 Screenshot pasted!');
        return;
      }
    }
    toast('No image in clipboard. Take a screenshot first (Win+Shift+S).');
  } catch {
    toast('Paste blocked. Use Ctrl+V while the app is focused, or upload a file.');
  }
}

// ── Paste Zone button handler ────────────────────────────────
async function triggerPasteFromButton() {
  try {
    const clipItems = await navigator.clipboard.read();
    for (const ci of clipItems) {
      const imgType = ci.types.find(t => t.startsWith('image/'));
      if (imgType) {
        const blob = await ci.getType(imgType);
        handleFile(new File([blob], 'paste.png', { type: imgType }));
        toast('📋 Screenshot pasted!');
        return;
      }
    }
    toast('No image in clipboard. Take a screenshot first (Win+Shift+S on Windows).');
  } catch {
    // Clipboard API blocked — show instruction
    toast('Press Ctrl+V anywhere in EHRLens to paste your screenshot.');
  }
}

function showPreview() {
  stopCamera();
  const img = $('preview-img');
  if(img) img.src = `data:image/jpeg;base64,${state.capturedImage}`;
  const badge = $('preview-mode-badge');
  if(badge){const cfg=CONFIG.MODES[state.mode];badge.textContent=cfg.label;badge.className=`preview-image-badge ${cfg.badge}`;}
  renderQuickQuestions();
  showScreen('preview');
  setTimeout(() => $('question-input')?.focus(), 400);
}

// ── Clipboard ─────────────────────────────────────────────────
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta); return ok;
  }
}

// ── Init ──────────────────────────────────────────────────────
function init() {
  // Welcome
  $('start-btn')?.addEventListener('click', () => { showScreen('camera'); startCamera(); });

  // Camera — mode chips
  $all('.mode-chip').forEach(c => c.addEventListener('click', () => setMode(c.dataset.mode)));

  // Camera — capture
  $('capture-btn')?.addEventListener('click', () => {
    navigator.vibrate?.(50);
    const b64 = captureFrame();
    if(!b64){toast('Camera not ready. Try again.');return;}
    state.capturedImage = b64; state.history = [];
    showPreview();
  });

  // Camera — file upload fallback
  $('camera-upload-btn')?.addEventListener('click', () => $('file-input')?.click());
  $('file-input')?.addEventListener('change', e => handleFile(e.target.files[0]));

  // Camera — paste zone button (PC side-by-side with Epic)
  $('paste-btn')?.addEventListener('click', triggerPasteFromButton);

  // ── Global Ctrl+V paste listener — works on ANY screen ───
  // Physician can Ctrl+V a screenshot at any time without touching the UI
  document.addEventListener('paste', (e) => handleClipboardPaste(e));

  // Drag-and-drop (desktop)
  $('screen-camera')?.addEventListener('dragover', e => {e.preventDefault();e.stopPropagation();});
  $('screen-camera')?.addEventListener('drop', e => {e.preventDefault();handleFile(e.dataTransfer.files[0]);});

  // Preview — back
  $('preview-back')?.addEventListener('click', () => { showScreen('camera'); startCamera(); });

  // Preview — textarea auto-resize
  $('question-input')?.addEventListener('input', function(){this.style.height='auto';this.style.height=`${Math.min(this.scrollHeight,140)}px`;});

  // Preview — voice
  const voiceBtn=$('voice-btn'), qi=$('question-input');
  if(voiceBtn){
    state.recognition = setupSpeech(qi, voiceBtn, q => { if(q&&q.length>3) setTimeout(()=>runQuery(q),800); });
    voiceBtn.addEventListener('click', () => {
      if(!state.recognition)return;
      state.isListening ? stopListening(state.recognition,voiceBtn) : startListening(state.recognition);
    });
  }

  // Preview — ask
  $('ask-btn')?.addEventListener('click', () => runQuery($('question-input')?.value||''));
  $('question-input')?.addEventListener('keydown', e => {
    if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();runQuery(e.target.value);}
  });

  // Response — back
  $('response-back')?.addEventListener('click', () => showScreen('preview'));

  // Response — new scan
  $('new-scan-btn')?.addEventListener('click', () => {
    state.capturedImage=null;state.history=[];state.response=null;
    const qi=$('question-input');if(qi){qi.value='';qi.style.height='auto';}
    showScreen('camera'); startCamera();
  });

  // Response — copy
  $('copy-btn')?.addEventListener('click', async function(){
    if(!state.response)return;
    if(await copyText(state.response)){
      this.classList.add('copied');this.textContent='✓ Copied';
      setTimeout(()=>{this.classList.remove('copied');this.textContent='📋 Copy';},2000);
    }
  });

  // Follow-up
  $('followup-input')?.addEventListener('input', function(){this.style.height='auto';this.style.height=`${Math.min(this.scrollHeight,100)}px`;});
  $('followup-send')?.addEventListener('click', () => { const q=$('followup-input')?.value.trim();if(q)runQuery(q); });
  $('followup-input')?.addEventListener('keydown', e => { if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();const q=e.target.value.trim();if(q)runQuery(q);}});

  // Follow-up voice
  const fuBtn=$('followup-voice-btn'),fuIn=$('followup-input');
  if(fuBtn&&fuIn){
    const fuR=setupSpeech(fuIn,fuBtn,q=>{if(q&&q.length>3)setTimeout(()=>runQuery(q),800);});
    fuBtn.addEventListener('click',()=>{if(!fuR)return;state.isListening?stopListening(fuR,fuBtn):startListening(fuR);});
  }

  // Service Worker
  if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});

  // URL mode param
  const m=new URLSearchParams(location.search).get('mode');
  if(m&&CONFIG.MODES[m])setMode(m);

  showScreen('welcome');
}

document.readyState==='loading' ? document.addEventListener('DOMContentLoaded',init) : init();
