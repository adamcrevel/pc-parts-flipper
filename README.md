# pc-parts-flipper

Local tool for managing a side hustle: sourcing used pre-built computers,
disassembling them, and reselling the individual parts for profit. Tracks
Sources (eBay, Mercari, Facebook Marketplace) → Listings → Purchases →
Teardowns → Parts → Sale Listings, with AI-assisted part identification and
pricing along the way.

It's a local-only app: a Fastify API backed by an embedded DuckDB file, and a
React (Vite) frontend. Nothing runs in the cloud; everything lives on your own
machine under `data/`.

## Prerequisites

- **Node.js 22+** (pinned in `.nvmrc`). If you use [nvm](https://github.com/nvm-sh/nvm):
  ```
  nvm install
  nvm use
  ```
- **npm** (ships with Node).
- **Chromium, for the Mercari/Facebook Marketplace scan connectors** (one-time,
  after `npm install`):
  ```
  npx playwright install chromium
  ```
  Not needed if you only plan to use eBay as a Source.

## Setup

```
git clone <this repo>
cd pc-parts-flipper
npm install
```

Then copy the two env-example files and fill in whatever you plan to use —
every value is optional, and the app runs fine with both files left blank:

```
cp apps/server/.env.example apps/server/.env
cp apps/web/.env.example apps/web/.env
```

- `apps/server/.env` — eBay API credentials (only needed to scan eBay as a
  Source), AI part-identification settings (only needed for the "Identify
  Parts" button), and notes on Mercari/Facebook Marketplace setup. See the
  comments in `apps/server/.env.example` for details — Mercari needs no setup
  at all; Facebook Marketplace needs one interactive login run first (see
  below).
- `apps/web/.env` — only needed if the API isn't running on the default
  `http://localhost:3001` (e.g. you changed `PORT` because something else was
  already using 3001).

### Facebook Marketplace (optional)

If you want to scan Facebook Marketplace, run this once against a **dedicated
secondary Facebook account** (never your personal one — the connector keeps
this account logged in persistently to scan on your behalf):

```
npm run login-facebook-marketplace -w @pc-parts-flipper/server
```

This opens a real, visible browser window — log in (and solve any 2FA/
checkpoint) by hand, then the session is saved locally to
`apps/server/data/facebook-marketplace-session.json` (gitignored, never
committed). No password is ever stored.

## Running it

```
npm run dev
```

This builds the shared package once, then starts both apps together:

- API: `http://localhost:3001`
- Web app: `http://localhost:5173` ← open this one in your browser

First boot creates a local DuckDB file under `data/` and runs migrations
automatically — nothing else to set up.

If port 3001 is already taken by something else on your machine, set `PORT` in
`apps/server/.env` (and point `apps/web/.env`'s `VITE_API_BASE_URL` at the same
port) before running `npm run dev`.

## Other useful commands

```
npm run build       # production build, all workspaces
npm test            # full test suite, all workspaces
npm run lint         # eslint, all workspaces
npm run typecheck   # apps/server's TypeScript project
npm run format       # prettier --write .
```

## Project layout

- `apps/server` — Fastify + DuckDB backend. Marketplace scan connectors live
  under `src/connectors/`.
- `apps/web` — React + Vite frontend.
- `packages/shared` — domain types shared between both.
- `.claude/feature/` — active and past feature plans, built via this
  repo's `/feature` workflow (goal, requirements, task history, retrospective
  per feature).
