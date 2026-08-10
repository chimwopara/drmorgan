/* Wopara Opaline | the overlay
   ---------------------------------------------------------------------
   The pages of a site are hand written and stay that way. What its owner
   changes from inside the browser is kept beside them, in one JSON
   document, and laid over the markup here on every visit. Nothing is
   rewritten in place, so an edit that goes wrong is undone by deleting a
   line of the overlay rather than by repairing a page.

   This file runs for every visitor. The editor itself (opaline-editor.js)
   is a separate, larger file that is only ever fetched once a password has
   been accepted, so a reader downloads none of it.

   How an element is named
     Each editable element gets an address computed from where it sits:
     the nearest ancestor carrying an id, then a tag-and-count path down
     to the element. Counting is per tag name, which is what makes the
     address survive a site's own script prepending a <header> and
     appending a <footer> after this file has already run — a new <header>
     does not move <main>. Anything the editor creates carries an explicit
     data-opl-id instead, and that always wins.

   Order of work
     Addresses are all resolved against the untouched page BEFORE anything
     structural happens, because inserting or reordering elements would
     otherwise move the very things later addresses are counting.  */

(function () {
  "use strict";

  /* Where this file was served from, caught while document.currentScript
     still points at it — by the time the editor is asked for, it does not. */
  var MY_SRC = (document.currentScript && document.currentScript.src) || "";

  /* The version, taken from this file's own URL where the page gave it one:

       <script src="js/opaline-overlay.js?v=2026-08-10"></script>

     It is passed on to opaline.css and opaline-editor.js, which are
     fetched by URL when the editor opens and which a cache will otherwise
     hold for days. A fix to the stylesheet reached nobody who had already
     opened the editor once, and the bug it fixed went on being reported
     after it had been fixed.

     Reading it off the tag rather than hardcoding it means ONE place to
     change — the tag in the HTML — and the HTML is the one thing a CDN in
     front of a static site does not usually cache, so a new version
     actually arrives. The constant below is only the fallback for a page
     whose tag carries no version at all. */
  var VERSION = (/[?&]v=([^&]+)/.exec(MY_SRC) || [])[1] || "2026-08-10d";

  /* Everything the host site can decide. A missing config is a valid
     config: every field below falls back to something that works. */
  var CONFIG = window.OpalineConfig || {};
  var ENDPOINT = CONFIG.endpoint || "";
  var SITE = CONFIG.site || null;
  var CACHE_KEY = "opl-overlay-cache" + (SITE ? ":" + SITE : "");

  var EMPTY = { v: 1, globals: {}, pages: {}, newPages: {}, popups: [] };

  var overlay = EMPTY;
  var applied = false;
  var observing = false;

  /* ------------------------------------------------------------------
     Addresses
     ------------------------------------------------------------------ */

  function ownIndex(el) {
    var p = el.parentElement;
    if (!p) return 1;
    var n = 0;
    for (var i = 0; i < p.children.length; i++) {
      if (p.children[i].tagName === el.tagName) {
        n++;
        if (p.children[i] === el) return n;
      }
    }
    return n;
  }

  function nodeId(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.getAttribute("data-opl-id")) return el.getAttribute("data-opl-id");

    var parts = [];
    var n = el;
    var guard = 0;
    while (n && n !== document.body && guard++ < 60) {
      var stamped = n.getAttribute("data-opl-id");
      if (stamped) { parts.unshift("@" + stamped); return parts.join(">"); }
      /* An id the page author wrote is a far better anchor than a count,
         so the address stops climbing the moment it finds one. Ids this
         file or the editor made are skipped: they are not the page's. */
      if (n.id && n.id.indexOf("opl-") !== 0) { parts.unshift("#" + n.id); return parts.join(">"); }
      if (!n.parentElement) break;
      parts.unshift(n.tagName.toLowerCase() + ":" + ownIndex(n));
      n = n.parentElement;
    }
    parts.unshift("body");
    return parts.join(">");
  }

  function childByTagIndex(parent, tag, want) {
    var seen = 0;
    for (var i = 0; i < parent.children.length; i++) {
      if (parent.children[i].tagName === tag) {
        seen++;
        if (seen === want) return parent.children[i];
      }
    }
    return null;
  }

  function stamped(id) {
    /* Attribute selectors need quoting this address cannot be trusted to
       survive, so the lookup is done by hand. */
    var all = document.querySelectorAll("[data-opl-id]");
    for (var i = 0; i < all.length; i++) {
      if (all[i].getAttribute("data-opl-id") === id) return all[i];
    }
    return null;
  }

  function byPath(id) {
    if (!id || typeof id !== "string") return null;

    var parts = id.split(">");
    var head = parts[0];
    var root;

    if (head === "body") root = document.body;
    else if (head.charAt(0) === "#") root = document.getElementById(head.slice(1));
    else if (head.charAt(0) === "@") root = stamped(head.slice(1));
    else return stamped(id);

    if (!root) return null;

    var n = root;
    for (var i = 1; i < parts.length; i++) {
      var cut = parts[i].lastIndexOf(":");
      if (cut < 1) return null;
      var tag = parts[i].slice(0, cut).toUpperCase();
      var want = parseInt(parts[i].slice(cut + 1), 10);
      if (!want) return null;
      n = childByTagIndex(n, tag, want);
      if (!n) return null;
    }
    return n;
  }

  /* Fingerprints
     ------------------------------------------------------------------
     A counted address is only as stable as the markup it counts through,
     and on a site nobody here wrote, that is not very. A theme update
     wraps everything in one more <div>; a framework re-renders with the
     children in a different order; a build tool renames every class.
     Any of those and "the third paragraph inside the second section" is
     suddenly a different paragraph, or nothing at all.

     So every edit also remembers what its element SAID. If the path
     misses, we look for something of the same kind saying the same
     thing. Between the two, an edit has to survive only one of them —
     the shape of the page, or its words — rather than both.

     The words recorded are the ORIGINAL ones, which is why this keeps
     working: a fresh page always arrives carrying them, and her version
     is laid over the top afterwards. */

  function words(el) {
    return ((el && el.textContent) || "").replace(/\s+/g, " ").trim().slice(0, 70).toLowerCase();
  }

  function fingerprint(el) {
    if (!el || el.nodeType !== 1) return null;
    var mark = { t: el.tagName, x: words(el) };
    var cls = typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] : "";
    if (cls && cls.indexOf("opl-") !== 0) mark.c = cls;
    if (el.tagName === "IMG") mark.s = (el.getAttribute("src") || "").split("/").pop();
    return mark;
  }

  /* Plain words out of markup, so an edit's own replacement text can be
     compared against what is on the page. */
  function textOf(html) {
    var box = document.createElement("div");
    box.innerHTML = String(html || "");
    return words(box);
  }

  function byFingerprint(mark, edit) {
    if (!mark || !mark.t) return null;
    var same = document.getElementsByTagName(mark.t);
    var loose = null;

    /* Either what it said originally, or what this edit has since made it
       say. The first is what a freshly loaded page carries; the second is
       what it carries once the overlay has already been laid down — and a
       re-apply after something moved the element has to find it then too. */
    var accept = [mark.x];
    if (edit) {
      if (typeof edit.html === "string") accept.push(textOf(edit.html));
      if (typeof edit.text === "string") accept.push(words({ textContent: edit.text }));
    }

    for (var i = 0; i < same.length; i++) {
      var el = same[i];
      if (el.closest && el.closest("#opl-bar, #opl-panel, #opl-sheet, #opl-gate, .opl-popup")) continue;

      if (mark.t === "IMG") {
        var file = (el.getAttribute("data-opl-original") || el.getAttribute("src") || "").split("/").pop();
        if (mark.s && (file === mark.s || file === String(edit && edit.src || "").split("/").pop())) return el;
        continue;
      }
      if (!mark.x) continue;
      if (accept.indexOf(words(el)) === -1) continue;

      /* Same words AND the same first class is as sure as this gets.
         Same words alone is kept as second best, because a class name is
         exactly the thing a rebuild is most likely to have changed —
         but never a copy, which says what its original says and would
         steal an edit meant for it. */
      if (el.closest && el.closest('[data-opl-id^="x-"]')) continue;
      if (mark.c && typeof el.className === "string" && el.className.indexOf(mark.c) !== -1) return el;
      if (!loose) loose = el;
    }
    return loose;
  }

  /* Which way an address was found last time, so the editor can tell her
     how her work is holding up, and quietly re-pin anything that only the
     fingerprint could find. */
  var howFound = {};

  /* The second argument may be a fingerprint on its own, or the whole edit
     it belongs to — the edit is better, because it also says what the
     element has been made to say since.

     Wording is a LAST resort and not always allowed. An address anchored
     to a name the editor gave out itself is exact: if the element is not
     there yet it will be, once the insertions have run, and the second
     pass will find it. Guessing by words there is actively wrong, because
     a copy says exactly what the thing it was copied from says — so the
     copy's edit would land on the original, and both would end up saying
     the same thing. */
  function resolve(id, hint) {
    var el = byPath(id);
    if (el) { howFound[id] = "path"; return el; }

    var exact = typeof id === "string" &&
      (id.charAt(0) === "@" || id.indexOf("k-") === 0 || id.indexOf("x-") === 0);
    if (exact) { howFound[id] = "lost"; return null; }

    var mark = hint && hint.t ? hint : (hint && hint.find);
    var edit = hint && hint.t ? null : hint;

    el = byFingerprint(mark, edit);
    if (el) { howFound[id] = "words"; return el; }

    howFound[id] = "lost";
    return null;
  }

  /* ------------------------------------------------------------------
     Which page we are standing on. A page the editor created lives at
     /p/<slug>, served by page.html, and names itself there.
     ------------------------------------------------------------------ */

  function currentPage() {
    if (window.OPALINE_PAGE_KEY) return window.OPALINE_PAGE_KEY;
    var path = location.pathname.replace(/\/+$/, "");
    var made = /\/p\/([A-Za-z0-9-]+)$/.exec(path);
    if (made) return "p/" + made[1];
    var file = path.split("/").pop();
    return file === "" ? "index.html" : file;
  }

  /* ------------------------------------------------------------------
     Applying
     ------------------------------------------------------------------ */

  function styleEl(id) {
    var el = document.getElementById(id);
    if (!el) {
      el = document.createElement("style");
      el.id = id;
      document.head.appendChild(el);
    }
    return el;
  }

  function applyGlobals(g) {
    if (!g) return;

    if (typeof g.css === "string") styleEl("opl-overlay-css").textContent = g.css;

    /* Faces she has chosen that this site does not already serve. */
    if (Array.isArray(g.fonts) && g.fonts.length) {
      var want = g.fonts
        .filter(function (f) { return /^[A-Za-z0-9 ]{2,40}$/.test(f); })
        .map(function (f) { return "family=" + encodeURIComponent(f).replace(/%20/g, "+") + ":wght@300;400;500;600;700"; })
        .join("&");
      var href = "https://fonts.googleapis.com/css2?" + want + "&display=swap";
      var link = document.getElementById("opl-overlay-fonts");
      if (!link) {
        link = document.createElement("link");
        link.id = "opl-overlay-fonts";
        link.rel = "stylesheet";
        document.head.appendChild(link);
      }
      if (link.href !== href) link.href = href;
    }

    /* One picture swapped everywhere it appears. This is how the logo is
       changed: the wordmark is the same file on every page, so replacing
       the file replaces the mark across the whole site at once. */
    if (g.imageSwaps) {
      var imgs = document.getElementsByTagName("img");
      for (var i = 0; i < imgs.length; i++) {
        var img = imgs[i];
        var original = img.getAttribute("data-opl-original") || img.getAttribute("src") || "";
        var key = original.replace(/^\.?\//, "");
        var to = g.imageSwaps[key] || g.imageSwaps[original];
        if (to && img.getAttribute("src") !== to) {
          img.setAttribute("data-opl-original", original);
          img.setAttribute("src", to);
          img.removeAttribute("srcset");
        }
      }
    }
  }

  var CSS_PROPS = {
    color: 1, background: 1, backgroundColor: 1, fontFamily: 1, fontSize: 1, fontWeight: 1,
    fontStyle: 1, lineHeight: 1, letterSpacing: 1, textAlign: 1, textTransform: 1,
    width: 1, maxWidth: 1, minWidth: 1, height: 1, maxHeight: 1, minHeight: 1,
    padding: 1, margin: 1, marginTop: 1, marginBottom: 1, borderRadius: 1, border: 1,
    opacity: 1, display: 1, objectFit: 1, objectPosition: 1, boxShadow: 1, textDecoration: 1,
    aspectRatio: 1, gap: 1, order: 1, filter: 1, transform: 1
  };

  function dashed(prop) {
    return prop.replace(/[A-Z]/g, function (c) { return "-" + c.toLowerCase(); });
  }

  /* Screens
     ------------------------------------------------------------------
     A size she sets while looking at a laptop lands on a phone too, and
     most of the people reading this site are holding one. So a style can
     be set for every screen, or only for the narrow ones. The narrow
     values cannot be inline — a media query needs a stylesheet — so any
     element she styles is pinned and addressed by its own name.

     The widths match the site's own breakpoints in css/main.css. */
  var SCREENS = {
    base: null,
    tablet: (CONFIG.screens && CONFIG.screens.tablet) || "(max-width: 980px)",
    phone: (CONFIG.screens && CONFIG.screens.phone) || "(max-width: 720px)"
  };

  function declarations(props) {
    var out = [];
    for (var key in props) {
      if (!Object.prototype.hasOwnProperty.call(props, key)) continue;
      if (!CSS_PROPS[key]) continue;
      var value = props[key];
      if (value === null || value === "") continue;
      /* Marked important because the site's own stylesheet is specific and
         a choice she made in the editor should win over it every time. */
      out.push("  " + dashed(key) + ": " + String(value) + " !important;");
    }
    return out.join("\n");
  }

  /* Styles for an element that has a name of its own go into a stylesheet,
     which is the only place a media query can live. Everything else is
     still written inline: an element with no name has no selector. */
  function applyStyle(el, props) {
    for (var key in props) {
      if (!Object.prototype.hasOwnProperty.call(props, key)) continue;
      if (!CSS_PROPS[key]) continue;
      var value = props[key];
      if (value === null || value === "") { el.style.removeProperty(dashed(key)); continue; }
      el.style.setProperty(dashed(key), String(value), "important");
    }
  }

  function buildStyleSheet(page) {
    var nodes = page.nodes || {};
    var buckets = { base: [], tablet: [], phone: [] };

    for (var id in nodes) {
      if (!Object.prototype.hasOwnProperty.call(nodes, id)) continue;
      var edit = nodes[id];
      /* Only a pinned element can be addressed from a stylesheet. */
      if (id.indexOf("k-") !== 0 && id.indexOf("x-") !== 0) continue;
      var selector = '[data-opl-id="' + id + '"]';

      if (edit.style) {
        var base = declarations(edit.style);
        if (base) buckets.base.push(selector + " {\n" + base + "\n}");
      }
      if (edit.styleAt) {
        ["tablet", "phone"].forEach(function (screen) {
          var at = edit.styleAt[screen];
          if (!at) return;
          var body = declarations(at);
          if (body) buckets[screen].push(selector + " {\n" + body + "\n}");
        });
      }
    }

    var css = buckets.base.join("\n");
    ["tablet", "phone"].forEach(function (screen) {
      if (!buckets[screen].length) return;
      css += "\n@media " + SCREENS[screen] + " {\n" + buckets[screen].join("\n") + "\n}";
    });
    styleEl("opl-overlay-node-css").textContent = css;
  }

  /* ------------------------------------------------------------------
     Videos
     ------------------------------------------------------------------ */

  /* Every shape YouTube hands out, and nothing else. A pasted address is
     the one place a person is most likely to bring something unexpected,
     so this reads an id or refuses. */
  function youtubeId(url) {
    var s = String(url || "").trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
    var m =
      /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|v\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/.exec(s);
    return m ? m[1] : null;
  }

  /* A film already embedded by whoever wrote the page. Its frame, its size
     and its settings are the page's business and stay exactly as they are —
     only which film it plays changes. The id appears twice in a looping
     embed, in the path and again in playlist=, and missing the second one
     leaves a loop that plays the new film once and then the old one for
     ever. */
  function retargetEmbed(src, id) {
    return String(src || "")
      .replace(/\/embed\/[A-Za-z0-9_-]{11}/, "/embed/" + id)
      .replace(/([?&]playlist=)[A-Za-z0-9_-]{11}/, "$1" + id);
  }

  function embedId(el) {
    var m = /\/embed\/([A-Za-z0-9_-]{11})/.exec(
      el.getAttribute("data-opl-original") || el.getAttribute("src") || "");
    return m ? m[1] : null;
  }

  function isVideoFrame(el) {
    return el.tagName === "IFRAME" && /youtube(-nocookie)?\.com\/embed\//.test(
      el.getAttribute("data-opl-original") || el.getAttribute("src") || "");
  }

  function buildVideo(el, spec) {
    if (el.getAttribute("data-opl-video") === spec.id) return;
    el.setAttribute("data-opl-video", spec.id);
    el.classList.add("opl-video");
    el.innerHTML = "";

    var frame = document.createElement("div");
    frame.className = "opl-video-frame";

    var still = document.createElement("img");
    still.className = "opl-video-still";
    still.loading = "lazy";
    still.alt = spec.title || "Video";
    still.src = "https://i.ytimg.com/vi/" + spec.id + "/maxresdefault.jpg";
    /* Not every video has the large still; the medium one always exists. */
    still.onerror = function () {
      still.onerror = null;
      still.src = "https://i.ytimg.com/vi/" + spec.id + "/hqdefault.jpg";
    };

    var play = document.createElement("button");
    play.type = "button";
    play.className = "opl-video-play";
    play.setAttribute("aria-label", "Play " + (spec.title || "video"));
    play.innerHTML = '<svg viewBox="0 0 68 48" aria-hidden="true">' +
      '<path class="opl-video-play-bg" d="M66.5 7.7a8.6 8.6 0 0 0-6-6C55.2 0 34 0 34 0S12.8 0 7.5 1.6a8.6 8.6 0 0 0-6 6A90 90 0 0 0 0 24a90 90 0 0 0 1.5 16.3 8.6 8.6 0 0 0 6 6C12.8 48 34 48 34 48s21.2 0 26.5-1.7a8.6 8.6 0 0 0 6-6A90 90 0 0 0 68 24a90 90 0 0 0-1.5-16.3z"/>' +
      '<path d="M45 24 27 14v20z" fill="#fff"/></svg>';

    if (spec.title) {
      var caption = document.createElement("span");
      caption.className = "opl-video-title";
      caption.textContent = spec.title;
      frame.appendChild(caption);
    }

    play.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (window.OPALINE_EDITING) return;      /* she is editing, not watching */
      var player = document.createElement("iframe");
      player.className = "opl-video-player";
      player.src = "https://www.youtube-nocookie.com/embed/" + spec.id +
        "?autoplay=1&rel=0&modestbranding=1" + (spec.start ? "&start=" + spec.start : "");
      player.title = spec.title || "Video";
      player.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture";
      player.setAttribute("allowfullscreen", "");
      player.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
      frame.innerHTML = "";
      frame.appendChild(player);
    });

    frame.appendChild(still);
    frame.appendChild(play);
    el.appendChild(frame);
  }

  var SAFE_ATTRS = { href: 1, alt: 1, title: 1, target: 1, rel: 1, src: 1, "aria-label": 1 };

  /* What each element said and looked like before the overlay first touched
     it, recorded at the moment it is overwritten — the only moment the
     original is still on the page. This is what lets the editor put one
     thing back days later, in a session that never saw the untouched page.
     Keyed by address, and never overwritten once taken. */
  var originals = {};

  function keepOriginal(id, el, edit) {
    if (originals[id]) return;
    var was = { style: el.getAttribute("style"), attrs: {} };
    if (typeof edit.html === "string" || typeof edit.text === "string") was.html = el.innerHTML;
    if (typeof edit.src === "string") was.src = el.getAttribute("src");
    for (var a in SAFE_ATTRS) {
      if (Object.prototype.hasOwnProperty.call(SAFE_ATTRS, a)) was.attrs[a] = el.getAttribute(a);
    }
    originals[id] = was;
  }

  function applyNode(el, edit, id) {
    if (!el || !edit) return;
    if (id) keepOriginal(id, el, edit);

    if (edit.hidden) {
      el.setAttribute("data-opl-hidden", "");
      el.style.setProperty("display", "none", "important");
      return;
    }
    if (el.hasAttribute("data-opl-hidden")) {
      el.removeAttribute("data-opl-hidden");
      el.style.removeProperty("display");
    }


    /* A video she linked. It is rendered as a still with a play button
       rather than an iframe, and YouTube is not contacted at all until
       somebody presses it. That is worth doing for three reasons: an
       embed on every page costs a reader a megabyte they may never
       watch, it sets cookies before they have chosen anything, and it
       drags the page's own loading time down with it.

       Built as elements rather than markup because clean() strips
       iframes on sight — and should, since the wording of an edit is not
       a place to be accepting frames from. */
    if (edit.video && edit.video.id) {
      if (isVideoFrame(el)) {
        var next = retargetEmbed(el.getAttribute("src"), edit.video.id);
        if (el.getAttribute("src") !== next) {
          if (!el.getAttribute("data-opl-original")) el.setAttribute("data-opl-original", el.getAttribute("src") || "");
          el.setAttribute("src", next);
        }
        if (edit.video.title) el.setAttribute("title", edit.video.title);
        return;
      }
      buildVideo(el, edit.video);
      return;
    }

    if (typeof edit.html === "string" && el.innerHTML !== edit.html) el.innerHTML = edit.html;
    else if (typeof edit.text === "string" && el.textContent !== edit.text) el.textContent = edit.text;

    if (typeof edit.src === "string" && el.tagName === "IMG" && el.getAttribute("src") !== edit.src) {
      if (!el.getAttribute("data-opl-original")) el.setAttribute("data-opl-original", el.getAttribute("src") || "");
      el.setAttribute("src", edit.src);
      el.removeAttribute("srcset");
      /* A <picture>'s sources would otherwise keep winning over the img. */
      var pic = el.parentElement;
      if (pic && pic.tagName === "PICTURE") {
        var srcs = pic.getElementsByTagName("source");
        while (srcs.length) srcs[0].parentNode.removeChild(srcs[0]);
      }
    }

    if (typeof edit.bgImage === "string") {
      el.style.setProperty("background-image", edit.bgImage ? 'url("' + edit.bgImage + '")' : "none", "important");
    }

    if (edit.attrs) {
      for (var a in edit.attrs) {
        if (!Object.prototype.hasOwnProperty.call(edit.attrs, a)) continue;
        if (!SAFE_ATTRS[a]) continue;
        if (edit.attrs[a] === null) el.removeAttribute(a);
        else el.setAttribute(a, String(edit.attrs[a]));
      }
    }

    /* A pinned element takes its styles from the stylesheet instead, so
       that the same choice can differ between a phone and a laptop. */
    /* A link she has repointed somewhere else entirely. Somebody pasting
       an Amazon page or a booking address into a button means "send them
       there", not "send them away from my site and lose them" — so an
       address that leaves the site opens beside it, and one that comes
       back home stops doing that.

       rel goes with it because a page opened with target="_blank" can
       otherwise reach back through window.opener at the page that opened
       it, and nobody pasting a link is thinking about that. */
    if (edit.attrs && typeof edit.attrs.href === "string" && el.tagName === "A") {
      var leaves = /^https?:\/\//i.test(edit.attrs.href) &&
        edit.attrs.href.indexOf(location.origin) !== 0;
      if (leaves) {
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener");
      } else if (el.getAttribute("target") === "_blank") {
        el.removeAttribute("target");
        if (el.getAttribute("rel") === "noopener") el.removeAttribute("rel");
      }
    }

    if (edit.style && !(id && (id.indexOf("k-") === 0 || id.indexOf("x-") === 0))) applyStyle(el, edit.style);
    if (typeof edit.addClass === "string" && edit.addClass) {
      edit.addClass.split(/\s+/).forEach(function (c) { if (c) el.classList.add(c); });
    }
  }

  /* Markup she or the assistant wrote. Scripts and event handlers are cut
     out before it is put on the page — the editor is one password deep,
     and a password is not a reason to stop checking. */
  function clean(html) {
    var box = document.createElement("div");
    box.innerHTML = String(html || "");
    var bad = box.querySelectorAll("script, iframe, object, embed, link, meta, form");
    for (var i = 0; i < bad.length; i++) bad[i].parentNode.removeChild(bad[i]);
    var all = box.querySelectorAll("*");
    for (var j = 0; j < all.length; j++) {
      var attrs = all[j].attributes;
      for (var k = attrs.length - 1; k >= 0; k--) {
        var name = attrs[k].name.toLowerCase();
        if (name.indexOf("on") === 0) all[j].removeAttribute(attrs[k].name);
        if ((name === "href" || name === "src") && /^\s*javascript:/i.test(attrs[k].value)) {
          all[j].removeAttribute(attrs[k].name);
        }
      }
    }
    return box.innerHTML;
  }

  function buildInsert(entry) {
    var box = document.createElement("div");
    box.innerHTML = clean(entry.html);
    var el = box.firstElementChild;
    if (!el) return null;
    el.setAttribute("data-opl-id", entry.id);
    return el;
  }

  function applyInserts(page, map) {
    var list = page.inserts || [];
    for (var i = 0; i < list.length; i++) {
      var entry = list[i];
      if (!entry || !entry.id) continue;
      if (stamped(entry.id)) continue;             // already on the page

      var el = buildInsert(entry);
      if (!el) continue;

      var after = entry.after ? (map[entry.after] || resolve(entry.after)) : null;
      var parent = entry.parent ? (map[entry.parent] || resolve(entry.parent)) : null;

      if (entry.before === "start") {
        var head = document.querySelector("main") || document.body;
        head.insertBefore(el, head.firstChild);
      } else if (after && after.parentNode) {
        after.parentNode.insertBefore(el, entry.above ? after : after.nextSibling);
      } else if (parent) parent.appendChild(el);
      else if (entry.before === "footer") {
        var main = document.querySelector("main") || document.body;
        main.appendChild(el);
      } else continue;

      /* The site fades a block in when it scrolls into view, and the
         observer that does it was set up before this element existed. An
         unobserved [data-reveal] stays invisible forever, so anything
         arriving late is simply marked as already revealed. */
      if (el.hasAttribute("data-reveal")) el.classList.add("revealed");
      el.querySelectorAll("[data-reveal]").forEach(function (n) { n.classList.add("revealed"); });
    }
  }

  function applyOrder(page, map) {
    var orders = page.order || {};
    for (var parentId in orders) {
      if (!Object.prototype.hasOwnProperty.call(orders, parentId)) continue;
      var parent = map[parentId] || resolve(parentId);
      if (!parent) continue;
      var ids = orders[parentId];
      if (!Array.isArray(ids)) continue;
      for (var i = 0; i < ids.length; i++) {
        var child = map[ids[i]] || resolve(ids[i]);
        /* appendChild on an element already in this parent moves it, so
           walking the list in order lays the whole row out again. */
        if (child && child.parentElement === parent) parent.appendChild(child);
      }
    }
  }

  /* Pins
     ------------------------------------------------------------------
     A counted address says "the third paragraph here", which stops being
     true the moment she moves the second one. So the first time an element
     takes part in anything structural — a reorder, a duplication, an
     insertion beside it — the editor gives it a name of its own and files
     the counted address that found it. Those pairs are laid down here,
     before anything else runs, while the page is still in the order the
     addresses were written against. */
  function applyPins(page) {
    var pins = page.pins || {};
    for (var path in pins) {
      if (!Object.prototype.hasOwnProperty.call(pins, path)) continue;
      var name = pins[path];
      if (stamped(name)) continue;
      var el = resolve(path);
      if (el) el.setAttribute("data-opl-id", name);
    }
  }

  /* What a page calls itself, and what it looks like when someone shares it.
     None of this is in the body, so none of it can be an ordinary edit. */
  function meta(selector, attr, value) {
    if (typeof value !== "string" || !value) return;
    var tag = document.head.querySelector(selector);
    if (!tag) {
      tag = document.createElement("meta");
      var m = /\[(name|property)="([^"]+)"\]/.exec(selector);
      if (!m) return;
      tag.setAttribute(m[1], m[2]);
      document.head.appendChild(tag);
    }
    tag.setAttribute(attr || "content", value);
  }

  function applyMeta(page) {
    var m = page.meta;
    if (!m) return;

    if (m.title) {
      document.title = m.title;
      meta('meta[property="og:title"]', "content", m.title);
      meta('meta[name="twitter:title"]', "content", m.title);
    }
    if (m.description) {
      meta('meta[name="description"]', "content", m.description);
      meta('meta[property="og:description"]', "content", m.description);
      meta('meta[name="twitter:description"]', "content", m.description);
    }
    if (m.image) {
      meta('meta[property="og:image"]', "content", m.image);
      meta('meta[name="twitter:image"]', "content", m.image);
    }
  }

  /* The header nav and the footer's link columns, which a site's own script may build
     from lists in its own source. Hiding, renaming and adding are done here
     rather than there, so she never needs the file opened for her. */
  function applyNav() {
    var made = overlay.newPages || {};
    var nav = (overlay.globals && overlay.globals.nav) || {};
    var hide = nav.hide || [];
    var extra = (nav.add || []).slice();

    Object.keys(made).forEach(function (slug) {
      if (made[slug] && made[slug].nav) extra.push({ label: made[slug].title || slug, href: "p/" + slug, slug: slug });
    });

    var where = CONFIG.chrome || {};
    var homes = [
      { at: document.querySelector(where.headerLinks || "header nav, #site-header .nav-links, nav"), cls: "" },
      { at: where.menuLinks ? document.querySelector(where.menuLinks) : null, cls: "" },
      { at: document.querySelector(where.footerLinks || "footer ul, #site-footer ul"), cls: "", li: true }
    ];

    homes.forEach(function (home) {
      if (!home.at) return;
      extra.forEach(function (item) {
        var key = item.slug || item.href;
        if (home.at.querySelector('[data-opl-nav="' + key + '"]')) return;
        var a = document.createElement("a");
        a.href = item.href;
        a.textContent = item.label;
        a.setAttribute("data-opl-nav", key);
        if (home.cls) a.className = home.cls;
        if (home.li) {
          var li = document.createElement("li");
          li.appendChild(a);
          home.at.appendChild(li);
        } else home.at.appendChild(a);
      });
    });

    /* Renaming and hiding reach every copy of a link at once, wherever the
       chrome happens to have put it. */
    hide.forEach(function (href) {
      document.querySelectorAll('a[href="' + href + '"]')
        .forEach(function (a) {
          if (!a.closest("header, footer, nav, #site-header, #site-footer, #mobile-menu")) return;
          var box = a.closest("li") || a;
          box.style.setProperty("display", "none", "important");
          box.setAttribute("data-opl-navhidden", "");
        });
    });

    var renames = nav.rename || {};
    for (var href in renames) {
      if (!Object.prototype.hasOwnProperty.call(renames, href)) continue;
      document.querySelectorAll('a[href="' + href + '"]')
        .forEach(function (a) {
          if (!a.closest("header, footer, nav, #site-header, #site-footer, #mobile-menu")) return;
          if (a.textContent !== renames[href]) a.textContent = renames[href];
        });
    }
  }

  /* ------------------------------------------------------------------
     Posts
     ------------------------------------------------------------------
     A post IS a page she made. That is the whole design rather than a
     shortcut: pages she makes already have a title, an address of their
     own, their own words for a search result, and a body of blocks the
     editor can change in every way it can change a hand-written page. A
     blog built on anything else would have been a second, poorer editor
     living beside the first one — one where a picture could not be
     swapped and a block could not be moved.

     What a post adds to a page is a date, an opening line and a picture,
     which are the three things a list of posts has to show, and a flag
     saying it belongs in that list.

     The list is rendered into any element the site marks data-opl-posts.
     Where the site has said what one of its cards looks like, that markup
     is used and the result is indistinguishable from the rest of the
     page; where it has not, the fallback is plain and inherits whatever
     the page around it wears.
     ------------------------------------------------------------------ */

  /* Pages she makes need an address, and what kind of address depends on
     what the host can do. A host that can rewrite gets a real path. One
     that cannot — GitHub Pages, most static buckets — gets a query on a
     single template file, which needs nothing of the host at all and is
     still a link anybody can send anybody. Both are configured the same
     way, by writing one down in newPagePath. */
  function pageHref(slug) {
    var base = CONFIG.newPagePath;
    if (!base || !slug) return null;
    return base.indexOf("?") !== -1
      ? base + encodeURIComponent(slug)
      : base.replace(/\/*$/, "/") + encodeURIComponent(slug);
  }

  /* Newest first, which is the only order a blog is ever read in. Anything
     without a date sorts last rather than being dropped: a post she has
     not dated yet is still a post. */
  function postList() {
    var made = overlay.newPages || {};
    return Object.keys(made)
      .filter(function (slug) { return made[slug] && made[slug].post; })
      .map(function (slug) {
        var p = made[slug];
        return {
          slug: slug,
          title: p.title || slug,
          date: p.date || "",
          excerpt: p.excerpt || "",
          image: p.image || "",
          href: pageHref(slug) || "#"
        };
      })
      .sort(function (a, b) {
        if (!a.date) return 1;
        if (!b.date) return -1;
        return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
      });
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* "10 August 2026" in the reader's own locale, from a plain YYYY-MM-DD.
     Split by hand rather than passed to Date(), because new Date("2026-08-10")
     is UTC midnight and prints as the 9th to anybody west of Greenwich. */
  function showDate(iso) {
    var bits = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
    if (!bits) return String(iso || "");
    var d = new Date(+bits[1], +bits[2] - 1, +bits[3]);
    try {
      return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
    } catch (e) { return iso; }
  }

  var POST_CARD =
    '<article class="opl-post">' +
      '<a href="{{href}}"><img src="{{image}}" alt="" loading="lazy" decoding="async"></a>' +
      '<p><time datetime="{{datetime}}">{{date}}</time></p>' +
      '<h3><a href="{{href}}">{{title}}</a></h3>' +
      "<p>{{excerpt}}</p>" +
    "</article>";

  function fillTemplate(tpl, post) {
    var values = {
      slug: post.slug,
      href: post.href,
      title: post.title,
      excerpt: post.excerpt,
      datetime: post.date,
      date: showDate(post.date),
      image: post.image || (CONFIG.posts && CONFIG.posts.defaultImage) || ""
    };
    return String(tpl).replace(/\{\{(\w+)\}\}/g, function (whole, key) {
      return key in values ? esc(values[key]) : whole;
    });
  }

  function applyPosts() {
    var homes = document.querySelectorAll("[data-opl-posts]");
    if (!homes.length) return;

    var spec = CONFIG.posts || {};
    var list = postList();

    /* Rewritten only when the answer has changed. This runs on every
       apply, and every apply is triggered by a mutation, so writing the
       same markup back unconditionally would be a loop that never
       settles. */
    var sig = JSON.stringify(list);

    for (var i = 0; i < homes.length; i++) {
      var home = homes[i];
      if (home.getAttribute("data-opl-posts-sig") === sig) continue;
      home.setAttribute("data-opl-posts-sig", sig);

      /* Opaline wrote this, so Opaline owns it: the editor leaves it alone
         rather than offering to edit words that the next render would
         throw away. The post itself is where those words are changed. */
      home.setAttribute("data-opl-skip", "");

      home.innerHTML = list.length
        ? list.map(function (post) { return fillTemplate(spec.card || POST_CARD, post); }).join("")
        : (spec.empty || '<p class="opl-post-empty">Nothing written yet.</p>');
    }
  }

  function apply() {
    var page = (overlay.pages || {})[currentPage()] || {};
    var nodes = page.nodes || {};

    applyGlobals(overlay.globals);
    applyPins(page);
    applyMeta(page);
    applyNav();
    applyPosts();
    buildStyleSheet(page);

    /* Every address resolved first, against the page as it stands, before
       a single insertion or move can shift what the next one counts. */
    var map = {};
    var id;
    for (id in nodes) {
      if (!Object.prototype.hasOwnProperty.call(nodes, id)) continue;
      map[id] = resolve(id, nodes[id]);
    }
    (page.inserts || []).forEach(function (e) {
      if (e.after && !(e.after in map)) map[e.after] = resolve(e.after);
      if (e.parent && !(e.parent in map)) map[e.parent] = resolve(e.parent);
    });
    var orders = page.order || {};
    for (var parentId in orders) {
      if (!Object.prototype.hasOwnProperty.call(orders, parentId)) continue;
      if (!(parentId in map)) map[parentId] = resolve(parentId);
      (orders[parentId] || []).forEach(function (cid) {
        if (!(cid in map)) map[cid] = resolve(cid);
      });
    }

    applyInserts(page, map);

    /* Anything that could not be found before may exist now: an edit to a
       block she duplicated lives inside the copy this run just made. */
    for (id in nodes) {
      if (!Object.prototype.hasOwnProperty.call(nodes, id)) continue;
      if (!map[id]) map[id] = resolve(id, nodes[id]);
      applyNode(map[id], nodes[id], id);
    }

    applyOrder(page, map);
    applied = true;

    fitDoor();
    document.dispatchEvent(new CustomEvent("opaline:overlay", { detail: { overlay: overlay } }));
  }

  /* A site's own script may build its header and footer after this file has run, and
     an edit to either would find nothing to change on the first pass. One
     debounced re-run covers that, and every later arrival too. */
  /* The editor's own furniture, a popup, and anything she is typing into.
     None of it should send this observer round and round, and re-laying the
     overlay over a word half typed would eat the word. */
  function isChrome(node) {
    var el = node && node.nodeType === 1 ? node : (node && node.parentElement);
    var guard = 0;
    while (el && guard++ < 40) {
      if (el.id && el.id.indexOf("opl-") === 0) return true;
      if (el.getAttribute && el.getAttribute("contenteditable") === "true") return true;
      if (el.classList && el.classList.contains("opl-popup")) return true;
      el = el.parentElement;
    }
    return false;
  }

  function watch() {
    if (observing || !window.MutationObserver) return;
    observing = true;
    var queued = null;
    var observer = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        if (!records[i].addedNodes.length) continue;
        if (isChrome(records[i].target)) continue;
        var self = false;
        for (var k = 0; k < records[i].addedNodes.length; k++) {
          if (isChrome(records[i].addedNodes[k])) { self = true; break; }
        }
        if (self) continue;
        if (queued) clearTimeout(queued);
        queued = setTimeout(function () { queued = null; apply(); }, 60);
        return;
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  /* ------------------------------------------------------------------
     Popups
     ------------------------------------------------------------------ */

  function showPopup(p) {
    if (document.getElementById("opl-popup-" + p.id)) return;

    var wrap = document.createElement("div");
    wrap.id = "opl-popup-" + p.id;
    wrap.className = "opl-popup";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    if (p.title) wrap.setAttribute("aria-label", p.title);

    wrap.innerHTML =
      '<div class="opl-popup-scrim"></div>' +
      '<div class="opl-popup-card">' +
      '<button class="opl-popup-close" type="button" aria-label="Close">&times;</button>' +
      (p.image ? '<div class="opl-popup-figure"><img src="' + p.image + '" alt=""></div>' : "") +
      '<div class="opl-popup-body">' +
      (p.title ? "<h3>" + clean(p.title) + "</h3>" : "") +
      (p.body ? "<div>" + clean(p.body) + "</div>" : "") +
      (p.btnLabel ? '<a class="btn small" href="' + (p.btnHref || "#") + '">' + clean(p.btnLabel) + "</a>" : "") +
      "</div></div>";

    document.body.appendChild(wrap);
    requestAnimationFrame(function () { wrap.classList.add("open"); });

    function close() {
      wrap.classList.remove("open");
      setTimeout(function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }, 320);
      if (p.once) { try { localStorage.setItem("opl-popup-seen-" + p.id, "1"); } catch (e) { } }
    }
    wrap.querySelector(".opl-popup-close").addEventListener("click", close);
    wrap.querySelector(".opl-popup-scrim").addEventListener("click", close);
    document.addEventListener("keydown", function esc(e) {
      if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); }
    });
  }

  function armPopups() {
    if (window.OPALINE_EDITING) return;                  // never while she is working
    var list = overlay.popups || [];
    var page = currentPage();

    list.forEach(function (p) {
      if (!p || !p.id || p.enabled === false) return;
      if (Array.isArray(p.pages) && p.pages.length && p.pages.indexOf(page) === -1) return;
      if (p.once) {
        try { if (localStorage.getItem("opl-popup-seen-" + p.id)) return; } catch (e) { }
      }
      if (document.getElementById("opl-popup-armed-" + p.id)) return;
      var flag = document.createElement("span");
      flag.id = "opl-popup-armed-" + p.id;
      flag.hidden = true;
      document.body.appendChild(flag);

      if (p.trigger === "click" && p.clickId) {
        var target = resolve(p.clickId);
        if (target) target.addEventListener("click", function (e) { e.preventDefault(); showPopup(p); });
        return;
      }
      if (p.trigger === "exit") {
        var fired = false;
        document.addEventListener("mouseout", function (e) {
          if (fired || e.relatedTarget || e.clientY > 12) return;
          fired = true;
          showPopup(p);
        });
        return;
      }
      if (p.trigger === "scroll") {
        var seen = false;
        window.addEventListener("scroll", function () {
          if (seen) return;
          var reached = (window.scrollY + window.innerHeight) / document.body.scrollHeight;
          if (reached < (p.scrollAt || 0.5)) return;
          seen = true;
          showPopup(p);
        }, { passive: true });
        return;
      }
      setTimeout(function () { showPopup(p); }, Math.max(0, Number(p.delay || 2)) * 1000);
    });
  }

  /* ------------------------------------------------------------------
     Fetching. The last overlay seen is kept in this browser and laid down
     at once, so a reader does not watch the original wording flash past
     before her version arrives. The network answer then corrects it.
     ------------------------------------------------------------------ */

  function readCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }

  function writeCache(doc) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(doc)); } catch (e) { }
  }

  function setOverlay(doc, opts) {
    overlay = (doc && typeof doc === "object") ? doc : EMPTY;
    if (!overlay.pages) overlay.pages = {};
    if (!overlay.globals) overlay.globals = {};
    if (!overlay.newPages) overlay.newPages = {};
    if (!overlay.popups) overlay.popups = [];
    apply();
    if (!opts || opts.cache !== false) writeCache(overlay);
  }

  function load() {
    if (!ENDPOINT) return Promise.resolve(overlay);
    return fetch(ENDPOINT + (SITE ? "?site=" + encodeURIComponent(SITE) : ""), { method: "GET" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.ok) throw new Error("no overlay");
        setOverlay(data.overlay);
        return overlay;
      })
      .catch(function () {
        /* Offline, or the store is not switched on. The cached version is
           already on the page and the original site is underneath it. */
        return overlay;
      });
  }

  /* Previewing. The editor opens the page again inside a narrow frame so she
     can see what a phone will make of a change — and it has to be the change
     she is holding, not the one the world has. It is handed over through
     sessionStorage, which the frame shares with the tab that opened it, and
     the network is never asked. */
  var PREVIEWING = /[?&]opl-preview=1/.test(location.search);

  function previewDoc() {
    try { return JSON.parse(sessionStorage.getItem("opl-preview-doc") || "null"); }
    catch (e) { return null; }
  }

  var cached = PREVIEWING ? previewDoc() : readCache();
  if (cached) { overlay = cached; }

  function start() {
    apply();
    fitDoor();
    watch();
    if (PREVIEWING) return;      // a preview shows what she is holding, and nothing else
    load().then(function () {
      /* Popups are armed once, from the true overlay rather than the cache,
         so one she has just switched off does not greet a reader again. */
      armPopups();
    });
  }

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start);

  window.addEventListener("load", function () { apply(); });

  /* ------------------------------------------------------------------
     What the editor uses. Everything it needs to read the page, name a
     part of it and put a changed overlay back.
     ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------
     The accent
     ------------------------------------------------------------------
     Opaline's own chrome — the bar, the dashed boxes, the buttons, the
     reel on the password screen — is drawn in one accent colour, and
     that colour should be the site's own. A workbench that turns up in
     somebody else's brand looks like a tool bolted to the page. One in
     the site's colour looks like part of it.

     It is asked for three ways, in the order the answer can be trusted:

       1. `accent` in the config. Nothing beats being told.
       2. A custom property on :root with an accent-ish name — resolved
          through however many other properties it points at, because
          sites routinely write --accent: var(--clay).
       3. The colour the site's own links and buttons actually are.

     An answer is refused if it cannot do the job. A near-grey has no hue
     to lend. What survives but is too dark to see against Opaline's own
     dark chrome is LIFTED rather than refused: a brand colour a little
     lighter is still recognisably the brand, and throwing it away would
     put a stranger's colour on their page instead.

     Deep blue is the fallback — the one hue that sits quietly beside
     almost any brand without pretending to belong to it.
     ------------------------------------------------------------------ */

  var ACCENT_FALLBACK = [47, 90, 140];        // #2F5A8C
  var CHROME_INK = [22, 24, 28];              // --opl-ink, what the accent sits on

  var ACCENT_NAMES = [
    "--opl-accent-source",                    // for a site that wants to say outright
    "--accent", "--accent-2", "--accent-color", "--color-accent",
    "--brand", "--brand-color", "--color-brand", "--brand-primary",
    "--primary", "--primary-color", "--color-primary",
    "--highlight", "--link", "--link-color"
  ];

  var probe = null;

  /* Resolved by the browser rather than by hand: a value of "var(--clay)"
     is worked out against this page exactly as the page works it out,
     however many hops it takes to get to a colour. */
  function resolveColour(value) {
    if (!value) return null;
    if (!probe) {
      probe = document.createElement("span");
      probe.setAttribute("aria-hidden", "true");
      probe.style.cssText = "position:absolute;left:-9999px;top:-9999px;width:0;height:0";
    }
    if (!probe.isConnected) document.documentElement.appendChild(probe);
    probe.style.color = "";
    probe.style.color = value;
    if (!probe.style.color) return null;      // not a colour at all
    return rgbOf(getComputedStyle(probe).color);
  }

  function rgbOf(str) {
    var m = /^rgba?\(([^)]+)\)/.exec(String(str || "").trim());
    if (!m) return null;
    var parts = m[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat);
    if (parts.length < 3 || parts.slice(0, 3).some(isNaN)) return null;
    if (parts.length > 3 && parts[3] === 0) return null;   // fully transparent says nothing
    return [parts[0], parts[1], parts[2]];
  }

  function toHsl(rgb) {
    var r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var l = (max + min) / 2, h = 0, s = 0;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return [h, s, l];
  }

  function fromHsl(h, s, l) {
    function channel(p, q, t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    if (s === 0) { var v = Math.round(l * 255); return [v, v, v]; }
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    return [
      Math.round(channel(p, q, h + 1 / 3) * 255),
      Math.round(channel(p, q, h) * 255),
      Math.round(channel(p, q, h - 1 / 3) * 255)
    ];
  }

  function luminance(rgb) {
    var c = rgb.map(function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  function contrast(a, b) {
    var x = luminance(a), y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }

  /* Lifted until it can be seen on the chrome it will sit on. */
  function legible(rgb) {
    var hsl = toHsl(rgb);
    var guard = 0;
    while (contrast(rgb, CHROME_INK) < 2.6 && hsl[2] < 0.82 && guard++ < 30) {
      hsl[2] = Math.min(0.82, hsl[2] + 0.03);
      rgb = fromHsl(hsl[0], hsl[1], hsl[2]);
    }
    return rgb;
  }

  function usable(rgb) {
    if (!rgb) return null;
    var hsl = toHsl(rgb);
    if (hsl[1] < 0.18) return null;                    // a grey has no hue to lend
    if (hsl[2] < 0.1 || hsl[2] > 0.92) return null;    // too near black or white to be a colour
    return legible(rgb);
  }

  function fromNames() {
    for (var i = 0; i < ACCENT_NAMES.length; i++) {
      var raw = getComputedStyle(document.documentElement).getPropertyValue(ACCENT_NAMES[i]);
      if (!raw || !raw.trim()) continue;
      var ok = usable(resolveColour(raw.trim()));
      if (ok) return ok;
    }
    return null;
  }

  /* Last resort: what the site's own links and buttons are actually
     painted. Counted rather than taken first, because the commonest
     usable colour among the things a reader clicks is a better guess at
     a brand than whichever one happens to be nearest the top. */
  function fromPage() {
    var seen = {};
    var els = document.querySelectorAll("a[href], button, [class*='btn'], [class*='button']");
    for (var i = 0; i < els.length && i < 150; i++) {
      var el = els[i];
      if (el.closest && el.closest("#opl-bar, #opl-panel, #opl-sheet, #opl-gate, .opl-popup")) continue;
      var cs = getComputedStyle(el);
      [cs.color, cs.backgroundColor, cs.borderTopColor].forEach(function (c) {
        var ok = usable(rgbOf(c));
        if (ok) seen[ok.join(",")] = (seen[ok.join(",")] || 0) + 1;
      });
    }
    var best = null, most = 0;
    Object.keys(seen).forEach(function (k) { if (seen[k] > most) { most = seen[k]; best = k; } });
    return best ? best.split(",").map(Number) : null;
  }

  function hex(rgb) {
    return "#" + rgb.map(function (v) {
      return ("0" + Math.max(0, Math.min(255, Math.round(v))).toString(16)).slice(-2);
    }).join("");
  }

  function pickAccent() {
    /* Told is told: honoured even where it would have been refused if it
       had only been guessed at, and made legible either way. */
    var told = resolveColour(CONFIG.accent);
    if (told) return legible(told);
    return fromNames() || fromPage() || ACCENT_FALLBACK;
  }

  var painted = null;

  function paintAccent() {
    var rgb = pickAccent();
    var value = hex(rgb);
    if (value === painted) return value;
    painted = value;

    var root = document.documentElement;
    root.style.setProperty("--opl-accent", value);
    /* Whether a label on top of it should be dark or light. A picker
       cannot answer this and a guess gets it wrong on exactly the bright
       brands that most need it right. */
    root.style.setProperty("--opl-accent-ink", luminance(rgb) > 0.45 ? "#16181c" : "#ffffff");
    return value;
  }

  /* Sites switch themselves between light and dark, and a good many
     define their accent differently in each — a blue that reads on paper
     is not the blue that reads on ink. So the answer is taken again when
     the site says its theme has changed.

     The filter deliberately excludes "style", which is the attribute
     paintAccent itself writes: watching it would mean answering our own
     change forever. */
  var watchingTheme = false;

  function watchTheme() {
    if (watchingTheme || !window.MutationObserver) return;
    watchingTheme = true;
    new MutationObserver(function () { paintAccent(); markInk(); })
      .observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "data-theme", "data-color-scheme", "data-mode"]
      });
  }

  /* ------------------------------------------------------------------
     The way in. The editor is a large file and a reader has no use for
     it, so it is fetched only when she asks for it, or when this browser
     is already carrying a session from her last visit.
     ------------------------------------------------------------------ */

  var loading = null;
  var TOKEN_KEY = "opl-editor-token" + (SITE ? ":" + SITE : "");

  function loadEditor() {
    if (window.OpalineEditor) return Promise.resolve(window.OpalineEditor);
    if (loading) return loading;

    loading = new Promise(function (done, fail) {
      /* Beside this file, wherever it was loaded from — which on the
         hosted product is Wopara's CDN and on a self-hosted site is the
         folder it was copied into. Neither needs configuring. */
      var here = (document.currentScript && document.currentScript.src) || MY_SRC || "";
      var base = here.replace(/[^/]*$/, "");

      /* Before the stylesheet, not after: the chrome should arrive already
         wearing this site's colour rather than flashing a default first. */
      paintAccent();
      watchTheme();

      var css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = base + "opaline.css?v=" + VERSION;
      document.head.appendChild(css);

      var script = document.createElement("script");
      script.src = base + "opaline-editor.js?v=" + VERSION;
      script.onload = function () { done(window.OpalineEditor); };
      script.onerror = function () { loading = null; fail(new Error("The editor could not be loaded.")); };
      document.body.appendChild(script);
    });
    return loading;
  }

  /* The way in. On a site Wopara built, the markup carries it already. On
     a site it did not, nobody is going to edit thirteen page templates to
     add a link, so Opaline puts one there itself — beside the maker's
     credit in the footer, which is where it belongs and where nobody
     looking for a shop or a phone number will trip over it. */
  /* The door's own styles, and the only ones a visitor ever gets: this
     file runs for everybody, opaline.css does not. Without them the door
     is a full-size black logo pushed hard against whatever it was put
     beside — which is exactly what it looked like.

     Everything is sized in em and inherits colour, so it takes the type
     of the credit line it stands next to instead of importing a look of
     its own. The margin is its own rather than the container's, because
     the container may not have thought about gaps at all. */
  function doorStyles(home) {
    var sheet = document.getElementById("opl-door-css");
    if (!sheet) {
      sheet = document.createElement("style");
      sheet.id = "opl-door-css";
      /* The three properties that decide whether this reads as one line
         are marked !important, and that is not laziness.

         Opaline lands in footers it has never seen, and a footer that
         styles its own links — `.footer__bottom a { display:inline-block }`
         is an ordinary thing to write — outranks a single class selector
         and wins. When it does, the flex row collapses, the gap stops
         applying, and "Edit with [mark] Opaline" breaks into three lines
         with the mark stranded on its own. Which is exactly what it did.

         Everything cosmetic is left overridable on purpose: a site may
         quite reasonably want the door dimmer, or in its own colour. Only
         the layout is defended, because a door nobody can read is not a
         door. */
      sheet.textContent =
        ".opaline-door{" +
          "display:inline-flex!important;align-items:center;gap:.34em;" +
          /* Never abuts the credit it stands beside, whatever it was
             appended into: a flex row with its own gap adds to this, and
             a paragraph that has no gap at all still gets one. */
          "margin-left:1.35em!important;" +
          "white-space:nowrap!important;" +
          "vertical-align:middle;" +
          "font:inherit;color:inherit;text-decoration:none;" +
          "opacity:.6;transition:opacity .25s ease}" +
        ".opaline-door:hover{opacity:1}" +
        /* The file carries a wide transparent margin, the same one the
           maker's credit mark beside it carries, so it is scaled up
           inside its own footprint rather than given a bigger box. */
        ".opaline-mark{" +
          "width:1.15em!important;height:1.15em!important;" +
          "object-fit:contain;flex:none;display:block;" +
          "transform:scale(1.5);" +
          "filter:var(--opl-door-mark,brightness(0));" +
          "opacity:.85;transition:opacity .25s ease}" +
        ".opaline-door:hover .opaline-mark{opacity:1}";
      document.head.appendChild(sheet);
    }

    doorHome = home;
    markInk();
  }

  /* One mark, two grounds. It is a black PNG, so on a dark footer it has to
     be turned inside out or it is a hole in the page — which is what it
     was. Decided from the colour the door will actually inherit, rather
     than from a guess about the site's theme, because a light site with a
     dark footer is a common thing and a guess gets it backwards.

     Taken again whenever the site changes theme, since a footer that is
     dark in one and pale in the other would otherwise keep whichever
     answer happened to be true when the page first loaded. */
  var doorHome = null;

  function markInk() {
    if (!doorHome || !doorHome.isConnected) return;
    var ink = rgbOf(getComputedStyle(doorHome).color);
    var light = ink ? luminance(ink) > 0.45 : true;
    document.documentElement.style.setProperty(
      "--opl-door-mark", light ? "brightness(0) invert(1)" : "brightness(0)"
    );
  }

  function fitDoor() {
    var d = CONFIG.door || {};
    if (document.querySelector("[data-opaline]")) return;

    var home = document.querySelector(d.into || ".footer-credit, footer .credit, footer");
    if (!home) return;

    doorStyles(home);
    watchTheme();

    var a = document.createElement("a");
    a.href = "#";
    a.className = "opaline-door";
    a.setAttribute("data-opaline", "");
    /* The mark stands in for the word: "Edit with [logo] Opaline". A site
       that sets its own label gets exactly that; otherwise the brand logo
       from the config takes the place of the name, with the name itself as
       the alt so nothing is lost to a screen reader. */
    var brand = CONFIG.brand || {};
    if (d.label) {
      a.textContent = d.label;
    } else if (brand.logo) {
      a.innerHTML = 'Edit with <img class="opaline-mark" src="' + brand.logo +
        '" alt="Wopara" width="18" height="18" loading="lazy" decoding="async">Opaline';
    } else {
      a.textContent = "Edit with Wopara Opaline";
    }
    home.appendChild(a);
  }

  document.addEventListener("click", function (e) {
    var hit = e.target.closest && e.target.closest("[data-opaline]");
    if (!hit) return;
    e.preventDefault();
    if (window.OPALINE_EDITING && window.OpalineEditor) window.OpalineEditor.signOut();
    else window.OpalineDoor.open();
  });

  document.addEventListener("keydown", function (e) {
    var key = ((CONFIG.door || {}).hotkey || "e").toLowerCase();
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === key) {
      e.preventDefault();
      window.OpalineDoor.open();
    }
  });

  window.OpalineDoor = {
    open: function () {
      loadEditor().then(function (editor) { if (editor) editor.open(); });
    },
    loaded: function () { return !!window.OpalineEditor; }
  };

  /* A session in hand means she is still signed in, so the workbench comes
     back on its own as she walks from page to page. Never inside a preview
     frame, which is meant to look exactly like a reader's screen. */
  try {
    var held = JSON.parse(localStorage.getItem(TOKEN_KEY) || "null");
    if (!PREVIEWING && held && held.expires > Date.now()) loadEditor();
    else if (!PREVIEWING && new RegExp("[?&]" + (((CONFIG.door || {}).urlFlag) || "opaline") + "(=|&|$)").test(location.search)) {
      loadEditor().then(function (editor) { if (editor) editor.open(); });
    }
  } catch (e) { }

  window.Opaline = {
    endpoint: ENDPOINT,
    site: SITE,
    config: CONFIG,
    nodeId: nodeId,
    resolve: resolve,
    currentPage: currentPage,
    clean: clean,
    cssProps: CSS_PROPS,
    screens: SCREENS,
    fingerprint: fingerprint,
    /* The accent Opaline decided to wear, as a hex string. The editor uses
       it where a colour has to be computed rather than inherited. */
    accent: paintAccent,
    /* Posts, and where one lives. The editor writes them; this reads them,
       so both agree on the ordering and on the address without either
       having to know how the host is set up. */
    posts: postList,
    pageHref: pageHref,
    showDate: showDate,
    youtubeId: youtubeId,
    embedId: embedId,
    isVideoFrame: isVideoFrame,
    /* "path" — found where it was left. "words" — the markup moved but the
       wording gave it away, so it still landed. "lost" — neither, and that
       edit did nothing this time. */
    howFound: function (id) { return howFound[id] || null; },
    health: function () {
      var page = (overlay.pages || {})[currentPage()] || {};
      var out = { path: 0, words: 0, lost: 0, lostIds: [] };
      Object.keys(page.nodes || {}).forEach(function (k) {
        var how = howFound[k] || "lost";
        out[how]++;
        if (how === "lost") out.lostIds.push(k);
      });
      return out;
    },
    get: function () { return overlay; },
    set: function (doc) { setOverlay(doc, { cache: false }); },
    apply: apply,
    reload: load,
    showPopup: showPopup,
    empty: function () { return JSON.parse(JSON.stringify(EMPTY)); },

    /* What an element said before the overlay first touched it. The editor
       needs this to put one thing back in a session that never saw the
       untouched page. Null when the overlay has never touched it, which is
       itself the answer: there is nothing to put back. */
    originalOf: function (id) { return originals[id] || null; },

    /* The licensed catalog and its prices, which js/store.js renders. Kept
       here rather than in that file so the price on the page and the price
       at the till are the same number, read from the same place. */
    catalog: function () {
      var g = overlay.globals || {};
      return g.catalog || null;
    }
  };
})();
