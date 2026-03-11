# Voice Operator

A voice-first task agent web app built with the OpenAI Realtime API, the OpenAI Agents SDK, and a background task worker for research and browser automation.

## What it does

- Runs a live browser voice session on `gpt-realtime`
- Delegates long-running tasks to a backend worker using `gpt-5.4` / `gpt-5.4-pro`
- Classifies requests dynamically into research or browser-automation flows
- Pauses only when blocked by missing information or sensitive approvals
- Persists task state, progress, approvals, and results locally in `.data/tasks.json`

## Quick start

1. Copy `.env.example` to `.env`
2. Set `OPENAI_API_KEY`
3. Install Playwright Chromium if needed: `npx playwright install chromium`
4. Start the app: `npm run dev`

The frontend runs on `http://localhost:3000` and proxies API requests to the backend on `http://localhost:8787`.
