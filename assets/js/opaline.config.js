/* drmorgan.ai | Wopara Opaline, the one file that changes per site
   =====================================================================
   Loaded BEFORE opaline-overlay.js, after the site's own scripts.

   Everything here has a working default; what is filled in is only what
   this site knows better than a guess. Three fields carry most of the
   weight: `blocks`, which is written in drmorgan's own classes so that
   what Dr. Morgan adds is indistinguishable from what the site already
   has; `screens`, copied out of assets/css/site.css so that "make this
   smaller on phones" writes a media query that agrees with the one it is
   overriding; and `palette`, which names the site's custom properties
   rather than their resolved colours, so a choice still reads correctly
   when the page is switched to dark.
   ===================================================================== */

window.OpalineConfig = {

  /* --- where it keeps things -------------------------------------- */

  /* The site's own Cloud Function. The site is served from GitHub Pages
     and this is a different origin, which is expected and handled: the
     function checks Origin against its own ORIGINS list. */
  endpoint: "https://us-central1-drmorgan-site.cloudfunctions.net/opaline",

  site: null,

  /* --- the way in --------------------------------------------------- */

  door: {
    /* Beside "Website by Wopara Group", but as its own item in the footer's
       bottom row rather than inside that paragraph. Appended into the <p> it
       inherited the last flex item's width, which is only as wide as the
       credit itself: the door broke across three lines and its last word ran
       straight into "Wopara Group". As a sibling it takes the row's own gap.
       Quiet either way, and nowhere a visitor is looking. */
    into: ".footer__bottom",
    label: "",                   // empty: the mark stands in for the name
    editingLabel: "Stop editing",
    hotkey: "e",                 // Ctrl/Cmd + Shift + E
    urlFlag: "opaline"           // ?opaline opens the password box
  },

  /* --- the site ----------------------------------------------------- */

  /* Listed rather than read off the navigation, because privacy and terms
     are only linked from the footer's legal line and 404 should never be
     offered as somewhere to move a block to. */
  pages: [
    "index.html",
    "about.html",
    "services.html",
    "methodology.html",
    "insights.html",
    "codex.html",
    "store.html",
    "engage.html",
    "privacy.html",
    "terms.html"
  ],

  /* Renaming and hiding reach every copy of a link at once; adding puts a
     new one here. The mobile menu is left out on purpose — its items are
     numbered and staggered (.menu__num, --i) and a plain link appended to
     it would be the one thing on the page that looked wrong. */
  chrome: {
    headerLinks: "header .nav",
    menuLinks: "",
    footerLinks: ".footer__l"
  },

  /* The two breakpoints the layout actually turns on: 980px is where the
     split grids and the footer collapse, 620px is where the footer goes
     to two columns and the phone layout proper begins. */
  screens: {
    tablet: "(max-width: 980px)",
    phone: "(max-width: 620px)"
  },

  /* --- look and feel ------------------------------------------------ */

  /* Named, not resolved. :root[data-theme="dark"] redefines every one of
     these, so a colour chosen here follows the page into dark mode; a hex
     taken off the rendered page could not. The contextual tokens
     (--accent, --fg, --bg) are deliberately left out: they mean something
     different inside every surface, which is right for the stylesheet and
     bewildering in a colour picker. */
  palette: [
    "var(--graphite)",
    "var(--graphite-2)",
    "var(--bone)",
    "var(--bone-dim)",
    "var(--blue)",
    "var(--blue-lit)",
    "var(--blue-deep)",
    "var(--gold)",
    "var(--gold-lit)",
    "var(--gold-deep)",
    "var(--clay)",
    "var(--clay-lit)",
    "var(--ink)",
    "var(--ink-2)",
    "var(--paper)",
    "var(--paper-2)",
    "var(--paper-3)"
  ],

  fonts: [
    { label: "Fraunces — the display face", value: "var(--font-display)" },
    { label: "Instrument Sans — body", value: "var(--font-sans)" },
    { label: "Spline Sans Mono — labels", value: "var(--font-mono)" },
    { label: "Caveat — the hand, used for kickers", value: "var(--font-hand)" }
  ],

  /* --- what she can add --------------------------------------------- */

  /* drmorgan's own patterns, reduced to their bones.

     NOTHING HERE CARRIES data-reveal, and nothing carries .reveal-img,
     .frame, .strike, .uline, .mk, .dialstat, .balance, .buildstory,
     .archband or .connector. assets/js/site.js collects all of those
     once, at load, and hands them to an IntersectionObserver; anything
     that appears afterwards is never observed, and [data-reveal] starts
     at opacity 0. A block carrying one would be added and stay invisible
     forever. Blocks arrive already visible instead, which is also what
     she wants while placing them.

     Pictures point at files this site really has. */
  blocks: [

    /* ---- Sections ---- */

    {
      group: "Sections", name: "Words on paper",
      hint: "A kicker, a heading and an opening line, on the light ground",
      html:
        '<section class="section surface-paper">' +
          '<div class="shell"><div class="stack">' +
            '<p class="kicker">The heading above</p>' +
            '<h2 class="giant">A new heading, with <span class="em">a phrase set apart</span></h2>' +
            '<p class="lede">The opening line. Two sentences is usually right here — enough to say what the section is for, not so much that it competes with the heading.</p>' +
          '</div></div>' +
        '</section>'
    },
    {
      group: "Sections", name: "Words on ink",
      hint: "The same, on one of the dark plates",
      html:
        '<section class="section surface-ink">' +
          '<div class="shell"><div class="stack">' +
            '<p class="kicker">The heading above</p>' +
            '<h2 class="giant">A new heading, with <span class="em">a phrase set apart</span></h2>' +
            '<p class="lede">The opening line. Dark sections read as punctuation between the light ones, so they work best when they are not next to each other.</p>' +
          '</div></div>' +
        '</section>'
    },
    {
      group: "Sections", name: "Words beside a picture",
      hint: "Two columns: words on the left, a picture on the right",
      html:
        '<section class="section surface-paper-2">' +
          '<div class="shell split" style="align-items:center">' +
            '<div class="stack">' +
              '<p class="kicker">The heading above</p>' +
              '<h2 class="big">A heading for this half</h2>' +
              '<p class="lede">The words that sit beside the picture. Click the picture to put your own in its place.</p>' +
            '</div>' +
            '<div><img src="photos.jpg" alt="Describe this picture" width="800" height="1000" loading="lazy" decoding="async" style="width:100%;border-radius:var(--r-lg)"></div>' +
          '</div>' +
        '</section>'
    },
    {
      group: "Sections", name: "A closing call",
      hint: "The centred band with two buttons that ends most pages",
      html:
        '<section class="phero phero--closing" style="min-height:auto;padding-block:clamp(6rem,12vw,10rem);align-items:center;text-align:center">' +
          '<div class="shell" style="display:grid;justify-items:center;gap:1.5rem;position:relative">' +
            '<h2 class="giant">A closing line, and <span class="em">what to do next</span></h2>' +
            '<p class="lede" style="max-width:52ch;text-align:center">One sentence saying what happens if they get in touch.</p>' +
            '<div class="phero__cta">' +
              '<a class="btn" href="engage.html">Initiate Engagement</a>' +
              '<a class="btn btn--ghost" href="services.html">Explore the Work</a>' +
            '</div>' +
          '</div>' +
        '</section>'
    },

    /* ---- Rows ---- */

    {
      group: "Rows", name: "Three cards",
      hint: "Picture cards that lead somewhere, side by side",
      html:
        '<section class="section surface-ink-2">' +
          '<div class="shell">' +
            '<div class="duo" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,17rem),1fr))">' +
              '<a class="feature" href="services.html" style="min-height:clamp(18rem,25vw,22rem)"><img src="assets/video/premise-poster.jpg" alt="Describe this picture" width="800" height="640" loading="lazy" decoding="async"><p class="kicker kicker--bare">01</p><h3 class="small feature__t">The first card</h3><p class="feature__x">A line about what this one is.</p><span class="feature__go"><i></i>Where it leads</span></a>' +
              '<a class="feature" href="services.html" style="min-height:clamp(18rem,25vw,22rem)"><img src="assets/video/premise-poster.jpg" alt="Describe this picture" width="800" height="640" loading="lazy" decoding="async"><p class="kicker kicker--bare">02</p><h3 class="small feature__t">The second card</h3><p class="feature__x">A line about what this one is.</p><span class="feature__go"><i></i>Where it leads</span></a>' +
              '<a class="feature" href="services.html" style="min-height:clamp(18rem,25vw,22rem)"><img src="assets/video/premise-poster.jpg" alt="Describe this picture" width="800" height="640" loading="lazy" decoding="async"><p class="kicker kicker--bare">03</p><h3 class="small feature__t">The third card</h3><p class="feature__x">A line about what this one is.</p><span class="feature__go"><i></i>Where it leads</span></a>' +
            '</div>' +
          '</div>' +
        '</section>'
    },
    {
      group: "Rows", name: "Two columns of words",
      hint: "A heading on the left, the argument on the right",
      html:
        '<section class="section surface-paper">' +
          '<div class="shell split" style="align-items:start">' +
            '<div class="stack">' +
              '<p class="kicker">The heading above</p>' +
              '<h2 class="big">The claim, on the left</h2>' +
            '</div>' +
            '<div class="stack">' +
              '<p class="lede">The first part of the argument.</p>' +
              '<p class="lede">The second part. Two or three of these is the usual shape.</p>' +
            '</div>' +
          '</div>' +
        '</section>'
    },
    {
      group: "Rows", name: "A row of labels",
      hint: "Short phrases in the site's small outlined chips",
      html:
        '<div class="chips">' +
          '<span class="chip">The first label</span>' +
          '<span class="chip">The second label</span>' +
          '<span class="chip">The third label</span>' +
        '</div>'
    },
    {
      group: "Rows", name: "A ticked list",
      hint: "Points in two columns, each with the site's rule mark",
      html:
        '<ul class="ticks ticks--2">' +
          '<li>The first point</li>' +
          '<li>The second point</li>' +
          '<li>The third point</li>' +
          '<li>The fourth point</li>' +
        '</ul>'
    },

    {
      group: "Rows", name: "A title for sale",
      hint: "A cover beside its description, for the Store page",
      /* The same shape as the book already on store.html, so a second title
         sits beside the first as though it had always been there.

         Its id is a placeholder. Opaline can change the words and the cover
         but not data-product, and a title cannot be sold until its price and
         its Wopara licence exist on the server anyway — so a new one shows
         "not on sale yet" under the button until that has been done, which is
         the truth rather than a button that takes money and delivers nothing. */
      html:
        '<article class="split split--wide" style="align-items:start" data-product="new-title">' +
          '<div><img src="assets/img/book-codex.svg" alt="Cover of the new title" width="800" height="1200" loading="lazy" decoding="async" style="width:100%;max-width:22rem;border-radius:var(--r-md);box-shadow:0 40px 80px -50px rgba(27,37,48,.6)"></div>' +
          '<div class="stack">' +
            '<p class="kicker kicker--bare">Book two</p>' +
            '<h3 class="mid">The title of the new work</h3>' +
            '<p class="lede">What it is and who it is for. Two paragraphs is the shape the first one uses.</p>' +
            '<ul class="ticks ticks--2"><li>The first thing in it</li><li>The second thing in it</li></ul>' +
            '<p style="display:flex;flex-wrap:wrap;align-items:baseline;gap:.9rem">' +
              '<span class="mid" data-price="new-title">&mdash;</span>' +
              '<span class="note">one payment &#183; yours to keep &#183; opens in your Wopara desktop</span>' +
            '</p>' +
            '<div><button class="btn" type="button" data-buy="new-title">Buy the book</button></div>' +
            '<p class="note" data-store-note style="max-width:44ch"></p>' +
          '</div>' +
        '</article>'
    },

    /* ---- Single things ---- */

    {
      group: "Single things", name: "A heading",
      hint: "One line, at the middle size",
      html: '<h2 class="big">A new heading</h2>'
    },
    {
      group: "Single things", name: "A paragraph",
      hint: "One paragraph at the reading size",
      html: '<p class="lede">A new paragraph. Click it to type your own words.</p>'
    },
    {
      group: "Single things", name: "A quotation",
      hint: "Set in the display face, with a rule down its left side",
      html:
        '<blockquote class="mid" style="border-left:2px solid var(--gold);padding-left:1.5rem;font-family:var(--font-display);font-style:italic">' +
          'The words being quoted.' +
        '</blockquote>'
    },
    {
      group: "Single things", name: "A picture",
      hint: "One picture with a line underneath it",
      html:
        '<figure style="margin:0;display:grid;gap:.75rem">' +
          '<img src="assets/video/premise-poster.jpg" alt="Describe this picture" width="1600" height="900" loading="lazy" decoding="async" style="width:100%;border-radius:var(--r-lg)">' +
          '<figcaption class="note">What this picture shows.</figcaption>' +
        '</figure>'
    },
    {
      group: "Single things", name: "Two buttons",
      hint: "The filled one and the outlined one, side by side",
      html:
        '<div class="phero__cta">' +
          '<a class="btn" href="engage.html">The main thing to do</a>' +
          '<a class="btn btn--ghost" href="services.html">The other thing</a>' +
        '</div>'
    }
  ],

  /* Controls, not content: pressing them has to keep working while she
     edits, and she has no reason to restyle them. The theme toggles and
     the burger matter most — colours resolve differently in light and
     dark, so she needs to switch; and on a phone the burger is the only
     way to reach the menu whose wording she may want to change. The hero
     on the front page is a machine with its own buttons, and all of them
     belong here for the same reason.

     Added to Opaline's own list, never replacing it. */
  controls:
    "[data-burger], [data-menu-close], [data-menu-ask], .menu__act, " +
    ".themetoggle, [data-ask-toggle], [data-ask-close], [data-ask-scrim], [data-ask-form], " +
    "[data-curtain], [data-progress], " +
    "[data-goto], [data-prev], [data-next], [data-hold], [data-dial-run], [data-rail-next]",

  /* --- pages she makes ---------------------------------------------- */

  /* Off. Pages created in the editor live at /p/<name> and need the host
     to send that path to a single template. GitHub Pages has no rewrites,
     so there is nowhere for such a page to be served from, and page
     creation is hidden rather than offered and broken.

     If this site ever moves behind the Cloudflare Worker that already
     serves its API, add a route for /p/* returning opaline-page.html and
     set this back to "/p/". */
  newPagePath: null,

  /* --- extras -------------------------------------------------------- */

  /* Nothing on this site is rendered from a data file — every page is
     markup — so there are no figures to wire in and the panel stays
     hidden. */
  data: null,

  brand: {
    name: "Opaline",
    logo: "assets/img/wopara.png"
  }
};
