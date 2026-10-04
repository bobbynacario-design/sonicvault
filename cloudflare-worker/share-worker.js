// SonicVault's public share domain: the share-link previews from share.js
// and nothing else -- no AI routes, no secrets, no bindings. It is kept
// apart from the AI worker so the address printed on a Facebook card can be
// a clean domain without putting the token-guarded AI routes behind it.
//
// Deploy: npx wrangler deploy -c share.wrangler.toml

import { handleShareRoute } from "./share.js";

const DEFAULT_APP_URL = "https://bobbynacario-design.github.io/sonicvault";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" || request.method === "HEAD") {
      if (url.pathname.startsWith("/s/")) return handleShareRoute(request, env, url);
      // The bare domain goes to the app.
      if (url.pathname === "/") {
        return Response.redirect((env.SHARE_APP_URL || DEFAULT_APP_URL).replace(/\/+$/, "") + "/", 302);
      }
    }
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
};
