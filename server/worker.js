/* ==========================================================================
   drmorgan.ai — edge proxy
   Holds the secrets that must never reach the browser.

   Routes
     POST /inquiry  -> Brevo transactional email (the engage form, and the
                       book-list signups, which also join a Brevo contact list)
     POST /ask      -> DeepSeek answer, grounded in the site's own sections

   Secrets (set in the Cloudflare dashboard, never in this file):
     BREVO_API_KEY     Brevo > SMTP & API > API Keys
     DEEPSEEK_API_KEY  platform.deepseek.com > API Keys

   Plain variables:
     BREVO_BOOKLIST_ID  the numeric id of the Brevo list book-list signups
                        join. Optional: without it every signup still arrives
                        as an email, it is simply not filed.
   ========================================================================== */

const ALLOWED = ["https://drmorgan.ai", "https://www.drmorgan.ai"];

// Local development: file:// pages send "null", and dev servers use any port.
const isDev = (o) => o === "null" || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
const allowed = (o) => !o || ALLOWED.includes(o) || isDev(o);
const INBOX = "drmorgan@drmorgan.ai";
const SENDER = { name: "drmorgan.ai", email: "no-reply@drmorgan.ai" }; // must be a verified Brevo sender

const cors = (origin) => ({
  "Access-Control-Allow-Origin": allowed(origin) && origin ? origin : ALLOWED[0],
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
});

const json = (data, status, origin) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors(origin) },
  });

const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const { pathname } = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, origin);
    if (!allowed(origin)) return json({ error: "Forbidden" }, 403, origin);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Bad JSON" }, 400, origin);
    }

    /* ---------------------------------------------------------- /inquiry */
    if (pathname === "/inquiry") {
      // honeypot: bots fill hidden fields, people do not
      if (body.email_address_check) return json({ ok: true }, 200, origin);

      const email = String(body.EMAIL || "").trim();
      const name = String(body.NAME || "").trim();
      const message = String(body.MESSAGE || "").trim();

      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Invalid email" }, 400, origin);
      if (!name || !message) return json({ error: "Missing fields" }, 400, origin);
      if (message.length > 6000 || name.length > 200) return json({ error: "Too long" }, 413, origin);

      // The assistant's hand-off form posts here too, carrying what was already
      // discussed so a reply can pick up rather than start the question again.
      const transcript = String(body.TRANSCRIPT || "").trim().slice(0, 4000);
      const source = String(body.SOURCE || "").trim().slice(0, 60);

      // The book list posts here as well. It is not an enquiry — nobody is
      // waiting for a reply — so it goes into a Brevo contact list if one is
      // configured. The email below is sent either way: an unset list id must
      // lose a signup, not swallow it.
      const list = String(body.LIST || "").trim().slice(0, 80);
      if (list && env.BREVO_BOOKLIST_ID) {
        try {
          await fetch("https://api.brevo.com/v3/contacts", {
            method: "POST",
            headers: { "api-key": env.BREVO_API_KEY, "Content-Type": "application/json", accept: "application/json" },
            body: JSON.stringify({
              email,
              attributes: { FIRSTNAME: name },
              listIds: [Number(env.BREVO_BOOKLIST_ID)],
              updateEnabled: true,        // a second signup is an update, not a 400
            }),
          });
        } catch {
          // Fall through to the email. Being on the list matters less than
          // his knowing somebody asked to be.
        }
      }

      const rows = [
        ["Name", name],
        ["Organization", body.COMPANY],
        ["Role", body.ROLE],
        ["Email", email],
        ["Area of interest", body.INTEREST],
        ["Nature of inquiry", body.NATURE],
        ["Book list", list],
        ["Came from", source],
      ]
        .filter(([, v]) => v)
        .map(([k, v]) => `<tr><td style="padding:4px 14px 4px 0;color:#777">${esc(k)}</td><td>${esc(v)}</td></tr>`)
        .join("");

      const res = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": env.BREVO_API_KEY, "Content-Type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          sender: SENDER,
          to: [{ email: INBOX }],
          replyTo: { email, name },                     // hitting Reply answers the enquirer
          subject: list
            ? `Book list — ${name}`
            : `${source ? "Question" : "Inquiry"} — ${name}${body.COMPANY ? ` · ${body.COMPANY}` : ""}`,
          htmlContent:
            `<div style="font:15px/1.6 -apple-system,Segoe UI,sans-serif;color:#111">` +
            `<table style="border-collapse:collapse;margin-bottom:18px">${rows}</table>` +
            `<div style="white-space:pre-wrap;border-left:3px solid #C9A45C;padding-left:14px">${esc(message)}</div>` +
            (transcript
              ? `<p style="color:#777;font-size:12px;margin:22px 0 6px">What they asked the assistant first</p>` +
                `<div style="white-space:pre-wrap;font-size:13px;color:#555;border-left:2px solid #ddd;padding-left:14px">${esc(transcript)}</div>`
              : "") +
            `<p style="color:#999;font-size:12px;margin-top:22px">Sent from the drmorgan.ai ` +
            `${list ? "book list" : source ? "site assistant" : "engagement portal"}</p></div>`,
        }),
      });

      if (!res.ok) return json({ error: "Send failed" }, 502, origin);
      return json({ ok: true }, 200, origin);
    }

    /* -------------------------------------------------------------- /ask */
    if (pathname === "/ask") {
      const q = String(body.q || "").trim().slice(0, 500);
      if (!q) return json({ error: "Empty question" }, 400, origin);

      // The whole site is only a few thousand tokens, so it is all supplied.
      // Answers stay grounded without depending on retrieval picking correctly.
      const facts = body.facts && typeof body.facts === "object"
        ? Object.entries(body.facts).map(([k, v]) => `${k}: ${v}`).join("\n")
        : "";

      const context = (Array.isArray(body.context) ? body.context : [])
        .slice(0, 60)
        .map((d) => `### ${d.h}  [${d.p}#${d.id}]\n${String(d.t).slice(0, 950)}`)
        .join("\n\n")
        .slice(0, 60000);

      // Posts kept by hand in assets/data/updates.json. Most are excerpts:
      // the logged-out LinkedIn page cuts every body off at about 150
      // characters, so the model is told plainly where the text stops.
      const updates = (Array.isArray(body.updates) ? body.updates : [])
        .slice(0, 12)
        .filter((u) => u && typeof u.text === "string")
        .map((u) => {
          const text = u.text.slice(0, 1200);
          const when = u.date ? `(${String(u.date).slice(0, 40)}) ` : "";
          return `- ${when}${text}${u.truncated ? " [EXCERPT: the rest is not available]" : ""}`;
        })
        .join("\n")
        .slice(0, 8000);

      // Prior turns let people ask follow-ups naturally ("what about speaking?")
      const history = (Array.isArray(body.history) ? body.history : [])
        .slice(-6)
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .map((m) => ({ role: m.role, content: m.content.slice(0, 900) }));

      const messages = [
        {
          role: "system",
          content:
            "You are the assistant on Dr. Ebere Morgan's website. You have been given the KEY FACTS and the FULL " +
            "contents of every page, so answer confidently and specifically from them. Synthesise across sections " +
            "where it helps, and use concrete detail (names, years, sectors, the seven advisory domains) rather " +
            "than vague summary.\n" +
            "Voice: a well-briefed colleague. Warm, direct, plain English. Two to four sentences. " +
            "No bullet points, markdown, headings or emoji. Never use em dashes or en dashes; use commas, colons or full stops. " +
            "Never repeat the question back or open with 'Based on'.\n" +
            "Only decline if the material genuinely does not cover it (fees and client names are deliberately not " +
            "published), then say so plainly in one line and point to the engagement portal. " +
            "Never invent credentials, clients, figures or dates.\n" +
            "RECENT POSTS are what he has been writing publicly. Use them for what he is thinking about lately. " +
            "Any marked [EXCERPT] stops mid-thought: draw on what is actually there and never carry the sentence " +
            "on for him, never present your own continuation as his words, and never claim to know a post's date " +
            "unless one is given.",
        },
        ...history,
        {
          role: "user",
          content:
            `KEY FACTS\n${facts}\n\nSITE CONTENTS\n${context}` +
            (updates ? `\n\nRECENT POSTS\n${updates}` : "") +
            `\n\nQuestion: ${q}`,
        },
      ];

      const upstream = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "deepseek-chat", temperature: 0.3, max_tokens: 380, stream: true, messages }),
      });

      if (!upstream.ok || !upstream.body) return json({ error: "Upstream error" }, 502, origin);

      // Pipe the token stream straight through so text appears as it is written.
      return new Response(upstream.body, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          ...cors(origin),
        },
      });
    }

    return json({ error: "Not found" }, 404, origin);
  },
};
