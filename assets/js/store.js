/* drmorgan.ai — the store
   ==========================================================================
   Three small jobs, and one rule.

   The rule: this file never decides what anything costs and never decides
   who may open anything. It reads the prices from the server that will do
   the charging, and access is granted by the payment webhook talking to
   Wopara — never from this page. A browser that closes on the redirect back
   would otherwise leave somebody who has paid with nothing.

   The jobs:
     1. Fill in the prices, so the shelf and the till cannot disagree.
     2. Send a buyer to Stripe Checkout.
     3. Send somebody who has lost their access email a fresh link.

   The words and the pictures on this page are NOT here. They are in
   store.html, written out as markup, which is what lets them be edited from
   inside the site with Opaline. Anything drawn by this file would be a trap:
   the page would show one thing and the checkout would charge another.
   ========================================================================== */

(function () {
  "use strict";

  /* The store half of the site's own Cloud Functions. Same project as the
     editor; a different function, because one of them mints access and the
     other only lays words over a page. */
  var STORE_API = "https://us-central1-drmorgan-site.cloudfunctions.net/store";

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function post(action, body) {
    return fetch(STORE_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ action: action }, body || {}))
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) throw Object.assign(new Error(data.error || "That did not work."), { status: r.status, data: data });
        return data;
      });
    });
  }

  function money(amount, currency) {
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency", currency: currency || "USD",
        minimumFractionDigits: amount % 100 === 0 ? 0 : 2
      }).format(amount / 100);
    } catch (e) {
      return "$" + (amount / 100).toFixed(2);
    }
  }

  /* ----------------------------------------------------------------- prices
     Written into the page from the same figures the checkout will use. Until
     they arrive the button says so rather than offering to sell something at
     a price nobody has confirmed. */

  var catalog = {};

  function fillPrices() {
    return post("catalog").then(function (data) {
      catalog = {};
      (data.products || []).forEach(function (p) { catalog[p.id] = p; });

      $$("[data-price]").forEach(function (slot) {
        var p = catalog[slot.getAttribute("data-price")];
        slot.textContent = p ? money(p.amount, p.currency) : "—";
      });

      $$("[data-buy]").forEach(function (btn) {
        var id = btn.getAttribute("data-buy");
        var known = !!catalog[id];
        btn.disabled = !known;
        if (!known) {
          btn.setAttribute("aria-disabled", "true");
          note(btn, "This title is not on sale yet.");
        }
      });
      return data;
    }).catch(function () {
      /* The shop is not open. Say that, rather than showing a price that
         might be wrong or a button that leads nowhere. */
      $$("[data-buy]").forEach(function (btn) {
        btn.disabled = true;
        btn.setAttribute("aria-disabled", "true");
        note(btn, "The shop is being switched on. Email drmorgan@drmorgan.ai and it will be sent to you by hand in the meantime.");
      });
    });
  }

  function note(fromBtn, message) {
    var box = fromBtn.closest("[data-product]");
    var slot = box && $("[data-store-note]", box);
    if (slot) slot.textContent = message;
  }

  /* ------------------------------------------------------------------ buying
     Stripe collects the email itself, so there is no form here. The address
     that pays is the address that gets the link, which is the only pairing
     that cannot go wrong. */

  function buy(btn) {
    var id = btn.getAttribute("data-buy");
    if (!catalog[id]) return;

    var was = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = "Taking you to checkout…";

    post("checkout", {
      productId: id,
      returnTo: location.origin + location.pathname
    }).then(function (data) {
      if (data && data.url) { location.href = data.url; return; }
      throw new Error("No checkout was returned.");
    }).catch(function (err) {
      btn.disabled = false;
      btn.innerHTML = was;
      note(btn, (err && err.message) || "Checkout could not be opened just now. Please try again in a moment.");
    });
  }

  /* --------------------------------------------------------------- returning
     Stripe sends the buyer back here. This says what to expect; it does NOT
     grant anything, and it deliberately does not claim the email has already
     arrived, because the webhook may still be in flight. */

  function afterCheckout() {
    if (!/[?&]bought=1/.test(location.search)) return;
    var shelf = $("[data-shelf]");
    if (!shelf) return;

    var box = document.createElement("div");
    box.className = "stack";
    box.style.cssText = "border:1px solid var(--hairline);border-radius:var(--r-lg);padding:clamp(1.5rem,3vw,2.25rem)";
    box.innerHTML =
      '<p class="kicker kicker--bare">Thank you</p>' +
      '<h3 class="mid">Your link is on its way</h3>' +
      '<p class="lede">Watch the inbox of the address you paid with. The email holds a private link that opens your desktop on wopara.com; the first time you follow it, your email is already filled in and you choose a password.</p>' +
      '<p class="note">Nothing after a few minutes? Check the spam folder, then ask for a fresh link below.</p>' +
      '<div><a class="btn btn--ghost" href="#access">Ask for a fresh link</a></div>';
    shelf.parentNode.insertBefore(box, shelf);
    box.scrollIntoView({ behavior: "smooth", block: "center" });

    /* Taken out of the address bar, so a refresh or a shared link does not
       tell somebody else they have bought something. */
    if (history.replaceState) history.replaceState({}, "", location.pathname + "#shelf");
  }

  /* ---------------------------------------------------------------- recovery
     The reply is the same whether or not that address owns anything. That is
     the point: otherwise this box would tell anyone who typed an address into
     it whether that person had bought a book. */

  function wireResend() {
    var form = $("[data-resend]");
    if (!form) return;
    var status = $("[data-resend-status]", form);
    var button = $("button[type=submit]", form);

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (form.querySelector("#r-check") && form.querySelector("#r-check").value) return; // a bot filled the hidden field
      var email = (form.querySelector("#r-email") || {}).value || "";

      button.disabled = true;
      status.textContent = "Sending…";

      post("resend", { email: email }).then(function () {
        status.textContent = "If that address has bought something, a fresh link is on its way to it.";
        form.reset();
      }).catch(function (err) {
        status.textContent = (err && err.message) ||
          "That could not be sent just now. Email drmorgan@drmorgan.ai and it will be dealt with by hand.";
      }).then(function () {
        button.disabled = false;
      });
    });
  }

  /* -------------------------------------------------------------------- boot */

  function start() {
    if (!$("[data-shelf]")) return;   // not the store page
    fillPrices();
    afterCheckout();
    wireResend();

    /* Delegated, so a title added later from inside the editor is buyable
       without this file being touched. */
    document.addEventListener("click", function (e) {
      var btn = e.target.closest && e.target.closest("[data-buy]");
      if (!btn || btn.disabled) return;
      e.preventDefault();
      buy(btn);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
