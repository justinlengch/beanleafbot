# Beanleaf Bot (Telegram → Google Sheets)

A minimal, production-oriented Telegram bot that logs coffee orders to Google Sheets. It’s webhook-based (no polling), append-only, and deploys cleanly on Vercel or any Node host.

Highlights:
- Inline keyboard menu.
- Append-only logs to a sheet named Orders via Google Sheets API v4.
- Idempotent handling of Telegram retries and double taps.
- Serverless-friendly with short timeouts and concise error handling.

---

## Features

- Commands:
  - /start or /menu → inline keyboard of drinks (2 per row)
  - /list → bullet list with prices, marks “(oat opt.)” when available
  - /undo → removes the last order from the Orders sheet (if any)
- Idempotency:
  - In-memory LRU for update_id to ignore retries
  - One-time guard per message to not re-show milk choices
- Errors:
  - Always returns 200 to Telegram to stop retries
  - Sends a fallback “⚠ couldn’t save, try again” message to the chat
  - Optional admin ping for critical errors

---

## Architecture

- Vercel Serverless Function: POST /api/bot (Node 18, TypeScript)
- Telegram Bot API via HTTPS (global fetch)
- Google Sheets API v4 via `googleapis` + `google-auth-library` with a service account (JWT)
- Menu is loaded once per deployment from a Google Sheets tab named "Menu" (columns: Name, Price, OatMilk). Falls back to the built-in static menu if absent or invalid
- Timeouts: Telegram ~6.5s, Sheets ~8s

---

## Repository layout

- /api/bot.ts — webhook handler (main entry)
- /lib/telegram.ts — thin Telegram client helpers
- /lib/sheets.ts — Google Sheets helpers (ensureSheet, appendOrder)
- /lib/menu.ts — DRINKS array + menu builders and helpers
- /lib/idempotency.ts — tiny in-memory LRU and once-guard

---

## Prerequisites

- Node.js 18+
- A Telegram bot token (create via @BotFather)
- A Google Cloud Service Account with the Google Sheets API enabled
- A Google Spreadsheet shared with your service account email

---

## Google Cloud setup (Service Account + Sheets)

1. Create or use an existing GCP project.
2. Enable the Google Sheets API:
   - APIs & Services → Enable APIs and Services → Search “Google Sheets API” → Enable
3. Create a Service Account:
   - IAM & Admin → Service Accounts → Create
   - Grant “Editor” role (or a minimal role that allows Sheets append via API)
4. Create a JSON key for the service account and note:
   - client_email (this is the service account email)
   - private_key
5. Share your target Spreadsheet with the service account email:
   - Open the spreadsheet in Google Sheets
   - Share → Add the service account’s client_email as Viewer/Editor (Editor recommended)
6. Copy the Spreadsheet ID:
   - From the URL: https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit

Important: Preserve newlines in the private key. On Vercel, you’ll typically store GOOGLE_PRIVATE_KEY with literal \n sequences. The code normalizes them at runtime.

---

## Environment variables

Set these in your environment (Vercel Project Settings → Environment Variables):

- BOT_TOKEN — Telegram bot token from @BotFather
- SHEET_ID — The spreadsheet ID (not the full URL)
- GOOGLE_SERVICE_ACCOUNT_EMAIL — The service account’s client_email
- GOOGLE_PRIVATE_KEY — The service account’s private key with literal \n newlines
- ADMIN_CHAT_ID — Optional. A Telegram chat ID for admin pings

Example .env (local):
```
BOT_TOKEN=123456:ABC-DEF...yourtoken
SHEET_ID=1x2y3z...spreadsheetid
GOOGLE_SERVICE_ACCOUNT_EMAIL=your-svc@your-project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nMIIEvAIBADANBgkqhkiG9w0B...\n-----END PRIVATE KEY-----\n
ADMIN_CHAT_ID=123456789
```
Note:
- Remove the outer surrounding quotes (") for GOOGLE_PRIVATE_KEY on Vercel and ignore the warning about unsafe characters. The '\n' will be converted to real newlines in code.

---

## Install dependencies

This project uses only two runtime dependencies:

- googleapis
- google-auth-library

If you’re working locally:
- Initialize: npm init -y
- Install: npm i -E googleapis google-auth-library
- (Optional) TypeScript tooling if you plan to develop locally: npm i -D typescript @types/node

Vercel will install dependencies automatically on deploy.

---

## Deploy to Vercel

Option A: Vercel dashboard
1. Create a new project and import this repository.
2. Set the environment variables listed above.
3. Deploy.

Option B: Vercel CLI
1. npm i -g vercel
2. vercel
3. vercel env add BOT_TOKEN ...
4. vercel env add SHEET_ID ...
5. vercel env add GOOGLE_SERVICE_ACCOUNT_EMAIL ...
6. vercel env add GOOGLE_PRIVATE_KEY ...
7. vercel env add ADMIN_CHAT_ID (optional)
8. vercel --prod

---

## Set Telegram webhook

After deploying, set the webhook to your deployment’s URL:
```
curl -X POST "https://api.telegram.org/bot$BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://<your-app>.vercel.app/api/bot"}'
```

Verify:
```
curl "https://api.telegram.org/bot$BOT_TOKEN/getWebhookInfo"
```

To remove the webhook:
```
curl "https://api.telegram.org/bot$BOT_TOKEN/deleteWebhook?drop_pending_updates=true"
```

---

## Usage

- /start or /menu:
  - Displays an inline keyboard of drinks (2 per row)
  - Label format: Name ($X.XX), adds a “⋆” for oat-eligible items
- /list:
  - Sends a bullet list of all drinks with prices, marking (oat opt.) where applicable
- /undo:
  - Removes the last order from the Orders sheet (if any)
  - Sends a confirmation or “No orders to undo” message

- Tapping a non-oat drink:
  - Appends a row in the Orders sheet
  - Edits the message text to “Saved: … — $X.XX” and removes the buttons
- Tapping an oat-eligible drink:
  - Edits the same message’s keyboard to show two options:
    - Dairy Milk
    - Oat Milk
- Choosing either oat option:
  - Appends a row
  - Edits the message text to “Saved: … — $X.XX” and removes the buttons

---

## Local development

Telegram requires a reachable HTTPS webhook. Options:
- Deploy to Vercel and test against the production URL (recommended).
- Use a tunnel (e.g., ngrok) to expose your local server and set the webhook to that public URL.

If you run locally:
- Ensure Node 18+ (global fetch available).
- Create a minimal dev server that routes POST /api/bot to the handler.
- Set the webhook to your tunnel URL:
```
curl -X POST "https://api.telegram.org/bot$BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://<your-ngrok-subdomain>.ngrok.io/api/bot"}'
```
