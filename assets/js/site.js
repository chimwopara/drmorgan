/* ==========================================================================
   DRMORGAN.AI — motion layer
   Progressive enhancement: every page is fully readable and navigable
   with this file blocked.
   ========================================================================== */
(function () {
  "use strict";

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var coarse = window.matchMedia("(hover: none)").matches;
  var $ = function (s, c) { return (c || document).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); };
  var clamp = function (v, a, b) { return Math.min(b, Math.max(a, v)); };

  /* ---------------------------------------------------------------- header */
  function header() {
    var el = $("[data-header]"), bar = $("[data-progress] i");
    if (!el) return;
    var last = 0, tick = false;

    function up() {
      var y = window.scrollY, max = document.documentElement.scrollHeight - window.innerHeight;
      el.classList.toggle("is-stuck", y > 20);
      last = y;
      if (bar) bar.style.width = (max > 0 ? (y / max) * 100 : 0) + "%";
      tick = false;
    }
    addEventListener("scroll", function () { if (!tick) { tick = true; requestAnimationFrame(up); } }, { passive: true });
    up();
  }

  /* ----------------------------------------------------------------- theme
     The chosen ground is written to <html data-theme> by a tiny inline script
     in the document head, so the first paint is already correct. This only
     keeps the controls in sync and handles the switch. */
  var THEME_KEY = "dm-theme";
  var THEME_BG = { light: "#F2F6FB", dark: "#0C1421" };

  function paintTheme(mode) {
    var dark = mode === "dark";
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");

    var meta = $('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", dark ? THEME_BG.dark : THEME_BG.light);

    $$("[data-theme-toggle]").forEach(function (b) {
      var say = dark ? "Switch to light mode" : "Switch to dark mode";
      var lbl = $(".themetoggle__lbl", b);
      if (lbl) lbl.textContent = dark ? "Light" : "Dark";
      b.setAttribute("aria-pressed", String(dark));
      b.setAttribute("aria-label", say);
      b.setAttribute("title", say);
    });
  }

  var themeTimer = null;

  function theme() {
    var stored = null;
    try { stored = localStorage.getItem(THEME_KEY); } catch (e) {}
    paintTheme(stored === "dark" ? "dark"
             : stored === "light" ? "light"
             : document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light");

    $$("[data-theme-toggle]").forEach(function (b) {
      b.addEventListener("click", function () {
        var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
        try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
        if (!reduced) {
          document.documentElement.classList.add("is-theming");
          clearTimeout(themeTimer);
          themeTimer = setTimeout(function () {
            document.documentElement.classList.remove("is-theming");
          }, 500);
        }
        paintTheme(next);
      });
    });
  }

  /* ------------------------------------------------------------------ menu */
  function menu() {
    var b = $("[data-burger]"), m = $("[data-menu]");
    if (!b || !m) return;
    function set(open) {
      m.classList.toggle("is-open", open);
      document.body.classList.toggle("is-locked", open);
      document.documentElement.classList.toggle("is-menu-open", open);
      b.setAttribute("aria-expanded", String(open));
      m.setAttribute("aria-hidden", String(!open));
    }
    b.addEventListener("click", function () { set(!m.classList.contains("is-open")); });
    $$("a", m).forEach(function (a) { a.addEventListener("click", function () { set(false); }); });
    var dis = $("[data-menu-close]", m);
    if (dis) dis.addEventListener("click", function () { set(false); });

    // "Get Help" inside the menu: close the sheet, then hand over to the
    // assistant. Clear any jump state first or scrollState() would take the click.
    var ask = $("[data-menu-ask]", m);
    if (ask) ask.addEventListener("click", function () {
      set(false);
      var toggle = $("[data-ask-toggle]");
      if (!toggle) return;
      delete toggle.dataset.jump;
      setTimeout(function () { toggle.click(); }, 340);
    });
    addEventListener("keydown", function (e) { if (e.key === "Escape") set(false); });
    set(false);
  }

  /* -------------------------------------------------------- page curtain */
  function curtain() {
    var c = $("[data-curtain]");
    if (!c || reduced) return;

    // Arrival is handled entirely in CSS: the markup ships with .is-in and the
    // strips lift on their own keyframes. JS only clears the class afterwards
    // so a later .is-out isn't fighting a finished (forwards) animation.
    // Reduced motion never reaches here, and with JS off the CSS still lifts.
    if (c.classList.contains("is-in")) {
      setTimeout(function () { c.classList.remove("is-in"); }, 1400);
    }

    document.addEventListener("click", function (e) {
      var a = e.target.closest && e.target.closest("a");
      if (!a) return;
      var href = a.getAttribute("href") || "";
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      if (a.target === "_blank" || a.hasAttribute("download")) return;
      if (!/\.html$/.test(href.split("#")[0]) && href !== "/" ) return;
      if (a.origin && a.origin !== location.origin) return;
      if (a.pathname === location.pathname && href.indexOf("#") > -1) return;

      e.preventDefault();
      c.classList.remove("is-in");   // finished arrival animation would override .is-out
      c.classList.add("is-out");
      setTimeout(function () { location.href = a.href; }, 620);
    });

    // returning via bfcache must not leave the curtain down
    addEventListener("pageshow", function (e) {
      if (e.persisted) c.classList.remove("is-out", "is-in");
    });
  }

  /* ---------------------------------------------------------------- reveal */
  function reveal() {
    var items = $$("[data-reveal], [data-draw-group], .reveal-img, .frame, .dialstat, .strike, .uline, .mk, .connector, .balance, .buildstory, .archband");
    if (!items.length) return;

    function show(el) { el.classList.add("is-in"); }

    // stagger siblings inside a group
    items.forEach(function (el) {
      if (el.hasAttribute("data-reveal") && !el.style.getPropertyValue("--d")) {
        var g = el.closest("[data-group]");
        if (g) {
          var i = $$("[data-reveal]", g).indexOf(el);
          if (i > -1) el.style.setProperty("--d", i * 85 + "ms");
        }
      }
    });

    if (reduced || !("IntersectionObserver" in window)) {
      items.forEach(show);
      return;
    }

    var pending = items.slice();

    function done(el) {
      show(el);
      io.unobserve(el);
      var k = pending.indexOf(el);
      if (k > -1) pending.splice(k, 1);
    }

    var io = new IntersectionObserver(function (es) {
      es.forEach(function (en) { if (en.isIntersecting) done(en.target); });
    }, { rootMargin: "0px 0px -10% 0px", threshold: 0.06 });

    items.forEach(function (el) { io.observe(el); });

    // Safety net. Observer notifications can be missed (sticky/stacking
    // contexts, throttled or coalesced frames, restored scroll positions).
    // Content must never stay hidden while it is on screen, so sweep too.
    function sweep() {
      for (var i = pending.length - 1; i >= 0; i--) {
        var el = pending[i], r = el.getBoundingClientRect();
        if (r.height > 0 && r.bottom > 0 && r.top < innerHeight * 0.94) done(el);
      }
      if (!pending.length) {
        removeEventListener("scroll", onScroll);
        removeEventListener("resize", onScroll);
      }
    }

    // Time-throttled, not rAF-throttled: a stalled animation frame (background
    // tab, throttled webview) must never leave content permanently hidden.
    var last = 0, queued = false;
    function onScroll() {
      var now = +new Date();
      if (now - last > 100) { last = now; sweep(); return; }
      if (!queued) {
        queued = true;
        setTimeout(function () { queued = false; last = +new Date(); sweep(); }, 100);
      }
    }

    addEventListener("scroll", onScroll, { passive: true });
    addEventListener("resize", onScroll);
    sweep();
    setTimeout(sweep, 300);
  }

  /* ------------------------------------------------------- split to words */
  function splitWords(el) {
    if (!el || el.dataset.done) return;
    var words = el.textContent.trim().split(/\s+/), frag = document.createDocumentFragment();
    words.forEach(function (w, i) {
      var s = document.createElement("span");
      s.className = "w"; s.style.setProperty("--i", i);
      var inner = document.createElement("i"); inner.textContent = w;
      s.appendChild(inner); frag.appendChild(s);
      if (i < words.length - 1) frag.appendChild(document.createTextNode(" "));
    });
    el.textContent = ""; el.appendChild(frag); el.dataset.done = "1";
  }

  /* ------------------------------------------------------------ hero acts */
  // Ambient video: decorative only. Hold still for reduced-motion users, and
  // don't burn cycles decoding frames while it's off screen.
  function ambient() {
    var vids = $$("video[data-ambient]");
    if (!vids.length) return;
    vids.forEach(function (v) {
      v.muted = true;
      if (reduced) { v.removeAttribute("autoplay"); try { v.pause(); } catch (e) {} return; }
      if (!("IntersectionObserver" in window)) return;
      new IntersectionObserver(function (es) {
        es.forEach(function (en) {
          if (en.isIntersecting) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
          else { try { v.pause(); } catch (e) {} }
        });
      }, { threshold: 0.15 }).observe(v);
    });
  }

  // Keep the floating help pill clear of the footer credit bar instead of
  // sitting on top of it once the user reaches the bottom of the page.
  function askClearance() {
    var ask = $(".ask"), bar = $(".footer__bottom");
    if (!ask || !bar) return;
    var tick = false;
    function up() {
      tick = false;
      var r = bar.getBoundingClientRect();
      var overlap = window.innerHeight - r.top;
      ask.style.transform = overlap > 0 ? "translateY(" + -(overlap + 12) + "px)" : "";
    }
    function req() { if (!tick) { tick = true; requestAnimationFrame(up); } }
    addEventListener("scroll", req, { passive: true });
    addEventListener("resize", req);
    up();
  }

  // Liquid glass: track the pointer across glass surfaces so the specular
  // highlight moves with it. Skipped on coarse pointers and reduced motion.
  function glass() {
    if (reduced || coarse) return;
    var els = $$(".glass, .header__pod, .pathway, .formcard, .panel__in, .ask__panel");
    if (!els.length) return;
    els.forEach(function (el) {
      el.addEventListener("pointermove", function (e) {
        var r = el.getBoundingClientRect();
        el.style.setProperty("--gx", ((e.clientX - r.left) / r.width * 100).toFixed(1) + "%");
        el.style.setProperty("--gy", ((e.clientY - r.top) / r.height * 100).toFixed(1) + "%");
        el.classList.add("is-lit");
      }, { passive: true });
      el.addEventListener("pointerleave", function () { el.classList.remove("is-lit"); });
    });
  }

  // The boot overlay covers the viewport. If its animation is dropped for any
  // reason the site becomes unusable, so clear it unconditionally on a timer.
  function bootClear() {
    var b = $(".boot");
    if (!b) return;
    setTimeout(function () { b.classList.add("is-done"); }, 2100);
  }

  // Horizontal rails: the hint is a real control. Each click advances by one
  // tile; at the end it flips and returns to the start.
  function railNav() {
    $$("[data-rail-next]").forEach(function (btn) {
      var id = btn.getAttribute("aria-controls");
      var rail = id ? document.getElementById(id) : $("[data-rail]");
      if (!rail) return;
      var tile = $(".tile", rail);

      function atEnd() { return rail.scrollLeft >= rail.scrollWidth - rail.clientWidth - 4; }
      function sync() { btn.classList.toggle("is-end", atEnd()); }

      btn.addEventListener("click", function () {
        var step = tile ? tile.getBoundingClientRect().width + 16 : rail.clientWidth * 0.8;
        var to = atEnd() ? 0 : rail.scrollLeft + step;
        rail.scrollTo({ left: to, behavior: reduced ? "auto" : "smooth" });
      });
      rail.addEventListener("scroll", function () {
        clearTimeout(rail._t); rail._t = setTimeout(sync, 90);
      }, { passive: true });
      sync();
    });
  }

  // Rocket: maps the section's travel through the viewport onto a vertical
  // climb (plus a touch of drift), so it moves in sync with scroll rather than
  // on a timer. Purely decorative, so reduced-motion parks it.
  function rocket() {
    var fields = $$("[data-rocket]");
    if (!fields.length || reduced) return;
    var tick = false;
    function upd() {
      tick = false;
      fields.forEach(function (f) {
        var art = $(".rocket", f), host = f.parentElement;
        if (!art || !host) return;
        var r = host.getBoundingClientRect();
        if (r.bottom < -300 || r.top > innerHeight + 300) return;
        // 0 when the section first enters, 1 when it has fully passed
        var p = (innerHeight - r.top) / (innerHeight + r.height);
        p = clamp(p, 0, 1);
        var rise = (0.5 - p) * 62;        // climbs as you scroll down
        var drift = Math.sin(p * Math.PI) * 5;
        art.style.transform = "translate3d(" + drift.toFixed(2) + "%," + rise.toFixed(2) + "%,0) rotate(" + (drift * 0.5).toFixed(2) + "deg)";
      });
    }
    addEventListener("scroll", function () { if (!tick) { tick = true; requestAnimationFrame(upd); } }, { passive: true });
    addEventListener("resize", upd);
    upd();
  }

  function hero() {
    var root = $("[data-hero]");
    if (!root) return;
    var acts = $$("[data-act]", root),
        shots = $$("[data-shot]", root),
        rail = $$("[data-goto]", root),
        phases = $$("[data-phase]", root),
        run = $("[data-dial-run]", root),
        cur = $("[data-cur]", root),
        tot = $("[data-tot]", root);
    if (acts.length < 2) return;

    var DUR = 7200, i = 0, timer = null, paused = false, held = false, chosen = false;
    root.style.setProperty("--act-dur", DUR + "ms");
    if (tot) tot.textContent = String(acts.length).padStart(2, "0");
    if (!reduced) acts.forEach(function (a) { splitWords($("[data-split]", a)); });

    if (run) {
      var r = run.r ? run.r.baseVal.value : 20;
      var c = 2 * Math.PI * r;
      run.style.setProperty("--c", c.toFixed(1));
      run.style.strokeDasharray = c.toFixed(1);
    }

    function restartDial() {
      if (!run || reduced) return;
      run.classList.remove("is-running");
      void run.getBoundingClientRect();
      run.classList.add("is-running");
    }

    function go(n, manual) {
      i = (n + acts.length) % acts.length;
      acts.forEach(function (a, k) {
        var on = k === i;
        a.classList.toggle("is-on", on);
        a.setAttribute("aria-hidden", String(!on));
        if (on && !reduced) {
          $$(".w i", a).forEach(function (w) { w.style.animation = "none"; void w.offsetWidth; w.style.animation = ""; });
        }
      });
      shots.forEach(function (s, k) { s.classList.toggle("is-on", k === i); });
      phases.forEach(function (p, k) { p.classList.toggle("is-on", k === i); });
      rail.forEach(function (b, k) {
        b.classList.toggle("is-on", k === i);
        if (k === i) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current");
      });
      if (cur) cur.textContent = String(i + 1).padStart(2, "0");
      restartDial();
      if (manual) schedule();
    }

    /* `paused` is the transient courtesy stop while a pointer or the keyboard
       is inside the hero. `held` is the visitor pressing the hold button, and
       it must outlive the pointer leaving, so the two are tracked apart.
       Once `chosen` is set the visitor has taken manual control, and an
       explicit press outranks the hover heuristic — otherwise pressing play
       while the cursor rests on the hero would appear to do nothing. */
    function schedule() {
      clearTimeout(timer);
      if (reduced || held || (paused && !chosen)) { root.classList.add("is-paused"); return; }
      root.classList.remove("is-paused");
      timer = setTimeout(function () { go(i + 1); schedule(); }, DUR);
    }

    function autoPause() {
      if (chosen) return;
      paused = true;
      clearTimeout(timer);
      root.classList.add("is-paused");
    }

    rail.forEach(function (b, k) { b.addEventListener("click", function () { go(k, true); }); });
    var p = $("[data-prev]", root), n = $("[data-next]", root), h = $("[data-hold]", root);
    if (p) p.addEventListener("click", function () { go(i - 1, true); });
    if (n) n.addEventListener("click", function () { go(i + 1, true); });

    if (h) {
      h.addEventListener("click", function () {
        held = !held;
        chosen = true;
        var say = held ? "Play the manifesto" : "Pause the manifesto";
        h.setAttribute("aria-pressed", String(held));
        h.setAttribute("aria-label", say);
        h.setAttribute("title", say);
        if (run) run.style.animationPlayState = held ? "paused" : "running";
        schedule();
      });
    }

    root.addEventListener("mouseenter", function () { autoPause(); if (run && !chosen) run.style.animationPlayState = "paused"; });
    root.addEventListener("mouseleave", function () { paused = false; if (run && !held) run.style.animationPlayState = "running"; schedule(); });
    root.addEventListener("focusin", autoPause);
    root.addEventListener("focusout", function (e) { if (!root.contains(e.relatedTarget)) { paused = false; schedule(); } });
    document.addEventListener("visibilitychange", function () { if (document.hidden) clearTimeout(timer); else schedule(); });

    addEventListener("keydown", function (e) {
      if (window.scrollY > innerHeight * 0.7) return;
      var t = (e.target && e.target.tagName) || "";
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(t) || (e.target && e.target.isContentEditable)) return;
      if (e.key === "ArrowRight") go(i + 1, true);
      if (e.key === "ArrowLeft") go(i - 1, true);
    });

    var sx = null;
    root.addEventListener("pointerdown", function (e) { sx = e.clientX; }, { passive: true });
    root.addEventListener("pointerup", function (e) {
      if (sx === null) return;
      var d = e.clientX - sx;
      if (Math.abs(d) > 60) go(i + (d < 0 ? 1 : -1), true);
      sx = null;
    }, { passive: true });

    go(0); schedule();
  }

  /* ------------------------------------------- hero ribbon (twisted mesh) */
  function ribbon() {
    var cv = $("[data-ribbon]");
    if (!cv || reduced) return;
    var ctx = cv.getContext("2d");
    if (!ctx) return;

    var dpr = Math.min(devicePixelRatio || 1, 2), w = 0, h = 0, raf = null, t = 0, alive = true;
    var LINES = 26;
    // pointer influence on the waist, eased toward the target each frame
    var aim = { x: 0.5, y: 0.6 }, at = { x: 0.5, y: 0.6 };
    var hero = cv.closest(".hero") || cv.parentElement;
    if (hero && !coarse) {
      hero.addEventListener("pointermove", function (e) {
        var r = hero.getBoundingClientRect();
        aim.x = clamp((e.clientX - r.left) / r.width, 0, 1);
        aim.y = clamp((e.clientY - r.top) / r.height, 0, 1);
      });
      hero.addEventListener("pointerleave", function () { aim.x = 0.5; aim.y = 0.6; });
    }

    function size() {
      var r = cv.getBoundingClientRect();
      w = r.width; h = r.height;
      if (!w || !h) return;
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function frame() {
      if (!w || !h) { raf = requestAnimationFrame(frame); return; }
      t += 0.0042;
      ctx.clearRect(0, 0, w, h);

      // the waist the whole band twists through: drift + pointer pull
      at.x += (aim.x - at.x) * 0.045;
      at.y += (aim.y - at.y) * 0.045;
      var px = w * (0.42 + 0.09 * Math.sin(t * 0.8) + 0.26 * at.x);
      var py = h * (0.40 + 0.07 * Math.cos(t * 0.6) + 0.32 * at.y);

      for (var k = 0; k < LINES; k++) {
        var u = k / (LINES - 1);
        var phase = t + u * 2.2;

        var x0 = w * (0.18 + 1.02 * u) + 26 * Math.sin(phase);
        var x1 = w * (1.26 - 1.06 * u) + 22 * Math.cos(phase * 0.9);

        // pull each strand toward the waist by a varying amount -> the twist
        var pull = 0.52 + 0.34 * Math.sin(u * Math.PI + t * 0.9);
        var mx = (x0 + x1) / 2, my = h * 0.5;
        var cx = mx + (px - mx) * pull;
        var cy = my + (py - my) * pull;

        var fade = 0.10 + 0.26 * Math.abs(Math.sin(u * Math.PI));
        ctx.strokeStyle = "rgba(27,37,48," + (fade * 0.5).toFixed(3) + ")";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x0, -30);
        ctx.quadraticCurveTo(cx, cy, x1, h + 30);
        ctx.stroke();
      }

      // a gold strand travelling through the band
      var g = (Math.sin(t * 0.7) * 0.5 + 0.5);
      var gx0 = w * (0.18 + 1.02 * g), gx1 = w * (1.26 - 1.06 * g);
      ctx.strokeStyle = "rgba(32,32,32,.45)";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(gx0, -30);
      ctx.quadraticCurveTo(px, py, gx1, h + 30);
      ctx.stroke();

      raf = requestAnimationFrame(frame);
    }

    function start() { if (!raf && alive) raf = requestAnimationFrame(frame); }
    function stop() { if (raf) { cancelAnimationFrame(raf); raf = null; } }

    size(); start();
    var rt; addEventListener("resize", function () { clearTimeout(rt); rt = setTimeout(size, 160); });
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (e) { alive = e[0].isIntersecting; alive ? start() : stop(); }, { threshold: 0.02 }).observe(cv);
    }
    document.addEventListener("visibilitychange", function () { document.hidden ? stop() : start(); });
  }

  /* ------------------------------------------- hero depth on pointer move */
  function heroDepth() {
    var hero = $("[data-hero]");
    if (!hero || reduced || coarse) return;
    var media = $(".hero__media", hero), acts = $(".hero__acts", hero);
    var tx = 0, ty = 0, cx = 0, cy = 0, raf = null;

    hero.addEventListener("pointermove", function (e) {
      var r = hero.getBoundingClientRect();
      tx = (e.clientX - r.left) / r.width - 0.5;
      ty = (e.clientY - r.top) / r.height - 0.5;
      if (!raf) raf = requestAnimationFrame(loop);
    });
    hero.addEventListener("pointerleave", function () { tx = 0; ty = 0; if (!raf) raf = requestAnimationFrame(loop); });

    function loop() {
      cx += (tx - cx) * 0.06;
      cy += (ty - cy) * 0.06;
      if (media) media.style.transform = "scale(1.06) translate3d(" + (cx * -22).toFixed(2) + "px," + (cy * -14).toFixed(2) + "px,0)";
      if (acts) acts.style.transform = "translate3d(" + (cx * 9).toFixed(2) + "px," + (cy * 6).toFixed(2) + "px,0)";
      raf = (Math.abs(cx - tx) > 0.0005 || Math.abs(cy - ty) > 0.0005) ? requestAnimationFrame(loop) : null;
    }
  }

  /* ------------------------------------------------------------- 3D tilt */
  function tilt() {
    if (reduced || coarse) return;
    $$("[data-tilt]").forEach(function (el) {
      var max = parseFloat(el.dataset.tilt) || 9;
      var frameId = null, tx = 0, ty = 0;
      el.style.transformStyle = "preserve-3d";
      el.addEventListener("pointermove", function (e) {
        var r = el.getBoundingClientRect();
        tx = ((e.clientY - r.top) / r.height - 0.5) * -2 * max;
        ty = ((e.clientX - r.left) / r.width - 0.5) * 2 * max;
        if (!frameId) frameId = requestAnimationFrame(function () {
          el.style.transform = "perspective(1000px) rotateX(" + tx.toFixed(2) + "deg) rotateY(" + ty.toFixed(2) + "deg)";
          frameId = null;
        });
      });
      el.addEventListener("pointerleave", function () {
        el.style.transform = "perspective(1000px) rotateX(0) rotateY(0)";
      });
    });
  }

  /* ------------------------------------------------- magnetic hover on CTA */
  function magnetic() {
    if (reduced || coarse) return;
    $$("[data-magnetic]").forEach(function (el) {
      el.addEventListener("pointermove", function (e) {
        var r = el.getBoundingClientRect();
        var x = (e.clientX - r.left - r.width / 2) * 0.24;
        var y = (e.clientY - r.top - r.height / 2) * 0.34;
        el.style.transform = "translate(" + x.toFixed(1) + "px," + y.toFixed(1) + "px)";
      });
      el.addEventListener("pointerleave", function () { el.style.transform = ""; });
    });
  }

  /* ------------------------------------------ statement: scroll-lit words */
  function statement() {
    var els = $$("[data-lit]");
    if (!els.length) return;
    els.forEach(function (el) {
      if (!el.dataset.done) {
        var parts = el.innerHTML.split(/(\s+)/);
        el.innerHTML = parts.map(function (p) {
          return /^\s+$/.test(p) || !p ? p : '<span class="dim">' + p + "</span>";
        }).join("");
        el.dataset.done = "1";
      }
      var spans = $$("span.dim, span.lit", el);
      if (reduced) { spans.forEach(function (s) { s.className = "lit"; }); return; }
      var tick = false;
      function upd() {
        var r = el.getBoundingClientRect();
        var p = clamp((innerHeight * 0.82 - r.top) / (r.height + innerHeight * 0.32), 0, 1);
        var n = Math.round(p * spans.length);
        spans.forEach(function (s, k) { s.className = k < n ? "lit" : "dim"; });
        tick = false;
      }
      addEventListener("scroll", function () { if (!tick) { tick = true; requestAnimationFrame(upd); } }, { passive: true });
      upd();
    });
  }

  /* --------------------------------------------- sticky panel depth stack */
  function panels() {
    var ps = $$("[data-panel]");
    if (!ps.length || reduced) return;

    var inners = ps.map(function (p) { return $(".panel__in", p); });
    // Matches the breakpoint where the CSS drops `position: sticky`. Static
    // panels have no stack to recede into, and driving depth off scroll there
    // blurs and fades the very card the reader is on.
    var mq = matchMedia("(min-width: 861px)");
    var tick = false, stacked = false;

    function clear() {
      inners.forEach(function (inner) {
        if (!inner) return;
        inner.style.transform = "";
        inner.style.opacity = "";
        inner.style.filter = "";
      });
    }

    function upd() {
      tick = false;
      if (!mq.matches) { if (stacked) { stacked = false; clear(); } return; }
      stacked = true;

      // Read every rect first, then write. Interleaving them forces a fresh
      // layout per card, per frame.
      var rects = ps.map(function (p) { return p.getBoundingClientRect(); });
      var top = parseFloat(getComputedStyle(ps[0]).top) || 0;

      ps.forEach(function (p, k) {
        var inner = inners[k];
        if (!inner) return;

        // A pinned panel sits at exactly `top`, so measuring its own offset
        // reports no progress for the whole time it is stuck — the old
        // reading — and then every card lurches at once when the stack
        // finally releases. Depth belongs to the card climbing over this one:
        // full when it has covered this card, none before it starts.
        var next = rects[k + 1];
        var past = 0;
        if (next && rects[k].height > 0) {
          past = clamp((top + rects[k].height - next.top) / rects[k].height, 0, 1);
        }

        inner.style.transform = "scale(" + (1 - past * 0.07).toFixed(4) + ")";
        inner.style.opacity = (1 - past * 0.35).toFixed(3);
        inner.style.filter = past > 0.01 ? "blur(" + (past * 2.2).toFixed(2) + "px)" : "";
      });
    }

    function onScroll() { if (!tick) { tick = true; requestAnimationFrame(upd); } }
    addEventListener("scroll", onScroll, { passive: true });
    // Card heights and the sticky offset both track the viewport, so stale
    // values survive a resize or an orientation flip without this.
    addEventListener("resize", onScroll);
    if (mq.addEventListener) mq.addEventListener("change", onScroll);
    else if (mq.addListener) mq.addListener(onScroll);
    upd();
  }

  /* ------------------------------------------------------------ spine draw */
  function spine() {
    var ss = $$("[data-spine]");
    if (!ss.length || reduced) return;
    var tick = false;
    function upd() {
      ss.forEach(function (s) {
        var host = s.parentElement, fill = $("i", s);
        if (!host || !fill) return;
        var r = host.getBoundingClientRect();
        var p = clamp((innerHeight * 0.6 - r.top) / r.height, 0, 1);
        fill.style.height = (p * 100).toFixed(1) + "%";
      });
      tick = false;
    }
    addEventListener("scroll", function () { if (!tick) { tick = true; requestAnimationFrame(upd); } }, { passive: true });
    upd();
  }

  /* ------------------------------------------------------------ count-ups */
  function counters() {
    var els = $$("[data-count]");
    if (!els.length) return;
    if (reduced || !("IntersectionObserver" in window)) {
      els.forEach(function (e) { e.textContent = e.dataset.count; });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        var el = en.target, target = parseInt(el.dataset.count, 10) || 0, pad = el.dataset.count.length;
        var t0 = null;
        function step(ts) {
          if (!t0) t0 = ts;
          var p = clamp((ts - t0) / 1400, 0, 1);
          var eased = 1 - Math.pow(1 - p, 3);
          el.textContent = String(Math.round(eased * target)).padStart(pad, "0");
          if (p < 1) requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
        io.unobserve(el);
      });
    }, { threshold: 0.5 });
    els.forEach(function (e) { io.observe(e); });
  }

  /* ------------------------------------------------------------ accordion */
  function accordion() {
    $$("[data-acc]").forEach(function (root) {
      $$(".acc__btn", root).forEach(function (btn) {
        var item = btn.closest(".acc__item");
        var body = $(".acc__body", item);
        btn.setAttribute("aria-expanded", "false");
        btn.addEventListener("click", function () {
          var open = item.classList.toggle("is-open");
          btn.setAttribute("aria-expanded", String(open));
          if (body) body.setAttribute("aria-hidden", String(!open));
        });
        if (body) body.setAttribute("aria-hidden", "true");
      });
    });
  }

  /* -------------------------------------------------------------- sidenav */
  function sidenav() {
    var nav = $("[data-sidenav]");
    if (!nav || !("IntersectionObserver" in window)) return;
    var links = $$("a[href^='#']", nav), map = {}, targets = [];
    links.forEach(function (l) {
      var t = document.getElementById(l.getAttribute("href").slice(1));
      if (t) { map[t.id] = l; targets.push(t); }
    });
    if (!targets.length) return;
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (en) {
        if (!en.isIntersecting) return;
        links.forEach(function (l) { l.classList.remove("is-active"); });
        if (map[en.target.id]) map[en.target.id].classList.add("is-active");
      });
    }, { rootMargin: "-28% 0px -58% 0px" });
    targets.forEach(function (t) { io.observe(t); });
  }

  /* ------------------------------------------------- horizontal rail drag */
  function rails() {
    $$("[data-rail]").forEach(function (r) {
      var down = false, x0 = 0, s0 = 0, moved = false;
      r.addEventListener("pointerdown", function (e) {
        if (e.pointerType === "touch") return;
        down = true; moved = false; x0 = e.clientX; s0 = r.scrollLeft; r.style.cursor = "grabbing";
      });
      r.addEventListener("pointermove", function (e) {
        if (!down) return;
        var d = e.clientX - x0;
        if (Math.abs(d) > 4) moved = true;
        r.scrollLeft = s0 - d;
      });
      ["pointerup", "pointerleave", "pointercancel"].forEach(function (ev) {
        r.addEventListener(ev, function () { down = false; r.style.cursor = ""; });
      });
      r.addEventListener("click", function (e) { if (moved) { e.preventDefault(); e.stopPropagation(); } }, true);
    });
  }

  /* -------------------------------------------------- click feedback */
  function clicks() {
    if (reduced) return;

    // ripple inside pressable surfaces
    document.addEventListener("pointerdown", function (e) {
      var host = e.target.closest && e.target.closest(".btn, .feature, .tile, .flip__face, .card, .hero__arrow");
      if (!host) return;
      // a surface only ripples if it actually goes somewhere
      if (!host.closest("a[href], button, [role='button']")) return;
      var r = host.getBoundingClientRect();
      var size = Math.max(r.width, r.height) * 2.2;
      var span = document.createElement("span");
      span.className = "ripple";
      span.style.width = span.style.height = size + "px";
      span.style.left = (e.clientX - r.left) + "px";
      span.style.top = (e.clientY - r.top) + "px";
      host.appendChild(span);
      setTimeout(function () { span.remove(); }, 700);
    }, { passive: true });

    // expanding ring at the pointer for navigation taps
    document.addEventListener("pointerdown", function (e) {
      var a = e.target.closest && e.target.closest(".nav__link, .menu__link, .link, .footer__l a, .acts-rail button");
      if (!a) return;
      var p = document.createElement("span");
      p.className = "pulse";
      p.style.left = e.clientX + "px";
      p.style.top = e.clientY + "px";
      document.body.appendChild(p);
      setTimeout(function () { p.remove(); }, 800);
    }, { passive: true });
  }

  /* ------------------------------------------------------------ parallax */
  function parallax() {
    var els = $$("[data-parallax]");
    if (!els.length || reduced) return;
    var tick = false;
    function upd() {
      els.forEach(function (el) {
        var depth = parseFloat(el.dataset.parallax) || 12;
        var host = el.parentElement;
        var r = (host || el).getBoundingClientRect();
        if (r.bottom < -200 || r.top > innerHeight + 200) return;
        var mid = (r.top + r.height / 2 - innerHeight / 2) / innerHeight;
        el.style.transform = "translate3d(0," + (mid * depth * -1).toFixed(2) + "%, 0) scale(1.14)";
      });
      tick = false;
    }
    addEventListener("scroll", function () { if (!tick) { tick = true; requestAnimationFrame(upd); } }, { passive: true });
    addEventListener("resize", upd);
    upd();
  }

  /* ------------------------------------------ blueprint: scroll-drawn SVG */
  function blueprint() {
    var root = $("[data-blueprint]");
    if (!root) return;
    var paths = $$("[data-scroll-draw]", root);
    var nodes = $$(".bp-node", root);

    paths.forEach(function (p) {
      var len = 1000;
      try { len = Math.ceil(p.getTotalLength()) + 2; } catch (err) {}
      p.style.setProperty("--len", len);
      p.style.strokeDasharray = len;
      p.style.strokeDashoffset = reduced ? 0 : len;
      p._len = len;
    });

    if (reduced) { nodes.forEach(function (n) { n.classList.add("is-lit"); }); return; }

    // The sequence must read as finished the moment the diagram sits centred.
    // Paths are staggered across SPAN and each takes the remainder, so the
    // last one lands exactly on p === 1 rather than trailing past it.
    var SPAN = 0.82;

    var tick = false;
    function upd() {
      var r = root.getBoundingClientRect();
      // 0 while the diagram is still rising into view, 1 with it centred.
      // The old divisor was the diagram's own height plus a slice of the
      // viewport, which put completion a full height above centre — the
      // taller the diagram, the further past it you had already scrolled.
      var enter = innerHeight * 0.95;          // top edge just inside the fold
      var mid = (innerHeight - r.height) / 2;  // top edge with the diagram centred
      var p = clamp((enter - r.top) / Math.max(enter - mid, 1), 0, 1);
      var n = paths.length;
      paths.forEach(function (path, i) {
        var start = i / n * SPAN;
        var local = clamp((p - start) / (SPAN / n + (1 - SPAN)), 0, 1);
        path.style.strokeDashoffset = (path._len * (1 - local)).toFixed(1);
      });
      nodes.forEach(function (node, i) {
        // Divide by the last index, not the count, so the final node actually
        // reaches the end of its range: the joints light as the structure
        // closes, and the last pop settles just as the diagram hits centre.
        var at = 0.22 + (i / Math.max(nodes.length - 1, 1)) * 0.63;
        node.classList.toggle("is-lit", p > at);
      });
      tick = false;
    }
    addEventListener("scroll", function () { if (!tick) { tick = true; requestAnimationFrame(upd); } }, { passive: true });
    addEventListener("resize", upd);
    upd();
  }

  /* ------------------------------------------------------------- mailform */
  function mailform() {
    var f = $("[data-mailform]");
    if (!f) return;
    var status = $("[data-form-status]", f),
        btn = f.querySelector('button[type="submit"]'),
        to = f.dataset.mailform;

    function say(msg) { if (status) status.textContent = msg; }

    function mailtoFallback(d) {
      var lines = [];
      d.forEach(function (v, k) {
        if (k === "email_address_check" || k === "locale") return;
        if (String(v).trim()) lines.push(k.charAt(0).toUpperCase() + k.slice(1).toLowerCase() + ": " + v);
      });
      lines.push("", "Sent from drmorgan.ai");
      var org = (d.get("COMPANY") || "").toString().trim(),
          interest = (d.get("INTEREST") || "").toString().trim();
      location.href = "mailto:" + to +
        "?subject=" + encodeURIComponent("Strategic Inquiry" + (interest ? " " + interest : "") + (org ? " " + org : "")) +
        "&body=" + encodeURIComponent(lines.join("\n"));
      say("Opening your mail client. If nothing happens, write to " + to + ".");
    }

    f.addEventListener("submit", function (e) {
      if (!f.checkValidity()) return;
      e.preventDefault();

      var trap = f.querySelector('[name="email_address_check"]');
      if (trap && trap.value) return;                    // bot

      var d = new FormData(f);

      if (!API_BASE) return mailtoFallback(d);           // proxy not deployed yet

      var payload = {};
      d.forEach(function (v, k) { payload[k] = v; });

      if (btn) btn.disabled = true;
      say("Sending...");

      fetch(API_BASE + "/inquiry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
        .then(function () {
          f.reset();
          $$(".field--sel > select", f).forEach(function (sel) {
            sel.dispatchEvent(new Event("change", { bubbles: true }));
          });
          say("Received. You will hear back personally.");
        })
        .catch(function () { mailtoFallback(d); })       // never lose an enquiry
        .then(function () { if (btn) btn.disabled = false; });
    });
  }

  /* ------------------------------------------------------- monogram draw */
  function monogram() {
    $$("[data-draw]").forEach(function (p) {
      if (typeof p.getTotalLength !== "function") return;
      try {
        var len = Math.ceil(p.getTotalLength()) + 2;
        p.style.setProperty("--len", len);
      } catch (err) { /* non-path node */ }
    });
  }


  /* ---------------------------------------------------------------- assistant
     Retrieval over a build-time index of every section on the site.
     Set ASSISTANT_ENDPOINT to a server you control to upgrade this to a
     generative answer; the API key must never live in this file.
     ------------------------------------------------------------------------ */
  // Set to the deployed Worker URL (see server/README.md) to make the contact
  // form and the assistant live. Empty = graceful local fallbacks.
  var API_BASE = "https://drmorgan-api.rwopara.workers.dev";

  function assistant() {
    var root = $("[data-ask]");
    if (!root) return;

    var btn = $("[data-ask-toggle]", root),
        panel = $("[data-ask-panel]", root),
        body = $("[data-ask-body]", root),
        form = $("[data-ask-form]", root),
        input = $("[data-ask-input]", root),
        closeBtn = $("[data-ask-close]", root);

    var docs = null, idf = null, facts = null, loading = false;
    var STOP = ("a an and are as at be but by for from has have he her his i in into is it its of on or that the " +
      "their them there to was were what when where which who why will with this these those you your we our us " +
      "not no do does did can could would should about me my more most such").split(" ");
    var STOPSET = {};
    STOP.forEach(function (w) { STOPSET[w] = 1; });

    // intent words people actually type -> vocabulary the site actually uses
    var SYN = {
      contact: ["engage", "inquiry", "conversation"], touch: ["engage", "inquiry", "conversation"],
      reach: ["engage", "inquiry"], email: ["engage", "inquiry"], hire: ["engage", "advisory"],
      book: ["speaking", "forums", "engage"], booking: ["speaking", "forums"],
      speak: ["speaking", "forums", "keynote"], speaker: ["speaking", "forums"],
      keynote: ["forums", "speaking"], talk: ["forums", "speaking"],
      cost: ["engagement", "advisory"], price: ["engagement", "advisory"], fee: ["engagement", "advisory"],
      who: ["profile", "philosophy"], bio: ["profile", "quest"], background: ["profile", "credentials", "record"],
      credentials: ["record", "profile"], experience: ["record", "board", "governance"],
      qualifications: ["record", "credentials"], board: ["record", "governance", "continuity"],
      services: ["advisory", "engagement", "domains"], offer: ["advisory", "engagement", "domains"],
      help: ["advisory", "engagement"], work: ["advisory", "architecture", "domains"],
      books: ["codex", "publications", "research"], research: ["codex", "publications"],
      writing: ["insights", "essays"], blog: ["insights", "essays"], articles: ["insights", "essays"],
      approach: ["methodology", "architecture"], process: ["methodology"], method: ["methodology"],
      government: ["national", "civic", "public"], school: ["academies", "universities"],
      university: ["universities", "academies"], succession: ["continuity", "systems"]
    };

    function terms(str) {
      var base = (str || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
        .filter(function (w) { return w.length > 2 && !STOPSET[w]; });
      return base;
    }

    function queryTerms(str) {
      var base = terms(str), out = base.slice();
      base.forEach(function (w) {
        var syn = SYN[w] || SYN[w.replace(/(s|ing|ed)$/, "")];
        if (syn) out = out.concat(syn);
      });
      return out;
    }

    function load() {
      if (docs || loading) return Promise.resolve();
      loading = true;
      return fetch("assets/data/search.json")
        .then(function (r) { return r.json(); })
        .then(function (d) {
          facts = d.facts || null;
          docs = d.docs.map(function (doc) {
            var tf = {};
            terms(doc.h + " " + doc.h + " " + doc.k + " " + doc.t).forEach(function (w) { tf[w] = (tf[w] || 0) + 1; });
            return { d: doc, tf: tf };
          });
          idf = {};
          docs.forEach(function (x) {
            Object.keys(x.tf).forEach(function (w) { idf[w] = (idf[w] || 0) + 1; });
          });
          Object.keys(idf).forEach(function (w) { idf[w] = Math.log(docs.length / idf[w]) + 1; });
          loading = false;
        })
        .catch(function () { loading = false; });
    }

    function search(q) {
      var qt = queryTerms(q);
      if (!qt.length || !docs) return [];
      return docs.map(function (x) {
        var score = 0;
        qt.forEach(function (w) {
          if (x.tf[w]) score += x.tf[w] * (idf[w] || 1);
          // partial credit for stems, so "advisory" matches "advisor"
          else {
            for (var k in x.tf) {
              if (k.indexOf(w) === 0 || w.indexOf(k) === 0) { score += 0.45 * (idf[k] || 1); break; }
            }
          }
        });
        return { d: x.d, s: score };
      }).filter(function (r) { return r.s > 0.9; })
        .sort(function (a, b) { return b.s - a.s; })
        .slice(0, 4);
    }

    // Every section, best matches at full length and the rest condensed.
    function everything(hits) {
      var top = {};
      hits.forEach(function (h) { top[h.d.p + "#" + h.d.id] = 1; });
      return docs.map(function (x) {
        var d = x.d, key = d.p + "#" + d.id;
        return { h: d.h, p: d.p, id: d.id, k: d.k, t: top[key] ? d.t : d.t.slice(0, 380) };
      });
    }

    function extract(text, q) {
      var qt = queryTerms(q);
      // only real sentences: must end in a full stop and read as prose
      var sentences = text.split(/(?<=[.!?])\s+/).filter(function (sn) {
        return sn.length > 45 && /[.!?]$/.test(sn.trim()) && (sn.match(/\s/g) || []).length > 6;
      });
      if (!sentences.length) return text.slice(0, 190).replace(/\s\S*$/, "") + "...";
      var best = sentences[0], bestScore = -1;
      sentences.forEach(function (sn) {
        var low = sn.toLowerCase(), sc = 0;
        qt.forEach(function (w) { if (low.indexOf(w) > -1) sc++; });
        if (sc > bestScore) { bestScore = sc; best = sn; }
      });
      return best.length > 230 ? best.slice(0, 228).replace(/\s\S*$/, "") + "..." : best;
    }

    var STARTERS = [
      "What does he actually do?",
      "How do engagements work?",
      "What is the Leadership Codex?",
      "What is his background?",
      "How do I get in touch?"
    ];

    var history = [];   // prior turns, so follow-ups make sense

    function el(tag, cls, txt) {
      var n = document.createElement(tag);
      if (cls) n.className = cls;
      if (txt != null) n.textContent = txt;
      return n;
    }

    function bubble(who, text) {
      var turn = el("div", "ask__turn ask__turn--" + who);
      var b = el("div", "ask__bubble");
      if (text != null) b.textContent = text;
      turn.appendChild(b);
      body.appendChild(turn);
      body.scrollTop = body.scrollHeight;
      return b;
    }

    function chips() {
      var wrap = el("div", "ask__chips");
      STARTERS.forEach(function (q) {
        var c = el("button", "ask__chip", q);
        c.type = "button";
        c.addEventListener("click", function () { send(q); });
        wrap.appendChild(c);
      });
      body.appendChild(wrap);
    }

    function greet() {
      body.innerHTML = "";
      body.appendChild(el("p", "ask__intro",
        "Ask me anything about the work: the thinking behind it, how engagements run, or where to start. I will point you to the exact page."));
      chips();
    }

    function sources(hits) {
      if (!hits.length) return;
      body.appendChild(el("p", "ask__label", "Read it on the site"));
      hits.slice(0, 3).forEach(function (h) {
        var a = el("a", "ask__hit");
        a.href = h.d.p + "#" + h.d.id;
        a.appendChild(el("b", null, h.d.h));
        a.appendChild(el("em", null, (h.d.p === "index.html" ? "Home" : h.d.p.replace(".html", "")) + (h.d.k ? " / " + h.d.k : "")));
        body.appendChild(a);
      });
      body.scrollTop = body.scrollHeight;
    }

    var GREET = /^\s*(hi|hey|hello|howdy|yo|sup|hiya|good\s*(morning|afternoon|evening)|greetings|what'?s up)\b[\s!.?]*$/i;
    var THANKS = /^\s*(thanks|thank you|cheers|ta|appreciate it)\b[\s!.?]*$/i;

    function social(q) {
      if (GREET.test(q)) return "Hello. Ask me anything about the work, the methodology, the record, or how to start a conversation.";
      if (THANKS.test(q)) return "Any time. If you would like to take it further, the engagement portal reaches him directly.";
      return null;
    }

    function localAnswer(q, hits, node) {
      var text = social(q) || (hits.length
        ? extract(hits[0].d.t, q)
        : "I do not have that on the site. For anything specific, the engagement portal reaches him directly.");
      node.textContent = text;
      history.push({ role: "assistant", content: text });
      sources(hits);
    }

    function send(q) {
      q = (q || "").trim();
      if (!q || busy) return;
      busy = true;
      input.value = "";                       // clear the box on send

      // drop the greeting/chips once a conversation starts
      var chipRow = $(".ask__chips", body);
      if (chipRow) chipRow.remove();
      var intro = $(".ask__intro", body);
      if (intro) intro.remove();

      bubble("me", q);
      history.push({ role: "user", content: q });

      var node = bubble("bot", null);
      node.innerHTML = '<span class="ask__dots"><i></i><i></i><i></i></span>';

      load().then(function () {
        var hits = search(q);
        var quick = social(q);

        if (quick) { node.textContent = quick; history.push({ role: "assistant", content: quick }); busy = false; return; }
        if (!API_BASE) { node.textContent = ""; localAnswer(q, hits, node); busy = false; return; }

        fetch(API_BASE + "/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            q: q,
            facts: facts,
            context: everything(hits),
            history: history.slice(0, -1)
          })
        }).then(function (r) {
          if (!r.ok || !r.body) throw new Error("upstream");
          var reader = r.body.getReader(), dec = new TextDecoder(), buf = "", out = "";
          node.textContent = "";

          return (function pump() {
            return reader.read().then(function (res) {
              if (res.done) {
                if (!out) throw new Error("empty");
                out = clean(out);
                node.textContent = out;
                history.push({ role: "assistant", content: out });
                sources(hits);
                return;
              }
              buf += dec.decode(res.value, { stream: true });
              var lines = buf.split("\n");
              buf = lines.pop();
              lines.forEach(function (line) {
                if (line.indexOf("data:") !== 0) return;
                var payload = line.slice(5).trim();
                if (!payload || payload === "[DONE]") return;
                try {
                  var tok = JSON.parse(payload).choices[0].delta.content;
                  if (tok) { out += tok; node.textContent = clean(out); body.scrollTop = body.scrollHeight; }
                } catch (err) { /* keep-alive or partial frame */ }
              });
              return pump();
            });
          })();
        })
        .catch(function () {
          node.textContent = "";
          var warn = document.createElement("em");
          warn.style.cssText = "display:block;font-style:normal;opacity:.6;font-size:.78rem;margin-bottom:.45rem";
          warn.textContent = "Could not reach the assistant. Showing what is on the site:";
          node.appendChild(warn);
          var span = document.createElement("span");
          node.appendChild(span);
          var fake = { textContent: "" };
          Object.defineProperty(fake, "textContent", { set: function (v) { span.textContent = v; }, get: function () { return span.textContent; } });
          localAnswer(q, hits, fake);
        })
        .then(function () { busy = false; });
      });
    }

    // The model still reaches for em dashes; the site never uses them.
    function clean(t) {
      return t.replace(/\s*[\u2014\u2013]\s*/g, ", ").replace(/,\s*,/g, ",").replace(/\s+([.,;:!?])/g, "$1");
    }

    var busy = false;

    function open(state) {
      root.classList.toggle("is-open", state);
      btn.setAttribute("aria-expanded", String(state));
      panel.setAttribute("aria-hidden", String(!state));
      if (state) {
        load().then(function () { if (!body.childNodes.length) greet(); });
        setTimeout(function () { input.focus(); }, 380);
      }
    }

    btn.addEventListener("click", function () {
      if (btn.dataset.jump) return;   // scrollState() owns the button right now
      open(!root.classList.contains("is-open"));
    });
    if (closeBtn) closeBtn.addEventListener("click", function () { open(false); });
    addEventListener("keydown", function (e) { if (e.key === "Escape" && root.classList.contains("is-open")) open(false); });
    document.addEventListener("click", function (e) {
      if (root.classList.contains("is-open") && !root.contains(e.target)) open(false);
    });

    form.addEventListener("submit", function (e) { e.preventDefault(); send(input.value); });

    open(false);
  }

  /* ------------------------------------------------------- custom selects
     Replaces the OS dropdown chrome. The native <select> stays in the DOM and
     remains the source of truth, so FormData, submission and no-JS all work.
     Implements the ARIA button + listbox pattern with full keyboard support.
     ---------------------------------------------------------------------- */
  function selects() {
    $$(".field--sel > select").forEach(function (native, n) {
      var field = native.parentElement;
      var label = $("label[for='" + native.id + "']", field) || $("label", field);
      var opts = Array.prototype.slice.call(native.options);
      if (!opts.length) return;

      var listId = (native.id || "sel" + n) + "-list";
      var btnId = (native.id || "sel" + n) + "-btn";
      if (label && !label.id) label.id = (native.id || "sel" + n) + "-label";

      var wrap = document.createElement("div");
      wrap.className = "sel";

      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sel__btn";
      btn.id = btnId;
      btn.setAttribute("aria-haspopup", "listbox");
      btn.setAttribute("aria-expanded", "false");
      btn.setAttribute("aria-controls", listId);
      if (label) btn.setAttribute("aria-labelledby", label.id + " " + btnId);

      var val = document.createElement("span");
      val.className = "sel__value";
      btn.appendChild(val);
      btn.insertAdjacentHTML("beforeend",
        '<svg class="sel__chev" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M2 4.2 6 8.2l4-4"/></svg>');

      var list = document.createElement("ul");
      list.className = "sel__list";
      list.id = listId;
      list.setAttribute("role", "listbox");
      list.setAttribute("tabindex", "-1");
      if (label) list.setAttribute("aria-labelledby", label.id);

      var items = opts.map(function (o, i) {
        var li = document.createElement("li");
        li.className = "sel__opt";
        li.setAttribute("role", "option");
        li.id = listId + "-o" + i;
        li.dataset.value = o.value;
        li.textContent = o.textContent;
        li.setAttribute("aria-selected", String(i === native.selectedIndex));
        list.appendChild(li);
        return li;
      });

      wrap.appendChild(btn);
      wrap.appendChild(list);
      field.appendChild(wrap);
      field.classList.add("is-custom");
      native.setAttribute("tabindex", "-1");
      native.setAttribute("aria-hidden", "true");

      var open = false, active = Math.max(native.selectedIndex, 0);

      function paint() {
        var o = opts[native.selectedIndex] || opts[0];
        val.textContent = o.textContent;
        val.classList.toggle("is-empty", !o.value);
        items.forEach(function (li, i) {
          li.setAttribute("aria-selected", String(i === native.selectedIndex));
          li.classList.toggle("is-active", open && i === active);
        });
        if (open) {
          list.setAttribute("aria-activedescendant", items[active].id);
          var li = items[active], lt = li.offsetTop, lb = lt + li.offsetHeight;
          if (lt < list.scrollTop) list.scrollTop = lt;
          else if (lb > list.scrollTop + list.clientHeight) list.scrollTop = lb - list.clientHeight;
        } else {
          list.removeAttribute("aria-activedescendant");
        }
      }

      function setOpen(state) {
        open = state;
        wrap.classList.toggle("is-open", state);
        btn.setAttribute("aria-expanded", String(state));
        if (state) {
          active = Math.max(native.selectedIndex, 0);
          // flip upward when there is not enough room below
          var r = btn.getBoundingClientRect();
          list.classList.toggle("sel__list--up", innerHeight - r.bottom < 260 && r.top > 260);
        }
        paint();
      }

      function choose(i) {
        native.selectedIndex = i;
        native.dispatchEvent(new Event("change", { bubbles: true }));
        setOpen(false);
        btn.focus();
      }

      btn.addEventListener("click", function (e) { e.stopPropagation(); setOpen(!open); });

      btn.addEventListener("keydown", function (e) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setOpen(true);
          list.focus();
        }
      });

      list.addEventListener("keydown", function (e) {
        var k = e.key;
        if (k === "Escape") { e.preventDefault(); setOpen(false); btn.focus(); return; }
        if (k === "Tab") { setOpen(false); return; }
        if (k === "Enter" || k === " ") { e.preventDefault(); choose(active); return; }
        if (k === "ArrowDown") { e.preventDefault(); active = Math.min(active + 1, items.length - 1); paint(); return; }
        if (k === "ArrowUp") { e.preventDefault(); active = Math.max(active - 1, 0); paint(); return; }
        if (k === "Home") { e.preventDefault(); active = 0; paint(); return; }
        if (k === "End") { e.preventDefault(); active = items.length - 1; paint(); return; }
        if (k.length === 1 && /\S/.test(k)) {
          // type-ahead
          clearTimeout(list._t);
          list._q = (list._q || "") + k.toLowerCase();
          list._t = setTimeout(function () { list._q = ""; }, 600);
          for (var i = 0; i < items.length; i++) {
            if (items[i].textContent.toLowerCase().indexOf(list._q) === 0) { active = i; paint(); break; }
          }
        }
      });

      items.forEach(function (li, i) {
        li.addEventListener("click", function (e) { e.stopPropagation(); choose(i); });
        li.addEventListener("pointerenter", function () { active = i; paint(); });
      });

      if (label) label.addEventListener("click", function (e) { e.preventDefault(); btn.focus(); });

      document.addEventListener("click", function (e) { if (open && !wrap.contains(e.target)) setOpen(false); });
      // keep the custom control in sync if the form is reset or set in code
      native.addEventListener("change", function () { if (!open) paint(); });
      if (native.form) native.form.addEventListener("reset", function () { setTimeout(paint, 0); });

      paint();
    });
  }

  /* ----------------------------------------------- pathway -> form prefill */
  /* A pathway card is an anchor to #inquiry. It also sets the matching option
     on the Area of Interest select, so the form arrives already pointed at
     whatever the visitor clicked. */
  function prefill() {
    var cards = $$("[data-prefill]");
    if (!cards.length) return;

    cards.forEach(function (card) {
      card.addEventListener("click", function () {
        var want = card.getAttribute("data-prefill");
        var sel = document.getElementById(card.getAttribute("data-prefill-field") || "f-interest");
        if (sel && want) {
          var opts = Array.prototype.slice.call(sel.options), hit = -1;
          opts.forEach(function (o, i) {
            if (hit < 0 && o.textContent.trim().toLowerCase() === want.trim().toLowerCase()) hit = i;
          });
          if (hit > -1) {
            sel.selectedIndex = hit;
            // repaints the custom select built over the native one
            sel.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }
        var msg = document.getElementById("f-message");
        if (msg) setTimeout(function () { try { msg.focus({ preventScroll: true }); } catch (e) { msg.focus(); } }, 700);
      });
    });
  }


  /* ----------------------------------------------------------- scroll state
     While the page is moving the header steps back to 30% and the assistant
     button becomes a jump control pointing the way you are already going.
     Both settle back the moment scrolling stops (button after a 2s grace).
     ------------------------------------------------------------------------ */
  function scrollState() {
    var root = document.documentElement;
    var btn = $("[data-ask-toggle]");
    var txt = btn && $("[data-ask-txt]", btn);
    var ask = $("[data-ask]");
    if (!btn || !txt) return;

    var LABEL = txt.textContent;
    var idle = null, revert = null, last = window.scrollY, active = false;

    function jump(mode) {
      if (mode) {
        btn.dataset.jump = mode;
        txt.textContent = mode === "down" ? "To Bottom" : "To Top";
        btn.setAttribute("aria-label", mode === "down" ? "Scroll to bottom" : "Scroll to top");
      } else {
        delete btn.dataset.jump;
        txt.textContent = LABEL;
        btn.removeAttribute("aria-label");
      }
    }

    var hdr = $("[data-header]") || $(".header");

    function dim(on) {
      root.classList.toggle("is-scrolling", on);
      // Set it directly: the header's opacity is also touched elsewhere, and a
      // cascade fight here would be silent and fragile.
      if (hdr && !reduced) hdr.style.opacity = on ? ".3" : "";
    }

    function settle() {
      active = false;
      dim(false);                              // undim at once
    }

    addEventListener("scroll", function () {
      var y = window.scrollY;
      var d = y - last;
      if (Math.abs(d) < 2) return;             // ignore sub-pixel jitter
      last = y;

      if (!active) { active = true; dim(true); }
      clearTimeout(idle);
      idle = setTimeout(settle, 130);          // "paused" = 130ms of quiet

      // the assistant owns its own button while the panel is open
      if (ask && ask.classList.contains("is-open")) return;

      jump(d > 0 ? "down" : "up");
      clearTimeout(revert);
      revert = setTimeout(function () { jump(null); }, 2000);
    }, { passive: true });

    btn.addEventListener("click", function (e) {
      var mode = btn.dataset.jump;
      if (!mode) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      clearTimeout(revert);
      jump(null);
      var doc = document.documentElement;
      window.scrollTo({
        top: mode === "down" ? doc.scrollHeight - innerHeight : 0,
        behavior: reduced ? "auto" : "smooth"
      });
    }, true);   // capture, so it runs before the assistant's own handler
  }

  function year() { $$("[data-year]").forEach(function (e) { e.textContent = new Date().getFullYear(); }); }

  function boot() {
    theme(); bootClear(); monogram(); header(); menu(); curtain(); reveal(); hero(); ribbon(); ambient(); askClearance(); railNav(); glass(); rocket();
    tilt(); magnetic(); statement(); panels(); spine(); counters();
    clicks(); parallax(); blueprint(); heroDepth();
    accordion(); sidenav(); rails(); selects(); prefill(); mailform(); assistant(); scrollState(); year();
  }

  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", boot) : boot();
})();
