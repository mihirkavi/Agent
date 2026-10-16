# Agent — Voice Operator

<p><img src="assets/brand/logo.png" alt="Voice Operator logo" width="96" height="96"></p>

A voice-first task agent web app built with the OpenAI Realtime API, the OpenAI Agents SDK, and a background task worker for research and browser automation.

## What it does

- Runs a live browser voice session on `gpt-realtime`
- Delegates long-running tasks to a backend worker using `gpt-5.4` / `gpt-5.4-pro`
- Classifies requests dynamically into research or browser-automation flows
- Pauses only when blocked by missing information or sensitive approvals
- Persists task state, progress, approvals, and results locally in `.data/tasks.json`

## Quick start

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env` and set `OPENAI_API_KEY`.
3. Install the browser used for automation: `npx playwright install chromium`.
4. Start the app: `npm run dev`.

The frontend runs on `http://localhost:3000` and proxies API requests to the backend on `http://localhost:8787`.

## Tech stack

- **Frontend:** React 19, Vite, TypeScript, `@openai/agents/realtime` (`RealtimeAgent` / `RealtimeSession`)
- **Backend:** Node.js, Express 5, `@openai/agents` (agents with web search and browser tools), `openai`, Zod
- **Browser automation:** Playwright (Chromium)

## Project structure

```text
src/                  React client
  App.tsx             UI for the voice session and task list
  hooks/useVoiceOperator.ts  Realtime voice session and client-side tools
  lib/api.ts          Calls to the backend API
server/               Express backend
  index.ts            API routes
  task-runner.ts      Background task worker (research and browser-automation agents)
  browser-controller.ts  Playwright browser wrapper
  task-store.ts       JSON file persistence in .data/
  config.ts           Environment configuration
  openai.ts           OpenAI client helpers
shared/types.ts       Types shared by client and server
```

## Configuration

Copy `.env.example` to `.env`. Variables read by `server/config.ts`:

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | Required for voice sessions and tasks |
| `OPENAI_REALTIME_MODEL` | Voice model (default `gpt-realtime`) |
| `OPENAI_TASK_MODEL` / `OPENAI_FAST_MODEL` | Models used by the task worker |
| `PORT` | Backend port (default `8787`) |
| `CLIENT_ORIGIN` | Allowed frontend origin (default `http://localhost:3000`) |
| `BROWSER_HEADLESS` | Set to `false` to watch the automated browser |
| `DISABLE_BROWSER_AUTOMATION` | Set to `true` to turn off browser tasks |
| `ALLOWED_AUTOMATION_DOMAINS` | Comma-separated hostnames that can be automated without per-task approval |

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Run the Vite client and the backend (`tsx watch`) together |
| `npm run build` | Build the client and compile the server to `dist/` |
| `npm start` | Run the compiled server |
| `npm run typecheck` | Type-check client and server |

## API

The backend exposes `GET /api/health`, `GET /api/tasks`, `GET /api/tasks/:taskId`, `POST /api/tasks`, `POST /api/tasks/:taskId/input`, `POST /api/tasks/:taskId/approve`, and `POST /api/realtime/client-secret` (issues an ephemeral key for the browser voice session).

## Status and limitations

This is a local development prototype. Voice, research, and automated browsing require configured OpenAI access and may incur API charges. Task state is stored on the host filesystem; this repository does not establish a production hosting or multi-user isolation setup.

## License

No license file is included in this repository. This README grants no additional reuse or redistribution permissions; contact the repository owner about permitted use.

<!-- project-artwork:start -->
## Project artwork

![Conceptual artwork for Voice Operator](assets/brand/cover.png)

Conceptual project artwork. [Asset files, design notes, and generation prompts](assets/brand/README.md).
<!-- project-artwork:end -->
