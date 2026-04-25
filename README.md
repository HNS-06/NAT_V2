# NAT Adaptive AI Assistant

Single-service React + Express app with:

- Vite frontend
- Express API server
- Socket.IO realtime layer
- Multi-provider AI backend
- Current production providers: `groq`, `gemini`

## Local Run

Prerequisites:

- Node.js 20+

Commands:

```bash
npm install
npm run dev
```

App URL:

- `http://localhost:3000` by default

## Environment Variables

Copy `.env.example` into `.env` and set the values you need.

Required for AI:

- `GROQ_API_KEY`
- `GEMINI_API_KEY`

Recommended:

- `AI_PROVIDER=auto`
- `AI_FALLBACK_ORDER=groq,gemini`

## Production Build

```bash
npm run build
npm start
```

The server serves `dist/` automatically when `NODE_ENV=production`.

## Render Deployment

This repo includes `render.yaml` for a Render web service deployment.

Manual Render settings:

- Runtime: `Node`
- Build Command: `npm install && npm run build`
- Start Command: `npm start`
- Health Check Path: `/api/health`

Environment variables to set in Render:

- `AI_PROVIDER=auto`
- `AI_FALLBACK_ORDER=groq,gemini`
- `GROQ_API_KEY`
- `GEMINI_API_KEY`

Notes:

- Render provides `NODE_ENV=production` at runtime for Node services.
- Render web services support WebSockets, which fits this app's Socket.IO server.
