/* =====================================================================
   Wopara Opaline — the server
   ---------------------------------------------------------------------
   One function, two ways of running it.

   SELF-HOSTED   One site, its own Firebase project, its own password.
                 Set SITES to null and it behaves exactly as it does on
                 the sites Wopara builds.

   HOSTED        Many sites, one Wopara project. Every request names a
                 site; the site's registered origins are what say whether
                 the caller may speak for it, and its own password is
                 what says whether the caller may change it. This is what
                 the embed snippet talks to, and what Port sells.

   Three things live here that cannot live in a browser: the password,
   the authority to write, and the AI key. Everything else the browser
   does for itself.

   Firestore
     sites/<id>                    { name, origins[], passwordHash,
                                     reserves, createdAt, plan }
     sites/<id>/state/overlay      { json, updatedAt, savedHash }
     sites/<id>/saves/<saveId>     { name, at, json, hash, auto }

   The overlay is stored as a JSON string rather than a nested object,
   because Firestore refuses arrays inside arrays and the overlay is full
   of them. It costs one parse and buys the freedom to shape the document
   however the editor needs it.
   ===================================================================== */

const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const crypto = require("crypto");
const admin = require("firebase-admin");

const DEEPSEEK_API_KEY = defineSecret("DEEPSEEK_API_KEY");
const EDITOR_PASSWORD = defineSecret("EDITOR_PASSWORD");

/* Wopara's own service key, used for one thing: posting an invitation or a
   password code through Wopara's mail service. Deploying requires every
   declared secret to hold something, so a self-hosted site that is not
   buying mail from us still has to put a value here — and with a
   placeholder in it, invitations are shown on screen to be read out and a
   forgotten password is answered with support@wopara.com, which is a
   working install rather than a broken one.

     firebase functions:secrets:set WOPARA_KEY                          */
const WOPARA_KEY = defineSecret("WOPARA_KEY");

/* Self-hosted: the domains this one site is served from, and null below.
   Hosted: leave ORIGINS empty — each site brings its own. */
const ORIGINS = [
  "https://drmorgan.ai",
  "https://www.drmorgan.ai"
];

/* Set to "hosted" to run one function for many sites. */
const MODE = "self";

/* Self-hosted: where a password code goes while the site is still on one
   nameless password. It is the site's own contact address, and it is set
   here rather than read off the page because a destination a browser can
   choose is a way to have somebody else's reset posted to yourself. Leave
   it empty and a forgotten password is answered with support@wopara.com.
   Hosted, the address registered in Port is used instead. */
const CONTACT_EMAIL = "drmorgan@drmorgan.ai";

const MEDIA_BUCKET = "drmorgan-site-media";

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

/* Who is allowed to speak for this site. Self-hosted, that is the list
   above. Hosted, it is the domains registered when Opaline was bought —
   which is what stops somebody pasting another customer's site id into
   their own page and editing a site they do not own. */
async function siteFor(req) {
  if (MODE !== "hosted") {
    return { id: "self", origins: ORIGINS, doc: null };
  }
  const id = String(req.query.site || (req.body && req.body.site) || "").slice(0, 64);
  if (!/^[a-z0-9-]{6,64}$/.test(id)) return null;

  const snap = await db().collection("sites").doc(id).get();
  if (!snap.exists) return null;
  const d = snap.data() || {};
  if (d.suspended) return null;
  return { id: id, origins: d.origins || [], doc: d };
}

function originAllowed(site, origin) {
  if (!origin) return false;
  if (isLocal(origin)) return true;          // a developer's own machine, never a stranger's
  return (site.origins || []).indexOf(origin) !== -1;
}


/* How often one caller has done a thing lately.

   Per-instance and therefore approximate, which is the right trade: it
   costs nothing, and what it guards is a password box whose real defence
   is the password. It exists so that guessing is not worth anybody's
   afternoon, not so that it is impossible.

   This lived in the host site's own functions file until the server was
   split out into a package, and did not come with it — which meant the
   first line of the login path threw, and every self-hosted install
   answered "that could not be completed just now" to the correct
   password. Anything the request path calls has to live beside it. */
const recent = new Map();

function tooOften(key, limit, windowMs) {
  const now = Date.now();
  const hits = (recent.get(key) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  recent.set(key, hits);
  if (recent.size > 5000) recent.clear();
  return hits.length > limit;
}

/* No password lives in this file, and none ever should.

   Self-hosted, it is in Secret Manager. Hosted, it is the hash the
   customer chose in Port, stored against their own site. Unset, there is
   no password and no way in — which is the correct failure: a door that
   cannot be opened is better than one whose key is written on the frame.

   An earlier version kept a hash here as a fallback. Do not put one back.
   An unsalted hash of a short password in a repository is not a secret,
   it is a head start.                                                  */

/* Pictures she uploads. A bucket of its own rather than the project's
   default one: created with uniform access and allUsers granted read on
   objects but NOT list, so a picture on a page is fetchable by anyone who
   has the page, and the shelf itself cannot be browsed. Hosted, every
   site's pictures live under its own id inside the one bucket.

     gcloud storage buckets create gs://YOUR-PROJECT-media \
       --location=us-central1 --uniform-bucket-level-access
     gcloud storage buckets add-iam-policy-binding gs://YOUR-PROJECT-media \
       --member=allUsers --role=roles/storage.legacyObjectReader          */

const SESSION_DAYS = 14;
const MAX_OVERLAY_BYTES = 900 * 1024;   // Firestore's ceiling is 1 MiB a document
const MAX_SAVES = 40;

function sha256(s) {
  return crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
}

/* The secret when there is one, the shipped hash when there is not. Either
   way what comes back is a hash, so the two paths are compared alike. */
/* Self-hosted, the one password in Secret Manager. Hosted, the hash the
   customer chose when they bought Opaline, stored against their site —
   so one customer's password is no use against another's site, and
   Wopara never holds any of them in the clear. */
function passwordHash(site) {
  if (MODE === "hosted") return (site.doc && site.doc.passwordHash) || null;
  const set = EDITOR_PASSWORD.value();
  return set ? sha256(set) : null;
}

/* A key that is not a key is not a key. Deploying requires every declared
   secret to hold SOMETHING, so a site that has not bought the assistant
   yet still has to put a value here — and the honest thing for a
   placeholder to produce is "not connected", not a 502 from an upstream
   that was handed nonsense. Real DeepSeek keys begin sk-. */
function aiReady(key) {
  return typeof key === "string" && key.indexOf("sk-") === 0 && key.length > 12;
}

function sameSecret(a, b) {
  const x = Buffer.from(String(a), "utf8");
  const y = Buffer.from(String(b), "utf8");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* =====================================================================
   Who may edit
   =====================================================================
   A site starts with one password and no names attached to it, which is
   the right shape for one person editing their own site: there is nothing
   to administer and nothing to forget but the password.

   The moment a second person is wanted, that shape stops working. Two
   people sharing one password cannot be told apart, cannot be removed one
   at a time, and cannot have a password reset without the other losing
   theirs. So adding an editor first asks the owner to put their own name
   to the door: an address attached to their own sign-in. From then on the
   box asks for an address and a password rather than a password alone,
   every session says whose it is, and removing somebody ends their
   sessions and nobody else's.

   Passwords chosen here are salted and run through scrypt, one salt each,
   so two people who pick the same word do not leave the same row. The
   founding password is not in this database at all: self-hosted it is in
   Secret Manager, hosted it is the hash the customer chose in Port, and
   only a hash is ever compared either way.
   ===================================================================== */

const INVITE_DAYS = 7;
const RESET_MINUTES = 45;
const SUPPORT_EMAIL = "support@wopara.com";

const AUTH_REF = (site) => db().collection("sites").doc(site).collection("state").doc("auth");
const EDITORS_REF = (site) => db().collection("sites").doc(site).collection("editors");

function emailKey(v) {
  return String(v || "").trim().toLowerCase().slice(0, 254);
}

function emailLooksReal(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}

/* Shown back to somebody who has just asked for a reset, so they can tell
   whether it went where they expected without the reply naming an address
   to anybody who guessed at it. */
function maskEmail(v) {
  const at = String(v || "").indexOf("@");
  if (at < 1) return "";
  return v.slice(0, 1) + "…" + v.slice(at - 1);
}

/* Where a reset goes while a site is still on one nameless password. Held
   on our side rather than read off the page, because a destination the
   browser can choose is a way to have somebody else's reset posted to
   yourself. Self-hosted, set CONTACT_EMAIL below; hosted, it is the
   address the customer registered in Port. */
function contactEmail(site) {
  if (MODE === "hosted") return emailKey((site.doc && site.doc.email) || "");
  return emailKey(CONTACT_EMAIL);
}

async function authDoc(site) {
  const snap = await AUTH_REF(site.id).get();
  return snap.exists ? (snap.data() || {}) : {};
}

async function authMode(site) {
  return (await authDoc(site)).mode === "email" ? "email" : "password";
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt: salt, hash: crypto.scryptSync(String(pw), salt, 64).toString("hex"), at: Date.now() };
}

function passwordMatches(rec, pw) {
  if (!rec || !rec.salt || !rec.hash) return false;
  return sameSecret(crypto.scryptSync(String(pw), rec.salt, 64).toString("hex"), rec.hash);
}

function passwordSound(pw) {
  return typeof pw === "string" && pw.length >= 8 && pw.length <= 200;
}

/* Codes get read down a phone line, so nothing in here can be mistaken
   for anything else in here: no I, L, O, zero or one. */
const CODE_ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function newCode() {
  const b = crypto.randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += CODE_ALPHA[b[i] % CODE_ALPHA.length];
  return s.slice(0, 4) + "-" + s.slice(4);
}

/* Never stored as it was sent. A code sitting in the database in the clear
   is a password in the database in the clear. */
function codeKey(c) {
  return sha256(String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, ""));
}

function whoTag(email) {
  return email ? Buffer.from(email, "utf8").toString("base64url") : "-";
}

function whoEmail(tag) {
  if (!tag || tag === "-") return null;
  try { return Buffer.from(tag, "base64url").toString("utf8"); } catch (e) { return null; }
}

/* A token is its own proof: an expiry and a name, signed with a key
   derived from the site AND that person's own password. So a token is
   useless against another site, useless once that person's password
   changes, and useless the moment their record is removed. Nothing is
   stored to check one against, so nothing about a session can be read out
   of the database either. */
async function editorKey(site, tag) {
  if (!tag || tag === "-") {
    const held = passwordHash(site);
    return held ? crypto.createHmac("sha256", "opaline-v1:" + site.id).update(held).digest() : null;
  }
  const who = whoEmail(tag);
  if (!who) return null;
  const snap = await EDITORS_REF(site.id).doc(who).get();
  if (!snap.exists) return null;
  const d = snap.data() || {};
  /* Somebody who has not chosen a password yet is signed in against the
     invitation, so their one session before choosing one can still be
     ended by withdrawing it. */
  const seed = d.hash || (d.invite && d.invite.hash) || null;
  return seed ? crypto.createHmac("sha256", "opaline-v1:" + site.id + ":" + who).update(seed).digest() : null;
}

async function mintToken(site, email) {
  const tag = whoTag(email);
  const key = await editorKey(site, tag);
  if (!key) return null;
  const expires = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const body = expires + "." + tag;
  const sig = crypto.createHmac("sha256", key).update(body).digest("hex");
  return { token: body + "." + sig, expires: expires, who: email || null };
}

/* Answers with who the token is, or null. Sessions minted before anyone
   had a name are two parts rather than three and still verify: nobody is
   signed out by an upgrade. */
async function tokenWho(token, site) {
  if (typeof token !== "string") return null;
  const bits = token.split(".");
  if (bits.length < 2 || bits.length > 3) return null;

  const expires = Number(bits[0]);
  if (!isFinite(expires) || expires < Date.now()) return null;

  const tag = bits.length === 3 ? bits[1] : "-";
  const key = await editorKey(site, tag);
  if (!key) return null;

  const body = bits.length === 3 ? bits[0] + "." + bits[1] : bits[0];
  if (!sameSecret(crypto.createHmac("sha256", key).update(body).digest("hex"), bits[bits.length - 1])) return null;
  return { tag: tag, email: whoEmail(tag) };
}

/* One place decides where a reset may be posted, and a browser is never
   consulted about it. */
async function resetTarget(site, mode, asked) {
  if (mode !== "email") {
    const to = contactEmail(site);
    return to ? { to: to, editor: null } : null;
  }
  const who = emailKey(asked);
  if (!emailLooksReal(who)) return null;
  const snap = await EDITORS_REF(site.id).doc(who).get();
  return snap.exists ? { to: who, editor: who } : null;
}

/* Mail goes out through Wopara's own service, which is where the mail
   credentials live. This function holds none and should hold none: one
   that can edit a website is a small thing to lose, and one that can send
   as anybody is not.

   Self-hosted with WOPARA_KEY unset, this says so rather than pretending,
   and the editor tells whoever is stuck to write to support instead. That
   is a working install, not a broken one: an invitation code is shown on
   screen as well as sent. */
const WOPARA_BASE = "https://wopara-token-service-296282827554.us-central1.run.app";

async function mailOut(site, to, subject, lines) {
  const key = WOPARA_KEY.value();
  if (!key || key.length < 12) return false;
  try {
    const r = await fetch(WOPARA_BASE + "/opaline/mail", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": key },
      body: JSON.stringify({
        to: to,
        subject: subject,
        lines: lines,
        site: (site.doc && site.doc.name) || site.id,
        replyTo: SUPPORT_EMAIL
      })
    });
    if (!r.ok) { logger.error("opaline mail refused", { status: r.status }); return false; }
    const d = await r.json().catch(() => ({}));
    return !!d.sent;
  } catch (err) {
    logger.error("opaline mail failed", { message: err.message });
    return false;
  }
}

function db() {
  ensureAdmin();
  return admin.firestore();
}

const OVERLAY_REF = (site) => db().collection("sites").doc(site).collection("state").doc("overlay");
const SAVES_REF = (site) => db().collection("sites").doc(site).collection("saves");

/* Her working copy: what she has changed and not yet published.
   ---------------------------------------------------------------------
   A document of its own, beside the live one and never in place of it.
   The public read serves `overlay` and only `overlay`, so nothing here
   can reach a visitor however wrong anything else goes, and the rules
   deny the browser both, so this is only ever read back to a request
   carrying a valid editing token.

   It is what lets her stop in the middle. Work done on a phone on
   Tuesday is on the laptop on Thursday, still unpublished, still hers,
   and it costs nothing: keeping a working copy is not a publish.
   --------------------------------------------------------------------- */
const DRAFT_REF = (site) => db().collection("sites").doc(site).collection("state").doc("draft");

const EMPTY_OVERLAY = { v: 1, globals: {}, pages: {}, newPages: {}, popups: [] };

async function readDraft(site) {
  const snap = await DRAFT_REF(site).get();
  if (!snap.exists) return null;
  const d = snap.data() || {};
  if (typeof d.json !== "string") return null;
  try {
    return { doc: JSON.parse(d.json), json: d.json, updatedAt: d.updatedAt || 0 };
  } catch (e) {
    return null;
  }
}

async function readOverlay(site) {
  const snap = await OVERLAY_REF(site).get();
  if (!snap.exists) return { doc: EMPTY_OVERLAY, json: JSON.stringify(EMPTY_OVERLAY), savedHash: null, updatedAt: 0 };
  const d = snap.data() || {};
  const json = typeof d.json === "string" ? d.json : JSON.stringify(EMPTY_OVERLAY);
  let doc = EMPTY_OVERLAY;
  try { doc = JSON.parse(json); } catch (e) { /* fall back to empty rather than 500 */ }
  return { doc: doc, json: json, savedHash: d.savedHash || null, updatedAt: d.updatedAt || 0 };
}

/* Whatever arrives is re-serialised from a parsed object, so a malformed or
   oversized body is refused before it can reach the document. */
function normaliseOverlay(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("The overlay must be an object."), { client: true });
  }
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > MAX_OVERLAY_BYTES) {
    throw Object.assign(
      new Error("This page of changes has grown past what one document can hold. Uploading pictures rather than pasting them keeps it small."),
      { client: true }
    );
  }
  return json;
}

/* Pictures. Cloud Storage when the project has it, because a picture served
   from a bucket is cached and costs the overlay nothing. When it does not,
   the picture rides inside the overlay as a data URL — which works, and is
   why the browser shrinks every upload before it is sent. */
async function storeUpload(site, dataUrl, filename) {
  const m = /^data:([\w.+-]+\/[\w.+-]+);base64,([\s\S]+)$/.exec(String(dataUrl || ""));
  if (!m) throw Object.assign(new Error("That file could not be read."), { client: true });

  const contentType = m[1];
  if (!/^image\/(png|jpeg|webp|gif|svg\+xml|avif)$/.test(contentType)) {
    throw Object.assign(new Error("Pictures only, please: PNG, JPEG, WebP, GIF, AVIF or SVG."), { client: true });
  }
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 5 * 1024 * 1024) {
    throw Object.assign(new Error("That picture is larger than 5 MB."), { client: true });
  }

  const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg", "image/avif": "avif" }[contentType];
  const safe = String(filename || "picture").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "picture";
  const path = site + "/" + Date.now() + "-" + crypto.randomBytes(4).toString("hex") + "-" + safe + "." + ext;

  try {
    ensureAdmin();
    const bucket = admin.storage().bucket(MEDIA_BUCKET);
    const file = bucket.file(path);
    await file.save(buf, {
      contentType: contentType,
      metadata: { cacheControl: "public, max-age=31536000, immutable" }
    });
    /* The bucket already grants the world read on its objects, and it uses
       uniform access, where a per-object ACL is refused outright. This is
       the belt for projects where that is not so; its failure is not one. */
    await file.makePublic().catch(() => { });
    return { url: "https://storage.googleapis.com/" + bucket.name + "/" + path, stored: "bucket", bytes: buf.length };
  } catch (err) {
    logger.warn("Storage unavailable, keeping the picture in the overlay", { message: err.message });
    if (buf.length > 400 * 1024) {
      throw Object.assign(
        new Error("Cloud Storage is not switched on for this project, and this picture is too large to keep in the page itself. Turn Storage on in the Firebase console, or use a smaller picture."),
        { client: true }
      );
    }
    return { url: dataUrl, stored: "inline", bytes: buf.length };
  }
}

/* ---------------------------------------------------------------------
   The AI button. She types what she wants; DeepSeek answers in the same
   small vocabulary of edits the editor already knows how to perform and
   how to undo. It is never handed the page's markup, only an index of
   what is on it, so the reply stays inside a budget and cannot invent a
   change to something that is not there.
   --------------------------------------------------------------------- */
function aiSystem(site) {
  const house = (site.doc && site.doc.houseStyle) ||
    "Match whatever the page already does. Change as little as the request allows.";
  return [
  "You are the editing assistant inside Wopara Opaline, which lets the owner of a website",
  "change it from inside the page. The site's own house style:",
  house,
  "",
  "You are given an index of the elements on one page. Each has an id you must quote back",
  "exactly. Reply with JSON only, shaped:",
  '{ "reply": "one or two warm sentences saying what you changed", "ops": [ ... ] }',
  "",
  "Every op is one of:",
  '{"op":"text","id":"...","value":"new wording, plain text or simple inline HTML"}',
  '{"op":"style","id":"...","props":{"color":"#B86F52","fontSize":"22px","fontFamily":"var(--serif)","textAlign":"center","width":"60%","fontWeight":"600","letterSpacing":"0.02em","lineHeight":"1.5","background":"#EDE7DC","padding":"24px","borderRadius":"22px"}}',
  '{"op":"hide","id":"..."}   {"op":"show","id":"..."}',
  '{"op":"duplicate","id":"..."}',
  '{"op":"move","id":"...","dir":"up"}   dir is "up" or "down"',
  '{"op":"insertHtml","afterId":"...","html":"<p>...</p>"}',
  '{"op":"attr","id":"...","name":"href","value":"about.html"}',
  '{"op":"css","value":".some-class { ... }"}   site-wide CSS, appended',
  "",
  "Rules: quote ids exactly as given and never invent one. Prefer the fewest ops that do the job.",
  "Prefer the site's own CSS custom properties for colour where the page uses them, so a choice",
  "still reads correctly if the site is switched between light and dark. A literal colour cannot.",
  "If the request is not something these ops can do, return an empty ops array and say so kindly in reply."
  ].join("\n");
}

async function askDeepSeek(prompt, context, key, site) {
  const messages = [
    { role: "system", content: aiSystem(site) },
    {
      role: "user",
      content:
        "Elements on " + (context.page || "this page") + ":\n" + context.outline +
        (context.target
          /* Named rather than left to be guessed at from a list of a hundred
             and seventy. Without this, "make this bigger" lands on whichever
             element the words happen to match first, which reads to her as
             being ignored. */
          ? "\n\nSHE HAS SELECTED THIS ONE, and the request is about it:\n" + context.target +
            (context.only
              /* Asked from the panel, which is standing on one element. She
                 is looking at that element, she described a change to that
                 element, and an op that lands anywhere else is not a
                 generous reading of her words: it is a wrong answer. The
                 editor refuses them as well, so this is the polite half of
                 a rule that is enforced either way. */
              ? "\n\nThis request came from the panel for that one element. Change ONLY that element" +
                " or something inside it. Do not touch anything else on the page, and do not write" +
                " site-wide CSS. If what she asks cannot be done inside it, say so in reply and" +
                " return no ops."
              : "\nChange that element. Touch another only where the request plainly asks for it.")
          : "\n\nNothing is selected: the request is about the page as a whole.") +
        "\n\nThe owner asks: " + prompt
    }
  ];
  const upstream = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      messages: messages,
      temperature: 0.3,
      max_tokens: 2400,
      response_format: { type: "json_object" }
    })
  });
  const data = await upstream.json();
  if (!upstream.ok) {
    logger.error("DeepSeek editor error", { status: upstream.status, data: data });
    throw new Error("Upstream error");
  }
  let parsed = { reply: "", ops: [] };
  try { parsed = JSON.parse(data.choices[0].message.content); } catch (e) { /* handled below */ }
  return {
    reply: typeof parsed.reply === "string" ? parsed.reply : "Done.",
    ops: Array.isArray(parsed.ops) ? parsed.ops.slice(0, 60) : [],
    tokens: (data.usage && data.usage.total_tokens) || 0
  };
}

/* ---------------------------------------------------------------------
   Reserves
   ---------------------------------------------------------------------
   Reserves are credit, not a licence fee. A hundred of them buys the
   feature and then goes on paying for the running of it: each publish,
   each picture kept and served, each ask of the assistant. When they run
   low the owner is told, and tops up.

   Two rules this is built around.

   Nothing is charged for until it is done. A publish that fails costs
   nothing; an upload that is refused costs nothing; an ask the assistant
   could not answer costs nothing. A meter that runs while you are being
   told no is a meter nobody believes twice.

   And every charge is written down, in the site's own ledger, in words
   its owner can read. "Published 3 changes — 1" is auditable. A balance
   that quietly goes down is not.

   ---------------------------------------------------------------------
   TWO NUMBERS BELOW ARE NOT MINE TO SET.

   RESERVE_USD  — what one reserve is worth in dollars.
   MARKUP       — Wopara's standard markup on pass-through cost.

   Both are company figures. They are marked null and everything that
   depends on them refuses to guess: with them unset, metered charges
   fall back to a flat rate rather than inventing a price. Set them and
   the metered path switches itself on.
   --------------------------------------------------------------------- */

const RESERVE_USD = null;   // e.g. 0.01  ← set from Wopara's own pricing
const MARKUP = null;        // e.g. 3.0   ← set from Wopara's standard markup

/* Google's published rates, us-central1. Cheap to keep current; wrong if
   left for years. Storage is per GB per month, egress per GB served. */
const GCP = {
  storagePerGbMonth: 0.020,
  egressPerGb: 0.12,
  firestoreWritePer100k: 0.18,
  firestoreReadPer100k: 0.06
};

/* What a stored picture is actually charged for: a year of keeping it,
   and an allowance of downloads. Egress dwarfs storage by three orders of
   magnitude — a 300 KB picture costs a fiftieth of a cent to keep for a
   year and thirty times that to serve five hundred times — so an honest
   price is mostly an egress price. Beyond the allowance nobody is
   chased; it is priced in, and generous, because metering every view of
   every picture would cost more than the views. */
const KEEP_MONTHS = 12;
const INCLUDED_VIEWS = 500;

const FLAT = {
  publish: 1,        // asked for: one reserve a publish
  upload: 2,         // used only while RESERVE_USD/MARKUP are unset
  aiFloor: 2
};

const LOW_AT = 0.15;   // tell them when this much or less is left

function metered() {
  return typeof RESERVE_USD === "number" && RESERVE_USD > 0 &&
         typeof MARKUP === "number" && MARKUP > 0;
}

/* Cost to us of keeping and serving one picture, marked up, in reserves.
   Rounded up, and never free: a charge of zero teaches nobody anything
   about what they are spending. */
function costOfUpload(bytes) {
  if (!metered()) return FLAT.upload;
  const gb = bytes / (1024 * 1024 * 1024);
  const usd = gb * (GCP.storagePerGbMonth * KEEP_MONTHS + GCP.egressPerGb * INCLUDED_VIEWS) * MARKUP;
  return Math.max(1, Math.ceil(usd / RESERVE_USD));
}

/* The assistant, charged on what it did rather than what was asked. A
   request that turned out to be one word is not a large request however
   grandly it was phrased, and charging as though it were is how a meter
   loses its customer. */
function costOfAsk(ops, tokens) {
  const work = ops || 0;
  const thought = Math.ceil((tokens || 0) / 1000);
  return Math.max(FLAT.aiFloor, work + thought);
}

/* A bill has to say what it was for. This reads the difference between
   what was published and what is being published, and says it plainly —
   "3 changes, 1 block added" rather than a hash nobody can check. */
function describeChange(before, after) {
  const count = (doc) => {
    let nodes = 0, inserts = 0, hidden = 0;
    Object.keys((doc && doc.pages) || {}).forEach((k) => {
      const p = doc.pages[k] || {};
      Object.keys(p.nodes || {}).forEach((id) => {
        if (p.nodes[id].hidden) hidden++; else nodes++;
      });
      inserts += (p.inserts || []).length;
    });
    return { nodes, inserts, hidden, pages: Object.keys((doc && doc.newPages) || {}).length };
  };
  const a = count(before);
  const b = count(after);
  const said = [];
  const delta = (n, one, many) => {
    if (n > 0) said.push(n + " " + (n === 1 ? one : many) + " added");
    else if (n < 0) said.push(-n + " " + (-n === 1 ? one : many) + " undone");
  };
  delta(b.nodes - a.nodes, "change", "changes");
  delta(b.inserts - a.inserts, "block", "blocks");
  delta(b.hidden - a.hidden, "removal", "removals");
  delta(b.pages - a.pages, "page", "pages");
  return "Published" + (said.length ? " \u2014 " + said.join(", ") : "");
}

async function recentLedger(site) {
  if (MODE !== "hosted") return [];
  const snap = await db().collection("sites").doc(site.id)
    .collection("ledger").orderBy("at", "desc").limit(20).get();
  const out = [];
  snap.forEach((d) => out.push(d.data()));
  return out;
}

async function balanceOf(site) {
  if (MODE !== "hosted") return Infinity;
  const snap = await db().collection("sites").doc(site.id).get();
  return (snap.data() || {}).reserves || 0;
}

/* Charge, write it down, and notice if that was the charge that took them
   low. Returns what is left. */
async function charge(site, amount, why) {
  if (MODE !== "hosted" || amount <= 0) return Infinity;

  const ref = db().collection("sites").doc(site.id);
  const after = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const d = snap.data() || {};
    const left = Math.max(0, (d.reserves || 0) - amount);
    tx.update(ref, { reserves: left, lastSpentAt: Date.now() });
    tx.set(ref.collection("ledger").doc(), {
      at: Date.now(), amount: -amount, why: why, balanceAfter: left
    });
    return { left: left, topUp: d.lastTopUp || d.reservesBought || 100, told: d.lowTold || false, email: d.email };
  });

  if (after.left <= after.topUp * LOW_AT && !after.told) await raiseTopUp(site, after);
  /* Back above the line, so the next dip is worth mentioning again. */
  if (after.left > after.topUp * LOW_AT && after.told) await ref.update({ lowTold: false });

  return after.left;
}

/* ---------------------------------------------------------------------
   Running low
   ---------------------------------------------------------------------
   At fifteen per cent left, a job is filed for the servant to write to
   them. Filed rather than sent: this function has no business holding
   mail credentials, and a queue can be retried, read and audited where a
   fire-and-forget send cannot.

   Wopara's side picks these up. The instruction is spelled out in words
   rather than implied by a status code, because the thing acting on it
   is an agent and agents read.
   --------------------------------------------------------------------- */
async function raiseTopUp(site, state) {
  const ref = db().collection("sites").doc(site.id);
  await ref.update({ lowTold: true, lowAt: Date.now() });
  await db().collection("tasks").add({
    at: Date.now(),
    kind: "opaline-top-up",
    site: site.id,
    siteName: (site.doc && site.doc.name) || site.id,
    email: state.email || (site.doc && site.doc.email) || null,
    remaining: state.left,
    of: state.topUp,
    percent: Math.round((state.left / Math.max(1, state.topUp)) * 100),
    done: false,
    instruction: "let the servant email them to top up"
  });
  logger.info("top-up raised", { site: site.id, remaining: state.left });
}

exports.opaline = onRequest(
  {
    secrets: [EDITOR_PASSWORD, DEEPSEEK_API_KEY, WOPARA_KEY],
    region: "us-central1",
    cors: false,
    maxInstances: 20,
    timeoutSeconds: 60,
    memory: "512MiB"
  },
  async (req, res) => {
    const origin = req.headers.origin || "";

    let site;
    try { site = await siteFor(req); }
    catch (err) { logger.error("site lookup failed", { message: err.message }); site = null; }

    if (!site) {
      /* Said the same way for an unknown site and a forbidden one, so this
         cannot be used to find out which site ids exist. */
      if (req.method === "OPTIONS") { res.status(204).send(""); return; }
      res.status(403).json({ error: "Not allowed from here." });
      return;
    }

    const allowed = originAllowed(site, origin);
    if (allowed) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Vary", "Origin");
      res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.set("Access-Control-Allow-Headers", "Content-Type");
      /* A renewed session rides back on a header rather than inside the
         answer, so no action has to know about sessions in order to hand
         one on. A browser cannot read a header it was not told it may. */
      res.set("Access-Control-Expose-Headers", "X-Opaline-Session");
      res.set("Access-Control-Max-Age", "3600");
    }
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (!allowed) { res.status(403).json({ error: "Not allowed from here." }); return; }

    /* Reading is public and must be: it is how every visitor's browser
       learns what the page says now. A short cache keeps a busy day from
       becoming a database bill; the editor asks past it. */
    if (req.method === "GET") {
      try {
        const cur = await readOverlay(site.id);
        res.set("Cache-Control", "public, max-age=20, stale-while-revalidate=120");
        res.status(200).json({ ok: true, overlay: cur.doc, updatedAt: cur.updatedAt });
      } catch (err) {
        logger.error("overlay read failed", { site: site.id, message: err.message });
        /* An empty overlay is the untouched site, which is the right thing
           to show when the store cannot be reached. */
        res.status(200).json({ ok: true, overlay: EMPTY_OVERLAY, updatedAt: 0, degraded: true });
      }
      return;
    }
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

    const body = req.body || {};
    const action = String(body.action || "");
    const ip = req.headers["x-forwarded-for"] || req.ip || "unknown";

    try {
      /* ---- what the box should ask for ----

         Public on purpose and says nothing worth having: whether this site
         wants an address as well as a password. The box has to know before
         anybody has typed anything, and an attacker learns only what one
         look at the form would have told them anyway. */
      if (action === "mode") {
        res.status(200).json({ ok: true, mode: await authMode(site), support: SUPPORT_EMAIL });
        return;
      }

      if (action === "login") {
        /* Slow enough that guessing is not worth anyone's afternoon. */
        if (tooOften("in:" + site.id + ":" + ip, 8, 10 * 60 * 1000)) {
          res.status(429).json({ error: "Too many tries. Please wait ten minutes." });
          return;
        }
        const want = passwordHash(site);
        const mode = await authMode(site);
        const said = String(body.password || "");

        if (mode !== "email") {
          if (!want) {
            logger.error("login attempted for a site with no password set", { site: site.id });
            res.status(503).json({ error: "Editing is not switched on for this site yet." });
            return;
          }
          if (!sameSecret(sha256(said), want)) {
            logger.warn("login refused", { site: site.id, ip: ip });
            res.status(401).json({ error: "That password is not right." });
            return;
          }
          const t = await mintToken(site, null);
          res.status(200).json({ ok: true, token: t.token, expires: t.expires, mode: mode });
          return;
        }

        /* Names are attached, so the address is half the answer. The reply
           is the same whether the address is unknown or the password is
           wrong, because a login box that distinguishes them is a way to
           find out who can edit a site. */
        const who = emailKey(body.email);
        const wrong = { error: "That address and password do not go together." };
        if (!emailLooksReal(who)) { res.status(401).json(wrong); return; }

        const ref = EDITORS_REF(site.id).doc(who);
        const snap = await ref.get();
        if (!snap.exists) { logger.warn("login refused", { site: site.id, ip: ip }); res.status(401).json(wrong); return; }
        const d = snap.data() || {};

        let ok = passwordMatches(d, said);
        let choosing = false;

        /* An invitation is a password that works once and then insists on
           being replaced. */
        if (!ok && d.invite && d.invite.expires > Date.now() &&
          sameSecret(codeKey(said), d.invite.hash)) {
          ok = true;
          choosing = true;
        }

        /* The owner can always get in with the password the site was set
           up on, provided they give their own address with it. Not a
           second door: the same one door, still answering to whoever holds
           the founding password. */
        if (!ok && d.role === "owner" && want && sameSecret(sha256(said), want)) ok = true;

        if (!ok) { logger.warn("login refused", { site: site.id, ip: ip }); res.status(401).json(wrong); return; }

        const t = await mintToken(site, who);
        if (!t) { res.status(503).json({ error: "Editing is not switched on for this site yet." }); return; }
        await ref.update({ lastIn: Date.now() }).catch(() => { });
        res.status(200).json({
          ok: true, token: t.token, expires: t.expires, mode: mode,
          who: who, role: d.role || "editor",
          /* Signed in on an invitation, which is not a password. */
          mustChoose: choosing
        });
        return;
      }

      /* ---- forgetting it ----

         Open, because somebody who has forgotten their password cannot
         prove anything yet. Two things keep it honest: where the code goes
         is decided here and never by the caller, and the reply is the same
         whether or not there was anywhere to send it. Otherwise this box
         becomes a way to ask which addresses can edit a site. */
      if (action === "resetStart") {
        if (tooOften("rs:" + site.id + ":" + ip, 6, 30 * 60 * 1000)) {
          res.status(429).json({ error: "That has been asked for a few times already. Please give it half an hour." });
          return;
        }
        const mode = await authMode(site);
        const target = await resetTarget(site, mode, body.email);

        if (!target) {
          /* On a site with names, saying nothing is the point. On a site
             with no contact address there is genuinely nowhere to send it,
             and saying so is the only useful thing left. */
          if (mode !== "email") {
            res.status(200).json({ ok: true, sent: false, none: true, support: SUPPORT_EMAIL, mode: mode });
            return;
          }
          res.status(200).json({ ok: true, sent: true, mode: mode, support: SUPPORT_EMAIL });
          return;
        }

        const code = newCode();
        const until = Date.now() + RESET_MINUTES * 60 * 1000;
        const label = (site.doc && site.doc.name) || site.id;

        if (target.editor) {
          await EDITORS_REF(site.id).doc(target.editor).update({ reset: { hash: codeKey(code), expires: until } });
        } else {
          await AUTH_REF(site.id).set({ reset: { hash: codeKey(code), expires: until } }, { merge: true });
        }

        const sent = await mailOut(site, target.to, "Your Opaline code for " + label, [
          "Somebody asked to set a new editing password for " + label + ".",
          "",
          "The code is " + code,
          "",
          "It works once, for the next " + RESET_MINUTES + " minutes. If this was not you, " +
          "nothing has changed and you can ignore this."
        ]);

        res.status(200).json({
          ok: true, sent: sent, mode: mode, to: maskEmail(target.to), support: SUPPORT_EMAIL
        });
        return;
      }

      if (action === "resetFinish") {
        if (tooOften("rf:" + site.id + ":" + ip, 10, 30 * 60 * 1000)) {
          res.status(429).json({ error: "Too many tries. Please wait half an hour." });
          return;
        }
        const mode = await authMode(site);
        const fresh = String(body.password || "");
        if (!passwordSound(fresh)) {
          res.status(400).json({ error: "Please choose a password of at least eight characters." });
          return;
        }

        const bad = { error: "That code is not right, or it has expired." };

        if (mode === "email") {
          const who = emailKey(body.email);
          if (!emailLooksReal(who)) { res.status(400).json(bad); return; }
          const ref = EDITORS_REF(site.id).doc(who);
          const snap = await ref.get();
          if (!snap.exists) { res.status(400).json(bad); return; }
          const d = snap.data() || {};
          if (!d.reset || d.reset.expires < Date.now() || !sameSecret(codeKey(body.code), d.reset.hash)) {
            res.status(400).json(bad); return;
          }
          /* Used once and gone, along with any invitation it stood in for. */
          await ref.update(Object.assign(hashPassword(fresh), {
            reset: admin.firestore.FieldValue.delete(),
            invite: admin.firestore.FieldValue.delete()
          }));
          const t = await mintToken(site, who);
          res.status(200).json({ ok: true, token: t.token, expires: t.expires, who: who, mode: mode });
          return;
        }

        /* Still one nameless password. Resetting it cannot rewrite a
           secret from in here, so what it does instead is attach the
           contact address to the door and give that address the new
           password, which is where the site was going anyway. */
        const a = await authDoc(site);
        if (!a.reset || a.reset.expires < Date.now() || !sameSecret(codeKey(body.code), a.reset.hash)) {
          res.status(400).json(bad); return;
        }
        const who = contactEmail(site);
        if (!emailLooksReal(who)) { res.status(400).json(bad); return; }
        await EDITORS_REF(site.id).doc(who).set(Object.assign(hashPassword(fresh), {
          email: who, role: "owner", addedAt: Date.now(), addedBy: "reset"
        }), { merge: true });
        await AUTH_REF(site.id).set({
          mode: "email", updatedAt: Date.now(), reset: admin.firestore.FieldValue.delete()
        }, { merge: true });
        const t = await mintToken(site, who);
        res.status(200).json({ ok: true, token: t.token, expires: t.expires, who: who, mode: "email" });
        return;
      }

      /* Everything past this point changes the site. */
      const me = await tokenWho(body.token, site);
      if (!me) {
        /* Logged, because until now this left no trace at all: a session
           that ran out mid-afternoon looked, from here, exactly like a
           quiet day. The one thing worth knowing is which request it
           happened on, since it is nearly always the last one somebody
           makes rather than the first. */
        logger.warn("editing session refused", { site: site.id, action: action, ip: ip });
        res.status(401).json({ error: "Your editing session has ended. Please sign in again." });
        return;
      }

      /* A sliding fortnight.

         A session lasted fourteen days from the moment it was opened and
         then stopped, wherever the person holding it happened to be. In
         practice that is at the end of an afternoon's work, because the
         request most likely to be the first one after the deadline is the
         last one somebody makes — which is Publish, and being timed out
         while publishing is exactly how it gets reported.

         So a token more than halfway through its life is quietly replaced
         on the next request. Somebody who edits their own site every week
         or two is never signed out; somebody who has not been near it for
         a fortnight still is, which is the point of having a session at
         all. */
      const endsAt = Number(String(body.token || "").split(".")[0]) || 0;
      if (endsAt && (endsAt - Date.now()) < (SESSION_DAYS / 2) * 24 * 60 * 60 * 1000) {
        const fresh = await mintToken(site, me.email);
        if (fresh) res.set("X-Opaline-Session", fresh.token + "|" + fresh.expires);
      }

      /* ---- who can get in, listed ---- */
      if (action === "editors") {
        const snap = await EDITORS_REF(site.id).orderBy("addedAt", "asc").limit(50).get();
        const people = [];
        snap.forEach((d) => {
          const v = d.data() || {};
          people.push({
            email: v.email || d.id,
            role: v.role || "editor",
            /* Invited and not yet arrived: worth showing, because an
               invitation nobody used looks exactly like an editor who
               cannot get in. */
            pending: !v.hash,
            addedAt: v.addedAt || 0,
            lastIn: v.lastIn || 0
          });
        });
        const to = contactEmail(site);
        res.status(200).json({
          ok: true, mode: await authMode(site), me: me.email, people: people,
          contact: to ? maskEmail(to) : "", support: SUPPORT_EMAIL
        });
        return;
      }

      /* ---- putting their own name to the door ----

         The step before a second editor is possible. The current password
         is asked for again, and not as ceremony: this is the request that
         decides who owns the site from now on, and the one thing a
         borrowed session cannot produce is the password it was opened
         with. */
      if (action === "attachEmail") {
        if (await authMode(site) === "email") {
          res.status(409).json({ error: "This site already signs in with an address." });
          return;
        }
        const want = passwordHash(site);
        if (!want || !sameSecret(sha256(String(body.password || "")), want)) {
          res.status(401).json({ error: "That password is not right." });
          return;
        }
        const who = emailKey(body.email);
        if (!emailLooksReal(who)) {
          res.status(400).json({ error: "That does not look like an email address." });
          return;
        }

        /* The password does not change here, so nothing they know becomes
           wrong: the same password, now with an address in front of it.
           Stored properly this time rather than left as a bare SHA-256,
           since from here it is theirs rather than the site's. */
        await EDITORS_REF(site.id).doc(who).set(Object.assign(hashPassword(String(body.password || "")), {
          email: who, role: "owner", addedAt: Date.now(), addedBy: "self"
        }), { merge: true });
        await AUTH_REF(site.id).set({ mode: "email", updatedAt: Date.now() }, { merge: true });

        const t = await mintToken(site, who);
        res.status(200).json({ ok: true, mode: "email", who: who, token: t.token, expires: t.expires });
        return;
      }

      /* ---- a second pair of hands ---- */
      if (action === "addEditor") {
        if (await authMode(site) !== "email") {
          res.status(409).json({ error: "Attach your own address to this site first." });
          return;
        }
        const who = emailKey(body.email);
        if (!emailLooksReal(who)) {
          res.status(400).json({ error: "That does not look like an email address." });
          return;
        }
        const already = await EDITORS_REF(site.id).doc(who).get();
        if (already.exists && (already.data() || {}).hash) {
          res.status(409).json({ error: "That address can already edit this site." });
          return;
        }

        /* The invitation is shown to the owner as well as sent, so an
           editor standing beside them can be let in without waiting on
           mail, and a site with no mail configured is not a site that
           cannot add anybody. */
        const code = newCode();
        const label = (site.doc && site.doc.name) || site.id;
        await EDITORS_REF(site.id).doc(who).set({
          email: who,
          role: "editor",
          addedAt: Date.now(),
          addedBy: me.email || "owner",
          invite: { hash: codeKey(code), expires: Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000 }
        }, { merge: true });

        const sent = await mailOut(site, who, "You can now edit " + label, [
          "You have been given editing access to " + label + ".",
          "",
          "Go to the site, press “Edit with Wopara Opaline” at the foot of any page,",
          "and sign in with this address and the code below. It will ask you to",
          "choose a password of your own straight afterwards.",
          "",
          "The code is " + code,
          "",
          "It works once, within the next " + INVITE_DAYS + " days."
        ]);

        res.status(200).json({ ok: true, who: who, code: code, sent: sent, support: SUPPORT_EMAIL });
        return;
      }

      if (action === "removeEditor") {
        const who = emailKey(body.email);
        const snap = await EDITORS_REF(site.id).doc(who).get();
        if (!snap.exists) { res.status(404).json({ error: "That address is not on the list." }); return; }
        const d = snap.data() || {};
        /* Neither of the two ways to lock a site's owner out of it. */
        if (d.role === "owner") {
          res.status(409).json({ error: "The owner of the site cannot be removed from it." });
          return;
        }
        if (who === (me.email || "")) {
          res.status(409).json({ error: "You cannot remove yourself. Ask another editor to do it." });
          return;
        }
        await EDITORS_REF(site.id).doc(who).delete();
        /* Their sessions were signed with a key derived from the record
           that has just gone, so they are already worthless. */
        res.status(200).json({ ok: true });
        return;
      }

      /* ---- changing it, from inside ---- */
      if (action === "setPassword") {
        if (!me.email) {
          res.status(409).json({ error: "Attach your own address to this site first." });
          return;
        }
        const fresh = String(body.password || "");
        if (!passwordSound(fresh)) {
          res.status(400).json({ error: "Please choose a password of at least eight characters." });
          return;
        }
        const ref = EDITORS_REF(site.id).doc(me.email);
        const snap = await ref.get();
        if (!snap.exists) { res.status(404).json({ error: "That address is not on the list." }); return; }
        const d = snap.data() || {};

        /* Somebody who arrived on an invitation has no password to be
           asked for yet. Everybody else does, because a session left open
           on a borrowed laptop should not be able to change the password
           that would end it. */
        if (d.hash) {
          const want = passwordHash(site);
          const okNow = passwordMatches(d, String(body.current || "")) ||
            (d.role === "owner" && want && sameSecret(sha256(String(body.current || "")), want));
          if (!okNow) { res.status(401).json({ error: "That is not your current password." }); return; }
        }

        await ref.update(Object.assign(hashPassword(fresh), {
          invite: admin.firestore.FieldValue.delete(),
          reset: admin.firestore.FieldValue.delete()
        }));
        /* The key their token was signed with has just changed, so the one
           they are holding is finished. They get a new one rather than a
           sign-in box. */
        const t = await mintToken(site, me.email);
        res.status(200).json({ ok: true, token: t.token, expires: t.expires });
        return;
      }

      if (action === "state") {
        const cur = await readOverlay(site.id);
        const snap = await SAVES_REF(site.id).orderBy("at", "desc").limit(MAX_SAVES).get();
        const saves = [];
        snap.forEach((d) => { const v = d.data(); saves.push({ id: d.id, name: v.name, at: v.at }); });
        /* Only when it still says something the live site does not. A draft
           that has caught up with what is published is not unfinished work,
           it is a leftover, and offering to restore it would be noise. */
        const kept = await readDraft(site.id);
        const pending = kept && kept.json !== cur.json ? kept : null;
        res.status(200).json({
          ok: true,
          overlay: cur.doc,
          updatedAt: cur.updatedAt,
          draft: pending ? pending.doc : null,
          draftAt: pending ? pending.updatedAt : 0,
          saves: saves,
          reserves: await balanceOf(site),
          ledger: await recentLedger(site),
          /* False means restoring is refused until she has saved: the whole
             point of that guard. */
          currentIsSaved: !!cur.savedHash && cur.savedHash === sha256(cur.json)
        });
        return;
      }

      /* ---- keep: her working copy, saved as she works, seen by nobody.
         Free, and deliberately so: she is not buying a save, she is being
         allowed to stop in the middle of a sentence. ---- */
      if (action === "draft") {
        const json = normaliseOverlay(body.overlay);
        const at = Date.now();
        await DRAFT_REF(site.id).set({ json: json, updatedAt: at });
        res.status(200).json({ ok: true, at: at });
        return;
      }

      if (action === "dropDraft") {
        await DRAFT_REF(site.id).delete();
        res.status(200).json({ ok: true });
        return;
      }

      if (action === "publish") {
        const json = normaliseOverlay(body.overlay);
        const before = await readOverlay(site.id);

        /* Publishing what is already published is not a publish. She may
           press it twice, or press it having undone everything she did
           since; neither should cost her anything. */
        if (before.json === json) {
          /* Nothing to publish also means nothing left over to pick up. */
          await DRAFT_REF(site.id).delete().catch(() => { });
          res.status(200).json({
            ok: true, updatedAt: before.updatedAt, spent: 0,
            reserves: await balanceOf(site),
            currentIsSaved: !!before.savedHash && before.savedHash === sha256(before.json)
          });
          return;
        }

        await OVERLAY_REF(site.id).set({ json: json, updatedAt: Date.now() }, { merge: true });
        /* The working copy has arrived. Leaving one behind would offer her
           yesterday's work back as though it were unfinished. */
        await DRAFT_REF(site.id).delete().catch(() => { });
        const cur = await readOverlay(site.id);
        /* Charged after it is done, so a publish that failed costs nothing. */
        const left = await charge(site, FLAT.publish, describeChange(before.doc, cur.doc));

        res.status(200).json({
          ok: true,
          updatedAt: cur.updatedAt,
          spent: FLAT.publish,
          reserves: left,
          currentIsSaved: !!cur.savedHash && cur.savedHash === sha256(cur.json)
        });
        return;
      }

      if (action === "save") {
        const name = String(body.name || "").trim().slice(0, 80);
        if (!name) { res.status(400).json({ error: "Please give this save a name." }); return; }
        const json = normaliseOverlay(body.overlay);
        const hash = sha256(json);
        const at = Date.now();

        const ref = await SAVES_REF(site.id).add({ name: name, at: at, json: json, hash: hash });
        /* The live document remembers which save it matches, so "restore"
           can tell whether anything would be lost by restoring. */
        await OVERLAY_REF(site.id).set({ json: json, updatedAt: at, savedHash: hash }, { merge: true });
        /* Saving publishes as well, so the working copy has arrived too. */
        await DRAFT_REF(site.id).delete().catch(() => { });

        const all = await SAVES_REF(site.id).orderBy("at", "desc").get();
        const extra = [];
        all.forEach((d, i) => { if (i >= MAX_SAVES) extra.push(d.ref); });
        await Promise.all(extra.map((r) => r.delete()));

        res.status(200).json({ ok: true, id: ref.id, name: name, at: at, currentIsSaved: true });
        return;
      }

      if (action === "restore") {
        const cur = await readOverlay(site.id);
        if (!cur.savedHash || cur.savedHash !== sha256(cur.json)) {
          res.status(409).json({
            error: "Save what the site looks like now before restoring an older version, so this one is not lost.",
            needsSave: true
          });
          return;
        }
        const snap = await SAVES_REF(site.id).doc(String(body.id || "")).get();
        if (!snap.exists) { res.status(404).json({ error: "That saved version is no longer there." }); return; }
        const v = snap.data();
        /* Restoring lands on a state that is itself already saved — it is
           this very save — so the guard stays satisfied afterwards. */
        await OVERLAY_REF(site.id).set({ json: v.json, updatedAt: Date.now(), savedHash: v.hash }, { merge: true });
        /* The site has been wound back to a named version; an unfinished
           copy of the version it was wound back from would be a trap. */
        await DRAFT_REF(site.id).delete().catch(() => { });
        let out = EMPTY_OVERLAY;
        try { out = JSON.parse(v.json); } catch (e) { /* refused quietly */ }
        res.status(200).json({ ok: true, overlay: out, name: v.name, currentIsSaved: true });
        return;
      }

      if (action === "deleteSave") {
        await SAVES_REF(site.id).doc(String(body.id || "")).delete();
        res.status(200).json({ ok: true });
        return;
      }

      if (action === "upload") {
        const out = await storeUpload(site.id, body.dataUrl, body.name);
        /* Charged on the bytes actually kept, not the bytes offered — the
           browser shrinks a picture before sending it, and she should be
           charged for the small one. */
        const cost = costOfUpload(out.bytes);
        const left = await charge(site, cost, "Picture uploaded, " + Math.round(out.bytes / 1024) + " KB");
        res.status(200).json({
          ok: true, url: out.url, stored: out.stored,
          spent: cost, reserves: left
        });
        return;
      }

      if (action === "ai") {
        const prompt = String(body.prompt || "").trim().slice(0, 2000);
        if (!prompt) { res.status(400).json({ error: "Tell me what you would like changed." }); return; }
        if (tooOften("ai:" + site.id, 60, 60 * 60 * 1000)) {
          res.status(429).json({ error: "That is a lot of asking in one hour. Please give it a few minutes." });
          return;
        }

        const left = await balanceOf(site);
        if (left < FLAT.aiFloor) {
          res.status(402).json({
            error: "This site has run out of reserves for the assistant. Everything else still works — " +
                   "words, pictures, colours and blocks are all yours to change by hand.",
            reserves: left,
            needsReserves: true
          });
          return;
        }

        const key = DEEPSEEK_API_KEY.value();
        if (!aiReady(key)) { res.status(503).json({ error: "The assistant is not connected yet." }); return; }

        const context = {
          page: String((body.context && body.context.page) || "").slice(0, 60),
          outline: String((body.context && body.context.outline) || "").slice(0, 24000),
          /* What she had selected when she asked. Empty means the request is
             about the page rather than one thing on it. */
          target: String((body.context && body.context.target) || "").slice(0, 300),
          /* Set when the ask came from the panel rather than the bar: the
             one element she is standing on, and the only one that may
             change. */
          only: String((body.context && body.context.only) || "").slice(0, 120)
        };
        const out = await askDeepSeek(prompt, context, key, site);

        /* Nothing charged when it could not do anything: an empty answer
           is not a service rendered. */
        const cost = out.ops.length ? costOfAsk(out.ops.length, out.tokens) : 0;
        const now = cost ? await charge(site, cost, "Asked: " + prompt.slice(0, 60)) : left;

        res.status(200).json({
          ok: true, reply: out.reply, ops: out.ops,
          spent: cost, reserves: now
        });
        return;
      }

      res.status(400).json({ error: "Unknown action" });
    } catch (err) {
      if (err.client) { res.status(400).json({ error: err.message }); return; }
      if (/NOT_FOUND|database|Firestore/i.test(err.message || "")) {
        logger.error("Firestore unavailable", { message: err.message });
        res.status(503).json({ error: "The place these changes are kept is not switched on yet." });
        return;
      }
      logger.error("opaline failure", { site: site.id, action: action, message: err.message });
      res.status(502).json({ error: "That could not be completed just now." });
    }
  }
);


/* ---------------------------------------------------------------------
   The nightly save
   ---------------------------------------------------------------------
   Restoring an older version is refused unless the state being left has
   itself been saved. That guard is right, and it depends on the owner
   having remembered to save — on the one morning they will not have.

   So once a night, for every site whose live state differs from its last
   save, one is filed on their behalf. Automatic saves are named by their
   date and pruned to a fortnight, so they never crowd out the ones
   somebody named themselves; those are only ever removed by hand.
   --------------------------------------------------------------------- */

const AUTO_KEEP = 14;

async function saveOneSite(id, zone) {
  const cur = await readOverlay(id);
  const hash = sha256(cur.json);
  if (cur.savedHash === hash) return false;
  if (cur.json === JSON.stringify(EMPTY_OVERLAY)) return false;

  const at = Date.now();
  const name = "Automatic — " + new Date(at).toLocaleDateString("en-CA", {
    timeZone: zone || "UTC", year: "numeric", month: "short", day: "numeric"
  });

  await SAVES_REF(id).add({ name: name, at: at, json: cur.json, hash: hash, auto: true });
  /* Marking the live document as saved is the point: it means an older
     version can be restored tomorrow morning without first having to save
     the very state they are trying to get away from. */
  await OVERLAY_REF(id).set({ savedHash: hash }, { merge: true });

  const old = await SAVES_REF(id).where("auto", "==", true).orderBy("at", "desc").get();
  const extra = [];
  old.forEach((d, i) => { if (i >= AUTO_KEEP) extra.push(d.ref); });
  await Promise.all(extra.map((r) => r.delete()));
  return true;
}

exports.opalineNightly = onSchedule(
  { schedule: "17 2 * * *", timeZone: "America/New_York", region: "us-central1", retryCount: 1 },
  async () => {
    if (MODE !== "hosted") {
      const did = await saveOneSite("self", "UTC");
      logger.info("nightly", { saved: did });
      return;
    }
    const sites = await db().collection("sites").where("suspended", "==", false).get();
    let saved = 0;
    for (const s of sites.docs) {
      try { if (await saveOneSite(s.id, (s.data() || {}).timeZone)) saved++; }
      catch (err) { logger.error("nightly failed for a site", { site: s.id, message: err.message }); }
    }
    logger.info("nightly", { sites: sites.size, saved: saved });
  }
);
