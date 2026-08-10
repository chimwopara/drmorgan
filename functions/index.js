/* =====================================================================
   drmorgan.ai — Cloud Functions
   ---------------------------------------------------------------------
   Two things live in this project, and they are kept apart on purpose.

     opaline.js   The site editor. Lays what Dr. Morgan changes over the
                  pages, and holds the only password that lets him.
                  Deployed as `opaline` and `opalineNightly`.

     store.js     The store. Holds the prices, talks to Stripe, and is the
                  only thing allowed to tell Wopara who may open what.
                  Deployed as `store` and `storeWebhook`.

   The site itself is not deployed from here — it is served from GitHub
   Pages at drmorgan.ai. These functions are a different origin, which is
   expected: each one checks Origin against the domains listed at the top
   of its own file.

   Secrets, all in Secret Manager and none in this repository:
     EDITOR_PASSWORD        the editor password
     WOPARA_KEY             wpk_…, from Port → Selling
     STRIPE_SECRET_KEY      sk_live_… / sk_test_…
     STRIPE_WEBHOOK_SECRET  whsec_…, from the Stripe dashboard
   ===================================================================== */

Object.assign(exports, require("./opaline"));
Object.assign(exports, require("./store"));
