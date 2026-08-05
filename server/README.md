# drmorgan.ai edge proxy

Holds the API keys that must never appear in the browser. Deploy once, and both
the contact form and the site assistant become live.

## Why this exists

`assets/js/site.js` is downloadable by every visitor. An API key placed there is
public. This Worker keeps the keys server-side and exposes only two narrow routes.

## Deploy (Cloudflare Workers — free tier is ample)

1. dash.cloudflare.com → **Workers & Pages** → **Create** → **Worker** → name it `drmorgan-api`
2. **Edit code**, paste `worker.js`, **Deploy**
3. **Settings → Variables and Secrets** → add two **Secrets**:
   - `BREVO_API_KEY` — Brevo → *SMTP & API* → *API Keys* → Generate
   - `DEEPSEEK_API_KEY` — platform.deepseek.com → *API Keys*
4. Copy the Worker URL, e.g. `https://drmorgan-api.<subdomain>.workers.dev`
5. In `assets/js/site.js` set:

   ```js
   var API_BASE = "https://drmorgan-api.<subdomain>.workers.dev";
   ```

## Brevo sender verification

`SENDER.email` in `worker.js` must be a sender Brevo has verified
(Brevo → *Senders, Domains & Dedicated IPs*). Verifying the whole `drmorgan.ai`
domain is best — it adds SPF/DKIM so replies land in the inbox, not spam.

Note this uses **Transactional email**, not *Marketing → Forms*. Sign-up forms
subscribe people to a list; they do not deliver the enquiry to an inbox.

## Routes

| Route | Purpose |
|---|---|
| `POST /inquiry` | Emails the engage form to `drmorgan@drmorgan.ai`, `Reply-To` set to the enquirer |
| `POST /ask` | DeepSeek answer grounded only in the site sections the page supplies |

Both validate origin, reject oversized input, and honour the form honeypot.

## If either key is absent

The site degrades on its own: the form falls back to a composed `mailto:` draft,
and the assistant falls back to local retrieval. Nothing breaks.
