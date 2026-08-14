/* Wopara Opaline | the editor
   ---------------------------------------------------------------------
   The owner's workbench. Fetched only once the password has been accepted,
   so a reader never downloads a byte of it.

   Nothing here writes to the pages. Every change is written into the
   overlay document that opaline-overlay.js lays over the markup, which is
   what makes undo possible at all: undoing is not repairing a page, it is
   putting back an earlier version of one JSON document and laying it down
   again.

   Three ideas hold the whole thing up.

   Addresses      Every element can be named — see opaline-overlay.js. The
                  moment an element takes part in anything structural it
                  is pinned: given a name of its own, so that moving its
                  neighbours cannot change what its name refers to.

   The baseline   Before an element is touched for the first time, what it
                  said and how it looked is kept in memory. Laying a
                  version down means putting every touched element back to
                  its baseline first, then applying whatever that version
                  asks for. Without this, undo could remove an instruction
                  but not its effect.

   Two ledgers    What she is working on, and what the world is seeing.
                  Publish moves the first onto the second. Save files a
                  named copy she can come back to, and restoring is
                  refused until the state being left has itself been
                  saved.
   ========================================================================== */

(function () {
  "use strict";

  var OV = window.Opaline;
  if (!OV) return;

  var ENDPOINT = OV.endpoint;
  var SITE = OV.site || null;
  var TOKEN_KEY = "opl-editor-token" + (SITE ? ":" + SITE : "");

  /* Everything the host site was allowed to decide. A missing config is a
     valid config: every field has a working default, and the ones that
     matter most are read off the page instead. */
  var CONFIG = OV.config || {};
  var BRAND = Object.assign(
    { name: "Opaline", logo: "https://wopara.com/opaline/wopara.png" },
    CONFIG.brand || {}
  );

  var token = null;
  var doc = OV.empty();        // what she is working on
  var published = OV.empty();  // what the world is seeing
  var saves = [];
  var currentIsSaved = false;

  /* What is left, and what the last thing cost. Infinity on a site that
     hosts its own — nobody is metering their own Firebase. */
  var reserves = Infinity;
  var ledger = [];

  var history = [];
  var hIndex = -1;
  var selected = null;
  var booted = false;

  /* Restored before each version is laid down, so an undone edit leaves
     nothing of itself behind. */
  var baseline = {};
  var orderBaseline = {};

  /* While she is typing in the panel or dragging one of its sliders, the
     page has to change under her hand. Laying a version down rebuilds the
     panel, though, which would take the very box she is typing in out from
     under her mid-word. So a live edit renders the page and leaves the
     panel standing; the panel catches up when she lets go. */
  var holdPanel = false;
  var liveTag = null;
  var liveAt = 0;

  /* Looking at the published site rather than at her own copy of it. The
     page really is rendered from the published document while this is on,
     which is the only honest way to show a before. */
  var peeking = false;
  var heldDoc = null;

  /* Her working copy, kept where she left it. */
  var draftTimer = null;
  var draftState = "";     // "" | "keeping" | "kept" | "adrift"

  /* ------------------------------------------------------------------
     Small helpers
     ------------------------------------------------------------------ */

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function rid(prefix) {
    return prefix + Math.random().toString(36).slice(2, 9);
  }

  function copy(v) { return JSON.parse(JSON.stringify(v)); }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function toast(message, bad) {
    var t = document.getElementById("opl-toast") || (function () {
      var n = el("div");
      n.id = "opl-toast";
      document.body.appendChild(n);
      return n;
    })();
    t.textContent = message;
    t.className = bad ? "bad on" : "on";
    clearTimeout(t._away);
    t._away = setTimeout(function () { t.className = bad ? "bad" : ""; }, bad ? 6000 : 2800);
  }

  function post(payload) {
    return fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ token: token, site: SITE }, payload))
    }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok) throw Object.assign(new Error(data.error || "That did not work."), { status: r.status, data: data });
        return data;
      });
    });
  }

  /* ------------------------------------------------------------------
     The overlay document, and the page we are standing on
     ------------------------------------------------------------------ */

  function pageKey() { return OV.currentPage(); }

  function pageDoc(key) {
    var k = key || pageKey();
    if (!doc.pages) doc.pages = {};
    if (!doc.pages[k]) doc.pages[k] = {};
    var p = doc.pages[k];
    if (!p.nodes) p.nodes = {};
    if (!p.pins) p.pins = {};
    if (!p.inserts) p.inserts = [];
    if (!p.order) p.order = {};
    return p;
  }

  /* What each element said before it was touched, taken at capture time —
     the last moment the original wording is still on the page. It rides
     with the edit so that js/opaline-overlay.js can find the element again
     by its words if the markup has moved under us. On a site we did not
     build, that is the difference between an edit surviving a theme update
     and quietly doing nothing. */
  var marks = {};

  function nodeEdit(id) {
    var p = pageDoc();
    if (!p.nodes[id]) p.nodes[id] = {};
    if (!p.nodes[id].find && marks[id]) p.nodes[id].find = marks[id];
    return p.nodes[id];
  }

  /* Told, or worked out. A site that lists its pages in the config gets
     exactly those; any other has them read off its own navigation, which
     is where a site keeps that list anyway. */
  var SITE_PAGES = (function () {
    if (CONFIG.pages && CONFIG.pages.length) return CONFIG.pages.slice();
    var seen = {};
    var out = [];
    document.querySelectorAll("header a[href], nav a[href], footer a[href]").forEach(function (a) {
      var href = (a.getAttribute("href") || "").split("#")[0];
      if (!href || /^(https?:|mailto:|tel:|javascript:)/.test(href)) return;
      var name = href.replace(/^\.?\//, "");
      if (!name || seen[name]) return;
      seen[name] = true;
      out.push(name);
    });
    var here = OV.currentPage();
    if (out.indexOf(here) === -1) out.unshift(here);
    return out;
  })();

  function allPages() {
    var list = SITE_PAGES.slice();
    Object.keys(doc.newPages || {}).forEach(function (slug) { list.push("p/" + slug); });
    return list;
  }

  /* ------------------------------------------------------------------
     Pinning. An element about to take part in a move, a copy or an
     insertion gets a name of its own first, and the counted address that
     found it is filed so the name can be reattached on the next visit.
     ------------------------------------------------------------------ */

  function pin(node) {
    if (!node) return null;
    var already = node.getAttribute("data-opl-id");
    if (already) return already;

    var path = OV.nodeId(node);
    var name = rid("k-");
    var p = pageDoc();
    p.pins[path] = name;
    node.setAttribute("data-opl-id", name);

    /* Anything already said about it under the counted address now belongs
       to the name, or the edit would be orphaned the moment it moves. */
    if (p.nodes[path]) { p.nodes[name] = p.nodes[path]; delete p.nodes[path]; }
    if (baseline[path]) baseline[name] = baseline[path];
    return name;
  }

  /* Moving one child of a row changes what every counted address in that
     row refers to, so the whole row is named at once or not at all. */
  function pinRow(parent) {
    var out = [];
    var kids = Array.prototype.slice.call(parent.children);
    kids.forEach(function (k) {
      if (k.id && k.id.indexOf("opl-") === 0) return;
      out.push(pin(k));
    });
    return out;
  }

  function recordOrder(parent) {
    var parentId = pin(parent);
    var ids = pinRow(parent);
    if (!orderBaseline[parentId]) orderBaseline[parentId] = ids.slice();
    pageDoc().order[parentId] = ids;
  }

  /* ------------------------------------------------------------------
     The baseline
     ------------------------------------------------------------------ */

  var KEPT_ATTRS = ["href", "alt", "title", "src", "target", "rel", "aria-label"];

  function capture(node, wantHtml) {
    if (!node) return null;
    var id = OV.nodeId(node);
    /* Before the early return, and before anything is changed: this is the
       last moment the element still says what it originally said, and that
       is the whole value of writing it down. */
    if (!marks[id]) marks[id] = OV.fingerprint(node);
    if (baseline[id]) return id;
    var b = { style: node.getAttribute("style"), attrs: {} };
    /* Only the leaves keep their markup. Restoring a container's innerHTML
       would throw away the listeners the site's own script hung inside it. */
    if (wantHtml || node.getAttribute("data-opl-e") === "text") b.html = node.innerHTML;
    KEPT_ATTRS.forEach(function (a) { b.attrs[a] = node.getAttribute(a); });
    baseline[id] = b;
    return id;
  }

  /* On a fresh sign-in the page has already been overwritten by the overlay,
     so capturing a "before" now would capture the after. opaline-overlay.js kept
     the real one at the moment it did the overwriting; this borrows it, so
     that putting one thing back works in a session that never saw the
     untouched page. */
  /* Give an edit a permanent name and move it there, keeping everything
     that was said about it. Used when the counted address has stopped
     working and only the fingerprint found the element — from now on it
     carries an explicit name and neither is needed. */
  function rehome(oldId, node) {
    if (!node || node.getAttribute("data-opl-id")) return;
    var p = pageDoc();
    var name = rid("k-");
    p.pins[OV.nodeId(node)] = name;
    node.setAttribute("data-opl-id", name);

    if (p.nodes[oldId]) { p.nodes[name] = p.nodes[oldId]; delete p.nodes[oldId]; }
    if (baseline[oldId]) baseline[name] = baseline[oldId];
    if (marks[oldId]) marks[name] = marks[oldId];

    (p.inserts || []).forEach(function (e) {
      if (e.after === oldId) e.after = name;
      if (e.parent === oldId) e.parent = name;
    });
    Object.keys(p.order || {}).forEach(function (parentId) {
      p.order[parentId] = p.order[parentId].map(function (c) { return c === oldId ? name : c; });
      if (parentId === oldId) { p.order[name] = p.order[oldId]; delete p.order[oldId]; }
    });
  }

  /* Anything the markup moved out from under, put back on solid ground —
     and a plain word about anything that could not be found at all, rather
     than letting her wonder why a change she remembers making is not
     there. */
  function healAndReport() {
    var health = OV.health();
    var moved = 0;

    Object.keys(pageDoc().nodes).forEach(function (id) {
      if (OV.howFound(id) !== "words") return;
      var node = OV.resolve(id, pageDoc().nodes[id]);
      if (node) { rehome(id, node); moved++; }
    });

    if (moved) {
      published = copy(doc);          // a rename changes nothing anybody can see
      post({ action: "publish", overlay: doc }).catch(function () { });
      history = [copy(doc)];
      hIndex = 0;
    }
    if (health.lost) {
      toast(health.lost + " of your changes could not find what they belonged to. " +
        "The page may have been rebuilt. See What I\u2019ve changed.", true);
    }
    return health;
  }

  function seedBaseline() {
    var nodes = pageDoc().nodes;
    Object.keys(nodes).forEach(function (id) {
      if (baseline[id]) return;
      var was = OV.originalOf(id);
      if (was) baseline[id] = was;
    });
  }

  function restoreBaseline() {
    Object.keys(baseline).forEach(function (id) {
      var node = OV.resolve(id);
      if (!node) return;
      var b = baseline[id];
      if (typeof b.html === "string" && node.innerHTML !== b.html) {
        node.innerHTML = b.html;
        node.removeAttribute("data-opl-video");
        node.classList.remove("opl-video");
      }
      if (b.style === null) node.removeAttribute("style"); else node.setAttribute("style", b.style);
      KEPT_ATTRS.forEach(function (a) {
        if (b.attrs[a] === null) node.removeAttribute(a);
        else node.setAttribute(a, b.attrs[a]);
      });
      node.removeAttribute("data-opl-hidden");
    });

    /* Rows put back the way they were found, so undoing a reorder is a
       reorder rather than a half-order. */
    Object.keys(orderBaseline).forEach(function (parentId) {
      var parent = OV.resolve(parentId);
      if (!parent) return;
      orderBaseline[parentId].forEach(function (cid) {
        var child = OV.resolve(cid);
        if (child && child.parentElement === parent) parent.appendChild(child);
      });
    });

    /* Copies and additions that this version no longer asks for. */
    var wanted = {};
    Object.keys(doc.pages || {}).forEach(function (k) {
      (doc.pages[k].inserts || []).forEach(function (e) { wanted[e.id] = true; });
    });
    var made = document.querySelectorAll('[data-opl-id^="x-"]');
    for (var i = 0; i < made.length; i++) {
      var name = made[i].getAttribute("data-opl-id");
      if (!wanted[name] && made[i].parentNode) made[i].parentNode.removeChild(made[i]);
    }
  }

  /* ------------------------------------------------------------------
     Laying a version down
     ------------------------------------------------------------------ */

  function render() {
    var keepId = selected ? OV.nodeId(selected) : null;
    restoreBaseline();
    OV.set(doc);
    mark();
    if (keepId) {
      var again = OV.resolve(keepId);
      if (again) select(again, true); else clearSelection();
    }
    refreshBar();
    /* Every version she arrives at is put somewhere she can get it back
       from, on this machine or any other. Not while she is looking at the
       published site, which is not her work and must not overwrite it. */
    if (booted && !peeking) queueDraft();
  }

  function push() {
    /* A step that changed nothing must not take a place in the history, or
       pressing undo once would appear to do nothing at all — the version it
       arrived at being the one already on the screen. Panels can fire the
       same change twice, so this is not a rare case. */
    if (peeking) return;
    liveTag = null;
    if (hIndex >= 0 && JSON.stringify(history[hIndex]) === JSON.stringify(doc)) { render(); return; }

    history = history.slice(0, hIndex + 1);
    history.push(copy(doc));
    if (history.length > 80) history.shift();
    hIndex = history.length - 1;
    render();
  }

  /* A version laid down while her hand is still on the control that is
     making it.

     Two things differ from an ordinary push. The panel is held still, so
     the slider she is dragging or the box she is typing in survives the
     render. And a run of these from the same control collapses into a
     single step, because dragging one slider is one thing to undo, not
     forty of them.

     The run ends when she moves to another control, or after a second and
     a half of stillness, whichever comes first. */
  function pushLive(tag) {
    if (peeking) return;
    var now = Date.now();
    var run = tag && tag === liveTag && (now - liveAt) < 1500 && hIndex > 0;

    holdPanel = true;
    if (run) { history[hIndex] = copy(doc); render(); }
    else push();
    holdPanel = false;

    liveTag = tag;
    liveAt = now;
  }

  function undo() {
    if (hIndex <= 0) return;
    hIndex--;
    doc = copy(history[hIndex]);
    liveTag = null;
    render();
    toast("Undone");
  }

  function redo() {
    if (hIndex >= history.length - 1) return;
    hIndex++;
    doc = copy(history[hIndex]);
    liveTag = null;
    render();
    toast("Redone");
  }

  function dirty() { return JSON.stringify(doc) !== JSON.stringify(published); }

  /* ------------------------------------------------------------------
     Keeping her working copy
     ------------------------------------------------------------------
     Everything she does is kept as she does it, in the same place the
     published site is kept, and none of it is public. So an afternoon's
     work on a phone is waiting for her on a laptop that evening, and an
     afternoon's work interrupted is still there next week. It becomes the
     site the moment she presses Publish and not one moment sooner, which
     is the whole point: she can leave something half said.
     ------------------------------------------------------------------ */

  function queueDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 1400);
  }

  function saveDraft() {
    if (!token || !booted) return;
    var sending = JSON.stringify(doc);
    draftState = "keeping";
    refreshBar();
    post({ action: "draft", overlay: doc })
      .then(function () {
        /* If she has typed on since this went out, the thing that was kept
           is already behind her: the next save is what will say "kept". */
        draftState = JSON.stringify(doc) === sending ? "kept" : "keeping";
        refreshBar();
      })
      .catch(function () {
        draftState = "adrift";
        refreshBar();
      });
  }

  /* Everything unpublished, thrown away on purpose. */
  function dropDraft() {
    if (!confirm("Throw away everything you have changed since the last publish? The published site is not touched.")) return;
    clearTimeout(draftTimer);
    post({ action: "dropDraft" }).catch(function () { });
    doc = copy(published);
    history = [copy(doc)];
    hIndex = 0;
    draftState = "";
    render();
    toast("Thrown away. You are back to the published site.");
  }

  /* ------------------------------------------------------------------
     Looking at the before
     ------------------------------------------------------------------
     The page is rendered from the published document instead of hers, so
     what she sees is what a visitor is seeing right now, in place, at full
     size. Nothing is recorded while she looks, and her own copy is held
     untouched until she comes back to it.
     ------------------------------------------------------------------ */

  function peek(on) {
    if (!!on === peeking) return;
    if (on) { heldDoc = doc; doc = copy(published); }
    else { doc = heldDoc; heldDoc = null; }
    peeking = !!on;
    render();
    document.body.classList.toggle("opl-peeking", peeking);

    var pill = document.getElementById("opl-peek");
    if (!pill) {
      pill = el("div");
      pill.id = "opl-peek";
      pill.innerHTML = '<span>This is the site as it is published now.</span>' +
        '<button class="opl-btn primary" type="button">Back to my changes</button>';
      pill.querySelector("button").onclick = function () { peek(false); };
      document.body.appendChild(pill);
    }
    pill.classList.toggle("on", peeking);

    /* She came here from a list she was reading. Put her back in it. */
    if (!peeking && peekBack) {
      var back = peekBack;
      peekBack = null;
      back();
    }
  }

  /* ------------------------------------------------------------------
     Marking what can be edited
     ------------------------------------------------------------------ */

  var INLINE = { A: 1, EM: 1, STRONG: 1, SPAN: 1, BR: 1, B: 1, I: 1, U: 1, SMALL: 1, SUP: 1, SUB: 1, CODE: 1, MARK: 1, ABBR: 1, TIME: 1, CITE: 1, Q: 1, S: 1, WBR: 1, SVG: 1 };
  var TEXTY = { H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, P: 1, LI: 1, BLOCKQUOTE: 1, FIGCAPTION: 1, TD: 1, TH: 1, DT: 1, DD: 1, LABEL: 1, SUMMARY: 1, A: 1, BUTTON: 1, SPAN: 1, STRONG: 1, EM: 1, SMALL: 1, CITE: 1, LEGEND: 1, ADDRESS: 1, CAPTION: 1 };
  var BLOCKY = { SECTION: 1, ARTICLE: 1, ASIDE: 1, HEADER: 1, FOOTER: 1, NAV: 1, FIGURE: 1, UL: 1, OL: 1, DL: 1, TABLE: 1, MAIN: 1, DIV: 1, PICTURE: 1, TR: 1, TBODY: 1, DETAILS: 1, VIDEO: 1 };
  var NEVER = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, LINK: 1, META: 1, TITLE: 1, HEAD: 1, BASE: 1, TEMPLATE: 1, SOURCE: 1, BR: 1, HR: 1, INPUT: 1, TEXTAREA: 1, SELECT: 1, OPTION: 1, PATH: 1, CIRCLE: 1, RECT: 1, G: 1, DEFS: 1 };

  /* Controls, not content. She has no reason to restyle the theme switch or
     the Ask button, and every reason to press them while she works — the
     colours she picks resolve differently in light and dark, so she needs to
     see both. Marking them as editable meant a click selected them instead
     of pressing them, and the theme could not be changed at all while
     editing. The burger is here for the same reason: on a phone it is the
     only way to reach the menu whose contents she may want to edit. */
  var CONTROLS = "[data-theme-toggle], [data-ask], [data-opaline], #chat-launcher, .menu-btn, .menu-scrim, .skip-link" +
    (CONFIG.controls ? ", " + CONFIG.controls : "");

  /* On a phone the inspector is a sheet across the bottom of the screen.
     Anything selected in the lower half is behind it the moment it opens —
     she taps a paragraph and it disappears under the panel that exists to
     change it. Lifted into the strip that is still showing. Only ever
     upward, and only when it is actually hidden, so a tap near the top of
     the screen does not make the page jump for no reason. */
  function keepInView(node) {
    var visible = window.innerHeight * 0.38;      // what the sheet leaves
    var box = node.getBoundingClientRect();
    if (box.top >= 64 && box.bottom <= visible) return;
    var to = window.scrollY + box.top - Math.max(72, visible * 0.3);
    window.scrollTo({ top: Math.max(0, to), behavior: "smooth" });
  }

  /* How much room the end of the page needs so the bar is not standing on
     it, and what colour that room should be.

     Measured from the bar itself rather than written down, because it is
     one row on a laptop and two on a narrow window, and a number typed
     here would be wrong on one of them. */
  function fitTail() {
    var bar = document.getElementById("opl-bar");
    if (!bar) return;

    var tail = document.getElementById("opl-tail");
    if (!tail) {
      tail = el("div");
      tail.id = "opl-tail";
      tail.setAttribute("aria-hidden", "true");
      document.body.appendChild(tail);
    }
    tail.style.height = (bar.offsetHeight + 34) + "px";

    /* The strip continues whatever the page ends in — nearly always the
       footer — so it reads as part of it. Walked backwards past anything
       see-through, or a transparent last element would hand back nothing
       and leave a band of the body's own colour under a dark footer. */
    var kids = document.body.children;
    for (var i = kids.length - 1; i >= 0; i--) {
      var node = kids[i];
      if (isChrome(node)) continue;
      var bg = getComputedStyle(node).backgroundColor;
      if (bg && bg !== "transparent" && !/rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/.test(bg)) {
        tail.style.background = bg;
        return;
      }
    }
    tail.style.background = "transparent";
  }

  /* How far down the bar has to start on a phone.

     The bar sits at the top there, because the inspector has the bottom —
     and that is exactly where a site puts its fixed header. On both of
     Wopara's own sites that header carries the burger, which on a phone is
     the only way into the menu whose wording she may want to change, so the
     bar was covering the one control she cannot do without.

     Measured, not guessed: whatever is actually fixed or sticky across the
     top of THIS page decides it, because no two sites put their header at
     the same height. Nothing fixed up there means nothing to clear. */
  function clearFixedChrome() {
    var root = document.documentElement;
    if (window.innerWidth > 720) { root.style.removeProperty("--opl-top-clear"); return; }

    var lowest = 0;
    var all = document.body.getElementsByTagName("*");
    for (var i = 0; i < all.length && i < 400; i++) {
      var node = all[i];
      if (isChrome(node)) continue;
      var cs = getComputedStyle(node);
      if (cs.position !== "fixed" && cs.position !== "sticky") continue;
      var box = node.getBoundingClientRect();
      /* Across the top and wide enough to be chrome. A fixed button in a
         corner is not a header and must not push the bar down the screen. */
      if (box.height === 0 || box.top > 90 || box.width < window.innerWidth * 0.5) continue;
      if (box.bottom > lowest) lowest = box.bottom;
    }
    root.style.setProperty("--opl-top-clear", Math.round(Math.max(0, lowest)) + "px");
  }

  function isChrome(node) {
    var n = node;
    var guard = 0;
    while (n && guard++ < 60) {
      if (n.id && n.id.indexOf("opl-") === 0) return true;
      /* A list of posts is drawn from the posts themselves on every apply.
         Editing a word in one would last until the next render and no
         longer, so the words are not offered here — they are changed on
         the post, which is the only place they exist. */
      if (n.hasAttribute && n.hasAttribute("data-opl-skip")) return true;
      if (n.id === "chat-launcher" || n.id === "chat-panel") return true;
      if (n.classList && (n.classList.contains("opl-popup") || n.classList.contains("site-index-fallback"))) return true;
      if (n.matches && n.matches(CONTROLS)) return true;
      n = n.parentElement;
    }
    return false;
  }

  function kindOf(node) {
    var tag = node.tagName;
    if (NEVER[tag]) return null;
    if (tag === "IMG") return "img";
    if (OV.isVideoFrame(node)) return "video";
    if (node.namespaceURI && node.namespaceURI.indexOf("svg") !== -1) return null;

    if (TEXTY[tag]) {
      var onlyInline = true;
      for (var i = 0; i < node.children.length; i++) {
        if (!INLINE[node.children[i].tagName]) { onlyInline = false; break; }
      }
      if (onlyInline && node.textContent.trim()) return "text";
    }
    if (BLOCKY[tag] && node.children.length) return "block";
    if (BLOCKY[tag] && /url\(/.test(getComputedStyle(node).backgroundImage || "")) return "block";
    return null;
  }

  function mark() {
    var all = document.body.getElementsByTagName("*");
    for (var i = 0; i < all.length; i++) {
      var node = all[i];
      if (isChrome(node)) continue;
      var kind = kindOf(node);
      if (kind) {
        if (node.getAttribute("data-opl-e") !== kind) node.setAttribute("data-opl-e", kind);
      } else if (node.hasAttribute("data-opl-e")) {
        node.removeAttribute("data-opl-e");
      }
    }
  }

  function unmark() {
    var all = document.querySelectorAll("[data-opl-e], [data-opl-sel]");
    for (var i = 0; i < all.length; i++) {
      all[i].removeAttribute("data-opl-e");
      all[i].removeAttribute("data-opl-sel");
    }
  }

  function labelOf(node) {
    var text = (node.textContent || "").replace(/\s+/g, " ").trim();
    if (text) return text.slice(0, 44) + (text.length > 44 ? "…" : "");
    if (node.tagName === "IMG") return (node.getAttribute("alt") || node.getAttribute("src") || "picture").split("/").pop();
    return node.tagName.toLowerCase() + (node.className && typeof node.className === "string" ? "." + node.className.split(" ")[0] : "");
  }

  /* ------------------------------------------------------------------
     Selecting
     ------------------------------------------------------------------ */

  function clearSelection() {
    if (selected) {
      selected.removeAttribute("data-opl-sel");
      if (selected.getAttribute("contenteditable")) stopTyping(selected);
    }
    selected = null;
    var panel = document.getElementById("opl-panel");
    if (panel) {
      panel.classList.remove("open");
      /* The panel slides out but stays in the document, and every control
         in it still answers a click. One landing during the slide called
         setStyle with nothing selected and threw. Emptying it means there
         is nothing left to press. */
      var body = panel.querySelector(".opl-panel-body");
      var head = panel.querySelector(".opl-panel-head div");
      if (body) body.innerHTML = "";
      if (head) head.innerHTML = "";
    }
    document.body.classList.remove("opl-panel-open");
  }

  /* Every path that writes to the document goes through here first. A stale
     control, a keyboard shortcut after a deselect, an op from the assistant
     naming something that has since gone — all of them arrive with nothing
     selected, and all of them used to throw. */
  function haveSelection() {
    if (selected && selected.isConnected) return true;
    selected = null;
    toast("Click something on the page first.", true);
    return false;
  }

  function select(node, quiet) {
    if (selected && selected !== node) {
      selected.removeAttribute("data-opl-sel");
      if (selected.getAttribute("contenteditable")) stopTyping(selected);
    }
    selected = node;
    node.setAttribute("data-opl-sel", "");
    /* Held still while a live edit is in flight, so the control her hand is
       on is still there when the page has finished changing. */
    if (!holdPanel) buildPanel();
    if (!quiet) {
      var panel = document.getElementById("opl-panel");
      panel.classList.add("open");
      if (window.innerWidth > 720) document.body.classList.add("opl-panel-open");
      else keepInView(node);
    }
  }

  function onPageClick(e) {
    if (isChrome(e.target)) return;
    /* What she is looking at is the published site, not her copy of it.
       Selecting something here would offer to edit a page that is about to
       be thrown away and replaced by her own. */
    if (peeking) return;
    var hit = e.target.closest("[data-opl-e]");
    if (!hit) return;
    /* Links and buttons would otherwise carry her off the page she is
       editing the moment she tried to select one. */
    e.preventDefault();
    e.stopPropagation();
    if (selected === hit && hit.getAttribute("data-opl-e") === "text") { startTyping(hit); return; }
    select(hit);
  }

  var tag = null;
  function onPageMove(e) {
    if (!tag) return;
    if (isChrome(e.target)) { tag.classList.remove("on"); return; }
    var hit = e.target.closest("[data-opl-e]");
    if (!hit) { tag.classList.remove("on"); return; }
    var kind = hit.getAttribute("data-opl-e");
    tag.textContent = kind + " · " + hit.tagName.toLowerCase();
    tag.classList.add("on");
    /* Clamped on both axes. A tall block starting near the top of the
       window has its bottom far below the fold, and the label would have
       gone with it. */
    var box = hit.getBoundingClientRect();
    var top = box.top > 30 ? box.top - 26 : box.bottom + 6;
    tag.style.left = Math.max(6, Math.min(box.left, window.innerWidth - tag.offsetWidth - 6)) + "px";
    tag.style.top = Math.max(6, Math.min(top, window.innerHeight - tag.offsetHeight - 6)) + "px";
  }

  /* ------------------------------------------------------------------
     Typing straight onto the page
     ------------------------------------------------------------------ */

  function startTyping(node) {
    if (!node || !node.isConnected) return;
    capture(node);
    node.setAttribute("contenteditable", "true");
    node.focus();
    var range = document.createRange();
    range.selectNodeContents(node);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    node.addEventListener("blur", function once() {
      node.removeEventListener("blur", once);
      stopTyping(node);
    });
    node.addEventListener("keydown", function keys(e) {
      if (e.key === "Escape") { node.blur(); node.removeEventListener("keydown", keys); }
    });
  }

  function stopTyping(node) {
    if (!node.getAttribute("contenteditable")) return;
    node.removeAttribute("contenteditable");
    var id = capture(node);
    var html = OV.clean(node.innerHTML);
    if (html === baseline[id].html) {
      var p = pageDoc();
      if (p.nodes[id]) { delete p.nodes[id].html; delete p.nodes[id].text; }
    } else {
      nodeEdit(id).html = html;
    }
    push();
  }

  /* ------------------------------------------------------------------
     Pictures
     ------------------------------------------------------------------ */

  function shrink(file) {
    return new Promise(function (done, fail) {
      if (file.type === "image/svg+xml" || file.size < 90 * 1024) {
        var plain = new FileReader();
        plain.onload = function () { done(plain.result); };
        plain.onerror = fail;
        plain.readAsDataURL(file);
        return;
      }
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () {
        var max = 1800;
        var scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        var canvas = el("canvas");
        canvas.width = Math.round(img.naturalWidth * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        /* WebP where the browser has it, which is every browser this site
           supports; JPEG is the parachute. Transparency survives WebP,
           which is why it is preferred over JPEG for logos. */
        var out = canvas.toDataURL("image/webp", 0.88);
        if (out.indexOf("data:image/webp") !== 0) out = canvas.toDataURL("image/jpeg", 0.86);
        done(out);
      };
      img.onerror = function () { URL.revokeObjectURL(url); fail(new Error("That picture could not be read.")); };
      img.src = url;
    });
  }

  function upload(file) {
    toast("Uploading " + file.name + "…");
    return shrink(file)
      .then(function (dataUrl) { return post({ action: "upload", dataUrl: dataUrl, name: file.name }); })
      .then(function (data) {
        if (typeof data.reserves === "number") reserves = data.reserves;
        toast("Uploaded" + (data.spent ? " \u2014 " + data.spent +
          (data.spent === 1 ? " reserve" : " reserves") + ", " + reserves + " left" : "") +
          (data.stored === "inline" ? ", kept inside the page" : ""));
        refreshBar();
        lowWarning();
        return data.url;
      })
      .catch(function (err) { toast(err.message, true); throw err; });
  }

  function pickFile() {
    return new Promise(function (done) {
      var input = el("input");
      input.type = "file";
      input.accept = "image/*";
      input.onchange = function () { if (input.files && input.files[0]) done(input.files[0]); };
      input.click();
    });
  }

  /* ------------------------------------------------------------------
     What the panel can do to the selected element
     ------------------------------------------------------------------ */

  /* A style needs a selector — that is how the same choice can differ
     between a phone and a laptop — and only a pinned element has one. So
     styling an element names it, once, before anything else. */
  function setStyle(prop, value, tag) {
    if (!haveSelection()) return;
    pin(selected);
    var id = capture(selected);
    var edit = nodeEdit(id);

    var bag;
    if (screen === "base") {
      edit.style = edit.style || {};
      bag = edit.style;
    } else {
      edit.styleAt = edit.styleAt || {};
      edit.styleAt[screen] = edit.styleAt[screen] || {};
      bag = edit.styleAt[screen];
    }

    if (value === "" || value == null) delete bag[prop];
    else bag[prop] = value;

    if (screen === "base" && !Object.keys(edit.style).length) delete edit.style;
    if (screen !== "base") {
      if (!Object.keys(bag).length) delete edit.styleAt[screen];
      if (!Object.keys(edit.styleAt).length) delete edit.styleAt;
    }
    /* A tag means her hand is still on the control that asked for this. */
    if (tag) pushLive(tag); else push();
  }

  /* Everything said about one element, forgotten. It works in a session
     that never saw the untouched page, because opaline-overlay.js recorded what
     each element was at the moment it first overwrote it. */
  function revertNode(id, page) {
    var p = pageDoc(page);
    delete p.nodes[id];

    /* If it is something she added, forgetting the edit is not enough:
       the thing itself has to go. */
    p.inserts = (p.inserts || []).filter(function (e) { return e.id !== id; });

    for (var parentId in p.order) {
      if (!Object.prototype.hasOwnProperty.call(p.order, parentId)) continue;
      p.order[parentId] = p.order[parentId].filter(function (cid) { return cid !== id; });
    }

    var was = OV.originalOf(id);
    if (was && !baseline[id]) baseline[id] = was;
  }

  function setAttr(name, value, tag) {
    if (!haveSelection()) return;
    var id = capture(selected);
    var edit = nodeEdit(id);
    if (!edit.attrs) edit.attrs = {};
    edit.attrs[name] = value;
    if (tag) pushLive(tag); else push();
  }

  function toggleRemoved() {
    if (!haveSelection()) return;
    var id = capture(selected);
    var edit = nodeEdit(id);
    if (edit.hidden) delete edit.hidden;
    else { edit.hidden = true; edit.label = labelOf(selected); }
    push();
    toast(edit.hidden ? "Removed. It stays faint here until you publish." : "Put back");
  }

  function duplicate() {
    if (!haveSelection()) return;
    var parent = selected.parentElement;
    if (!parent) return;
    pinRow(parent);
    var anchor = pin(selected);

    var clone = selected.cloneNode(true);
    clone.removeAttribute("data-opl-id");
    clone.removeAttribute("data-opl-sel");
    clone.removeAttribute("data-opl-e");
    var inner = clone.querySelectorAll("[data-opl-id], [data-opl-e], [data-opl-sel], [contenteditable]");
    for (var i = 0; i < inner.length; i++) {
      inner[i].removeAttribute("data-opl-id");
      inner[i].removeAttribute("data-opl-e");
      inner[i].removeAttribute("data-opl-sel");
      inner[i].removeAttribute("contenteditable");
    }

    pageDoc().inserts.push({ id: rid("x-"), after: anchor, html: clone.outerHTML, label: labelOf(selected) });
    push();
    toast("Copied");
  }

  function nudge(direction) {
    if (!haveSelection()) return;
    var parent = selected.parentElement;
    if (!parent) return;
    var sibling = direction < 0 ? selected.previousElementSibling : selected.nextElementSibling;
    while (sibling && sibling.id && sibling.id.indexOf("opl-") === 0) {
      sibling = direction < 0 ? sibling.previousElementSibling : sibling.nextElementSibling;
    }
    if (!sibling) { toast("Already at the " + (direction < 0 ? "top" : "bottom"), true); return; }

    pinRow(parent);
    if (!orderBaseline[pin(parent)]) recordOrder(parent);

    if (direction < 0) parent.insertBefore(selected, sibling);
    else parent.insertBefore(sibling, selected);

    /* Read the row back off the page rather than computing it, so what is
       filed is exactly what she is looking at. */
    var parentId = pin(parent);
    var ids = [];
    for (var i = 0; i < parent.children.length; i++) {
      var child = parent.children[i];
      if (child.id && child.id.indexOf("opl-") === 0) continue;
      ids.push(pin(child));
    }
    pageDoc().order[parentId] = ids;
    push();
  }

  function moveToPage(target) {
    if (!haveSelection()) return;
    if (target === pageKey()) return;
    var id = capture(selected);
    pin(selected);
    id = OV.nodeId(selected);

    var clone = selected.cloneNode(true);
    var inner = clone.querySelectorAll("[data-opl-id], [data-opl-e], [data-opl-sel], [contenteditable]");
    clone.removeAttribute("data-opl-id");
    clone.removeAttribute("data-opl-e");
    clone.removeAttribute("data-opl-sel");
    for (var i = 0; i < inner.length; i++) {
      inner[i].removeAttribute("data-opl-id");
      inner[i].removeAttribute("data-opl-e");
      inner[i].removeAttribute("data-opl-sel");
      inner[i].removeAttribute("contenteditable");
    }

    /* It arrives at the foot of the other page's <main>, where she can pick
       it up and move it into place. */
    pageDoc(target).inserts.push({ id: rid("x-"), before: "footer", html: clone.outerHTML, label: labelOf(selected) });

    var edit = nodeEdit(id);
    edit.hidden = true;
    edit.label = labelOf(selected) + " — moved to " + target;
    push();
    toast("Moved to " + target + ". Publish, then open that page to place it.");
  }

  /* ------------------------------------------------------------------
     The panel
     ------------------------------------------------------------------ */

  /* Faces Opaline can serve anywhere, offered after whatever the site
     already uses. Each names the Google family to fetch; nothing is
     loaded until she picks it. */
  var WEB_FONTS = [
    { label: "Lora", value: '"Lora", Georgia, serif', google: "Lora" },
    { label: "Cormorant Garamond", value: '"Cormorant Garamond", Georgia, serif', google: "Cormorant Garamond" },
    { label: "EB Garamond", value: '"EB Garamond", Georgia, serif', google: "EB Garamond" },
    { label: "Libre Baskerville", value: '"Libre Baskerville", Georgia, serif', google: "Libre Baskerville" },
    { label: "Fraunces", value: '"Fraunces", Georgia, serif', google: "Fraunces" },
    { label: "DM Serif Display", value: '"DM Serif Display", Georgia, serif', google: "DM Serif Display" },
    { label: "Merriweather", value: '"Merriweather", Georgia, serif', google: "Merriweather" },
    { label: "Inter", value: '"Inter", system-ui, sans-serif', google: "Inter" },
    { label: "Work Sans", value: '"Work Sans", system-ui, sans-serif', google: "Work Sans" },
    { label: "Karla", value: '"Karla", system-ui, sans-serif', google: "Karla" },
    { label: "Nunito", value: '"Nunito", system-ui, sans-serif', google: "Nunito" },
    { label: "Georgia", value: "Georgia, serif" },
    { label: "Helvetica", value: '"Helvetica Neue", Arial, sans-serif' }
  ];

  /* No hardcoded palette. See palette() above: on a site whose colours
     Opaline was told, it uses those; on any other, it reads them off the
     page, so every swatch offered is one the site already wears. */

  /* ------------------------------------------------------------------
     Things she can add
     ------------------------------------------------------------------
     Duplicating a block that looks roughly right, then editing it into
     shape, was the only way to make anything new. These are the site's
     own patterns, written in the site's own classes, so what she adds is
     indistinguishable from what was written by hand.

     None of them carry data-reveal. The site fades a block in when it
     scrolls into view, and the observer that does it was set up long
     before these existed; an unobserved one would never appear at all.
     ------------------------------------------------------------------ */

  /* Blocks for a site that has told Opaline nothing about itself. They
     carry no classes at all, so they inherit whatever the page around
     them gives them — correct on any site, handsome on none, which is
     the right way round for a default. A site that fills in
     OpalineConfig.blocks gets its own patterns instead, and should.

     Inline styles only where a block would be meaningless without them:
     a row that is not a row is just three paragraphs. */
  var FALLBACK_BLOCKS = [
    {
      group: "Sections",
      name: "Heading and words",
      hint: "The plainest thing there is",
      html: "<section><h2>A new heading</h2><p>And the words underneath it. Click any of this and type over it.</p></section>"
    },
    {
      group: "Sections",
      name: "Heading, words and a button",
      hint: "With a way onward",
      html: '<section><h2>A new heading</h2><p>What there is to say about it.</p><p><a href="#">A link</a></p></section>'
    },
    {
      group: "Rows",
      name: "Two columns",
      hint: "Side by side, one under the other on a phone",
      html: '<section><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:32px">' +
        "<div><h3>On this side</h3><p>What belongs on the left.</p></div>" +
        "<div><h3>And on this</h3><p>What belongs on the right.</p></div></div></section>"
    },
    {
      group: "Rows",
      name: "Three cards",
      hint: "Three of the same thing",
      html: '<section><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:24px">' +
        ["The first", "The second", "The third"].map(function (n) {
          return "<div><h3>" + n + "</h3><p>A sentence about it.</p></div>";
        }).join("") + "</div></section>"
    },
    {
      group: "Rows",
      name: "A picture beside words",
      hint: "Picture on the left, words on the right",
      html: '<section><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:32px;align-items:center">' +
        '<img src="data:image/svg+xml;charset=utf8,' +
        encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 3"><rect width="4" height="3" fill="%23d9d4cb"/></svg>') +
        '" alt="Replace this picture" style="width:100%;height:auto">' +
        "<div><h3>A heading beside the picture</h3><p>And what there is to say.</p></div></div></section>"
    },
    {
      group: "Single things",
      name: "A list",
      hint: "Points, one under another",
      html: "<section><h3>What this includes</h3><ul><li>The first thing</li><li>The second thing</li><li>The third thing</li></ul></section>"
    },
    {
      group: "Single things",
      name: "A video",
      hint: "A YouTube film, shown as a still until it is pressed",
      html: '<section><div class="opl-video-slot"><p>Select this, then paste a YouTube link in the panel.</p></div></section>'
    },
    {
      group: "Single things",
      name: "A quote",
      hint: "Someone else's words, set apart",
      html: "<section><blockquote><p>The sentence worth setting apart from everything around it.</p>" +
        "<cite>Who said it</cite></blockquote></section>"
    },
    {
      group: "Single things",
      name: "A picture",
      hint: "One picture, full width",
      html: '<section><img src="data:image/svg+xml;charset=utf8,' +
        encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 9"><rect width="16" height="9" fill="%23d9d4cb"/></svg>') +
        '" alt="Replace this picture" style="width:100%;height:auto"></section>'
    },
    {
      group: "Single things",
      name: "A paragraph",
      hint: "Just words",
      html: "<section><p>A paragraph on its own.</p></section>"
    }
  ];

  /* Written in the site's own classes where somebody has taken the
     trouble; plain and inheriting where nobody has. A plain block is
     correct on any site and handsome on none, which is the right way
     round for a default. */
  var BLOCKS = (CONFIG.blocks && CONFIG.blocks.length) ? CONFIG.blocks : FALLBACK_BLOCKS;

  /* Which screen the sizes she is setting belong to. "base" is every
     screen; the others are the site's own breakpoints, and a value set on
     one of them only applies at that width and below. */
  var screen = "base";

  function loadFont(name) {
    if (!name) return;
    if (!doc.globals) doc.globals = {};
    if (!doc.globals.fonts) doc.globals.fonts = [];
    if (doc.globals.fonts.indexOf(name) === -1) doc.globals.fonts.push(name);
  }

  function field(label, control) {
    var wrap = el("label", "opl-field");
    wrap.appendChild(el("span", null, esc(label)));
    wrap.appendChild(control);
    return wrap;
  }

  function styleNow(prop) {
    var edit = pageDoc().nodes[OV.nodeId(selected)] || {};
    var bag = screen === "base" ? (edit.style || {}) : ((edit.styleAt || {})[screen] || {});
    return bag[prop] || "";
  }

  /* Whether this element has anything said about it at the narrower widths,
     so the panel can say so rather than leave her guessing. */
  function screensTouched() {
    var edit = pageDoc().nodes[OV.nodeId(selected)] || {};
    return Object.keys(edit.styleAt || {});
  }

  function selectControl(options, current, onChange) {
    var node = el("select", "opl-select");
    options.forEach(function (o) {
      var opt = el("option");
      opt.value = o.value;
      opt.textContent = o.label;
      if (o.value === current) opt.selected = true;
      node.appendChild(opt);
    });
    node.onchange = function () { onChange(node.value); };
    return node;
  }

  /* Everything in the panel answers as she works it rather than when she
     leaves it.

     It used to answer to change, which on a text box means blur: she typed
     a new heading, looked at the page, and the page still said the old one
     until she happened to tap somewhere else. Which read, fairly, as the
     panel not working. Now the page keeps up, a beat behind her last
     keystroke, and the whole run of them is one thing to undo.

     The beat matters: laying a version down re-renders the page, and doing
     that on every keystroke of a long paragraph would stutter. A third of
     a second after she stops is invisible to her and cheap to us. */
  function live(fn, wait) {
    var timer = null;
    return function () {
      var args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(null, args); }, wait == null ? 320 : wait);
    };
  }

  function textControl(value, placeholder, onCommit) {
    var node = el("input", "opl-input");
    node.type = "text";
    node.value = value || "";
    node.placeholder = placeholder || "";
    var tag = "text:" + rid("");
    var soon = live(function () { onCommit(node.value.trim(), tag); });
    node.oninput = soon;
    node.onchange = function () { onCommit(node.value.trim()); };
    return node;
  }

  function sliderControl(value, min, max, unit, onChange) {
    var wrap = el("div", "opl-slider");
    var input = el("input");
    input.type = "range";
    input.min = min; input.max = max; input.step = (max - min) <= 4 ? 0.05 : 1;
    var started = parseFloat(value);
    input.value = isNaN(started) ? (min + max) / 2 : started;
    var out = el("output", null, value || "—");
    var tag = "slide:" + rid("");
    /* Fast enough to feel like the handle is moving the page itself, slow
       enough that a full drag is a few renders and not a hundred. */
    var soon = live(function () { onChange(input.value + unit, tag); }, 60);
    input.oninput = function () { out.textContent = input.value + unit; soon(); };
    input.onchange = function () { onChange(input.value + unit); };
    var clear = el("button", "opl-btn icon", "&times;");
    clear.title = "Back to the site's own";
    clear.onclick = function () { onChange(""); };
    wrap.appendChild(input);
    wrap.appendChild(out);
    wrap.appendChild(clear);
    return wrap;
  }

  function colorControl(prop) {
    var wrap = el("div");
    var row = el("div", "opl-row");
    var picker = el("input", "opl-input");
    picker.type = "color";
    picker.style.padding = "3px";
    picker.style.height = "34px";
    try { picker.value = rgbToHex(getComputedStyle(selected)[prop]); } catch (e) { }
    /* The whole point of a colour wheel is watching the thing change while
       you move around it. */
    var tag = "colour:" + prop + rid("");
    var soon = live(function () { setStyle(prop, picker.value, tag); }, 60);
    picker.oninput = soon;
    picker.onchange = function () { setStyle(prop, picker.value); };
    row.appendChild(picker);
    wrap.appendChild(row);

    var swatches = el("div", "opl-swatches");
    palette().forEach(function (c) {
      var s = el("button", "opl-swatch");
      s.type = "button";
      s.style.background = c;
      s.title = c;
      s.onclick = function () { setStyle(prop, c); };
      swatches.appendChild(s);
    });
    var clear = el("button", "opl-swatch clear");
    clear.type = "button";
    clear.title = "Back to the site's own colour";
    clear.onclick = function () { setStyle(prop, ""); };
    swatches.appendChild(clear);
    wrap.appendChild(swatches);
    return wrap;
  }

  function rgbToHex(value) {
    var m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value || "");
    if (!m) return "#000000";
    return "#" + [m[1], m[2], m[3]].map(function (n) {
      return ("0" + parseInt(n, 10).toString(16)).slice(-2);
    }).join("");
  }

  /* ------------------------------------------------------------------
     Checking her work
     ------------------------------------------------------------------
     The site carries an accessibility statement making promises. A colour
     chosen by eye can quietly break one, and nobody would know until
     somebody could not read the page. So the promises are checked here,
     where the choice is being made, rather than left to be discovered.
     ------------------------------------------------------------------ */

  function channels(colour) {
    var probe = el("span");
    probe.style.color = colour;
    probe.style.display = "none";
    document.body.appendChild(probe);
    var read = getComputedStyle(probe).color;
    probe.remove();
    var m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/.exec(read);
    if (!m) return null;
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  }

  function luminance(c) {
    var v = [c.r, c.g, c.b].map(function (n) {
      var s = n / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  }

  /* The ground an element actually sits on, which is rarely its own: most
     things on this site are transparent over a band's colour. Falling back
     to white would be wrong here — the site opens in dark. */
  function groundOf(node) {
    var n = node;
    var guard = 0;
    while (n && guard++ < 30) {
      var bg = channels(getComputedStyle(n).backgroundColor);
      if (bg && bg.a > 0.5) return bg;
      n = n.parentElement;
    }
    var page = channels(getComputedStyle(document.documentElement).backgroundColor);
    return page && page.a > 0.5 ? page : { r: 255, g: 255, b: 255, a: 1 };
  }

  /* Measuring something nobody can see is how a checker earns its way into
     being ignored. The skip link, the closed mobile menu and anything still
     waiting to fade in are all invisible right now and all report nonsense. */
  function onScreen(node) {
    var s = getComputedStyle(node);
    if (s.display === "none" || s.visibility === "hidden") return false;
    if (node.classList.contains("skip-link") || node.classList.contains("sr-only")) return false;
    if (node.closest('[aria-hidden="true"], [hidden]')) return false;

    var box = node.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) return false;

    var n = node;
    var guard = 0;
    while (n && guard++ < 25) {
      if (parseFloat(getComputedStyle(n).opacity) < 0.15) return false;
      n = n.parentElement;
    }
    return true;
  }

  function contrastOf(node) {
    var fg = channels(getComputedStyle(node).color);
    if (!fg) return null;
    var bg = groundOf(node);
    var a = luminance(fg), b = luminance(bg);
    var ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

    var size = parseFloat(getComputedStyle(node).fontSize) || 16;
    var weight = parseInt(getComputedStyle(node).fontWeight, 10) || 400;
    /* WCAG counts 24px, or 18.66px bold, as large type, which is allowed a
       gentler ratio because it is easier to read at the same contrast. */
    var large = size >= 24 || (size >= 18.66 && weight >= 700);
    var need = large ? 3 : 4.5;
    return { ratio: Math.round(ratio * 100) / 100, need: need, large: large, passes: ratio >= need };
  }

  /* Everything on this page that would fail somebody, split by whose doing
     it is. The site shipped with a handful of its own — a terracotta button
     with white type is a hair under the mark, and always has been — and
     burying her three real mistakes among forty of those is the surest way
     to teach her that this list is not worth reading. */
  function pageProblems() {
    var mine = [];
    var already = [];
    var nodes = pageDoc().nodes;

    document.querySelectorAll("[data-opl-e]").forEach(function (node) {
      if (node.hasAttribute("data-opl-hidden")) return;
      if (!onScreen(node)) return;

      var kind = node.getAttribute("data-opl-e");
      var found = [];

      if (kind === "img") {
        /* An empty alt is a decision, not an omission: it tells a screen
           reader to skip a picture that carries no meaning. A missing one
           reads the file name aloud. */
        if (node.getAttribute("alt") === null) {
          found.push("This picture has no description. A screen reader will read out its file name.");
        }
      } else if (kind === "text" && (node.textContent || "").trim()) {
        var size = parseFloat(getComputedStyle(node).fontSize) || 16;
        if (size < 11) found.push("This is set at " + Math.round(size) + "px, small enough to be hard to read.");
        var c = contrastOf(node);
        if (c && !c.passes) {
          found.push("These words sit at " + c.ratio + ":1 against their background. " + c.need + ":1 is the readable minimum.");
        }
      }
      if (!found.length) return;

      var id = OV.nodeId(node);
      var hers = !!nodes[id] || !!node.closest('[data-opl-id^="x-"]');

      found.forEach(function (say) {
        (hers ? mine : already).push({ node: node, say: say });
      });
    });

    return { mine: mine, already: already };
  }

  function buildPanel() {
    var panel = document.getElementById("opl-panel");
    var head = panel.querySelector(".opl-panel-head div");
    var body = panel.querySelector(".opl-panel-body");
    body.innerHTML = "";

    var kind = selected.getAttribute("data-opl-e");
    var id = OV.nodeId(selected);
    var edit = pageDoc().nodes[id] || {};

    head.innerHTML = "<h4>" + esc(kind) + " · " + esc(selected.tagName.toLowerCase()) + "</h4><p>" + esc(labelOf(selected)) + "</p>";

    /* ---- asking for this one thing, in her own words ----

       The bar's Ask is about the page: it is handed an outline of a hundred
       and seventy elements and has to work out which one she means, and
       when it picks the wrong one that reads as it ignoring her. This one
       cannot pick wrong. It is standing on the thing she has selected, it
       says so, and nothing else on the page is offered to it.

       It sits at the top because it is the shortest way to say what she
       wants: everything below is the same request spelled out in controls,
       and some days she does not want to find the control. */
    var askWrap = el("div", "opl-ask");
    /* "Servant" is what this is called inside Wopara; on a customer's own
       site it is the assistant, which is what the rest of this editor
       calls it and what they will understand. */
    askWrap.appendChild(el("p", "opl-h", "Describe the change for the assistant"));

    var askArea = el("textarea", "opl-area opl-ask-area");
    askArea.placeholder = "Make this bigger and centre it. Warmer colour. Say “Get in touch” instead.";
    askWrap.appendChild(askArea);

    var askSay = el("p", "opl-note opl-ask-say");
    askSay.style.display = "none";

    var askBtn = el("button", "opl-btn primary opl-ask-go", "Ask about this one");
    askBtn.onclick = function () {
      var wish = askArea.value.trim();
      if (!wish) { askArea.focus(); return; }
      if (!haveSelection()) return;

      /* Held by name rather than by reference: laying the answer down
         re-renders the page, and the element she is looking at is found
         again from its address rather than assumed to be the same object. */
      var here = OV.nodeId(selected);
      var what = labelOf(selected);

      askBtn.disabled = true;
      askBtn.textContent = "Thinking…";
      askSay.style.display = "";
      askSay.textContent = "Asking about “" + what.slice(0, 40) + "”…";
      aiLog.push({ who: "you", text: "(" + what.slice(0, 40) + ") " + wish });

      post({
        action: "ai",
        prompt: wish,
        context: {
          page: pageKey(),
          /* Just this one, and what is inside it. A whole page of choices
             is what lets it wander off to the wrong heading. */
          outline: branchOutline(selected),
          target: here + " [" + kind + " " + selected.tagName.toLowerCase() + "] " + what,
          only: here
        }
      })
        .then(function (data) {
          var made = applyOps(data.ops || [], here);
          if (made) push();
          aiLog.push({ who: "her", text: data.reply });
          askArea.value = "";
          askSay.textContent = data.reply + (made ? "" : " (nothing on the page changed)");
          toast(made ? "Done. Undo is there if it is not what you meant." : "Nothing changed.");
        })
        .catch(function (err) { askSay.textContent = err.message; toast(err.message, true); })
        .then(function () {
          /* Laying the answer down rebuilt this panel, so the box that was
             waiting for the reply is no longer the box on the screen. The
             one on the screen is found again and told the same thing. */
          var go = document.querySelector(".opl-ask-go");
          if (go) { go.disabled = false; go.textContent = "Ask about this one"; }
          var said = document.querySelector(".opl-ask-say");
          if (said && askSay.textContent) { said.style.display = ""; said.textContent = askSay.textContent; }
        });
    };
    askWrap.appendChild(askBtn);
    askWrap.appendChild(askSay);
    body.appendChild(askWrap);
    body.appendChild(el("hr", "opl-hr"));

    /* A way back up the nesting, because the thing she wants is often the
       box around the thing she managed to click. */
    var up = selected.parentElement && selected.parentElement.closest("[data-opl-e]");
    if (up) {
      var upBtn = el("button", "opl-btn", "&uarr; Select what holds this");
      upBtn.style.width = "100%";
      upBtn.style.marginBottom = "14px";
      upBtn.onclick = function () { select(up); };
      body.appendChild(upBtn);
    }

    /* ---- what she can do to it ---- */
    var acts = el("div", "opl-acts");
    function act(label, cls, fn) {
      var b = el("button", "opl-btn" + (cls ? " " + cls : ""), label);
      b.onclick = fn;
      acts.appendChild(b);
      return b;
    }
    act("&uarr; Up", null, function () { nudge(-1); });
    act("&darr; Down", null, function () { nudge(1); });
    act("Duplicate", null, duplicate);
    act(edit.hidden ? "Put back" : "Remove", edit.hidden ? null : "danger", toggleRemoved);
    act("+ Add here", null, function () { openBlocks(selected); });
    body.appendChild(acts);

    /* Undoing one thing, days later, without disturbing anything else. */
    if (Object.keys(edit).length) {
      var undoOne = el("button", "opl-btn", "&#8630; Put this back as it was");
      undoOne.style.width = "100%";
      undoOne.style.marginBottom = "14px";
      undoOne.onclick = function () {
        revertNode(id);
        push();
        toast("Put back");
      };
      body.appendChild(undoOne);
    }

    var moveTo = selectControl(
      [{ label: "Move to another page…", value: "" }].concat(
        allPages().filter(function (p) { return p !== pageKey(); })
          .map(function (p) { return { label: p, value: p }; })
      ), "", function (v) { if (v) moveToPage(v); }
    );
    body.appendChild(field("Move", moveTo));

    body.appendChild(el("hr", "opl-hr"));

    /* ---- words ---- */
    if (kind === "text") {
      body.appendChild(el("p", "opl-h", "Words"));
      var area = el("textarea", "opl-area");
      area.value = selected.innerHTML.trim();
      var wordTag = "words:" + rid("");
      function sayIt(tag) {
        if (!selected || !selected.isConnected) return;
        var nid = capture(selected);
        nodeEdit(nid).html = OV.clean(area.value);
        if (tag) pushLive(tag); else push();
      }
      /* The page says what she is typing while she types it. This is the
         one she reported: the words changed here and the page kept the old
         ones until she happened to tap it. */
      area.oninput = live(function () { sayIt(wordTag); });
      area.onchange = function () { sayIt(); };
      body.appendChild(field("Text — plain, or simple HTML", area));

      var hint = el("p", "opl-note", "You can also double-click the words on the page and type straight onto them.");
      body.appendChild(hint);

      if (selected.tagName === "A") {
        body.appendChild(field("Where it goes", textControl(
          selected.getAttribute("href"), "about.html or https://…",
          function (v, tag) { setAttr("href", v, tag); }
        )));
      }
      body.appendChild(el("hr", "opl-hr"));
    }

    /* ---- pictures ---- */
    if (kind === "img") {
      body.appendChild(el("p", "opl-h", "Picture"));
      var thumb = el("img", "opl-thumb");
      thumb.src = selected.getAttribute("src") || "";
      body.appendChild(thumb);

      var drop = el("div", "opl-drop", "Choose a picture, or drop one here");
      drop.onclick = function () {
        pickFile().then(upload).then(function (url) {
          var nid = capture(selected);
          nodeEdit(nid).src = url;
          push();
        }).catch(function () { });
      };
      drop.ondragover = function (e) { e.preventDefault(); drop.classList.add("over"); };
      drop.ondragleave = function () { drop.classList.remove("over"); };
      drop.ondrop = function (e) {
        e.preventDefault();
        drop.classList.remove("over");
        var file = e.dataTransfer.files && e.dataTransfer.files[0];
        if (!file) return;
        upload(file).then(function (url) {
          var nid = capture(selected);
          nodeEdit(nid).src = url;
          push();
        }).catch(function () { });
      };
      body.appendChild(drop);

      body.appendChild(field("Or paste a web address", textControl(
        "", "https://…", function (v) {
          if (!v) return;
          var nid = capture(selected);
          nodeEdit(nid).src = v;
          push();
        }
      )));

      var altField = field("Described for a screen reader", textControl(
        selected.getAttribute("alt"), "What this picture shows",
        function (v, tag) { setAttr("alt", v, tag); }
      ));
      body.appendChild(altField);
      if (selected.getAttribute("alt") === null) {
        var altWarn = el("p", "opl-warn",
          "Without a description, someone using a screen reader hears this picture's file name read out. " +
          "If it is purely decorative, type a single space to say so deliberately.");
        body.insertBefore(altWarn, altField.nextSibling);
      }

      body.appendChild(field("How it fills its frame", selectControl([
        { label: "As the site sets it", value: "" },
        { label: "Cover — fill and crop", value: "cover" },
        { label: "Contain — show all of it", value: "contain" },
        { label: "Fill — stretch", value: "fill" }
      ], styleNow("objectFit"), function (v, tag) { setStyle("objectFit", v, tag); })));

      /* The same picture used everywhere — this is how the logo changes. */
      var original = selected.getAttribute("data-opl-original") || selected.getAttribute("src") || "";
      if (original && original.indexOf("data:") !== 0 && original.indexOf("http") !== 0) {
        var everywhere = el("button", "opl-btn", "Replace this picture everywhere it appears");
        everywhere.style.width = "100%";
        everywhere.title = "Use this for the logo: the same file appears in the header of every page.";
        everywhere.onclick = function () {
          pickFile().then(upload).then(function (url) {
            if (!doc.globals) doc.globals = {};
            if (!doc.globals.imageSwaps) doc.globals.imageSwaps = {};
            doc.globals.imageSwaps[original.replace(/^\.?\//, "")] = url;
            push();
            toast("Replaced across the whole site");
          }).catch(function () { });
        };
        body.appendChild(everywhere);
        body.appendChild(el("p", "opl-note", "The wordmark in the header is the same file on every page, so replacing it here replaces the logo everywhere."));
      }
      body.appendChild(el("hr", "opl-hr"));
    }

    /* ---- a picture behind a block ---- */
    if (kind === "block") {
      var bg = el("button", "opl-btn", "Set a picture behind this");
      bg.style.width = "100%";
      bg.onclick = function () {
        pickFile().then(upload).then(function (url) {
          var nid = capture(selected);
          nodeEdit(nid).bgImage = url;
          push();
        }).catch(function () { });
      };
      body.appendChild(bg);
      if (edit.bgImage) {
        var clearBg = el("button", "opl-btn danger", "Take that picture away");
        clearBg.style.width = "100%";
        clearBg.style.marginTop = "6px";
        clearBg.onclick = function () {
          var nid = capture(selected);
          nodeEdit(nid).bgImage = "";
          push();
        };
        body.appendChild(clearBg);
      }
      body.appendChild(el("hr", "opl-hr"));
    }

    /* ---- which screen these sizes belong to ---- */
    var touched = screensTouched();
    var screens = el("div", "opl-screens");
    [
      { key: "base", label: "All screens" },
      { key: "tablet", label: "Tablet" },
      { key: "phone", label: "Phone" }
    ].forEach(function (s) {
      var chip = el("button", "opl-chip" + (screen === s.key ? " on" : "") +
        (s.key !== "base" && touched.indexOf(s.key) !== -1 ? " set" : ""), s.label);
      chip.type = "button";
      chip.title = s.key === "base"
        ? "What you set here applies everywhere"
        : "What you set here applies only at that width and narrower";
      chip.onclick = function () { screen = s.key; buildPanel(); };
      screens.appendChild(chip);
    });
    body.appendChild(field("Setting sizes for", screens));
    if (screen !== "base") {
      body.appendChild(el("p", "opl-note",
        "Only " + (screen === "phone" ? "phones" : "tablets and narrower") +
        " will see what you set below. Leave a box empty and it keeps the all-screens value."));
    }

    /* ---- a video ---- */
    if (kind === "block" || kind === "img" || kind === "video") {
      body.appendChild(el("p", "opl-h", "Video"));
      /* A film she added, or one the page already had. Either way the
         question is the same: which film is this? */
      var already = (edit.video && edit.video.id) || (kind === "video" && OV.embedId(selected));

      if (kind === "video") {
        body.appendChild(el("p", "opl-note",
          "This film was placed here when the page was built. Its frame and its settings stay as they are \u2014 " +
          "paste a different link and only the film changes."));
      }

      if (already) {
        var still = el("img", "opl-thumb");
        still.src = "https://i.ytimg.com/vi/" + already + "/hqdefault.jpg";
        body.appendChild(still);
      }

      var link = el("input", "opl-input");
      link.type = "text";
      link.placeholder = "Paste a YouTube link";
      link.value = already ? "https://youtu.be/" + already : "";
      link.onchange = function () {
        var v = link.value.trim();
        if (!v) return;
        var id = OV.youtubeId(v);
        if (!id) { toast("That does not look like a YouTube link.", true); return; }
        var nid = capture(selected, true);
        var it = nodeEdit(nid);
        it.video = { id: id, title: (it.video && it.video.title) || "" };
        push();
        toast("Video added. It shows as a still until somebody presses play.");
      };
      body.appendChild(field("YouTube link", link));

      if (already) {
        body.appendChild(field("What it is called", textControl(
          (edit.video && edit.video.title) || selected.getAttribute("title") || "",
          "Said aloud by a screen reader",
          function (v) {
            var nid = capture(selected, true);
            var it = nodeEdit(nid);
            it.video = it.video || { id: already };
            it.video.title = v;
            push();
          }
        )));
        var drop = el("button", "opl-btn danger",
          kind === "video" ? "Put the original film back" : "Take the video away");
        drop.style.width = "100%";
        drop.onclick = function () {
          var nid = capture(selected, true);
          delete nodeEdit(nid).video;
          push();
        };
        body.appendChild(drop);
      } else {
        body.appendChild(el("p", "opl-note",
          "Nothing is fetched from YouTube until a reader presses play \u2014 the page shows a still until then, " +
          "so an embedded video costs nobody anything who does not watch it."));
      }
      body.appendChild(el("hr", "opl-hr"));
    }

    /* ---- type ---- */
    body.appendChild(el("p", "opl-h", "Type"));

    var fontSelect = selectControl(
      [{ label: "As the site sets it", value: "" }].concat(faceList().map(function (f) { return { label: f.label, value: f.value }; })),
      styleNow("fontFamily"),
      function (v) {
        var chosen = faceList().filter(function (f) { return f.value === v; })[0];
        if (chosen && chosen.google) loadFont(chosen.google);
        setStyle("fontFamily", v);
      }
    );
    body.appendChild(field("Face", fontSelect));

    body.appendChild(field("Size", sliderControl(styleNow("fontSize"), 10, 96, "px", function (v, tag) { setStyle("fontSize", v, tag); })));
    body.appendChild(field("Weight", selectControl([
      { label: "As the site sets it", value: "" },
      { label: "Light", value: "300" }, { label: "Regular", value: "400" },
      { label: "Medium", value: "500" }, { label: "Semibold", value: "600" }, { label: "Bold", value: "700" }
    ], styleNow("fontWeight"), function (v, tag) { setStyle("fontWeight", v, tag); })));

    body.appendChild(field("Line height", sliderControl(styleNow("lineHeight"), 0.9, 2.4, "", function (v, tag) { setStyle("lineHeight", v, tag); })));
    body.appendChild(field("Letter spacing", sliderControl(styleNow("letterSpacing"), -0.05, 0.4, "em", function (v, tag) { setStyle("letterSpacing", v, tag); })));

    body.appendChild(field("Alignment", selectControl([
      { label: "As the site sets it", value: "" },
      { label: "Left", value: "left" }, { label: "Centre", value: "center" },
      { label: "Right", value: "right" }, { label: "Justified", value: "justify" }
    ], styleNow("textAlign"), function (v, tag) { setStyle("textAlign", v, tag); })));

    body.appendChild(field("Colour", colorControl("color")));

    /* Said here, where the colour is being chosen, rather than discovered
       later by somebody who cannot read the page. */
    if (kind === "text") {
      var c = contrastOf(selected);
      if (c && !c.passes) {
        body.appendChild(el("p", "opl-warn",
          "These words sit at " + c.ratio + ":1 against what is behind them. " +
          c.need + ":1 is the readable minimum for type this size. Try a darker colour, or a larger size."));
      } else if (c) {
        body.appendChild(el("p", "opl-ok", "Contrast " + c.ratio + ":1 — comfortably readable."));
      }
    }

    body.appendChild(el("hr", "opl-hr"));

    /* ---- the box it sits in ---- */
    body.appendChild(el("p", "opl-h", "Its box"));
    body.appendChild(field("Width", textControl(styleNow("width"), "e.g. 60%, 420px, auto", function (v, tag) { setStyle("width", v, tag); })));
    body.appendChild(field("Widest it may get", textControl(styleNow("maxWidth"), "e.g. 780px", function (v, tag) { setStyle("maxWidth", v, tag); })));
    body.appendChild(field("Height", textControl(styleNow("height"), "e.g. 320px, auto", function (v, tag) { setStyle("height", v, tag); })));
    body.appendChild(field("Space inside", textControl(styleNow("padding"), "e.g. 40px, or 40px 24px", function (v, tag) { setStyle("padding", v, tag); })));
    body.appendChild(field("Space around", textControl(styleNow("margin"), "e.g. 60px 0", function (v, tag) { setStyle("margin", v, tag); })));
    body.appendChild(field("Corner rounding", textControl(styleNow("borderRadius"), "e.g. 22px, or 999px 999px 22px 22px", function (v, tag) { setStyle("borderRadius", v, tag); })));
    body.appendChild(field("Background colour", colorControl("backgroundColor")));
    body.appendChild(field("Opacity", sliderControl(styleNow("opacity"), 0, 1, "", function (v, tag) { setStyle("opacity", v, tag); })));
  }

  /* ------------------------------------------------------------------
     Sheets
     ------------------------------------------------------------------ */

  function sheet(title, build, footButtons) {
    var host = document.getElementById("opl-sheet");
    var card = host.querySelector(".opl-sheet-card");
    card.querySelector("h3").textContent = title;
    var body = card.querySelector(".opl-sheet-body");
    var foot = card.querySelector(".opl-sheet-foot");
    body.innerHTML = "";
    foot.innerHTML = "";
    build(body);
    (footButtons || []).forEach(function (b) {
      var node = el("button", "opl-btn" + (b.primary ? " primary" : "") + (b.danger ? " danger" : ""), b.label);
      node.onclick = b.onClick;
      foot.appendChild(node);
    });
    var close = el("button", "opl-btn", "Close");
    close.onclick = closeSheet;
    foot.appendChild(close);
    host.classList.add("open");
  }

  function closeSheet() {
    document.getElementById("opl-sheet").classList.remove("open");
  }

  /* ---- the assistant ---- */

  var aiLog = [];

  var GENERAL_HINT = "Make the headings larger across the page. Change the buttons to forest green. Take the third card away.";

  function pageOutline() {
    var lines = [];
    var all = document.querySelectorAll("[data-opl-e]");
    for (var i = 0; i < all.length && lines.length < 170; i++) {
      var node = all[i];
      if (node.getAttribute("data-opl-e") === "block" && !node.matches("section, article, aside, figure, ul, ol, .card, .wrap > div")) continue;
      lines.push(OV.nodeId(node) + " [" + node.getAttribute("data-opl-e") + " " + node.tagName.toLowerCase() + "] " + labelOf(node));
    }
    return lines.join("\n");
  }

  /* One element and everything inside it, for a request that is about that
     element. Its own line comes first so the assistant is in no doubt which
     address the words "this one" belong to. */
  function branchOutline(node) {
    var lines = [OV.nodeId(node) + " [" + node.getAttribute("data-opl-e") + " " +
      node.tagName.toLowerCase() + "] " + labelOf(node) + "   <- THIS ONE"];
    var inside = node.querySelectorAll("[data-opl-e]");
    for (var i = 0; i < inside.length && lines.length < 60; i++) {
      lines.push("  " + OV.nodeId(inside[i]) + " [" + inside[i].getAttribute("data-opl-e") + " " +
        inside[i].tagName.toLowerCase() + "] " + labelOf(inside[i]));
    }
    return lines.join("\n");
  }

  /* When the request came from the panel it was about one element, and
     nothing outside that element may be touched however the answer is
     worded. The assistant is told this; this is what makes it true.

     A page-wide rule is refused outright in that case rather than trimmed:
     there is no such thing as a stylesheet that only applies to one
     element, and half-applying one is worse than declining it. */
  function applyOps(ops, only) {
    var fence = only ? OV.resolve(only) : null;

    function allowed(id) {
      if (!fence) return true;
      var node = OV.resolve(id);
      return !!node && (node === fence || fence.contains(node));
    }

    var count = 0;
    ops.forEach(function (op) {
      if (!op || !op.op) return;
      if (fence && op.op === "css") return;
      if (fence && op.id && !allowed(op.id)) return;
      if (fence && op.op === "insertHtml" && !allowed(op.afterId)) return;
      if (op.op === "css") {
        if (!doc.globals) doc.globals = {};
        doc.globals.css = (doc.globals.css || "") + "\n" + String(op.value || "");
        count++;
        return;
      }
      var node = OV.resolve(op.id);
      if (!node && op.op !== "insertHtml") return;

      if (op.op === "insertHtml") {
        var anchor = OV.resolve(op.afterId);
        if (!anchor) return;
        if (anchor.parentElement) pinRow(anchor.parentElement);
        pageDoc().inserts.push({ id: rid("x-"), after: pin(anchor), html: OV.clean(op.html), label: "added by the assistant" });
        count++;
        return;
      }

      var id = capture(node);
      var edit = nodeEdit(id);

      if (op.op === "text") { edit.html = OV.clean(op.value); count++; }
      else if (op.op === "style" && op.props) {
        if (!edit.style) edit.style = {};
        Object.keys(op.props).forEach(function (k) {
          if (OV.cssProps[k]) { edit.style[k] = op.props[k]; count++; }
        });
      }
      else if (op.op === "hide") { edit.hidden = true; edit.label = labelOf(node); count++; }
      else if (op.op === "show") { delete edit.hidden; count++; }
      else if (op.op === "attr") { edit.attrs = edit.attrs || {}; edit.attrs[op.name] = op.value; count++; }
      else if (op.op === "duplicate") { selected = node; duplicate(); count++; }
      else if (op.op === "move") { selected = node; nudge(op.dir === "up" ? -1 : 1); count++; }
    });
    return count;
  }

  function openAI() {
    sheet("Ask for a change", function (body) {
      var log = el("div");
      log.id = "opl-ai-log";
      aiLog.forEach(function (turn) {
        log.appendChild(el("div", "opl-ai-turn " + turn.who,
          "<b>" + (turn.who === "you" ? "You" : "Assistant") + "</b>" + esc(turn.text) +
          (turn.spent ? '<span class="opl-spent">' + turn.spent + " reserves</span>" : "")));
      });
      body.appendChild(log);

      /* What she had selected when she pressed Ask, carried in as the thing
         the request is about. Otherwise "make this bigger" has to be
         guessed at from a list of a hundred and seventy elements, and the
         assistant picks the wrong one — which reads as it ignoring her.

         Shown rather than assumed, with a cross, because half of what
         anybody asks is about the page and not about one thing on it. */
      var aiTarget = selected && selected.isConnected ? {
        id: OV.nodeId(selected),
        kind: selected.getAttribute("data-opl-e") || "",
        tag: selected.tagName.toLowerCase(),
        label: labelOf(selected)
      } : null;

      var chipRow = el("div");
      chipRow.style.margin = "0 0 10px";

      function drawTarget() {
        chipRow.innerHTML = "";
        if (!aiTarget) return;
        var chip = el("span", "opl-target");
        chip.innerHTML = "<b>This one:</b> " + esc(aiTarget.label) +
          ' <button type="button" aria-label="Ask about the whole page instead">&times;</button>';
        chip.querySelector("button").onclick = function () {
          aiTarget = null;
          drawTarget();
          area.placeholder = GENERAL_HINT;
        };
        chipRow.appendChild(chip);
      }
      body.appendChild(chipRow);

      body.appendChild(el("p", "opl-note",
        "Describe what you want changed in your own words. " +
        "Anything it does lands in Undo, so nothing here is final until you publish."));

      var area = el("textarea", "opl-area");
      area.placeholder = aiTarget
        ? "Make it larger and centre it. Change its colour. Say this instead: \u2026"
        : GENERAL_HINT;
      area.style.minHeight = "96px";
      body.appendChild(area);
      drawTarget();

      var send = el("button", "opl-btn primary", "Ask");
      send.style.marginTop = "12px";
      send.onclick = function () {
        var prompt = area.value.trim();
        if (!prompt) return;
        send.disabled = true;
        send.textContent = "Thinking…";
        aiLog.push({ who: "you", text: prompt });
        log.appendChild(el("div", "opl-ai-turn you", "<b>You</b>" + esc(prompt)));

        post({
          action: "ai",
          prompt: prompt,
          context: {
            page: pageKey(),
            outline: pageOutline(),
            /* Named, so the assistant changes the thing she is looking at
               rather than the first one that matches her words. */
            target: aiTarget
              ? aiTarget.id + " [" + aiTarget.kind + " " + aiTarget.tag + "] " + aiTarget.label
              : ""
          }
        })
          .then(function (data) {
            var made = applyOps(data.ops || []);
            if (made) push();
            if (typeof data.reserves === "number") reserves = data.reserves;
            refreshBar();
            lowWarning();
            aiLog.push({ who: "her", text: data.reply, spent: data.spent || 0 });
            log.appendChild(el("div", "opl-ai-turn her", "<b>Assistant</b>" + esc(data.reply) +
              (made ? "" : " (nothing on the page changed)") +
              (data.spent ? '<span class="opl-spent">' + data.spent + " reserves</span>" : "")));
            log.scrollTop = log.scrollHeight;
            area.value = "";
          })
          .catch(function (err) { toast(err.message, true); })
          .then(function () { send.disabled = false; send.textContent = "Ask"; });
      };
      body.appendChild(send);
    }, []);
  }

  /* ---- saved versions ---- */

  function loadState() {
    return post({ action: "state" }).then(function (data) {
      saves = data.saves || [];
      if (typeof data.reserves === "number") reserves = data.reserves;
      ledger = data.ledger || [];
      currentIsSaved = !!data.currentIsSaved;
      published = data.overlay || OV.empty();
      return data;
    });
  }

  function openSaves() {
    sheet("Saved versions", function (body) {
      body.appendChild(el("p", "opl-note",
        dirty()
          ? "You have changes that are not published yet. Publish them, or undo them, before restoring an older version — restoring replaces what is live."
          : (currentIsSaved
            ? "The site as it stands is saved. You can restore any version below."
            : "The site as it stands has not been saved. Save it first, so restoring an older version cannot lose it.")));

      var name = el("input", "opl-input");
      name.placeholder = "A name for how the site looks right now";
      body.appendChild(field("Save this version", name));

      var saveBtn = el("button", "opl-btn primary", "Save");
      saveBtn.onclick = function () {
        if (!name.value.trim()) { toast("Give the save a name first", true); return; }
        saveBtn.disabled = true;
        post({ action: "save", name: name.value.trim(), overlay: doc })
          .then(function () {
            published = copy(doc);
            toast("Saved");
            return loadState();
          })
          .then(openSaves)
          .catch(function (err) { toast(err.message, true); saveBtn.disabled = false; });
      };
      body.appendChild(saveBtn);

      body.appendChild(el("hr", "opl-hr"));
      body.appendChild(el("p", "opl-h", "Versions you can go back to"));

      if (!saves.length) {
        body.appendChild(el("p", "opl-note", "None yet."));
        return;
      }

      var list = el("ul", "opl-list");
      saves.forEach(function (s) {
        var row = el("li");
        row.appendChild(el("div", null, "<b>" + esc(s.name) + "</b><small>" + new Date(s.at).toLocaleString() + "</small>"));

        var restore = el("button", "opl-btn", "Restore");
        restore.disabled = dirty() || !currentIsSaved;
        if (restore.disabled) restore.title = dirty() ? "Publish or undo your unpublished changes first" : "Save the current version first";
        restore.onclick = function () {
          restore.disabled = true;
          post({ action: "restore", id: s.id })
            .then(function (data) {
              doc = data.overlay || OV.empty();
              published = copy(doc);
              history = [copy(doc)];
              hIndex = 0;
              baseline = {};
              orderBaseline = {};
              render();
              closeSheet();
              toast("Restored “" + s.name + "”. Reloading so the page is clean…");
              setTimeout(function () { location.reload(); }, 900);
            })
            .catch(function (err) { toast(err.message, true); restore.disabled = false; });
        };
        row.appendChild(restore);

        var drop = el("button", "opl-btn danger icon", "&times;");
        drop.title = "Delete this save";
        drop.onclick = function () {
          post({ action: "deleteSave", id: s.id }).then(loadState).then(openSaves);
        };
        row.appendChild(drop);
        list.appendChild(row);
      });
      body.appendChild(list);
    }, []);
  }

  /* ---- pages ---- */

  function openPages() {
    sheet("Pages", function (body) {
      body.appendChild(el("p", "opl-h", "The site's own pages"));
      var list = el("ul", "opl-list");
      SITE_PAGES.forEach(function (p) {
        var row = el("li");
        row.appendChild(el("div", null, "<b>" + esc(p) + "</b><small>" +
          Object.keys((doc.pages[p] || {}).nodes || {}).length + " change(s)</small>"));
        var go = el("button", "opl-btn", p === pageKey() ? "You are here" : "Open");
        go.disabled = p === pageKey();
        go.onclick = function () { leaveFor(p); };
        row.appendChild(go);
        list.appendChild(row);
      });
      body.appendChild(list);

      body.appendChild(el("hr", "opl-hr"));
      body.appendChild(el("p", "opl-h", "Pages you made"));

      var made = Object.keys(doc.newPages || {});
      if (made.length) {
        var mine = el("ul", "opl-list");
        made.forEach(function (slug) {
          var page = doc.newPages[slug];
          var row = el("li");
          row.appendChild(el("div", null, "<b>" + esc(page.title) + "</b><small>/p/" + esc(slug) +
            (page.nav ? " · in the menu" : "") + "</small>"));

          var menu = el("button", "opl-btn", page.nav ? "Take out of menu" : "Put in menu");
          menu.onclick = function () { page.nav = !page.nav; push(); openPages(); };
          row.appendChild(menu);

          var go = el("button", "opl-btn", "Open");
          go.onclick = function () { leaveFor("p/" + slug); };
          row.appendChild(go);

          var drop = el("button", "opl-btn danger icon", "&times;");
          drop.title = "Delete this page";
          drop.onclick = function () {
            delete doc.newPages[slug];
            delete doc.pages["p/" + slug];
            push();
            openPages();
          };
          row.appendChild(drop);
          mine.appendChild(row);
        });
        body.appendChild(mine);
      } else {
        body.appendChild(el("p", "opl-note", "None yet."));
      }

      body.appendChild(el("hr", "opl-hr"));
      body.appendChild(el("p", "opl-h", "Make a new page"));

      var title = el("input", "opl-input");
      title.placeholder = "What the page is called";
      body.appendChild(field("Title", title));

      var lede = el("textarea", "opl-area");
      lede.placeholder = "The opening paragraph. You can change all of this on the page itself afterwards.";
      body.appendChild(field("Opening", lede));

      var make = el("button", "opl-btn primary", "Make the page");
      make.onclick = function () {
        var name = title.value.trim();
        if (!name) { toast("Give the page a title", true); return; }
        var slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
        if (!slug) { toast("That title cannot be made into an address", true); return; }
        if (!doc.newPages) doc.newPages = {};
        if (doc.newPages[slug]) { toast("There is already a page at that address", true); return; }
        doc.newPages[slug] = {
          title: name,
          nav: false,
          blocks: [
            '<section class="page-intro"><div class="wrap"><h1>' + esc(name) + "</h1>" +
            (lede.value.trim() ? '<p class="lede">' + esc(lede.value.trim()) + "</p>" : "") +
            "</div></section>",
            '<section class="tight"><div class="wrap narrow"><p>Write here. Every part of this page can be changed the same way as the rest of the site.</p></div></section>'
          ]
        };
        push();
        toast("Made. Publish, then open it to write on it.");
        openPages();
      };
      body.appendChild(make);
    }, []);
  }

  /* ---- posts ---- */

  /* A post is a page she made, with a date on it. Everything below is about
     the three fields a LIST of posts needs — when it was written, its
     opening line, its picture. The post itself is written on the page, with
     the same blocks, pictures and words as anywhere else on the site,
     because it is a page. */
  function openPosts() {
    sheet("Posts", function (body) {
      if (!CONFIG.newPagePath) {
        body.appendChild(el("p", "opl-note",
          "Posts need somewhere to live, and this site has not been given a place for them yet. " +
          "Ask Wopara to switch it on \u2014 nothing on the site has to change for it."));
        return;
      }

      body.appendChild(el("p", "opl-note",
        "Write a post here, then open it and write on it the way you write on any other page. " +
        "It appears in the list on any page that has one, newest first."));

      var posts = OV.posts();
      if (posts.length) {
        var list = el("ul", "opl-list");
        posts.forEach(function (post) {
          var page = doc.newPages[post.slug];
          var row = el("li");
          row.appendChild(el("div", null, "<b>" + esc(post.title) + "</b><small>" +
            (post.date ? esc(OV.showDate(post.date)) : "no date yet") + "</small>"));

          var edit = el("button", "opl-btn", "Details");
          edit.onclick = function () { openPostDetails(post.slug); };
          row.appendChild(edit);

          var go = el("button", "opl-btn", "Write");
          go.onclick = function () { leaveFor("p/" + post.slug); };
          row.appendChild(go);

          var drop = el("button", "opl-btn danger icon", "&times;");
          drop.title = "Delete this post";
          drop.onclick = function () {
            if (!confirm("Delete \u201c" + post.title + "\u201d? This cannot be undone once published.")) return;
            delete doc.newPages[post.slug];
            delete doc.pages["p/" + post.slug];
            push();
            openPosts();
          };
          row.appendChild(drop);
          list.appendChild(row);
          return page;
        });
        body.appendChild(list);
      } else {
        body.appendChild(el("p", "opl-note", "None yet."));
      }

      body.appendChild(el("hr", "opl-hr"));
      body.appendChild(el("p", "opl-h", "Write a new post"));

      var title = el("input", "opl-input");
      title.placeholder = "What the post is called";
      body.appendChild(field("Title", title));

      var when = el("input", "opl-input");
      when.type = "date";
      when.value = todayISO();
      body.appendChild(field("Date", when));

      var lede = el("textarea", "opl-area");
      lede.placeholder = "One or two sentences. This is what shows in the list, and what a search result shows.";
      body.appendChild(field("Opening line", lede));

      var make = el("button", "opl-btn primary", "Start the post");
      make.onclick = function () {
        var name = title.value.trim();
        if (!name) { toast("Give the post a title", true); return; }
        var slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
        if (!slug) { toast("That title cannot be made into an address", true); return; }
        if (!doc.newPages) doc.newPages = {};
        if (doc.newPages[slug]) { toast("There is already something at that address", true); return; }

        doc.newPages[slug] = {
          title: name,
          post: true,
          date: when.value || todayISO(),
          excerpt: lede.value.trim(),
          image: (CONFIG.posts && CONFIG.posts.defaultImage) || "",
          nav: false,
          blocks: (CONFIG.posts && CONFIG.posts.starter)
            ? CONFIG.posts.starter(name, lede.value.trim())
            : ["<h1>" + esc(name) + "</h1>",
               "<p>" + esc(lede.value.trim() || "Write here.") + "</p>"]
        };
        push();
        toast("Started. Publish, then open it to write.");
        openPosts();
      };
      body.appendChild(make);
    }, []);
  }

  function todayISO() {
    var d = new Date();
    return d.getFullYear() + "-" +
      ("0" + (d.getMonth() + 1)).slice(-2) + "-" +
      ("0" + d.getDate()).slice(-2);
  }

  function openPostDetails(slug) {
    var page = (doc.newPages || {})[slug];
    if (!page) { openPosts(); return; }

    sheet("Post details", function (body) {
      var title = el("input", "opl-input");
      title.value = page.title || "";
      title.oninput = function () { page.title = title.value; };
      body.appendChild(field("Title", title));

      var when = el("input", "opl-input");
      when.type = "date";
      when.value = page.date || "";
      when.oninput = function () { page.date = when.value; };
      body.appendChild(field("Date", when));

      var lede = el("textarea", "opl-area");
      lede.value = page.excerpt || "";
      lede.oninput = function () { page.excerpt = lede.value; };
      body.appendChild(field("Opening line", lede));

      var pic = el("input", "opl-input");
      pic.value = page.image || "";
      pic.placeholder = "assets/img/something.jpg";
      pic.oninput = function () { page.image = pic.value.trim(); };
      body.appendChild(field("Picture for the list", pic));

      var pick = el("button", "opl-btn", "Upload a picture");
      pick.onclick = function () {
        pickFile()
          .then(upload)
          .then(function (url) { page.image = url; pic.value = url; push(); })
          .catch(function () { /* upload() has already said so */ });
      };
      body.appendChild(pick);

      body.appendChild(el("hr", "opl-hr"));
      body.appendChild(el("p", "opl-note",
        "Its address is " + esc(OV.pageHref(slug) || "") + " \u2014 that cannot be changed once anybody has the link."));

      var done = el("button", "opl-btn primary", "Save these details");
      done.onclick = function () { push(); toast("Saved. Publish when you are ready."); openPosts(); };
      body.appendChild(done);
    }, []);
  }

  function leaveFor(page) {
    /* A page she made is addressed however this host can serve one — a real
       path where the host rewrites, a query on one template file where it
       cannot. Both are worked out in one place, by the overlay, so the
       editor never has to know which kind of host it is standing on. */
    var go = function () {
      var made = /^p\/(.+)$/.exec(page);
      location.href = made ? (OV.pageHref(made[1]) || page) : page;
    };
    if (!dirty()) { go(); return; }
    if (confirm("You have changes that are not published. Publish them before leaving this page?")) {
      publish().then(go);
    } else if (confirm("Leave anyway? The unpublished changes will be lost.")) {
      go();
    }
  }

  /* ---- popups ---- */

  function openPopups() {
    sheet("Popups", function (body) {
      body.appendChild(el("p", "opl-note", "A card that appears over the page. It never shows while you are editing."));

      var list = el("ul", "opl-list");
      (doc.popups || []).forEach(function (p, i) {
        var row = el("li");
        row.appendChild(el("div", null, "<b>" + esc(p.name || p.title || "Untitled") + "</b><small>" +
          esc(p.trigger || "load") + " · " + (p.pages && p.pages.length ? p.pages.join(", ") : "every page") + "</small>"));

        var onOff = el("button", "opl-btn", p.enabled === false ? "Off" : "On");
        onOff.onclick = function () { p.enabled = p.enabled === false; push(); openPopups(); };
        row.appendChild(onOff);

        var preview = el("button", "opl-btn", "Preview");
        preview.onclick = function () { closeSheet(); OV.showPopup(p); };
        row.appendChild(preview);

        var edit = el("button", "opl-btn", "Edit");
        edit.onclick = function () { popupForm(p, i); };
        row.appendChild(edit);

        var drop = el("button", "opl-btn danger icon", "&times;");
        drop.onclick = function () { doc.popups.splice(i, 1); push(); openPopups(); };
        row.appendChild(drop);
        list.appendChild(row);
      });
      body.appendChild(list);

      var add = el("button", "opl-btn primary", "New popup");
      add.onclick = function () { popupForm(null, -1); };
      body.appendChild(add);
    }, []);
  }

  function popupForm(existing, index) {
    var p = existing ? copy(existing) : {
      id: rid("pop-"), name: "", title: "", body: "", image: "",
      btnLabel: "", btnHref: "", trigger: "load", delay: 4, once: true, pages: [], enabled: true
    };

    sheet(existing ? "Edit popup" : "New popup", function (host) {
      host.appendChild(field("Name — just for you", textControl(p.name, "Spring newsletter", function (v) { p.name = v; })));
      host.appendChild(field("Heading", textControl(p.title, "A new story is out", function (v) { p.title = v; })));

      var text = el("textarea", "opl-area");
      text.value = p.body || "";
      text.onchange = function () { p.body = text.value; };
      host.appendChild(field("Words", text));

      var picked = el("div");
      if (p.image) {
        var thumb = el("img", "opl-thumb");
        thumb.src = p.image;
        picked.appendChild(thumb);
      }
      var pick = el("button", "opl-btn", p.image ? "Change the picture" : "Add a picture");
      pick.onclick = function () {
        pickFile().then(upload).then(function (url) { p.image = url; popupForm(p, index); }).catch(function () { });
      };
      picked.appendChild(pick);
      host.appendChild(field("Picture", picked));

      host.appendChild(field("Button words", textControl(p.btnLabel, "Read it", function (v) { p.btnLabel = v; })));
      host.appendChild(field("Button goes to", textControl(p.btnHref, "resources.html", function (v) { p.btnHref = v; })));

      host.appendChild(field("When it appears", selectControl([
        { label: "A moment after the page opens", value: "load" },
        { label: "Part way down the page", value: "scroll" },
        { label: "As they go to leave", value: "exit" }
      ], p.trigger, function (v) { p.trigger = v; })));

      host.appendChild(field("Wait, in seconds", textControl(String(p.delay || 4), "4", function (v) { p.delay = Number(v) || 0; })));

      var once = el("select", "opl-select");
      [["Once per person", "1"], ["Every visit", "0"]].forEach(function (o) {
        var opt = el("option");
        opt.value = o[1]; opt.textContent = o[0];
        if ((p.once ? "1" : "0") === o[1]) opt.selected = true;
        once.appendChild(opt);
      });
      once.onchange = function () { p.once = once.value === "1"; };
      host.appendChild(field("How often", once));

      var pages = el("select", "opl-select");
      pages.multiple = true;
      pages.size = 7;
      allPages().forEach(function (name) {
        var opt = el("option");
        opt.value = name; opt.textContent = name;
        if ((p.pages || []).indexOf(name) !== -1) opt.selected = true;
        pages.appendChild(opt);
      });
      pages.onchange = function () {
        p.pages = Array.prototype.filter.call(pages.options, function (o) { return o.selected; })
          .map(function (o) { return o.value; });
      };
      host.appendChild(field("Which pages — choose none for every page", pages));
    }, [{
      label: existing ? "Save changes" : "Add it",
      primary: true,
      onClick: function () {
        if (!doc.popups) doc.popups = [];
        if (index >= 0) doc.popups[index] = p; else doc.popups.push(p);
        push();
        openPopups();
      }
    }]);
  }

  /* ------------------------------------------------------------------
     Publishing
     ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------
     What this publish would change
     ------------------------------------------------------------------
     Not everything she has ever changed, which is a different question and
     has its own sheet. This is the difference between the site as it
     stands published and the site as she has it now: the list of what
     visitors would notice tomorrow morning that they cannot see tonight.
     ------------------------------------------------------------------ */

  /* What the site itself says, for the half of a comparison that has no
     edit behind it. js/overlay.js kept this at the moment it first
     overwrote each element, so it survives a sign-in that never saw the
     untouched page. */
  function sitesOwn(id) {
    return OV.originalOf(id) || baseline[id] || {};
  }

  function styleBags(edit) {
    var out = {};
    Object.keys((edit || {}).style || {}).forEach(function (p) { out["base|" + p] = edit.style[p]; });
    Object.keys((edit || {}).styleAt || {}).forEach(function (screen) {
      Object.keys(edit.styleAt[screen]).forEach(function (p) { out[screen + "|" + p] = edit.styleAt[screen][p]; });
    });
    return out;
  }

  /* Every look that differs between two versions of one element, named the
     way the panel names it, with the width it applies at when that is not
     every width. */
  function styleDiff(was, now) {
    var a = styleBags(was), b = styleBags(now);
    var keys = {};
    Object.keys(a).concat(Object.keys(b)).forEach(function (k) { keys[k] = 1; });
    var rows = [];
    Object.keys(keys).sort().forEach(function (k) {
      if ((a[k] || "") === (b[k] || "")) return;
      var cut = k.split("|");
      rows.push({
        prop: cut[1],
        screen: cut[0] === "base" ? "" : cut[0],
        from: a[k] || "",
        to: b[k] || ""
      });
    });
    return rows;
  }

  function attrDiff(was, now) {
    var a = (was || {}).attrs || {}, b = (now || {}).attrs || {};
    var keys = {};
    Object.keys(a).concat(Object.keys(b)).forEach(function (k) { keys[k] = 1; });
    var rows = [];
    Object.keys(keys).sort().forEach(function (k) {
      if ((a[k] || "") === (b[k] || "")) return;
      rows.push({ name: k, from: a[k] || "", to: b[k] || "" });
    });
    return rows;
  }

  function wordsOf(edit, id) {
    if (edit && typeof edit.html === "string") return edit.html;
    if (edit && typeof edit.text === "string") return esc(edit.text);
    var own = sitesOwn(id);
    return typeof own.html === "string" ? own.html : "";
  }

  function pictureOf(edit, id) {
    if (edit && edit.src) return edit.src;
    var own = sitesOwn(id);
    return own.src || "";
  }

  function describeDiff(was, now, id) {
    was = was || {}; now = now || {};
    var bits = [];
    if (!!now.hidden !== !!was.hidden) bits.push(now.hidden ? "taken off the page" : "put back on the page");
    if (wordsOf(was, id) !== wordsOf(now, id)) bits.push("different wording");
    if ((now.src || "") !== (was.src || "")) bits.push("a different picture");
    if ((now.bgImage || "") !== (was.bgImage || "")) bits.push("a different background");
    var looks = styleDiff(was, now);
    if (looks.length) {
      bits.push(looks.length === 1
        ? "its " + plainProp(looks[0].prop)
        : looks.length + " changes to how it looks");
    }
    var attrs = attrDiff(was, now);
    attrs.forEach(function (r) { bits.push(plainAttr(r.name)); });
    return bits.join(", ") || "changed";
  }

  var PLAIN_PROP = {
    fontSize: "size", fontWeight: "weight", fontFamily: "typeface", lineHeight: "line height",
    letterSpacing: "letter spacing", textAlign: "alignment", color: "colour",
    backgroundColor: "background colour", background: "background", padding: "space inside",
    margin: "space around", borderRadius: "corner rounding", opacity: "opacity",
    width: "width", maxWidth: "widest it may get", height: "height", display: "whether it shows",
    objectFit: "how it fills its frame", border: "border", boxShadow: "shadow"
  };
  function plainProp(p) { return PLAIN_PROP[p] || p; }

  var PLAIN_ATTR = {
    href: "where it goes", alt: "its description for a screen reader",
    title: "its tooltip", src: "its picture", "aria-label": "its spoken label"
  };
  function plainAttr(a) { return PLAIN_ATTR[a] || a; }

  /* Every difference between what is published and what she has, as a flat
     list she can read down. */
  function changeRows() {
    var rows = [];
    var pages = {};
    Object.keys(doc.pages || {}).forEach(function (k) { pages[k] = 1; });
    Object.keys(published.pages || {}).forEach(function (k) { pages[k] = 1; });

    Object.keys(pages).sort().forEach(function (key) {
      var mine = (doc.pages || {})[key] || {};
      var live = (published.pages || {})[key] || {};
      var here = key === pageKey();

      var ids = {};
      Object.keys(mine.nodes || {}).forEach(function (id) { ids[id] = 1; });
      Object.keys(live.nodes || {}).forEach(function (id) { ids[id] = 1; });

      Object.keys(ids).forEach(function (id) {
        var was = (live.nodes || {})[id];
        var now = (mine.nodes || {})[id];
        if (JSON.stringify(was || null) === JSON.stringify(now || null)) return;
        var node = here ? OV.resolve(id) : null;
        rows.push({
          page: key, id: id, was: was, now: now, node: node,
          title: (now && now.label) || (was && was.label) || (node ? labelOf(node) : id),
          say: now ? describeDiff(was, now, id) : "put back the way it was"
        });
      });

      var madeNow = {}, madeLive = {};
      (mine.inserts || []).forEach(function (e) { madeNow[e.id] = e; });
      (live.inserts || []).forEach(function (e) { madeLive[e.id] = e; });
      Object.keys(madeNow).forEach(function (id) {
        if (madeLive[id] || ids[id]) return;
        rows.push({
          page: key, id: id, added: madeNow[id], node: here ? OV.resolve(id) : null,
          title: madeNow[id].label || "something added", say: "added, and not published yet"
        });
      });
      Object.keys(madeLive).forEach(function (id) {
        if (madeNow[id] || ids[id]) return;
        rows.push({
          page: key, id: id, removedInsert: madeLive[id],
          title: madeLive[id].label || "something added", say: "taken away again"
        });
      });

      if (JSON.stringify(mine.order || {}) !== JSON.stringify(live.order || {})) {
        rows.push({ page: key, id: "__order", title: "The order of things on this page", say: "something was moved" });
      }
      if (JSON.stringify(mine.meta || null) !== JSON.stringify(live.meta || null)) {
        rows.push({
          page: key, id: "__meta", title: "This page's title and sharing card", say: "changed",
          meta: { was: live.meta || {}, now: mine.meta || {} }
        });
      }
    });

    var gNow = doc.globals || {}, gLive = published.globals || {};
    if (JSON.stringify(gNow.imageSwaps || {}) !== JSON.stringify(gLive.imageSwaps || {})) {
      var swaps = Object.assign({}, gLive.imageSwaps, gNow.imageSwaps);
      Object.keys(swaps).forEach(function (from) {
        if ((gNow.imageSwaps || {})[from] === (gLive.imageSwaps || {})[from]) return;
        rows.push({
          page: "the whole site", id: "swap:" + from,
          title: from.split("/").pop() + ", everywhere it appears",
          say: (gNow.imageSwaps || {})[from] ? "a different picture" : "put back",
          swap: { from: from, was: (gLive.imageSwaps || {})[from] || from, now: (gNow.imageSwaps || {})[from] || from }
        });
      });
    }
    if ((gNow.css || "") !== (gLive.css || "")) {
      rows.push({ page: "the whole site", id: "__css", title: "A rule the assistant wrote for the whole site", say: "changed" });
    }
    if (JSON.stringify(doc.newPages || {}) !== JSON.stringify(published.newPages || {})) {
      var slugs = Object.assign({}, published.newPages, doc.newPages);
      Object.keys(slugs).forEach(function (slug) {
        var a = (published.newPages || {})[slug], b = (doc.newPages || {})[slug];
        if (JSON.stringify(a || null) === JSON.stringify(b || null)) return;
        rows.push({
          page: "the whole site", id: "page:" + slug,
          title: (b || a).title + "  (/p/" + slug + ")",
          say: !a ? "a new page, not published yet" : (!b ? "a page taken away" : "changed")
        });
      });
    }
    if (JSON.stringify((doc.popups || [])) !== JSON.stringify((published.popups || []))) {
      rows.push({ page: "the whole site", id: "__popups", title: "Popups", say: "changed" });
    }
    if (JSON.stringify((gNow.catalog || {})) !== JSON.stringify((gLive.catalog || {}))) {
      rows.push({ page: "the whole site", id: "__catalog", title: "Prices and titles", say: "changed" });
    }
    return rows;
  }

  /* ---- the two halves, side by side ---- */

  function colourish(v) { return /^(#|rgb|hsl)/i.test(String(v || "").trim()); }

  function valueChip(v, empty) {
    var span = el("span", "opl-ba-val");
    if (!v) { span.className += " none"; span.textContent = empty || "the site's own"; return span; }
    if (colourish(v)) {
      var dot = el("i", "opl-ba-dot");
      dot.style.background = v;
      span.appendChild(dot);
    }
    span.appendChild(document.createTextNode(String(v)));
    return span;
  }

  function halfOf(title, build) {
    var col = el("div", "opl-ba-col");
    col.appendChild(el("span", "opl-ba-tag", title));
    build(col);
    return col;
  }

  function beforeAfter(row) {
    var wrap = el("div", "opl-ba");

    if (row.swap) {
      [["Before", row.swap.was], ["After", row.swap.now]].forEach(function (side) {
        wrap.appendChild(halfOf(side[0], function (col) {
          var img = el("img", "opl-ba-img");
          img.src = side[1];
          col.appendChild(img);
        }));
      });
      return wrap;
    }

    if (row.added || row.removedInsert) {
      var made = row.added || row.removedInsert;
      wrap.appendChild(halfOf(row.added ? "Before" : "After", function (col) {
        col.appendChild(el("p", "opl-ba-none", "Not on the page."));
      }));
      wrap.appendChild(halfOf(row.added ? "After" : "Before", function (col) {
        col.appendChild(el("div", "opl-ba-html", OV.clean(made.html || "")));
      }));
      return wrap;
    }

    if (row.meta) {
      ["Before", "After"].forEach(function (side, i) {
        var m = i ? row.meta.now : row.meta.was;
        wrap.appendChild(halfOf(side, function (col) {
          col.appendChild(el("div", "opl-ba-html",
            "<b>" + esc(m.title || "the page's own title") + "</b><br>" + esc(m.description || "")));
        }));
      });
      return wrap;
    }

    var was = row.was || {}, now = row.now || {};
    var wordsWas = wordsOf(was, row.id), wordsNow = wordsOf(now, row.id);
    var picWas = pictureOf(was, row.id), picNow = pictureOf(now, row.id);
    var looks = styleDiff(was, now);
    var attrs = attrDiff(was, now);
    var hid = !!was.hidden !== !!now.hidden;

    function side(title, edit, words, pic) {
      return halfOf(title, function (col) {
        if (hid) col.appendChild(el("p", "opl-ba-none", edit.hidden ? "Taken off the page." : "On the page."));
        if (wordsWas !== wordsNow) col.appendChild(el("div", "opl-ba-html", OV.clean(words)));
        if (picWas !== picNow && pic) {
          var img = el("img", "opl-ba-img");
          img.src = pic;
          col.appendChild(img);
        }
        looks.forEach(function (r) {
          var line = el("div", "opl-ba-line");
          line.appendChild(el("b", null, esc(plainProp(r.prop) + (r.screen ? " (" + r.screen + ")" : ""))));
          line.appendChild(valueChip(title === "Before" ? r.from : r.to));
          col.appendChild(line);
        });
        attrs.forEach(function (r) {
          var line = el("div", "opl-ba-line");
          line.appendChild(el("b", null, esc(plainAttr(r.name))));
          line.appendChild(valueChip(title === "Before" ? r.from : r.to, "nothing"));
          col.appendChild(line);
        });
        /* Only the label, which means the difference is one this half has
           no way of drawing. Better said than left blank. */
        if (col.children.length === 1) col.appendChild(el("p", "opl-ba-none", "Nothing to draw for this one."));
      });
    }

    wrap.appendChild(side("Before", was, wordsWas, picWas));
    wrap.appendChild(side("After", now, wordsNow, picNow));
    return wrap;
  }

  /* ---- the sheet she meets when she presses Publish ---- */

  var peekBack = null;

  function openPublish() {
    var rows = changeRows();
    if (!rows.length) { toast("Nothing to publish. The site already says what you have."); return; }

    sheet("Before you publish", function (body) {
      body.appendChild(el("p", "opl-note",
        "These " + rows.length + " change" + (rows.length === 1 ? " is" : "s are") +
        " the difference between the site as visitors see it now and the site as you have it. " +
        "Nothing here is live until you press Publish."));

      var whole = el("button", "opl-btn", "See the whole site as it is published");
      whole.style.width = "100%";
      whole.style.marginBottom = "14px";
      whole.onclick = function () {
        peekBack = openPublish;
        closeSheet();
        peek(true);
        window.scrollTo({ top: 0, behavior: "smooth" });
      };
      body.appendChild(whole);

      var byPage = {};
      rows.forEach(function (r) { (byPage[r.page] = byPage[r.page] || []).push(r); });

      Object.keys(byPage).forEach(function (key) {
        body.appendChild(el("p", "opl-h", key + (key === pageKey() ? "  ·  you are here" : "")));
        var list = el("ul", "opl-list opl-bullets");

        byPage[key].forEach(function (r) {
          var item = el("li");
          var head = el("div");
          head.appendChild(el("b", null, esc(String(r.title).slice(0, 70))));
          head.appendChild(el("small", null, esc(r.say)));
          item.appendChild(head);

          var seeBtn = el("button", "opl-btn", "Before &amp; after");
          var panel = null;
          seeBtn.onclick = function () {
            if (panel) { panel.parentNode.removeChild(panel); panel = null; seeBtn.innerHTML = "Before &amp; after"; return; }
            panel = beforeAfter(r);
            item.appendChild(panel);
            seeBtn.textContent = "Hide";
          };
          item.appendChild(seeBtn);

          if (r.node) {
            var place = el("button", "opl-btn", "In place");
            place.title = "Show me this one on the page, as it is published";
            place.onclick = function () {
              peekBack = openPublish;
              closeSheet();
              peek(true);
              var again = OV.resolve(r.id);
              if (again) again.scrollIntoView({ behavior: "smooth", block: "center" });
            };
            item.appendChild(place);
          }

          list.appendChild(item);
        });
        body.appendChild(list);
      });
    }, [{
      label: "Publish all of it",
      primary: true,
      onClick: function () { closeSheet(); publish(); }
    }]);
  }

  function publish() {
    return post({ action: "publish", overlay: doc })
      .then(function (data) {
        published = copy(doc);
        currentIsSaved = !!data.currentIsSaved;
        draftState = "";
        if (typeof data.reserves === "number") reserves = data.reserves;
        refreshBar();

        /* The bill, said at the moment it is charged rather than found
           later on a statement. */
        if (data.spent) {
          toast("Published. Every visitor sees this now. That cost " + data.spent +
            (data.spent === 1 ? " reserve" : " reserves") + "; " + reserves + " left.");
        } else {
          toast("Published. Every visitor sees this now.");
        }
        lowWarning();
      })
      .catch(function (err) { toast(err.message, true); });
  }

  /* Said once when it matters, not on every publish from then on. */
  var lowSaid = false;

  function lowWarning() {
    if (reserves === Infinity || lowSaid) return;
    var floor = (ledger[0] && ledger[0].of) || 100;
    if (reserves > floor * 0.15) return;
    lowSaid = true;
    setTimeout(function () {
      toast("You have " + reserves + " reserves left. Wopara has been asked to write to you about topping up — " +
        "everything keeps working until they run out, and even then only the assistant stops.", true);
    }, 3200);
  }

  /* ------------------------------------------------------------------
     The bar
     ------------------------------------------------------------------ */

  function refreshBar() {
    var bar = document.getElementById("opl-bar");
    if (!bar) return;
    bar.querySelector("[data-opl-undo]").disabled = hIndex <= 0;
    bar.querySelector("[data-opl-redo]").disabled = hIndex >= history.length - 1;
    /* Two things at once: that there is unpublished work, and that it is
       somewhere safe. The second is the one that lets her close the laptop
       in the middle of a sentence. */
    var count = bar.querySelector("#opl-count");
    var kept = { keeping: "keeping…", kept: "kept for later", adrift: "not kept yet" }[draftState] || "";
    count.textContent = peeking
      ? "you are looking at the published site"
      : (dirty() ? "unpublished changes" + (kept ? "  ·  " + kept : "") : "");
    count.className = draftState === "adrift" && dirty() && !peeking ? "bad" : "";

    var purse = bar.querySelector("#opl-reserves");
    if (purse) {
      if (reserves === Infinity) purse.textContent = "";
      else {
        purse.textContent = reserves + " reserves";
        purse.classList.toggle("low", reserves <= 15);
      }
    }
    bar.querySelector("[data-opl-publish]").disabled = !dirty() || peeking;
  }

  function buildChrome() {
    var bar = el("div");
    bar.id = "opl-bar";
    bar.innerHTML =
      '<div class="opl-brand">' +
      '  <img class="opl-brand-mark" src="' + esc(BRAND.logo) + '" alt="" width="18" height="18">' +
      '  <span><b>' + esc(BRAND.name) + "</b><span>" + esc(pageKey()) + "</span></span></div>" +
      '<button class="opl-btn" data-opl-undo title="Undo (Cmd/Ctrl + Z)">&#8630; Undo</button>' +
      '<button class="opl-btn" data-opl-redo title="Redo (Cmd/Ctrl + Shift + Z)">&#8631; Redo</button>' +
      '<button class="opl-btn" data-opl-add title="Add a heading, a row of cards, a picture">&#43; Add</button>' +
      '<button class="opl-btn" data-opl-ai>&#10022; Ask</button>' +
      '<button class="opl-btn" data-opl-screen title="See this page at phone width">&#9744; Screen</button>' +
      '<button class="opl-btn" data-opl-more>More &#9662;</button>' +
      '<span id="opl-count"></span>' +
      '<span id="opl-reserves" title="What a publish, a picture or an ask will draw on"></span>' +
      '<button class="opl-btn primary" data-opl-publish>Publish</button>' +
      '<button class="opl-btn icon" data-opl-help title="Show me round again">?</button>' +
      '<button class="opl-btn" data-opl-out>Sign out</button>';
    document.body.appendChild(bar);

    /* Nine things do not fit on a phone's bottom bar, and six of them are
       rare. The common ones stay out; the rest live behind one word. */
    var more = el("div");
    more.id = "opl-more";
    var menu = [
      ["This page's title &amp; sharing card", openIdentity],
      ["Menus &amp; links", openNav],
      ["Pages", openPages],
      ["Posts", openPosts],
      ["Popups", openPopups],
      ["Check the site", openChecks],
      ["What I've changed", openChanges],
      ["Throw away what is not published", dropDraft],
      ["Saved versions", function () { loadState().then(openSaves).catch(function (e) { toast(e.message, true); }); }],
      ["What it has cost", function () { loadState().then(openLedger).catch(function (e) { toast(e.message, true); }); }]
    ];
    /* Only offered where the site has given Opaline something to edit. */
    if (CONFIG.data && CONFIG.data.panel) menu.splice(4, 0, [CONFIG.data.label || "This site\u2019s figures", openData]);
    menu.forEach(function (item) {
      var b = el("button", "opl-more-item", item[0]);
      b.onclick = function () { more.classList.remove("open"); item[1](); };
      more.appendChild(b);
    });
    document.body.appendChild(more);

    bar.querySelector("[data-opl-undo]").onclick = undo;
    bar.querySelector("[data-opl-redo]").onclick = redo;
    bar.querySelector("[data-opl-add]").onclick = function () { openBlocks(selected); };
    bar.querySelector("[data-opl-ai]").onclick = openAI;
    bar.querySelector("[data-opl-screen]").onclick = openPreview;
    /* Publishing goes through the list first. She asked to see what she was
       about to do to the site before she did it, which is the one moment
       the question is worth asking. */
    bar.querySelector("[data-opl-publish]").onclick = openPublish;
    bar.querySelector("[data-opl-help]").onclick = function () { tour(0); };
    bar.querySelector("[data-opl-out]").onclick = signOut;

    /* The bar sits along the bottom on a laptop and along the top on a
       phone, so the menu cannot assume which way to open. It measures
       itself, picks the side with room, and is clamped into the window
       either way — the same mistake the tour made, and it put this menu
       270px above the top of an iPhone, taking half the editor with it. */
    var moreBtn = bar.querySelector("[data-opl-more]");

    function placeMore() {
      var box = moreBtn.getBoundingClientRect();
      var high = more.offsetHeight;
      var wide = more.offsetWidth;

      var below = box.bottom + high + 12 <= window.innerHeight;
      var top = below ? box.bottom + 8 : box.top - high - 8;

      more.style.top = Math.max(10, Math.min(top, window.innerHeight - high - 10)) + "px";
      more.style.left = Math.max(10, Math.min(box.left, window.innerWidth - wide - 10)) + "px";
    }

    moreBtn.onclick = function (e) {
      e.stopPropagation();
      var opening = !more.classList.contains("open");
      more.classList.toggle("open", opening);
      /* Measured only once it is displayed — a menu with display:none has
         no height, and every sum below would come out wrong. */
      if (opening) placeMore();
    };
    window.addEventListener("resize", function () {
      if (more.classList.contains("open")) placeMore();
      clearFixedChrome();
      fitTail();
    });
    window.addEventListener("orientationchange", function () { clearFixedChrome(); fitTail(); });
    clearFixedChrome();
    fitTail();
    document.addEventListener("click", function () { more.classList.remove("open"); });

    var panel = el("div");
    panel.id = "opl-panel";
    panel.innerHTML =
      '<div class="opl-panel-head"><div></div><button class="opl-btn icon" data-opl-close aria-label="Close">&times;</button></div>' +
      '<div class="opl-panel-body"></div>';
    document.body.appendChild(panel);
    panel.querySelector("[data-opl-close]").onclick = clearSelection;

    var host = el("div");
    host.id = "opl-sheet";
    host.innerHTML =
      '<div class="opl-sheet-card">' +
      '<div class="opl-sheet-head"><h3></h3></div>' +
      '<div class="opl-sheet-body"></div>' +
      '<div class="opl-sheet-foot"></div>' +
      "</div>";
    document.body.appendChild(host);
    host.addEventListener("click", function (e) { if (e.target === host) closeSheet(); });

    tag = el("div");
    tag.id = "opl-tag";
    document.body.appendChild(tag);
  }

  /* ------------------------------------------------------------------
     Coming and going
     ------------------------------------------------------------------ */

  function boot() {
    if (booted) return;
    booted = true;
    window.OPALINE_EDITING = true;
    document.body.classList.add("opl-editing");

    buildChrome();

    loadState()
      .then(function (data) {
        published = data.overlay || OV.empty();

        /* Where she left off, whichever machine she left off on. The
           published document stays the published document: this is her
           copy of it, laid on top, and nobody else can see it. */
        var resumed = data.draft && JSON.stringify(data.draft) !== JSON.stringify(published);
        doc = resumed ? data.draft : copy(published);

        history = [copy(doc)];
        hIndex = 0;
        draftState = resumed ? "kept" : "";
        render();
        seedBaseline();
        healAndReport();

        if (resumed) {
          var when = data.draftAt ? new Date(data.draftAt) : null;
          toast("Picking up where you left off" +
            (when ? ", from " + when.toLocaleString() : "") +
            ". Nobody sees this until you publish.");
        } else if (!tourSeen()) setTimeout(function () { tour(0); }, 700);
        else toast("Signed in. Click anything to change it.");
      })
      .catch(function (err) {
        toast(err.message, true);
        doc = copy(OV.get());
        published = copy(doc);
        history = [copy(doc)];
        hIndex = 0;
        render();
      });

    document.addEventListener("click", onPageClick, true);
    document.addEventListener("mousemove", onPageMove, true);
    document.addEventListener("opaline:overlay", function () { if (booted) mark(); });

    document.addEventListener("keydown", function (e) {
      var typing = e.target.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        if (typing && e.target.isContentEditable) return;   // let the browser undo the words
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); openPublish(); }
      if (e.key === "Escape" && !typing) {
        if (peeking) { peek(false); return; }
        closeSheet();
        clearSelection();
      }
    });

    /* Only when the last thing she did has not reached the store yet.
       Warning her about work that is already kept somewhere she can pick
       it up from is the kind of alarm people learn to click through. */
    window.addEventListener("beforeunload", function (e) {
      if (!dirty() || draftState === "kept") return;
      e.preventDefault();
      e.returnValue = "";
    });

    /* And the last beat of typing, sent before the tab goes. */
    window.addEventListener("pagehide", function () {
      if (!dirty() || draftState === "kept" || !token) return;
      try {
        navigator.sendBeacon(ENDPOINT, new Blob(
          [JSON.stringify({ token: token, action: "draft", overlay: doc })],
          { type: "application/json" }
        ));
      } catch (err) { }
    });
  }

  function signOut() {
    if (dirty() && draftState !== "kept" &&
      !confirm("Your last few changes have not been kept yet. Sign out anyway?")) return;
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) { }
    token = null;
    window.OPALINE_EDITING = false;
    location.reload();
  }

  /* ---- the password ---- */

  /* ------------------------------------------------------------------
     The showreel
     ------------------------------------------------------------------
     Fourteen seconds of what she is about to be able to do, drawn beside
     the password box: a cursor arrives, outlines snap around a heading,
     the words change, a picture is replaced, a card is copied, a colour
     is picked, and the whole thing is published.

     Every part shares one fourteen-second animation and expresses its own
     moment as a percentage of it, so nothing can drift out of step with
     anything else however long the page has been open. Whoever is reading
     with motion turned off gets the finished frame instead, which says the
     same thing more quietly.
     ------------------------------------------------------------------ */
  function showreel() {
    var line = function (x, y, w, h, cls, extra) {
      return '<rect class="' + cls + '" x="' + x + '" y="' + y + '" width="' + w + '" height="' + h +
        '" rx="' + (h / 2) + '"' + (extra || "") + "/>";
    };

    return '' +
      '<svg class="op-reel" viewBox="0 0 560 372" role="img" ' +
      'aria-label="A short animation: a cursor selects a heading and retypes it, replaces a picture, copies a card, picks a colour, and publishes the page.">' +
      "<defs>" +
      '  <linearGradient id="op-sky" x1="0" y1="0" x2="1" y2="1">' +
      '    <stop offset="0%" stop-color="#3f5a4c"/><stop offset="100%" stop-color="#6E8F7B"/></linearGradient>' +
      '  <linearGradient id="op-warm" x1="0" y1="0" x2="1" y2="1">' +
      '    <stop offset="0%" stop-color="#B86F52"/><stop offset="100%" stop-color="#D8A06A"/></linearGradient>' +
      '  <clipPath id="op-shot"><rect x="34" y="150" width="150" height="96" rx="10"/></clipPath>' +
      "</defs>" +

      /* the page being worked on */
      '<rect class="op-page" x="18" y="14" width="524" height="300" rx="16"/>' +

      /* its own header: a mark and three links */
      '<circle class="op-ink op-logo" cx="46" cy="42" r="9"/>' +
      line(400, 38, 34, 7, "op-ink op-dim") +
      line(444, 38, 34, 7, "op-ink op-dim") +
      line(488, 38, 34, 7, "op-ink op-dim") +

      /* the heading she edits, and the body under it */
      '<g class="op-head">' +
      line(34, 76, 232, 17, "op-ink op-headline") +
      line(34, 104, 300, 8, "op-ink op-dim") +
      line(34, 120, 258, 8, "op-ink op-dim") +
      "</g>" +
      '<rect class="op-box op-box-text" x="28" y="70" width="244" height="29" rx="6"/>' +
      '<text class="op-chip op-chip-text" x="30" y="64">TEXT</text>' +

      /* the picture she replaces */
      '<g clip-path="url(#op-shot)">' +
      '  <rect class="op-shot-old" x="34" y="150" width="150" height="96"/>' +
      '  <rect class="op-shot-new" x="34" y="150" width="150" height="96"/>' +
      "</g>" +
      '<rect class="op-box op-box-img" x="30" y="146" width="158" height="104" rx="10"/>' +
      '<text class="op-chip op-chip-img" x="32" y="140">PICTURE</text>' +

      /* three cards; the middle one gets copied */
      '<g class="op-card op-card-1"><rect x="210" y="150" width="98" height="96" rx="10"/>' +
      line(224, 168, 56, 8, "op-ink op-dim") + line(224, 184, 70, 6, "op-ink op-faint") + "</g>" +
      '<g class="op-card op-card-2"><rect x="320" y="150" width="98" height="96" rx="10"/>' +
      line(334, 168, 56, 8, "op-ink op-dim") + line(334, 184, 70, 6, "op-ink op-faint") + "</g>" +
      '<g class="op-card op-card-copy"><rect x="320" y="150" width="98" height="96" rx="10"/>' +
      line(334, 168, 56, 8, "op-ink op-dim") + line(334, 184, 70, 6, "op-ink op-faint") + "</g>" +
      '<rect class="op-box op-box-card" x="316" y="146" width="106" height="104" rx="10"/>' +
      '<text class="op-chip op-chip-card" x="318" y="140">BLOCK</text>' +

      /* the foot of the page */
      line(34, 268, 180, 8, "op-ink op-faint") +
      line(34, 284, 120, 8, "op-ink op-faint") +

      /* the inspector, sliding in for the colour */
      '<g class="op-panel">' +
      '  <rect x="404" y="256" width="130" height="50" rx="9"/>' +
      '  <circle class="op-sw op-sw-1" cx="424" cy="281" r="8"/>' +
      '  <circle class="op-sw op-sw-2" cx="448" cy="281" r="8"/>' +
      '  <circle class="op-sw op-sw-3" cx="472" cy="281" r="8"/>' +
      '  <circle class="op-sw op-sw-4" cx="496" cy="281" r="8"/>' +
      '  <circle class="op-sw-ring" cx="472" cy="281" r="12"/>' +
      "</g>" +

      /* the Opaline bar */
      '<g class="op-bar">' +
      '  <rect x="150" y="328" width="260" height="30" rx="10"/>' +
      '  <circle class="op-bar-dot" cx="170" cy="343" r="4"/>' +
      line(182, 340, 26, 6, "op-bar-item") +
      line(216, 340, 22, 6, "op-bar-item") +
      line(246, 340, 26, 6, "op-bar-item") +
      '  <rect class="op-publish" x="330" y="334" width="62" height="18" rx="7"/>' +
      '  <text class="op-publish-word" x="361" y="347">PUBLISH</text>' +
      '  <circle class="op-ping" cx="361" cy="343" r="10"/>' +
      "</g>" +

      /* and the hand doing it */
      '<g class="op-cursor">' +
      '  <circle class="op-click" cx="0" cy="0" r="4"/>' +
      '  <path d="M0 0 L0 17 L4.4 12.8 L7.4 19.4 L10.6 17.9 L7.6 11.4 L13.6 11z"/>' +
      "</g>" +
      "</svg>";
  }

  function gate() {
    if (document.getElementById("opl-gate")) return;

    var host = el("div");
    host.id = "opl-gate";
    host.innerHTML =
      '<div class="op-gate-card">' +
      '<div class="op-gate-reel">' + showreel() + "</div>" +
      "<form>" +
      '<div class="op-brand">' +
      '  <img src="' + esc(BRAND.logo) + '" alt="Wopara" width="44" height="44">' +
      '  <div><b>Wopara ' + esc(BRAND.name) + "</b><span>Edit this site, from inside it</span></div>" +
      "</div>" +
      '<p class="opl-note">Everything you change is yours to undo, and nobody sees it until you press Publish.</p>' +
      '<input class="opl-input" type="password" autocomplete="current-password" placeholder="Password" aria-label="Password">' +
      '<p class="opl-err"></p>' +
      '<div style="display:flex;gap:8px;margin-top:16px">' +
      '<button class="opl-btn primary" type="submit" style="flex:1">Start editing</button>' +
      '<button class="opl-btn" type="button" data-opl-cancel>Cancel</button>' +
      "</div>" +
      /* Whoever is looking at this box on somebody else's site is, by
         definition, somebody who has just seen what Opaline does. This is
         the only place that is true, so it is the only place worth
         saying it. */
      '<a class="op-get" href="https://wopara.com/museum/#embed" target="_blank" rel="noopener">' +
      "Add Opaline to your website now" +
      '<span aria-hidden="true">&rarr;</span></a>' +
      "</form>" +
      "</div>";
    document.body.appendChild(host);
    requestAnimationFrame(function () { host.classList.add("open"); });

    var form = host.querySelector("form");
    var input = host.querySelector("input");
    var err = host.querySelector(".opl-err");
    var submit = host.querySelector('[type="submit"]');
    setTimeout(function () { input.focus(); }, 120);

    function away() {
      document.removeEventListener("keydown", escape);
      host.classList.remove("open");
      setTimeout(function () { if (host.parentNode) host.parentNode.removeChild(host); }, 220);
    }
    /* Three ways out of a box that covers the whole screen: the button, the
       dark around it, and the key everyone reaches for. */
    function escape(e) { if (e.key === "Escape") away(); }
    document.addEventListener("keydown", escape);
    host.querySelector("[data-opl-cancel]").onclick = away;
    host.addEventListener("click", function (e) { if (e.target === host) away(); });

    form.onsubmit = function (e) {
      e.preventDefault();
      err.className = "opl-err";
      submit.disabled = true;
      submit.textContent = "Checking…";

      fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "login", password: input.value, site: SITE })
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (out) {
          if (!out.ok) throw new Error(out.d.error || "That did not work.");
          token = out.d.token;
          try { localStorage.setItem(TOKEN_KEY, JSON.stringify({ token: token, expires: out.d.expires })); } catch (e) { }
          away();
          boot();
        })
        .catch(function (e2) {
          err.textContent = e2.message;
          err.className = "opl-err on";
          input.value = "";
          input.focus();
          submit.disabled = false;
          submit.textContent = "Sign in";
        });
    };
  }

  function storedToken() {
    try {
      var saved = JSON.parse(localStorage.getItem(TOKEN_KEY) || "null");
      if (saved && saved.token && saved.expires > Date.now()) return saved.token;
    } catch (e) { }
    return null;
  }

  /* ==================================================================
     Learning the site it landed on
     ==================================================================
     On a site Wopara built, the palette and the faces are known. On a
     site it did not, nothing is — and a colour picker offering somebody
     else's brand colours is worse than useless, because every choice it
     offers is a way to make the page look wrong.

     So the swatches and the font list are read off the page itself: the
     colours it actually uses, in order of how much of it they cover, and
     the faces it actually sets. What she is offered is what her designer
     already chose, which is the only palette that cannot clash.
     ================================================================== */

  function readDesign() {
    var colourWeight = {};
    var backWeight = {};
    var faces = {};
    var radii = {};

    var all = document.body.getElementsByTagName("*");
    var step = Math.max(1, Math.floor(all.length / 900));   // a sample is plenty

    for (var i = 0; i < all.length; i += step) {
      var el = all[i];
      if (el.closest && el.closest("#opl-bar, #opl-panel, #opl-sheet, #opl-gate, #opl-tour")) continue;
      var box = el.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      var seen = getComputedStyle(el);
      var area = Math.min(box.width * box.height, 400000);

      var text = (el.textContent || "").trim();
      if (text && text.length < 400) {
        colourWeight[seen.color] = (colourWeight[seen.color] || 0) + text.length;
        var face = (seen.fontFamily || "").split(",")[0].replace(/["']/g, "").trim();
        if (face) faces[face] = (faces[face] || 0) + text.length;
      }
      var bg = seen.backgroundColor;
      if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
        backWeight[bg] = (backWeight[bg] || 0) + area;
      }
      var r = parseFloat(seen.borderRadius);
      if (r > 0) radii[seen.borderRadius] = (radii[seen.borderRadius] || 0) + 1;
    }

    var rank = function (bag, limit) {
      return Object.keys(bag)
        .sort(function (a, b) { return bag[b] - bag[a]; })
        .slice(0, limit);
    };

    /* Inks first, since a colour is most often wanted for words, then the
       grounds they sit on — which are the same colours she will reach for
       when she wants a block to stand out. */
    var swatches = rank(colourWeight, 7).concat(rank(backWeight, 6));
    var unique = [];
    swatches.forEach(function (c) {
      if (c && c !== "rgba(0, 0, 0, 0)" && unique.indexOf(c) === -1) unique.push(c);
    });

    return {
      swatches: unique.slice(0, 12),
      fonts: rank(faces, 4),
      radius: rank(radii, 1)[0] || "8px"
    };
  }

  /* Read once, when she signs in, and only where the site has not been
     told what its own palette is. */
  var learned = null;

  function palette() {
    if (CONFIG.palette && CONFIG.palette.length) return CONFIG.palette;
    if (!learned) learned = readDesign();
    return learned.swatches;
  }

  function faceList() {
    var mine = (CONFIG.fonts || []).slice();
    if (!mine.length) {
      if (!learned) learned = readDesign();
      mine = learned.fonts.map(function (f) {
        return { label: f + " \u2014 already on this site", value: '"' + f + '"' };
      });
    }
    return mine.concat(WEB_FONTS);
  }

  /* ==================================================================
     Adding things
     ================================================================== */

  function insertBlock(html, anchor, above) {
    var entry = { id: rid("x-"), html: html, label: "added block" };

    if (anchor) {
      /* Beside the thing she had selected — which means the whole row it
         sits in gets named first, or the insertion would move what every
         other address in that row refers to. */
      if (anchor.parentElement) pinRow(anchor.parentElement);
      entry.after = pin(anchor);
      if (above) entry.above = true;
    } else {
      entry.before = "footer";
    }

    pageDoc().inserts.push(entry);
    push();
    closeSheet();
    toast("Added. Click it to change the words.");

    setTimeout(function () {
      var made = OV.resolve(entry.id);
      if (made) {
        made.scrollIntoView({ behavior: "smooth", block: "center" });
        select(made);
      }
    }, 250);
  }

  function openBlocks(anchor) {
    var where = anchor ? "after" : "end";

    sheet("Add something", function (body) {
      if (anchor) {
        body.appendChild(el("p", "opl-note", "It will go beside what you have selected: " + esc(labelOf(anchor))));
        var whereRow = el("div", "opl-screens");
        [["above", "Above it"], ["after", "Below it"], ["end", "At the very bottom"]].forEach(function (o) {
          var chip = el("button", "opl-chip" + (where === o[0] ? " on" : ""), o[1]);
          chip.type = "button";
          chip.onclick = function () {
            where = o[0];
            whereRow.querySelectorAll(".opl-chip").forEach(function (c) { c.classList.remove("on"); });
            chip.classList.add("on");
          };
          whereRow.appendChild(chip);
        });
        body.appendChild(field("Where", whereRow));
        body.appendChild(el("hr", "opl-hr"));
      } else {
        body.appendChild(el("p", "opl-note", "It will go at the bottom of this page. Once it is there you can move it up, or select something first and add beside it."));
      }

      var groups = [];
      BLOCKS.forEach(function (b) { if (groups.indexOf(b.group) === -1) groups.push(b.group); });

      groups.forEach(function (group) {
        body.appendChild(el("p", "opl-h", group));
        var grid = el("div", "opl-blocks");
        BLOCKS.filter(function (b) { return b.group === group; }).forEach(function (b) {
          var card = el("button", "opl-block");
          card.type = "button";
          card.innerHTML = "<b>" + esc(b.name) + "</b><span>" + esc(b.hint) + "</span>";
          card.onclick = function () {
            insertBlock(b.html, where === "end" ? null : anchor, where === "above");
          };
          grid.appendChild(card);
        });
        body.appendChild(grid);
      });
    }, []);
  }

  /* ==================================================================
     What this page is called, and what it looks like when shared
     ================================================================== */

  function openIdentity() {
    var page = pageDoc();
    var current = page.meta || {};

    sheet("This page's name and sharing card", function (body) {
      body.appendChild(el("p", "opl-note",
        "The title is what shows in the browser tab and as the blue line in a Google result. " +
        "The description is the grey line under it. The picture is what appears when somebody shares the page on Facebook, LinkedIn or WhatsApp."));

      var title = el("input", "opl-input");
      title.value = current.title || document.title;
      title.maxLength = 70;
      var titleCount = el("p", "opl-note");
      var sayTitle = function () {
        var n = title.value.length;
        titleCount.textContent = n + " characters. " +
          (n > 60 ? "Google will cut this short — under 60 reads better." : "That sits well in a search result.");
      };
      title.oninput = sayTitle;
      sayTitle();
      body.appendChild(field("Title", title));
      body.appendChild(titleCount);

      var desc = el("textarea", "opl-area");
      var already = document.head.querySelector('meta[name="description"]');
      desc.value = current.description || (already ? already.getAttribute("content") : "");
      var descCount = el("p", "opl-note");
      var sayDesc = function () {
        var n = desc.value.length;
        descCount.textContent = n + " characters. " +
          (n > 160 ? "Google will cut this short — under 155 reads better." : "Good length.");
      };
      desc.oninput = sayDesc;
      sayDesc();
      body.appendChild(field("Description", desc));
      body.appendChild(descCount);

      var picked = el("div");
      var shown = current.image || (document.head.querySelector('meta[property="og:image"]') || {}).content;
      if (shown) {
        var thumb = el("img", "opl-thumb");
        thumb.src = shown;
        picked.appendChild(thumb);
      }
      var pick = el("button", "opl-btn", shown ? "Change the sharing picture" : "Add a sharing picture");
      pick.onclick = function () {
        pickFile().then(upload).then(function (url) {
          page.meta = page.meta || {};
          page.meta.image = url;
          push();
          openIdentity();
        }).catch(function () { });
      };
      picked.appendChild(pick);
      body.appendChild(field("Sharing picture — 1200 by 630 works best", picked));

      body.appendChild(el("p", "opl-note",
        "Pages you make in the editor are deliberately hidden from search engines: their words live in the overlay rather than in a file, so there is nothing for a crawler to read."));
    }, [{
      label: "Save",
      primary: true,
      onClick: function () {
        var host = document.getElementById("opl-sheet");
        page.meta = page.meta || {};
        page.meta.title = host.querySelector(".opl-input").value.trim();
        page.meta.description = host.querySelector(".opl-area").value.trim();
        push();
        closeSheet();
        toast("Saved. Publish when you are ready.");
      }
    }]);
  }

  /* ==================================================================
     Navigation
     ================================================================== */

  function navLinks() {
    var seen = {};
    var out = [];
    document.querySelectorAll("#site-header .nav-links a, #site-footer .footer-grid a, #mobile-menu .menu-foot a").forEach(function (a) {
      var href = a.getAttribute("href");
      if (!href || href === "#" || a.hasAttribute("data-opaline")) return;
      if (seen[href]) return;
      seen[href] = true;
      out.push({ href: href, label: (a.textContent || "").trim(), where: a.closest("#site-header") ? "Header" : (a.closest("#mobile-menu") ? "Menu" : "Footer") });
    });
    return out;
  }

  function openNav() {
    if (!doc.globals) doc.globals = {};
    var nav = doc.globals.nav = doc.globals.nav || {};
    nav.hide = nav.hide || [];
    nav.rename = nav.rename || {};
    nav.add = nav.add || [];

    sheet("Navigation", function (body) {
      body.appendChild(el("p", "opl-note",
        "Every link in the header, the menu and the footer. Renaming or hiding one reaches every copy of it at once."));

      var list = el("ul", "opl-list");
      navLinks().forEach(function (link) {
        var row = el("li");
        var hidden = nav.hide.indexOf(link.href) !== -1;

        var name = el("input", "opl-input");
        name.value = nav.rename[link.href] || link.label;
        name.onchange = function () {
          if (name.value.trim() && name.value.trim() !== link.label) nav.rename[link.href] = name.value.trim();
          else delete nav.rename[link.href];
          push();
        };
        var box = el("div");
        box.appendChild(name);
        box.appendChild(el("small", null, esc(link.where) + " &middot; " + esc(link.href)));
        row.appendChild(box);

        var toggle = el("button", "opl-btn" + (hidden ? "" : " danger"), hidden ? "Show" : "Hide");
        toggle.onclick = function () {
          if (hidden) nav.hide = nav.hide.filter(function (h) { return h !== link.href; });
          else nav.hide.push(link.href);
          push();
          openNav();
        };
        row.appendChild(toggle);
        list.appendChild(row);
      });
      body.appendChild(list);

      if (nav.add.length) {
        body.appendChild(el("p", "opl-h", "Links you added"));
        var mine = el("ul", "opl-list");
        nav.add.forEach(function (item, i) {
          var row = el("li");
          row.appendChild(el("div", null, "<b>" + esc(item.label) + "</b><small>" + esc(item.href) + "</small>"));
          var drop = el("button", "opl-btn danger icon", "&times;");
          drop.onclick = function () { nav.add.splice(i, 1); push(); openNav(); };
          row.appendChild(drop);
          mine.appendChild(row);
        });
        body.appendChild(mine);
      }

      body.appendChild(el("hr", "opl-hr"));
      body.appendChild(el("p", "opl-h", "Add a link"));
      var label = el("input", "opl-input");
      label.placeholder = "What it says";
      var href = el("input", "opl-input");
      href.placeholder = "about.html, or https://…";
      body.appendChild(field("Words", label));
      body.appendChild(field("Where it goes", href));
      var add = el("button", "opl-btn primary", "Add it");
      add.onclick = function () {
        if (!label.value.trim() || !href.value.trim()) { toast("Both boxes, please", true); return; }
        nav.add.push({ label: label.value.trim(), href: href.value.trim() });
        push();
        openNav();
      };
      body.appendChild(add);
    }, []);
  }

  /* ==================================================================
     Checking the whole site
     ================================================================== */

  function checkLinks() {
    var pages = SITE_PAGES.slice();
    var found = [];

    return Promise.all(pages.map(function (name) {
      return fetch(name)
        .then(function (r) { return r.ok ? r.text() : null; })
        .then(function (html) {
          if (!html) return { name: name, missing: true };
          var parsed = new DOMParser().parseFromString(html, "text/html");
          var ids = {};
          parsed.querySelectorAll("[id]").forEach(function (n) { ids[n.id] = true; });
          var links = [];
          parsed.querySelectorAll("a[href]").forEach(function (a) { links.push(a.getAttribute("href")); });
          return { name: name, ids: ids, links: links };
        })
        .catch(function () { return { name: name, missing: true }; });
    })).then(function (pageData) {
      var known = {};
      pageData.forEach(function (p) { if (!p.missing) known[p.name] = p; });

      /* Pages she made carry their anchors in the overlay rather than in a
         file, so they are added by name and their links are not walked. */
      Object.keys(doc.newPages || {}).forEach(function (slug) { known["p/" + slug] = { ids: {} }; });

      pageData.forEach(function (p) {
        if (p.missing) { found.push({ on: p.name, href: "", say: "This page could not be fetched." }); return; }
        var seen = {};
        p.links.forEach(function (href) {
          if (!href || seen[href]) return;
          seen[href] = true;
          if (/^(https?:|mailto:|tel:|#|javascript:)/.test(href)) return;   // external, or on the page itself

          var parts = href.split("#");
          var file = parts[0] || p.name;
          var anchor = parts[1];

          if (!known[file] && SITE_PAGES.indexOf(file) === -1 && file !== "page.html") {
            found.push({ on: p.name, href: href, say: "There is no page called " + file + "." });
            return;
          }
          if (anchor && known[file] && known[file].ids && Object.keys(known[file].ids).length && !known[file].ids[anchor]) {
            found.push({ on: p.name, href: href, say: "There is nothing called #" + anchor + " on " + file + "." });
          }
        });
      });
      return found;
    });
  }

  function openChecks() {
    sheet("Check the site", function (body) {
      var problems = pageProblems();

      function listOf(rows) {
        var list = el("ul", "opl-list");
        rows.forEach(function (p) {
          var row = el("li");
          row.appendChild(el("div", null,
            "<b>" + esc(labelOf(p.node)) + "</b><small>" + esc(p.say) + "</small>"));
          var go = el("button", "opl-btn", "Fix");
          go.onclick = function () {
            closeSheet();
            p.node.scrollIntoView({ behavior: "smooth", block: "center" });
            select(p.node);
          };
          row.appendChild(go);
          list.appendChild(row);
        });
        return list;
      }

      body.appendChild(el("p", "opl-h", "In your changes, on this page"));
      if (!problems.mine.length) {
        body.appendChild(el("p", "opl-ok", "Nothing you have changed is hard to read, and every picture you added is described."));
      } else {
        body.appendChild(listOf(problems.mine));
      }

      /* The site's own, kept behind a door. They are real, but they are not
         hers and not today's job, and a list she cannot act on is a list she
         stops opening. */
      if (problems.already.length) {
        body.appendChild(el("hr", "opl-hr"));
        var reveal = el("button", "opl-btn",
          "The site itself has " + problems.already.length + " of these &mdash; show me");
        reveal.style.width = "100%";
        reveal.onclick = function () {
          reveal.remove();
          body.insertBefore(el("p", "opl-note",
            "These came with the site's own design rather than with anything you changed — a terracotta button with white type, for instance, sits just under the mark and always has. " +
            "You can fix any of them the same way as anything else, or leave them and send this list to whoever built it."), afterHere);
          body.insertBefore(listOf(problems.already), afterHere);
        };
        body.appendChild(reveal);
        var afterHere = el("span");
        body.appendChild(afterHere);
      }

      body.appendChild(el("hr", "opl-hr"));
      body.appendChild(el("p", "opl-h", "Links across the whole site"));
      var linkBox = el("div");
      linkBox.appendChild(el("p", "opl-note", "Reading every page…"));
      body.appendChild(linkBox);

      checkLinks().then(function (broken) {
        linkBox.innerHTML = "";
        if (!broken.length) {
          linkBox.appendChild(el("p", "opl-ok", "Every link inside the site points at something real."));
          linkBox.appendChild(el("p", "opl-note", "Links out to other websites are not checked from here — a browser is not allowed to test them."));
          return;
        }
        var list = el("ul", "opl-list");
        broken.forEach(function (b) {
          var row = el("li");
          row.appendChild(el("div", null, "<b>" + esc(b.href || b.on) + "</b><small>On " + esc(b.on) + " &middot; " + esc(b.say) + "</small>"));
          list.appendChild(row);
        });
        linkBox.appendChild(list);
        linkBox.appendChild(el("p", "opl-note", "These live in the pages themselves rather than in your changes, so they need a developer. Send this list on."));
      });
    }, []);
  }

  /* ==================================================================
     What she has changed
     ================================================================== */

  function describeEdit(edit) {
    var bits = [];
    if (edit.hidden) bits.push("removed");
    if (typeof edit.html === "string" || typeof edit.text === "string") bits.push("wording");
    if (edit.src) bits.push("picture");
    if (edit.bgImage) bits.push("background");
    if (edit.style) bits.push(Object.keys(edit.style).length + " style change(s)");
    if (edit.styleAt) bits.push("sizes for " + Object.keys(edit.styleAt).join(" and "));
    if (edit.attrs) bits.push("link or description");
    return bits.join(", ") || "changed";
  }

  function openChanges() {
    sheet("Everything you have changed", function (body) {
      body.appendChild(el("p", "opl-note",
        "Each of these can be put back on its own, without disturbing anything else — today, or in a month."));

      var any = false;
      Object.keys(doc.pages || {}).sort().forEach(function (key) {
        var p = doc.pages[key];
        var rows = [];

        Object.keys(p.nodes || {}).forEach(function (id) {
          var node = key === pageKey() ? OV.resolve(id) : null;
          rows.push({
            id: id,
            title: (p.nodes[id].label) || (node ? labelOf(node) : id),
            say: describeEdit(p.nodes[id]),
            node: node
          });
        });
        (p.inserts || []).forEach(function (e) {
          if (p.nodes && p.nodes[e.id]) return;    // already listed above
          rows.push({ id: e.id, title: e.label || "something added", say: "added", node: key === pageKey() ? OV.resolve(e.id) : null });
        });
        if (p.meta) rows.push({ id: "__meta", title: "This page's title and sharing card", say: "changed", meta: true });

        if (!rows.length) return;
        any = true;
        body.appendChild(el("p", "opl-h", key + (key === pageKey() ? " — you are here" : "")));

        var list = el("ul", "opl-list");
        rows.forEach(function (r) {
          var row = el("li");
          row.appendChild(el("div", null, "<b>" + esc(String(r.title).slice(0, 60)) + "</b><small>" + esc(r.say) + "</small>"));

          if (r.node) {
            var show = el("button", "opl-btn", "Show me");
            show.onclick = function () {
              closeSheet();
              r.node.scrollIntoView({ behavior: "smooth", block: "center" });
              select(r.node);
            };
            row.appendChild(show);
          }

          var back = el("button", "opl-btn danger", "Put back");
          back.onclick = function () {
            if (r.meta) delete doc.pages[key].meta;
            else revertNode(r.id, key);
            push();
            openChanges();
            toast("Put back");
          };
          row.appendChild(back);
          list.appendChild(row);
        });
        body.appendChild(list);
      });

      var globals = doc.globals || {};
      if (globals.imageSwaps && Object.keys(globals.imageSwaps).length) {
        any = true;
        body.appendChild(el("p", "opl-h", "Pictures replaced everywhere"));
        var swaps = el("ul", "opl-list");
        Object.keys(globals.imageSwaps).forEach(function (from) {
          var row = el("li");
          row.appendChild(el("div", null, "<b>" + esc(from.split("/").pop()) + "</b><small>replaced across the whole site</small>"));
          var back = el("button", "opl-btn danger", "Put back");
          back.onclick = function () { delete globals.imageSwaps[from]; push(); openChanges(); };
          row.appendChild(back);
          swaps.appendChild(row);
        });
        body.appendChild(swaps);
      }

      if (!any) body.appendChild(el("p", "opl-note", "Nothing changed yet."));
    }, []);
  }

  /* ==================================================================
     The site's own figures
     ==================================================================
     Markup is only half of most sites. The other half is a data file —
     a price list, a product catalog, a team, a menu — that some script
     renders into the markup. Editing the rendered words is a trap there:
     the page would show one price and the checkout would charge another.

     So a site can hand Opaline a panel of its own. It gets the sheet to
     draw into and the same helpers Opaline uses, and Opaline gets a
     figure it can put in the overlay, undo, publish and restore with
     everything else. What the panel looks like is the site's business,
     because only the site knows what its figures mean.

       OpalineConfig.data = {
         label: "Prices & titles",
         panel: function (into, api) { ... },
         refresh: function () { ... }        // redraw after a change
       }

     api gives: field(label, control), text(value, hint, onDone),
     select(options, value, onPick), number(value, onDone), upload(),
     get(), set(patch)  — where get/set read and write the site's own
     corner of the overlay, so everything below Undo already works.
     See CLAUDE.md, "Wiring a site's own data".
     ================================================================== */

  function dataApi() {
    return {
      field: field,
      text: textControl,
      select: selectControl,
      upload: function () { return pickFile().then(upload); },
      note: function (words) { return el("p", "opl-note", esc(words)); },
      heading: function (words) { return el("p", "opl-h", esc(words)); },
      number: function (value, onDone) {
        var input = el("input", "opl-input");
        input.type = "number";
        input.value = value;
        input.onchange = function () { onDone(Number(input.value)); };
        return input;
      },
      get: function () {
        if (!doc.globals) doc.globals = {};
        return doc.globals.data || (doc.globals.data = {});
      },
      set: function () {
        push();
        if (CONFIG.data && CONFIG.data.refresh) CONFIG.data.refresh();
      }
    };
  }

  function openData() {
    var spec = CONFIG.data;
    if (!spec || typeof spec.panel !== "function") return;
    sheet(spec.label || "This site's own figures", function (body) {
      spec.panel(body, dataApi());
    }, []);
  }


  /* ==================================================================
     What it has cost
     ==================================================================
     A balance that quietly goes down is a balance nobody trusts. This is
     every charge, in the words it was charged under, newest first.
     ================================================================== */

  function openLedger() {
    sheet("What it has cost", function (body) {
      if (reserves === Infinity) {
        body.appendChild(el("p", "opl-note",
          "This site keeps its own changes on its own account, so nothing here is metered."));
        return;
      }

      var head = el("div", "opl-purse");
      head.innerHTML = "<b>" + reserves + "</b><span>reserves left</span>";
      body.appendChild(head);

      body.appendChild(el("p", "opl-note",
        "Reserves are credit. A publish costs one. A picture costs what it costs to keep and serve it. " +
        "The assistant costs what it actually did. Everything else \u2014 changing words, colours, sizes, " +
        "moving and copying blocks \u2014 happens in your browser and costs nothing at all."));

      if (!ledger.length) {
        body.appendChild(el("p", "opl-note", "Nothing spent yet."));
        return;
      }

      var list = el("ul", "opl-list");
      ledger.forEach(function (row) {
        var line = el("li");
        line.appendChild(el("div", null,
          "<b>" + esc(row.why || "Charge") + "</b><small>" + new Date(row.at).toLocaleString() + "</small>"));
        var amount = el("span", "opl-amount" + (row.amount > 0 ? " up" : ""),
          (row.amount > 0 ? "+" : "") + row.amount);
        line.appendChild(amount);
        list.appendChild(line);
      });
      body.appendChild(list);
    }, []);
  }

  /* ==================================================================
     Seeing it as a phone would
     ================================================================== */

  function openPreview() {
    try { sessionStorage.setItem("opl-preview-doc", JSON.stringify(doc)); }
    catch (e) { toast("There is too much here to preview at once.", true); return; }

    var sizes = [
      { key: "phone", label: "Phone", w: 390, h: 780 },
      { key: "tablet", label: "Tablet", w: 834, h: 700 },
      { key: "desktop", label: "Desktop", w: 1280, h: 720 }
    ];
    var chosen = sizes[0];

    sheet("How it looks", function (body) {
      var row = el("div", "opl-screens");
      var size = el("span", "opl-size");
      var stage = el("div", "opl-stage");
      var screen = el("div", "opl-screen");
      var frame = el("iframe", "opl-frame");
      frame.setAttribute("title", "Preview");

      var draw = function () {
        row.querySelectorAll(".opl-chip").forEach(function (c) {
          c.classList.toggle("on", c.textContent === chosen.label);
        });

        /* Scaled, not resized: the page inside has to go on believing it is
           the width she chose, or its own media queries answer for a screen
           nobody is looking at. */
        frame.style.width = chosen.w + "px";
        frame.style.height = chosen.h + "px";

        var room = Math.max(160, stage.clientWidth - 24);
        var scale = Math.min(1, room / chosen.w);
        frame.style.transform = "scale(" + scale + ")";

        /* And this is the part that was missing. A transform paints an
           element smaller; it does not make it take up less room. The stage
           was reserving 1280px of width for something drawn at 588 and
           centring the difference, so Desktop arrived as a narrow column
           adrift in the middle — while being, all along, the desktop
           layout in a slot far too wide for it. The wrapper is the size
           actually seen; the frame keeps its true width inside it. */
        screen.style.width = Math.round(chosen.w * scale) + "px";
        screen.style.height = Math.round(chosen.h * scale) + "px";

        size.textContent = chosen.w + " \u00d7 " + chosen.h;
      };

      sizes.forEach(function (s) {
        var chip = el("button", "opl-chip", s.label);
        chip.type = "button";
        chip.onclick = function () { chosen = s; draw(); };
        row.appendChild(chip);
      });
      body.appendChild(row);

      var here = location.pathname + (location.pathname.indexOf("?") === -1 ? "?" : "&") + "opl-preview=1";
      frame.src = here;
      screen.appendChild(frame);
      stage.appendChild(screen);
      row.appendChild(size);
      body.appendChild(stage);

      /* The sheet slides in, so the stage has no width worth measuring on
         the frame this is called from. Watched rather than guessed at with
         a timer, and it answers a resized window for free. */
      if (window.ResizeObserver) new ResizeObserver(draw).observe(stage);
      else window.addEventListener("resize", draw);

      body.appendChild(el("p", "opl-note",
        "This is the page as it stands, changes and all, at that exact width — including changes you have not published. " +
        "If something looks wrong only here, select it and set its size for Phone."));

      requestAnimationFrame(draw);
    }, []);
  }

  /* ==================================================================
     Showing her round
     ================================================================== */

  var TOUR = [
    {
      find: null,
      title: "This is your site, open for editing",
      say: "Everything you can change now has a dashed box around it. Warm for words, green for pictures, gold for the blocks that hold them. Click one to change it."
    },
    {
      find: function () { return document.querySelector('main [data-opl-e="text"]'); },
      title: "Click words to change them",
      say: "Click once to select. Click again to type straight onto the page. The panel on the right does the same thing, plus the face, size and colour."
    },
    {
      find: function () { return document.querySelector("[data-opl-add]"); },
      title: "Add is how you make something new",
      say: "A heading and a paragraph, a row of cards, a picture beside words — all drawn in your site's own style, ready to type over."
    },
    {
      find: function () { return document.querySelector("[data-opl-screen]"); },
      title: "Check it on a phone",
      say: "Most of your readers are holding one. This shows the page at phone width, including changes you have not published yet."
    },
    {
      find: function () { return document.querySelector("[data-opl-undo]"); },
      title: "Nothing here is final",
      say: "Undo goes back a step. And under More, \"What I've changed\" lists every single change with a Put back button beside it — even months later."
    },
    {
      find: function () { return document.querySelector("[data-opl-publish]"); },
      title: "Publish is the only thing readers see",
      say: "Until you press it, everything you have done is yours alone. Press it and the whole world has it, about twenty seconds later."
    },
    {
      find: function () { return document.querySelector("[data-opl-more]"); },
      title: "Everything else lives here",
      say: "The page's title and sharing card, your menus, popups, prices, new pages, a check of the whole site, and your saved versions."
    }
  ];

  /* A smooth scroll does not finish on a schedule — it finishes when it
     finishes, and a long jump up a tall page takes far longer than any
     timeout worth guessing at. Measuring mid-flight gives coordinates for
     where the page used to be, which is how the card ended up placed off
     the bottom of the screen. So: watch the element until it stops moving,
     then measure. Two identical frames is settled; a second and a bit is
     as long as this is ever worth waiting. */
  function whenStill(target, done) {
    var last = null;
    var same = 0;
    var frames = 0;
    (function tick() {
      var box = target.getBoundingClientRect();
      var now = Math.round(box.top) + ":" + Math.round(box.left);
      if (now === last) same++; else { same = 0; last = now; }
      if (same >= 2 || ++frames > 90) { done(); return; }
      requestAnimationFrame(tick);
    })();
  }

  function placeTour(host, card, target) {
    var box = target.getBoundingClientRect();

    var ring = host.querySelector(".opl-tour-ring") || el("div", "opl-tour-ring");
    ring.style.left = (box.left - 6) + "px";
    ring.style.top = (box.top - 6) + "px";
    ring.style.width = (box.width + 12) + "px";
    ring.style.height = (box.height + 12) + "px";
    if (!ring.parentNode) host.appendChild(ring);
    host.classList.add("has-ring");

    var high = card.offsetHeight;
    var wide = card.offsetWidth;
    var top;

    if (box.bottom + high + 24 < window.innerHeight) top = box.bottom + 16;
    else if (box.top - high - 24 > 0) top = box.top - high - 16;
    /* Neither side has room — a tall target on a short screen. Centring is
       better than picking an edge and sliding off it. */
    else top = (window.innerHeight - high) / 2;

    /* Clamped on both axes, always. Whatever the arithmetic above decided,
       the card ends up somewhere she can actually see it. */
    card.style.top = Math.max(12, Math.min(top, window.innerHeight - high - 12)) + "px";
    card.style.left = Math.max(12, Math.min(box.left, window.innerWidth - wide - 12)) + "px";
    card.style.transform = "none";
  }

  /* Shown once on each device she works from, not once ever.
     "Seen" is remembered in this browser, so a new laptop or a new phone
     gets it on its own. And it is remembered per shape of screen as well,
     because the tour points at where things are — and on a phone they are
     not where they were: the bar moves to the head of the page and the
     inspector becomes a sheet across the foot. Being shown round again on
     a screen that is laid out differently is the point, not a nuisance. */
  function deviceClass() {
    var w = window.innerWidth;
    return w <= 720 ? "phone" : (w <= 980 ? "tablet" : "desktop");
  }

  function tourSeen() {
    try { return !!localStorage.getItem("opl-tour-seen-" + deviceClass()); }
    catch (e) { return true; }   // no storage: never nag
  }

  function markTourSeen() {
    try { localStorage.setItem("opl-tour-seen-" + deviceClass(), "1"); } catch (e) { }
  }

  function tour(step) {
    var at = step || 0;
    var old = document.getElementById("opl-tour");
    if (old) {
      if (old._away) window.removeEventListener("resize", old._away);
      if (old._away) window.removeEventListener("scroll", old._away);
      old.remove();
    }
    if (at >= TOUR.length || at < 0) {
      markTourSeen();
      if (at >= TOUR.length) toast("That is all of it. The ? button brings this back.");
      return;
    }

    var stop = TOUR[at];
    var target = stop.find && stop.find();

    var host = el("div");
    host.id = "opl-tour";
    host.innerHTML =
      '<div class="opl-tour-scrim" title="Click anywhere out here to leave the tour"></div>' +
      '<div class="opl-tour-card">' +
      '<span class="opl-tour-count">' + (at + 1) + " of " + TOUR.length + "</span>" +
      "<h4>" + esc(stop.title) + "</h4>" +
      "<p>" + esc(stop.say) + "</p>" +
      '<div class="opl-tour-acts">' +
      '<button class="opl-btn" data-skip>Skip</button>' +
      (at > 0 ? '<button class="opl-btn" data-back>Back</button>' : "") +
      '<button class="opl-btn primary" data-next>' + (at === TOUR.length - 1 ? "Done" : "Next") + "</button>" +
      "</div></div>";
    document.body.appendChild(host);

    var card = host.querySelector(".opl-tour-card");

    if (target) {
      var box = target.getBoundingClientRect();
      /* The bar's own buttons are fixed to the screen and already in front
         of her. Scrolling to them does nothing but move the page under her
         for no reason. */
      var inView = box.top >= 0 && box.bottom <= window.innerHeight && box.height < window.innerHeight;
      if (!inView) target.scrollIntoView({ behavior: "smooth", block: "center" });

      whenStill(target, function () {
        if (!host.parentNode) return;          // she moved on while it settled
        placeTour(host, card, target);
      });

      /* If she scrolls or turns the phone, the ring would otherwise be
         pointing at empty space. */
      var again = function () { if (host.parentNode) placeTour(host, card, target); };
      host._away = again;
      window.addEventListener("resize", again);
      window.addEventListener("scroll", again, { passive: true });
    }

    /* Ways out, because a dimmed page with no visible card is a trap. */
    host.querySelector("[data-next]").onclick = function () { tour(at + 1); };
    host.querySelector("[data-skip]").onclick = function () { tour(TOUR.length); };
    var back = host.querySelector("[data-back]");
    if (back) back.onclick = function () { tour(at - 1); };
    host.querySelector(".opl-tour-scrim").onclick = function () { tour(TOUR.length); };
    document.addEventListener("keydown", function esc(e) {
      if (!host.parentNode) { document.removeEventListener("keydown", esc); return; }
      if (e.key === "Escape") { document.removeEventListener("keydown", esc); tour(TOUR.length); }
    });
  }

  window.OpalineEditor = {
    open: function () {
      var have = storedToken();
      if (have) { token = have; boot(); return; }
      gate();
    },
    editing: function () { return booted; },
    signOut: signOut,
    /* A session already in hand means she stays signed in as she walks
       from page to page, which is the whole point of editing a site. */
    resume: function () {
      var have = storedToken();
      if (have) { token = have; boot(); }
    }
  };

  window.OpalineEditor.resume();
})();
