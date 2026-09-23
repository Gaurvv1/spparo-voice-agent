// Spparo Voice Agent: demo lead qualification flow
// Mic -> 16kHz PCM -> AssemblyAI real-time STT -> LLM Gateway (reasoning) -> browser TTS

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const transcriptEl = document.getElementById('transcript');
const statusBadge = document.getElementById('statusBadge');

const fields = {
  name: document.getElementById('f-name'),
  budget: document.getElementById('f-budget'),
  area: document.getElementById('f-area'),
  intent: document.getElementById('f-intent'),
  timeline: document.getElementById('f-timeline')
};

let audioContext, mediaStream, processor, socket;
let partialLineEl = null;
let isSpeaking = false;
let isProcessing = false; // true while waiting on the LLM Gateway for a reply

// ---------- Conversation ----------
// Primary: an LLM (AssemblyAI LLM Gateway) reads each turn and writes the
// agent's next line. Fallback: if the LLM is rate-limited/unavailable, a
// deterministic slot-filler keeps the call working so the demo never breaks.

const lead = { name: null, intent: null, area: null, budget: null, timeline: null };
const GREETING = "Hi! This is Spparo's assistant calling about your Dubai property enquiry. Have you got a minute? Let's start: what's your name?";

// Full chat history sent to the LLM each turn, so it always reasons over
// the whole conversation instead of one message at a time.
let history = [];

function applyFields(found) {
  if (!found) return;
  Object.entries(found).forEach(([key, value]) => {
    if (value === null || value === undefined || value === '') return;
    lead[key] = value;
    if (fields[key]) {
      fields[key].textContent = value;
      fields[key].classList.remove('pending');
    }
  });
}

// ---------- Deterministic fallback (used only when the LLM is down) ----------

const SLOT_ORDER = ['name', 'intent', 'area', 'budget', 'timeline'];
let lastAsked = 'name';
const ASK = {
  name: "Sorry, I didn't catch your name. Could you tell me again?",
  intent: "Are you looking to buy or to rent?",
  area: "Which area in Dubai are you interested in?",
  budget: "What's your budget in AED, roughly?",
  timeline: "What's your timeline: this month, a few months, or just exploring?"
};
const CLOSING = "Thanks, that's everything I need. Someone from our team will follow up with matching listings shortly. Have a great day!";

function capIfLatin(w) {
  return /^[a-z]/i.test(w) ? w.charAt(0).toUpperCase() + w.slice(1) : w;
}

function extractSlots(text) {
  const found = {};
  if (!lead.name) {
    const m = text.match(/(?:my name is|i am|i'm|this is)\s+([a-z]+)/i) ||
             text.match(/(?:मेरा नाम|नाम)\s+([^\s।,.!?]+)/);
    if (m) found.name = capIfLatin(m[1]);
    else if (lastAsked === 'name') { const c = text.trim().replace(/\.$/, ''); if (c) found.name = capIfLatin(c.split(/\s+/)[0]); }
  }
  if (!lead.intent) {
    if (/\brent(?:ing)?\b/i.test(text) || /किराय/.test(text)) found.intent = 'Rent';
    else if (/\b(buy|buying|purchase)\b/i.test(text) || /खरीद/.test(text)) found.intent = 'Buy';
  }
  if (!lead.area && lastAsked === 'area') {
    const c = text.trim().replace(/\.$/, '');
    if (c) found.area = c;
  }
  if (!lead.budget) {
    const m = text.match(/(?:aed|\$)?\s?[\d,]+(?:\.\d+)?\s?(?:million|mn|m|k|thousand|lakh|crore)?/i);
    if (m && /\d/.test(m[0])) found.budget = m[0].trim();
  }
  if (!lead.timeline && lastAsked === 'timeline') {
    const c = text.trim().replace(/\.$/, '');
    if (c) found.timeline = c;
  }
  return found;
}

// One deterministic turn: extract what we can, then ask the next missing
// field (or close). Guarantees the call always moves forward.
function fallbackTurn(userText) {
  applyFields(extractSlots(userText));
  const missing = SLOT_ORDER.find((k) => !lead[k]);
  lastAsked = missing;
  if (missing) return { reply: ASK[missing], done: false };
  return { reply: CLOSING, done: true };
}

// Sends the conversation so far to our backend, which forwards it to
// AssemblyAI's LLM Gateway. Returns { degraded } true when the LLM could
// not answer, so the caller can switch to the deterministic fallback.
async function getAgentReply() {
  try {
    const res = await fetch('/api/agent-turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ history })
    });
    const data = await res.json();
    if (!res.ok || data.degraded || !data.reply) {
      return { degraded: true };
    }
    return data; // { reply, fields, done }
  } catch (err) {
    console.error('agent-turn request failed:', err);
    return { degraded: true };
  }
}

async function advance(userText) {
  if (isProcessing) return; // ignore overlapping turns while a reply is in flight
  isProcessing = true;
  const prevStatus = statusText.textContent;
  statusText.textContent = 'Thinking...';
  try {
    history.push({ role: 'user', content: userText });
    const result = await getAgentReply();
    statusText.textContent = prevStatus;

    let reply, done;
    if (result.degraded) {
      // LLM unavailable: fall back to deterministic slot-filling.
      const fb = fallbackTurn(userText);
      reply = fb.reply;
      done = fb.done;
    } else {
      applyFields(result.fields);
      reply = result.reply;
      done = result.done;
    }

    history.push({ role: 'assistant', content: reply });
    if (done) showFinalBadge();
    speak(reply, done ? endCall : resumeListening);
  } finally {
    isProcessing = false;
  }
}

function showFinalBadge() {
  const urgent = /week|month|now|asap|soon/i.test(lead.timeline || '');
  statusBadge.innerHTML = `<span class="badge ${urgent ? 'hot' : 'pending'}">${urgent ? '🔥 Hot lead: book callback' : '📋 Qualified: nurture'}</span>`;
}

// Devanagari script in the reply means the LLM answered in Hindi; anything
// else (including Hinglish written in Latin letters) reads better with an
// Indian-English voice than the browser's default (usually en-US).
function pickSpeechLang(text) {
  return /[ऀ-ॿ]/.test(text) ? 'hi-IN' : 'en-IN';
}

function speak(text, onEnd) {
  isSpeaking = true;
  addLine('agent', text);
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 1.0;
  utter.lang = pickSpeechLang(text);
  const voices = window.speechSynthesis.getVoices();
  const match = voices.find((v) => v.lang === utter.lang) ||
                voices.find((v) => v.lang && v.lang.startsWith(utter.lang.split('-')[0]));
  if (match) utter.voice = match;
  utter.onend = () => {
    isSpeaking = false;
    if (onEnd) onEnd();
  };
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utter);
}

function bubbleHTML(who, text) {
  const label = who === 'agent' ? 'Agent' : 'Lead';
  return `<div class="bubble"><span class="who">${label}</span>${text}</div>`;
}

function addLine(who, text, partial = false) {
  if (partial) {
    if (!partialLineEl) {
      partialLineEl = document.createElement('div');
      partialLineEl.className = `line ${who} partial`;
      transcriptEl.appendChild(partialLineEl);
    }
    partialLineEl.innerHTML = bubbleHTML(who, text);
  } else {
    if (partialLineEl) {
      partialLineEl.remove();
      partialLineEl = null;
    }
    const line = document.createElement('div');
    line.className = `line ${who}`;
    line.innerHTML = bubbleHTML(who, text);
    transcriptEl.appendChild(line);
  }
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function resumeListening() {
  // no-op placeholder: mic stays open throughout the call
}

// ---------- Audio capture + AssemblyAI streaming ----------

async function startCall() {
  startBtn.disabled = true;
  statusText.textContent = 'Connecting...';

  const tokenRes = await fetch('/api/token');
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok) {
    statusText.textContent = `Error: ${tokenData.error || 'could not get token'}`;
    startBtn.disabled = false;
    return;
  }

  socket = new WebSocket(
    `wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&speech_model=universal-3-5-pro&mode=balanced&token=${tokenData.token}`
  );
  socket.binaryType = 'arraybuffer';

  socket.onopen = async () => {
    try {
      await initMic();
    } catch (err) {
      console.error('Microphone access failed:', err);
      statusText.textContent = 'Error: microphone access denied or unavailable';
      socket.close();
      startBtn.disabled = false;
      return;
    }
    statusDot.classList.add('live');
    statusText.textContent = 'Call live, listening';
    stopBtn.disabled = false;
    Object.keys(lead).forEach((k) => (lead[k] = null));
    lastAsked = 'name';
    history = [{ role: 'assistant', content: GREETING }];
    Object.values(fields).forEach((el) => {
      el.textContent = '-';
      el.classList.add('pending');
    });
    statusBadge.innerHTML = '';
    speak(GREETING, resumeListening);
  };

  socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === 'Turn') {
      const text = msg.transcript;
      if (!text) return;

      if (!msg.end_of_turn) {
        if (!isSpeaking) addLine('lead', text, true);
      } else {
        addLine('lead', text, false);
        if (!isSpeaking && text.trim().length > 0) {
          advance(text);
        }
      }
    } else if (msg.type === 'Termination') {
      statusText.textContent = 'Session ended';
    } else if (msg.type === 'Begin') {
      // session confirmed open
    } else if (msg.error) {
      console.error('AssemblyAI error:', msg.error);
      statusText.textContent = `Error: ${msg.error}`;
    }
  };

  socket.onerror = (err) => {
    console.error('WebSocket error', err);
    statusText.textContent = 'Connection error, check console';
  };

  socket.onclose = () => {
    statusDot.classList.remove('live');
    if (!statusText.textContent.startsWith('Error:')) {
      statusText.textContent = 'Call ended';
    }
  };
}

async function initMic() {
  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  const source = audioContext.createMediaStreamSource(mediaStream);
  processor = audioContext.createScriptProcessor(4096, 1, 1);

  source.connect(processor);
  processor.connect(audioContext.destination);

  processor.onaudioprocess = (e) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (isSpeaking) return; // don't send agent's own TTS back as input

    const input = e.inputBuffer.getChannelData(0);
    const pcm16 = floatTo16BitPCM(input);
    socket.send(pcm16.buffer); // raw binary PCM16 frame, per v3 API
  };
}

function floatTo16BitPCM(float32Array) {
  const buffer = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    buffer[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return buffer;
}

function endCall() {
  statusDot.classList.remove('live');
  statusText.textContent = 'Call complete';
  stopBtn.disabled = true;
  startBtn.disabled = false;
  if (socket) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'Terminate' }));
    }
    socket.close();
  }
  cleanupAudio();
}

function cleanupAudio() {
  if (processor) processor.disconnect();
  if (audioContext) audioContext.close();
  if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
}

startBtn.addEventListener('click', startCall);
stopBtn.addEventListener('click', endCall);
