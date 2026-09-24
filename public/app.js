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
// Field the agent's last question was about. Updated at the end of every
// turn (LLM or fallback) so the fallback always knows what a reply answers.
let awaitingSlot = 'name';
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

function nextMissingSlot() {
  return SLOT_ORDER.find((k) => !lead[k]) || null;
}

function detectIntent(text) {
  if (/\brent(?:ing)?\b/i.test(text) || /किराय/.test(text)) return 'Rent';
  if (/\b(buy|buying|purchase)\b/i.test(text) || /खरीद/.test(text)) return 'Buy';
  return null;
}

function detectBudget(text) {
  const m = text.match(/(?:aed|\$)?\s?\d[\d,]*(?:\.\d+)?\s?(?:million|mn|m|k|thousand|lakh|crore)?\b/i);
  return m ? m[0].trim() : null;
}

// Stricter check for picking up a budget the lead volunteered unprompted:
// needs a currency/unit or a 4+ digit number, so "3 bedroom" is not a budget.
function detectVolunteeredBudget(text) {
  const b = detectBudget(text);
  return b && (/aed|\$|million|mn|m\b|k\b|thousand|lakh|crore/i.test(b) || /\d{4,}|\d{1,3},\d{3}/.test(b)) ? b : null;
}

function detectName(text) {
  const m = text.match(/(?:my name is|i am|i'm|this is)\s+([a-z]+)/i) ||
            text.match(/(?:मेरा नाम|नाम)\s+([^\s।,.!?]+)/);
  return m ? capIfLatin(m[1]) : null;
}

// Best-effort value for `slot`, given that `text` is the answer to that slot's question.
function interpretFor(slot, text) {
  const raw = text.trim().replace(/[.!?।]+$/, '');
  if (!raw) return null;
  switch (slot) {
    case 'name': return detectName(raw) || capIfLatin(raw.split(/\s+/)[0]);
    case 'intent': return detectIntent(raw) || raw;
    case 'budget': return detectBudget(raw) || raw;
    default: return raw; // area, timeline
  }
}

// One deterministic turn: fill the field we asked about, pick up any other
// clearly-stated fields, then ask the next missing one (or close).
function fallbackTurn(userText) {
  const found = {};
  if (awaitingSlot && !lead[awaitingSlot]) found[awaitingSlot] = interpretFor(awaitingSlot, userText);
  if (!lead.name && !found.name) found.name = detectName(userText);
  if (!lead.intent && !found.intent) found.intent = detectIntent(userText);
  if (!lead.budget && !found.budget) found.budget = detectVolunteeredBudget(userText);
  applyFields(found);
  const missing = nextMissingSlot();
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
    awaitingSlot = nextMissingSlot(); // keep fallback in sync whichever path handled the turn
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

// Mobile browsers only allow the first speechSynthesis utterance inside a user
// gesture, so play a silent one synchronously from the click handler.
function unlockTTS() {
  if (!window.speechSynthesis) return;
  const unlock = new SpeechSynthesisUtterance(' ');
  unlock.volume = 0;
  window.speechSynthesis.speak(unlock);
}

async function startCall() {
  unlockTTS();
  startBtn.disabled = true;
  statusText.textContent = 'Connecting...';

  // Use the device's native rate: mobile browsers reject a forced 16 kHz context.
  // Created inside the click gesture so it isn't left suspended on mobile.
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  audioContext.resume();
  const rate = audioContext.sampleRate;

  const tokenRes = await fetch('/api/token');
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok) {
    statusText.textContent = `Error: ${tokenData.error || 'could not get token'}`;
    cleanupAudio();
    startBtn.disabled = false;
    return;
  }

  try {
    await initMic();
  } catch (err) {
    console.error('Microphone access failed:', err);
    statusText.textContent = 'Error: microphone access denied or unavailable';
    cleanupAudio();
    startBtn.disabled = false;
    return;
  }

  socket = new WebSocket(
    `wss://streaming.assemblyai.com/v3/ws?sample_rate=${rate}&speech_model=universal-3-5-pro&mode=balanced&token=${tokenData.token}`
  );
  socket.binaryType = 'arraybuffer';

  socket.onopen = () => {
    statusDot.classList.add('live');
    statusText.textContent = 'Call live, listening';
    stopBtn.disabled = false;
    Object.keys(lead).forEach((k) => (lead[k] = null));
    awaitingSlot = 'name';
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
  // audioContext is created in startCall (native sample rate) before this runs.
  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
  if (audioContext && audioContext.state !== 'closed') audioContext.close();
  if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
  processor = null;
  audioContext = null;
  mediaStream = null;
}

startBtn.addEventListener('click', startCall);
stopBtn.addEventListener('click', endCall);
