# Spparo Voice Agent

An AI voice agent that qualifies Dubai real estate leads over a live call, built on **AssemblyAI**. Submission for the AssemblyAI Voice Agent Hackathon (lablab.ai).

## The problem

Real estate leads in Dubai message at all hours and often go cold before an agent can call back. Spparo already qualifies these leads over WhatsApp. This project adds a **voice layer**: an AI agent that calls the lead, has a natural conversation, and hands the agent a ready-to-act summary.

## What it does

- Listens to the lead in real time (browser mic to AssemblyAI streaming STT)
- Understands each reply with an LLM and asks the right follow-up question
- Extracts 5 things: name, buy/rent, preferred area, budget (AED), timeline
- Shows a live transcript and an auto-filling lead summary
- Scores the lead (hot / nurture) at the end of the call
- Understands English, Hindi, and Hinglish

## How AssemblyAI is used

1. **Universal-Streaming (v3) STT** — real-time speech to text over WebSocket, with a server-minted temporary token so the API key never touches the browser.
2. **LLM Gateway** — each finalized turn is sent to an LLM through AssemblyAI's LLM Gateway, which decides what is still missing and writes the agent's next line.

If the LLM Gateway is unavailable (e.g. free-tier rate limits), the app falls back to a deterministic slot-filler so the call never breaks.

## Run locally

```bash
npm install
cp .env.example .env      # then add your AssemblyAI API key
npm start
```

Open http://localhost:3000 and click **Start Call**.

### Environment variables

- `ASSEMBLYAI_API_KEY` — your key from https://www.assemblyai.com/dashboard/api-keys
- `LLM_MODEL` (optional) — defaults to `qwen3.5-4b-32k-fast` (free tier). Set to a stronger model like `claude-sonnet-4-6` if your account has access.

## Tech

- Node.js + Express (serves the app, mints STT tokens, proxies LLM Gateway)
- Vanilla JS front-end (Web Audio API for 16 kHz PCM capture, Web Speech API for TTS)
- AssemblyAI Universal-Streaming STT + LLM Gateway

## Roadmap

- Real outbound phone calls via Twilio (8 kHz mu-law audio straight into AssemblyAI)
- Two-way natural voice via AssemblyAI's Voice Agent API
- Direct integration with Spparo's WhatsApp flow: trigger a voice call when a warm lead goes quiet, then push the result back into the CRM

## License

MIT — see [LICENSE](LICENSE).
