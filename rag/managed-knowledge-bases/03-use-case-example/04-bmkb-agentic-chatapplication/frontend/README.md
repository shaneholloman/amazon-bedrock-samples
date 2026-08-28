# frontend/

React 18 + Vite + TypeScript + Tailwind single-page application.

## Features

- Cognito hosted-UI sign-in (OAuth 2.0 Authorization Code + PKCE)
- Drag-and-drop multi-file uploader with live size-routing hints
- Document list with real-time status polling
- Streaming chat panel with collapsible citations
- Dark/light theme toggle

## Runtime config

The deployed bundle is environment-agnostic. At startup it fetches `/config.json` (written by `cdk deploy` from stack outputs). Nothing is baked into the JavaScript at build time.

## Local development

```bash
cp ../.env.example ../.env   # fill in VITE_* values
npm run dev                  # starts Vite dev server
```
