# EHRLens — AI Clinical Navigator

> Point your camera at any EHR screen. Ask anything. Get instant AI-powered help.

Built for physicians navigating Epic, Cerner, and any complex medical software — without App Stores, without hospital IT approval, without installation.

---

## 🗂️ Structure

```
EHRLens/
├── index.html        # PWA shell (5-screen app)
├── styles.css        # Dark medical design system
├── app.js            # All app logic (vanilla JS, zero framework)
├── sw.js             # Service Worker — offline shell caching
├── manifest.json     # PWA manifest — installable on iPhone home screen
├── icons/
│   ├── icon-192.png
│   └── icon-512.png
└── worker/
    ├── index.js      # Cloudflare Worker — Gemini API proxy
    └── wrangler.toml # Worker deployment config
```

---

## 🚀 Deployment

### 1 — Deploy the Cloudflare Worker (backend)

```bash
cd worker
npm install -g wrangler
wrangler login
wrangler kv:namespace create "RATE_LIMIT"  # paste id into wrangler.toml
wrangler secret put GEMINI_API_KEY          # paste your Gemini key when prompted
wrangler deploy                             # note your worker URL
```

### 2 — Update Worker URL in app.js

```js
// app.js line ~12
WORKER_URL: 'https://ehrlens-api.YOUR_SUBDOMAIN.workers.dev',
```

### 3 — Deploy Frontend to Cloudflare Pages

Connect this GitHub repo to Cloudflare Pages:
- Root directory: `/` (repo root)
- Build command: *(none — static)*
- Output directory: *(empty)*

### 4 — iPhone Install

1. Open the Pages URL in **Safari**
2. Tap Share → **Add to Home Screen**
3. Done — standalone app, no App Store

---

## 🔑 Secrets

| Variable | Where | Value |
|---|---|---|
| `GEMINI_API_KEY` | Cloudflare Worker Secret | Google Gemini API key |
| `RATE_LIMIT` | Cloudflare KV Namespace | Rate limiting store |

---

## 🔒 PHI / HIPAA

Zero storage. Images processed ephemerally. No patient identifiers transmitted.
V1 is designed for non-PHI screens (navigation, workflows, empty forms, alerts).

---

© 2026 A. Alex Mohit · EHRLens
