/* =====================================================================
   drmorgan.ai — the store
   ---------------------------------------------------------------------
   What is sold here does not live on this site. It lives in a Wopara
   Desktop on wopara.com, and Wopara is told who may open it through the
   Port API. This file holds the only moments that conversation happens:

     grant    from the PAYMENT WEBHOOK, once Stripe's signature is
              verified. Never from the thank-you page: a buyer who closes
              the tab on the redirect back would have paid and received
              nothing.
     resend   from the store page, when a buyer has lost the email.
     revoke   from the webhook again, on a refund or a chargeback.

   Three things live here that cannot live in a browser: the price, the
   Stripe key, and the authority to grant access. The page in front of the
   buyer is a shop window; this is the till.

   Firestore
     stripeEvents/<eventId>   one claim per Stripe event, so a redelivery
                              cannot mint a second link

   ===================================================================== */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const crypto = require("crypto");
const admin = require("firebase-admin");

const WOPARA_KEY = defineSecret("WOPARA_KEY");
const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");

const WOPARA_BASE = "https://wopara-token-service-296282827554.us-central1.run.app";
const REPLY_TO = "drmorgan@drmorgan.ai";

const ORIGINS = [
  "https://drmorgan.ai",
  "https://www.drmorgan.ai"
];


/* ---------------------------------------------------------------------
   The catalog. THIS is what a card is charged against.
   ---------------------------------------------------------------------
   The store page carries the words and the cover, because those are his
   to edit from inside the site. It does not carry the price: the page
   asks for it, and gets it from here, so the shelf and the till cannot
   drift apart. A browser is never asked what something costs.

   Adding a title is two lines and one trip to Port:
     1. add it here, with the amount in the smallest currency unit
     2. create a licence in Port under exactly the name in `licence`,
        naming the Desktop folder it opens
   Port treats an unknown licence name as an error rather than a silent
   no-op, which is what we want: a buyer paying for something nobody
   recognises should fail loudly at our end, not quietly at theirs.
   --------------------------------------------------------------------- */

const PRODUCTS = {
  "leadership-codex": {
    /* PLACEHOLDER PRICE — confirm with Dr. Morgan before this goes live.
       39 US dollars, in cents, as Stripe counts them. */
    amount: 3900,
    currency: "usd",
    title: "The LeadershipCodex",
    description: "Leadership Intelligence, Leadership Systems, Leadership Futures — the framework in full.",
    licence: "The LeadershipCodex"
  }
};


/* --------------------------------------------------------------- plumbing */

function ensureAdmin() {
  if (!admin.apps.length) admin.initializeApp();
}

function db() {
  ensureAdmin();
  return admin.firestore();
}

function isLocal(origin) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || "");
}

function originAllowed(origin) {
  if (!origin) return false;
  return isLocal(origin) || ORIGINS.indexOf(origin) !== -1;
}

/* Per-instance and therefore approximate, which is the right trade here:
   it costs nothing, and the things it guards are already safe — the worst
   a determined caller achieves is mail to an address that already owns
   what the mail is about. */
const recent = new Map();

function tooOften(key, limit, windowMs) {
  const now = Date.now();
  const hits = (recent.get(key) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  recent.set(key, hits);
  if (recent.size > 5000) recent.clear();
  return hits.length > limit;
}

/* The Wopara key is minted once in Port and shown once. Until it is set,
   every path here fails closed and says so, rather than half working. */
function keyReady(key) {
  return typeof key === "string" && key.indexOf("wpk_") === 0 && key.length > 12;
}

async function wopara(path, body, key) {
  if (!keyReady(key)) {
    const e = new Error("Wopara key is not configured yet.");
    e.notConfigured = true;
    throw e;
  }
  const r = await fetch(WOPARA_BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Wopara-Key": key },
    body: JSON.stringify(body)
  });
  let data = {};
  try { data = await r.json(); } catch (e) { /* non-JSON error body */ }
  if (!r.ok) {
    const e = new Error(data.detail || ("Wopara " + path + " failed (" + r.status + ")"));
    e.status = r.status;
    throw e;
  }
  return data;
}

/* Stripe's API takes form encoding, including for nested fields. One
   helper rather than the whole SDK, which would be four megabytes of
   dependency for two calls. */
function formEncode(obj, prefix, out) {
  out = out || [];
  Object.keys(obj).forEach((k) => {
    const v = obj[k];
    const key = prefix ? prefix + "[" + k + "]" : k;
    if (v === undefined || v === null) return;
    if (typeof v === "object") formEncode(v, key, out);
    else out.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(v)));
  });
  return out;
}

async function stripe(path, params, key) {
  const r = await fetch("https://api.stripe.com/v1" + path, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + key,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: formEncode(params).join("&")
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error((data.error && data.error.message) || ("Stripe " + path + " failed (" + r.status + ")"));
    e.status = r.status;
    throw e;
  }
  return data;
}


/* =====================================================================
   The shop front: catalog, checkout, resend.
   ===================================================================== */

exports.store = onRequest(
  {
    secrets: [WOPARA_KEY, STRIPE_SECRET_KEY],
    region: "us-central1",
    cors: false,
    maxInstances: 10,
    timeoutSeconds: 30
  },
  async (req, res) => {
    const origin = req.headers.origin || "";
    const allowed = originAllowed(origin);

    if (allowed) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Vary", "Origin");
      res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.set("Access-Control-Allow-Headers", "Content-Type");
      res.set("Access-Control-Max-Age", "3600");
    }
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (!allowed) { res.status(403).json({ error: "Not allowed from here." }); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

    const body = req.body || {};
    const action = String(body.action || "");
    const ip = req.headers["x-forwarded-for"] || req.ip || "unknown";

    try {
      /* ---- catalog: what is for sale and what it costs. Public, because
         it is a shop window, and it carries nothing a shop window does
         not. ---- */
      if (action === "catalog") {
        res.status(200).json({
          ok: true,
          products: Object.keys(PRODUCTS).map((id) => ({
            id: id,
            title: PRODUCTS[id].title,
            amount: PRODUCTS[id].amount,
            currency: PRODUCTS[id].currency
          }))
        });
        return;
      }

      /* ---- checkout: a Stripe session for one title. The browser sends an
         id and nothing else; the price comes from the list above, so a
         doctored request buys nothing at a price of its own choosing. ---- */
      if (action === "checkout") {
        const id = String(body.productId || "");
        const item = PRODUCTS[id];
        if (!item) { res.status(404).json({ error: "That title is not on sale." }); return; }

        const key = STRIPE_SECRET_KEY.value();
        /* Deploying requires every declared secret to hold something, so
           until Stripe is wired this carries a placeholder. A placeholder
           should produce "the shop is not switched on", not a 502 from
           Stripe having been handed nonsense. Real keys begin sk_. */
        if (!key || key.indexOf("sk_") !== 0) {
          logger.error("checkout attempted with no Stripe key set");
          res.status(503).json({ error: "The shop is not switched on yet. Please email drmorgan@drmorgan.ai." });
          return;
        }
        if (tooOften("co:" + ip, 20, 10 * 60 * 1000)) {
          res.status(429).json({ error: "That is a lot of attempts. Please wait a few minutes." });
          return;
        }

        /* Only ever back to a page of this site's own, whatever the caller
           asked for. An open redirect on a payment flow is how a buyer is
           landed somewhere that asks them to "confirm" their card. */
        let home = ORIGINS[0] + "/store.html";
        try {
          const asked = new URL(String(body.returnTo || ""));
          if (ORIGINS.indexOf(asked.origin) !== -1) home = asked.origin + asked.pathname;
        } catch (e) { /* not a URL at all; the default stands */ }

        const session = await stripe("/checkout/sessions", {
          mode: "payment",
          success_url: home + "?bought=1",
          cancel_url: home + "?cancelled=1",
          /* Stripe collects the address, and the address that pays is the
             address that is granted. Any other pairing is one a buyer can
             get wrong. */
          customer_creation: "always",
          metadata: { productId: id },
          /* Read on the completed event; session metadata does not travel
             onto the payment intent by itself. */
          payment_intent_data: { metadata: { productId: id } },
          line_items: {
            0: {
              quantity: 1,
              price_data: {
                currency: item.currency,
                unit_amount: item.amount,
                product_data: { name: item.title, description: item.description }
              }
            }
          }
        }, key);

        res.status(200).json({ ok: true, url: session.url });
        return;
      }

      /* ---- resend: open to anyone, and safe, because the only thing it
         produces is mail to the address that already owns the licence. The
         reply says nothing about whether that address holds anything, so
         it cannot be used to test who has bought what. ---- */
      if (action === "resend") {
        const email = String(body.email || "").trim().toLowerCase();
        if (!email || email.indexOf("@") < 1 || email.length > 254) {
          res.status(400).json({ error: "A valid email address is required." }); return;
        }
        if (tooOften("e:" + email, 3, 15 * 60 * 1000) || tooOften("i:" + ip, 12, 15 * 60 * 1000)) {
          res.status(429).json({ error: "That has been requested a few times already. Please give it a few minutes." });
          return;
        }

        const key = WOPARA_KEY.value();
        if (!keyReady(key)) { res.status(200).json({ ok: true, pending: true }); return; }

        /* Wopara answers 404 for an address it does not know and 200 for
           one it does, so the difference has to be hidden here, and not
           only in the words. A reply that came back faster for strangers
           than for buyers would answer the question just as well as saying
           so. Every reply is held to the same floor, comfortably above a
           normal round trip, whichever way it went. */
        const startedAt = Date.now();
        await wopara("/port/license/resend", { email: email, replyTo: REPLY_TO }, key)
          .catch((err) => {
            logger.info("resend declined", { message: err.message });
          });
        const floor = 900 - (Date.now() - startedAt);
        if (floor > 0) await new Promise((r) => setTimeout(r, floor));

        res.status(200).json({ ok: true, sent: true });
        return;
      }

      res.status(400).json({ error: "Unknown action" });
    } catch (err) {
      if (err.notConfigured) { res.status(200).json({ ok: true, pending: true }); return; }
      logger.error("store failure", { action: action, message: err.message });
      res.status(502).json({ error: "That could not be completed just now." });
    }
  }
);


/* =====================================================================
   The webhook. Fails closed: with no signing secret it refuses
   everything, because an unauthenticated endpoint that mints access is
   worse than no endpoint at all.
   ===================================================================== */

/* Stripe signs the raw body. Verified by hand rather than pulling in the
   whole SDK for one HMAC, and compared in constant time. */
function stripeSignatureValid(rawBody, header, secret) {
  if (!rawBody || !header || !secret) return false;
  const parts = {};
  header.split(",").forEach((kv) => {
    const i = kv.indexOf("=");
    if (i > 0) parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  });
  if (!parts.t || !parts.v1) return false;

  /* Reject anything older than five minutes, so a captured request cannot
     be replayed later. */
  const age = Math.abs(Date.now() / 1000 - Number(parts.t));
  if (!isFinite(age) || age > 300) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(parts.t + "." + rawBody.toString("utf8"), "utf8")
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(parts.v1, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* One Stripe event, granted once. Firestore rather than memory, because a
   duplicate can arrive hours later and on a different instance: an
   in-memory set would let every cold start through.

   `create` fails if the document exists, which makes the check and the
   claim a single atomic step, so two deliveries racing cannot both win. */
async function claimEvent(eventId) {
  if (!eventId) return false;
  try {
    await db().collection("stripeEvents").doc(eventId).create({
      at: admin.firestore.FieldValue.serverTimestamp()
    });
    return true;
  } catch (err) {
    if (err && (err.code === 6 || err.code === "already-exists")) return false;
    /* Firestore being unreachable must not quietly disable the guard, so
       the webhook fails and Stripe retries rather than double-granting. */
    throw err;
  }
}

/* Released when the grant did not happen, so Stripe's retry is a real
   retry rather than a no-op. The trade-off is a request that died after
   Wopara had already acted: that retry sends a second email and retires
   the first link. It is the lesser failure — an unexpected second email is
   a confusion, a buyer with nothing is a refund. */
async function releaseEvent(eventId) {
  if (!eventId) return;
  try {
    await db().collection("stripeEvents").doc(eventId).delete();
  } catch (err) {
    logger.error("Could not release a webhook claim; retries will be skipped", {
      id: eventId, message: err.message
    });
  }
}

function productsFor(productId) {
  const item = PRODUCTS[productId];
  if (!item) throw new Error("Unknown product id: " + productId);
  return [item.licence];
}

exports.storeWebhook = onRequest(
  {
    secrets: [WOPARA_KEY, STRIPE_WEBHOOK_SECRET],
    region: "us-central1",
    cors: false,
    maxInstances: 5,
    timeoutSeconds: 60
  },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).send("Method not allowed"); return; }

    const signingSecret = STRIPE_WEBHOOK_SECRET.value();
    if (!signingSecret || signingSecret.indexOf("whsec_") !== 0) {
      logger.error("storeWebhook called with no signing secret configured");
      res.status(503).send("Webhook not configured");
      return;
    }
    if (!stripeSignatureValid(req.rawBody, req.headers["stripe-signature"], signingSecret)) {
      logger.warn("storeWebhook rejected an unsigned or stale request");
      res.status(400).send("Bad signature");
      return;
    }

    let event;
    try { event = JSON.parse(req.rawBody.toString("utf8")); }
    catch (e) { res.status(400).send("Bad body"); return; }

    const object = (event.data && event.data.object) || {};
    const email =
      (object.customer_details && object.customer_details.email) ||
      object.customer_email ||
      (object.billing_details && object.billing_details.email) ||
      (object.receipt_email) || "";
    const productId = (object.metadata && object.metadata.productId) || "";
    const orderRef = object.id || event.id;

    try {
      if (event.type === "checkout.session.completed") {
        if (!email) throw new Error("No buyer email on " + event.type);

        /* grant is NOT idempotent: every call mints a new link, retires the
           previous one and sends another email. Stripe retries, and
           delivers more than once by design, so without this a buyer gets a
           second email and the link in the first one — which they have very
           likely already clicked — stops working.

           Claimed before the call so two deliveries racing cannot both
           send, and released again if the call failed, so a retry is a real
           retry. */
        if (!(await claimEvent(event.id))) {
          logger.info("Webhook replay ignored", { id: event.id, type: event.type });
          res.status(200).send("duplicate");
          return;
        }

        let out;
        try {
          out = await wopara("/port/license/grant", {
            email: email,
            products: productsFor(productId),
            orderRef: orderRef,
            replyTo: REPLY_TO,
            send: true
          }, WOPARA_KEY.value());
        } catch (err) {
          await releaseEvent(event.id);
          throw err;
        }

        /* Never log `out`. Its 200 body carries "link", and that token alone
           lets anyone set the password on this buyer's Wopara account. The
           status code and a boolean are all that may be recorded. */
        logger.info("Granted Wopara access", { email: email, orderRef: orderRef, emailed: out.emailed === true });

      } else if (
        event.type === "charge.refunded" ||
        event.type === "charge.dispute.created"
      ) {
        if (!email) throw new Error("No buyer email on " + event.type);

        /* A full revocation sends no products field at all. Wopara
           validates any names it is given against the embed, so naming them
           would make a refund fail with a 400 the day a licence is renamed
           or retired on the Wopara side — which is the worst possible day
           for it to fail. Omitting them revokes the whole purchase and
           cannot go stale. */
        await wopara("/port/license/revoke", { email: email, orderRef: orderRef }, WOPARA_KEY.value());
        logger.info("Revoked Wopara access", { email: email, orderRef: orderRef });

      } else {
        logger.info("Webhook ignored", { type: event.type });
      }

      res.status(200).send("ok");
    } catch (err) {
      if (err.notConfigured) {
        /* No Wopara key yet. Answering 200 would tell Stripe this was
           handled and the buyer would never be granted; a 503 keeps the
           event in Stripe's retry queue until the key is set. */
        logger.error("Webhook could not grant: Wopara key not configured", { orderRef: orderRef });
        res.status(503).send("Not configured");
        return;
      }
      logger.error("Webhook failure", { type: event && event.type, message: err.message });
      res.status(500).send("Failed");
    }
  }
);
