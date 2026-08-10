# drmorgan.ai

Ten hand-written pages, a store, and an editor laid over both.

The site is static and served from GitHub Pages at `drmorgan.ai`. Two other
things sit beside it and are deployed separately:

| | |
|---|---|
| `server/worker.js` | A Cloudflare Worker holding the Brevo and DeepSeek keys, for the contact form and the site assistant. Unchanged. |
| `functions/` | Firebase Cloud Functions: the site editor, and the store. New. |

---

## The editor — Wopara Opaline

Dr. Morgan edits the live site from inside it. There is no admin area, no
dashboard and no build step: he presses **Edit with Opaline** beside the Wopara
credit in the footer (or `Ctrl`/`Cmd` `+` `Shift` `+` `E`), types a password,
and dashed boxes appear around everything. What he changes is what a visitor
sees the moment he presses **Publish**.

**The pages themselves are never rewritten.** Every change is kept beside them
in one JSON document and laid over the markup on each visit. Delete that
document and the site renders exactly as it was written. That is what makes
undo possible at all — undoing is putting back an earlier version of one
document, not repairing a page.

### What is installed

```
assets/js/opaline-overlay.js   runs for every visitor; lays the overlay down
assets/js/opaline-editor.js    the workbench, fetched only after a password
assets/js/opaline.css          everything it looks like
assets/js/opaline.config.js    THE ONLY FILE THAT IS ABOUT THIS SITE
assets/img/wopara.png          the mark, for the bar and the password screen
functions/opaline.js           the server: the password, and the only writer
```

Two tags at the foot of every page, config first, engine second, both after
`site.js`. The editor and the stylesheet are fetched relative to wherever the
overlay was loaded from, so all four files must stay in `assets/js/` together.

### What is in the config, and why

- **`blocks`** — fourteen blocks written in this site's own classes, so what he
  adds is indistinguishable from what is already there. **None of them carries
  `data-reveal`**, or any of the classes `site.js` hands to its
  IntersectionObserver at load: that observer was built before the block
  existed, `[data-reveal]` starts at `opacity: 0`, and an unobserved one would
  stay invisible forever.
- **`screens`** — `980px` and `620px`, copied from `assets/css/site.css`. Get
  these wrong and "make this smaller on phones" writes a media query that
  disagrees with the one it is overriding.
- **`palette`** — the site's custom properties by name, not their resolved
  colours, because `:root[data-theme="dark"]` redefines every one of them. A
  colour chosen as `var(--blue)` follows the page into dark mode; the same
  colour chosen as `#2F5A8C` cannot.
- **`newPagePath: null`** — pages he creates would live at `/p/<name>` and need
  the host to route that path to one template. GitHub Pages has no rewrites, so
  page creation is hidden rather than offered and broken. If the site ever
  moves behind the Cloudflare Worker, add a route for `/p/*` and set this back
  to `"/p/"`.

### Where the password lives

`EDITOR_PASSWORD` in Secret Manager, and nowhere else — not in this repository
and not in any file here. Changing it ends every open editing session, because
a session token is signed with a key derived from the password itself.

---

## The store

`store.html` sells Dr. Morgan's written work. What is bought does not live on
this site: it opens in a Wopara Desktop on `wopara.com`, holding only what that
buyer paid for.

### The handshake

1. A buyer pays **here**, through Stripe Checkout. Dr. Morgan keeps the money;
   Wopara is not in the payment path.
2. The **webhook** (`storeWebhook`), not the thank-you page, calls
   `POST /port/license/grant`. This matters: a buyer who closes the tab on the
   redirect back would otherwise have paid and received nothing.
3. Wopara emails that address a private link.
4. Following it the first time, the email is shown **locked** — it is the
   address that paid — and the buyer chooses a password. There are no
   activation codes and nothing to copy out of an email.
5. They land in a full-screen Desktop on wopara.com. Returning means signing in
   there; a lost password resets from inside it; a lost email is recovered from
   the form on `store.html`, which calls `resend`.
6. A refund or chargeback fires `revoke` from the same webhook.

### The shelf and the till

**The words and the cover are markup**, written out in `store.html`, which is
what lets Opaline edit them. **The price is not.** It arrives from
`functions/store.js`, which is also what the card is charged against, so the
shop window and the till cannot drift apart. A browser is never asked what
something costs.

Adding a title later is three things:

1. Add the block **A title for sale** from inside the editor, and write its
   words and put its cover in.
2. Add a line to `PRODUCTS` in `functions/store.js` — the amount, and the
   licence name.
3. Create that licence in Port under **exactly** that name, naming the Desktop
   folder it opens.

Until 2 and 3 are done the new title shows *"This title is not on sale yet"*
under its button, which is the truth. A button that took money for something
nobody could be granted would not be.

---

## Still to do before either goes live

**1 · Billing.** `drmorgan-site` exists on Firebase but cannot be used: the
billing account is at its project limit, so no API can be enabled on it and
nothing can be deployed. Free a slot by unlinking a dormant project, or ask
Google for a quota increase.

**2 · Provision, once:**

```bash
gcloud services enable firestore.googleapis.com cloudscheduler.googleapis.com \
  secretmanager.googleapis.com --project drmorgan-site
gcloud firestore databases create --location=nam5 --project drmorgan-site

gcloud storage buckets create gs://drmorgan-site-media \
  --location=us-central1 --uniform-bucket-level-access
# read objects, but not list them
gcloud storage buckets add-iam-policy-binding gs://drmorgan-site-media \
  --member=allUsers --role=roles/storage.legacyObjectReader
```

**3 · The four secrets.** None of them belongs in this repository.

| Secret | From | Without it |
|---|---|---|
| `EDITOR_PASSWORD` | chosen | the editor answers "editing is not switched on for this site yet" |
| `WOPARA_KEY` | Port → Selling, `wpk_…`, shown once | the webhook returns 503 and Stripe keeps retrying until it is set — nobody is quietly left unserved |
| `STRIPE_SECRET_KEY` | Stripe dashboard | the Buy button says the shop is being switched on |
| `STRIPE_WEBHOOK_SECRET` | Stripe dashboard, `whsec_…` | the webhook refuses every request |

```bash
cd functions && npm install
firebase functions:secrets:set EDITOR_PASSWORD --project drmorgan-site
firebase functions:secrets:set WOPARA_KEY --project drmorgan-site
firebase functions:secrets:set STRIPE_SECRET_KEY --project drmorgan-site
firebase functions:secrets:set STRIPE_WEBHOOK_SECRET --project drmorgan-site
firebase deploy --only functions,firestore:rules --project drmorgan-site
```

**4 · Point Stripe at the webhook.** The deployed `storeWebhook` URL, subscribed
to `checkout.session.completed`, `charge.refunded` and `charge.dispute.created`.

**5 · Create the licence in Port.** In **Port → Embed**: the Desktop embed, one
licence named exactly `The LeadershipCodex`, then **Selling → Only what they
bought**, then mint the key.

**6 · Confirm the price.** `functions/store.js` carries **$39** as a
placeholder. Nothing should be sold until Dr. Morgan has said what it costs.

**7 · Confirm the book.** `store.html` describes *The LeadershipCodex™* and
ships a typographic placeholder cover at `assets/img/book-codex.svg`. Both the
words and the cover are editable from inside the site, so the real ones can go
in without touching this repository — but somebody has to put them in.

---

## Checking it

After deploying, in a private window: the site loads, the console is quiet,
there is no editor chrome, and nothing is slower. Then press the footer link,
sign in, change a heading, publish, and confirm a private window sees it.
