require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;
// LLM Gateway model. AssemblyAI's own qwen3.5-4b-32k-fast is available on
// free accounts; Claude/GPT models need paid access. Override in .env if
// your account has access to a stronger model (e.g. claude-sonnet-4-6).
const LLM_MODEL = process.env.LLM_MODEL || 'qwen3.5-4b-32k-fast';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Issues a short-lived AssemblyAI v3 streaming token so the browser can
// connect directly to AssemblyAI's websocket without ever seeing the
// real API key. (v2 realtime/token is deprecated, this uses v3.)
app.get('/api/token', async (req, res) => {
  if (!ASSEMBLYAI_API_KEY || ASSEMBLYAI_API_KEY === 'your_key_here') {
    return res.status(500).json({
      error: 'ASSEMBLYAI_API_KEY not set. Add it to your .env file.'
    });
  }

  try {
    const response = await fetch(
      'https://streaming.assemblyai.com/v3/token?expires_in_seconds=60',
      {
        method: 'GET',
        headers: {
          authorization: ASSEMBLYAI_API_KEY // raw key, no "Bearer" prefix
        }
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error('AssemblyAI token error:', data);
      return res.status(response.status).json(data);
    }

    res.json(data); // { token: "..." }
  } catch (err) {
    console.error('Failed to fetch AssemblyAI token:', err);
    res.status(500).json({ error: 'Failed to fetch token' });
  }
});

// The system prompt that turns raw transcripts into a real conversation:
// the LLM reads what the lead said, decides what's still missing, and
// writes the agent's next line itself, instead of a fixed script.
const SYSTEM_PROMPT = `You are Spparo's AI voice assistant, calling a real estate lead in Dubai to qualify them.

Goal: through natural conversation, find out these 5 things:
1. name
2. intent: "Buy" or "Rent"
3. area: preferred area/neighborhood in Dubai
4. budget: in AED (or convert if they give another currency)
5. timeline: when they plan to move (e.g. "this month", "3 months", "just exploring")

Rules:
- Ask ONE thing at a time. Keep replies short (1-2 sentences), warm and professional.
- The lead may reply in English, Hindi, or a mix (Hinglish). Understand whatever language they use, and reply in the same language/style they're using.
- If they give several details in one sentence, extract all of them at once and skip questions you already have the answer to.
- If their answer is unclear or off-topic, politely ask again in a natural way (don't repeat the exact same sentence twice).
- Once all 5 fields are known, thank them warmly, say the team will follow up with matching listings, and end the call.

You MUST reply with ONLY a single valid JSON object, no text before or after it, in exactly this shape:
{"reply": "<what you say next, in the lead's language>", "fields": {"name": <string or null>, "intent": <"Buy"|"Rent"|null>, "area": <string or null>, "budget": <string or null>, "timeline": <string or null>}, "done": <true/false>}

Example (lead just said "I want to buy"):
{"reply": "Great, buying it is! Which area in Dubai are you interested in?", "fields": {"intent": "Buy"}, "done": false}

Keep "reply" to one short sentence. Only put a value in "fields" for something you are confident about from the whole conversation so far. Use null for anything still unknown. Set "done" to true only after you have all 5 fields and just said the closing line.`;

// Turns whatever the model returned into { reply, fields, done }, even
// when a small model breaks the JSON. Strategy: try strict JSON first;
// if that fails, salvage the "reply" (and any fields/done) with regex so
// the agent always says something sensible and never dead-ends.
function salvageReply(raw) {
  const text = (raw || '').trim();

  // 1. Best case: clean JSON, possibly wrapped in prose or code fences.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try {
      const obj = JSON.parse(text.slice(start, end + 1));
      if (obj && typeof obj.reply === 'string') {
        return {
          reply: obj.reply,
          fields: obj.fields && typeof obj.fields === 'object' ? obj.fields : {},
          done: obj.done === true
        };
      }
    } catch (_) {
      /* fall through to regex salvage */
    }
  }

  // 2. Broken JSON: pull the reply string out with a regex.
  const replyMatch = text.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (replyMatch) {
    let reply = replyMatch[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').trim();
    const doneMatch = text.match(/"done"\s*:\s*(true|false)/);
    return { reply, fields: {}, done: doneMatch ? doneMatch[1] === 'true' : false };
  }

  // 3. No JSON at all: the model just replied in plain text. Use it,
  //    stripping any stray braces so the lead never hears raw JSON.
  const plain = text.replace(/[{}]/g, '').trim();
  if (plain) {
    return { reply: plain, fields: {}, done: false };
  }

  // 4. Truly empty: ask them to continue rather than showing an error.
  return { reply: 'Sorry, could you say that again?', fields: {}, done: false };
}

// Runs one turn of the conversation through AssemblyAI's LLM Gateway:
// given the chat history so far, it returns the agent's next line plus
// whatever lead fields it could confidently extract.
app.post('/api/agent-turn', async (req, res) => {
  if (!ASSEMBLYAI_API_KEY || ASSEMBLYAI_API_KEY === 'your_key_here') {
    return res.status(500).json({ error: 'ASSEMBLYAI_API_KEY not set. Add it to your .env file.' });
  }

  const { history } = req.body; // [{role: 'assistant'|'user', content: string}, ...]
  if (!Array.isArray(history)) {
    return res.status(400).json({ error: 'history must be an array' });
  }

  try {
    const response = await fetch('https://llm-gateway.assemblyai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: ASSEMBLYAI_API_KEY, // raw key, no "Bearer" prefix
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
        max_tokens: 500
      })
    });

    const data = await response.json();
    if (!response.ok) {
      // Free-tier rate limits, quota, or model-access issues land here.
      // Never break the call: signal 'degraded' so the client falls back
      // to its own deterministic logic, and log the real reason for us.
      console.error('LLM Gateway error (status ' + response.status + '):', JSON.stringify(data));
      return res.json({ degraded: true, reply: null, fields: {}, done: false });
    }

    const raw = data.choices?.[0]?.message?.content || '';
    res.json(salvageReply(raw));
  } catch (err) {
    console.error('Failed to reach LLM Gateway:', err.message);
    res.json({ degraded: true, reply: null, fields: {}, done: false });
  }
});

app.listen(PORT, () => {
  console.log(`Voice Lead Agent [v2 - LLM salvage] running at http://localhost:${PORT}`);
  console.log(`Using LLM model: ${LLM_MODEL}`);
  if (!ASSEMBLYAI_API_KEY || ASSEMBLYAI_API_KEY === 'your_key_here') {
    console.warn('WARNING: ASSEMBLYAI_API_KEY is not set in .env');
  }
});
