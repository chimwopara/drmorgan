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

/* Self-hosted: the domains this one site is served from, and null below.
   Hosted: leave ORIGINS empty — each site brings its own. */
const ORIGINS = [
  "https://drmorgan.ai",
  "https://www.drmorgan.ai"
];

/* Set to "hosted" to run one function for many sites. */
const MODE = "self";

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

/* A token is its own proof: an expiry, signed with a key derived from the
   password. Nothing is stored, so nothing can be read, and changing the
   password changes the key and so retires every token at once. */
/* A token is signed with a key derived from the site AND its password, so
   a token is useless against any other site, and changing a password
   retires every token issued under the old one. */
function signingKey(site) {
  const held = passwordHash(site);
  if (!held) return null;
  return crypto.createHmac("sha256", "opaline-v1:" + site.id).update(held).digest();
}

function mintToken(site) {
  const key = signingKey(site);
  if (!key) return null;
  const expires = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const sig = crypto.createHmac("sha256", key).update(String(expires)).digest("hex");
  return { token: expires + "." + sig, expires: expires };
}

function tokenValid(token, site) {
  const key = signingKey(site);
  if (!key || typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const expires = Number(token.slice(0, dot));
  if (!isFinite(expires) || expires < Date.now()) return false;
  const sig = crypto.createHmac("sha256", key).update(String(expires)).digest("hex");
  return sameSecret(sig, token.slice(dot + 1));
}

function db() {
  ensureAdmin();
  return admin.firestore();
}

const OVERLAY_REF = (site) => db().collection("sites").doc(site).collection("state").doc("overlay");
const SAVES_REF = (site) => db().collection("sites").doc(site).collection("saves");

const EMPTY_OVERLAY = { v: 1, globals: {}, pages: {}, newPages: {}, popups: [] };

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
  "Use the palette variables (var(--wine), var(--forest), var(--gold), var(--ink)) where a colour is wanted.",
  "If the request is not something these ops can do, return an empty ops array and say so kindly in reply."
  ].join("\n");
}

async function askDeepSeek(prompt, context, key, site) {
  const messages = [
    { role: "system", content: aiSystem(site) },
    { role: "user", content: "Elements on " + (context.page || "this page") + ":\n" + context.outline + "\n\nBusayo asks: " + prompt }
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
    secrets: [EDITOR_PASSWORD, DEEPSEEK_API_KEY],
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
      if (action === "login") {
        /* Slow enough that guessing is not worth anyone's afternoon. */
        if (tooOften("in:" + site.id + ":" + ip, 8, 10 * 60 * 1000)) {
          res.status(429).json({ error: "Too many tries. Please wait ten minutes." });
          return;
        }
        const want = passwordHash(site);
        if (!want) {
          logger.error("login attempted for a site with no password set", { site: site.id });
          res.status(503).json({ error: "Editing is not switched on for this site yet." });
          return;
        }
        if (!sameSecret(sha256(String(body.password || "")), want)) {
          logger.warn("login refused", { site: site.id, ip: ip });
          res.status(401).json({ error: "That password is not right." });
          return;
        }
        const t = mintToken(site);
        res.status(200).json({ ok: true, token: t.token, expires: t.expires });
        return;
      }

      /* Everything past this point changes the site. */
      if (!tokenValid(body.token, site)) {
        res.status(401).json({ error: "Your editing session has ended. Please sign in again." });
        return;
      }

      if (action === "state") {
        const cur = await readOverlay(site.id);
        const snap = await SAVES_REF(site.id).orderBy("at", "desc").limit(MAX_SAVES).get();
        const saves = [];
        snap.forEach((d) => { const v = d.data(); saves.push({ id: d.id, name: v.name, at: v.at }); });
        res.status(200).json({
          ok: true,
          overlay: cur.doc,
          updatedAt: cur.updatedAt,
          saves: saves,
          reserves: await balanceOf(site),
          ledger: await recentLedger(site),
          /* False means restoring is refused until she has saved: the whole
             point of that guard. */
          currentIsSaved: !!cur.savedHash && cur.savedHash === sha256(cur.json)
        });
        return;
      }

      if (action === "publish") {
        const json = normaliseOverlay(body.overlay);
        const before = await readOverlay(site.id);

        /* Publishing what is already published is not a publish. She may
           press it twice, or press it having undone everything she did
           since; neither should cost her anything. */
        if (before.json === json) {
          res.status(200).json({
            ok: true, updatedAt: before.updatedAt, spent: 0,
            reserves: await balanceOf(site),
            currentIsSaved: !!before.savedHash && before.savedHash === sha256(before.json)
          });
          return;
        }

        await OVERLAY_REF(site.id).set({ json: json, updatedAt: Date.now() }, { merge: true });
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
          outline: String((body.context && body.context.outline) || "").slice(0, 24000)
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
