/**
 * Seagrape Rentals — website forms Worker (Cloudflare Workers, ES module).
 *
 *   POST /         register interest ──▶ Turnstile siteverify ──▶ Brevo double opt-in
 *   POST /contact  contact form      ──▶ Turnstile siteverify ──▶ Brevo transactional email
 *
 * The contact form only ever emails CONTACT_TO, with the visitor as reply-to, and
 * sends nothing back to the visitor, so it cannot be used to relay mail to others.
 * Neither address appears in this file: the source is public.
 *
 * Settings (Cloudflare dashboard → Worker → Settings → Variables and Secrets):
 *   BREVO_API_KEY          Secret  Brevo key used only by this Worker
 *   TURNSTILE_SECRET       Secret  Turnstile widget secret key
 *   BREVO_LIST_ID          Text    numeric id of the "Coming soon" list
 *   BREVO_DOI_TEMPLATE_ID  Text    numeric id of the double-opt-in template
 *   ALLOWED_ORIGINS        Text    optional, comma-separated; defaults below
 *   REDIRECT_URL           Text    optional; page shown after the user confirms
 *   CONTACT_TO             Text    inbox that receives contact-form messages
 *   CONTACT_FROM           Text    Brevo-verified sender address for those messages
 *   RATE_LIMITER           Binding optional Rate Limiting binding, keyed per IP
 *
 * Privacy: never log names, email addresses, tokens or upstream error text.
 */

const DEFAULT_ORIGINS = ["https://seagraperentals.com", "https://www.seagraperentals.com"];
const DEFAULT_REDIRECT = "https://seagraperentals.com/confirmed.html";
const TURNSTILE_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const BREVO_DOI_URL = "https://api.brevo.com/v3/contacts/doubleOptinConfirmation";
const BREVO_EMAIL_URL = "https://api.brevo.com/v3/smtp/email";
const ROUTES = {
  "/": { action: "register-interest", maxBytes: 4096 },
  "/contact": { action: "contact", maxBytes: 12288 },
};
const MAX_MESSAGE_CHARS = 2000;
const UPSTREAM_TIMEOUT_MS = 8000;

const AUDIENCES = ["guest", "owner"];
const AREAS = [
  "Seven Mile Beach",
  "West Bay",
  "George Town / South Sound",
  "Rum Point / North Side",
  "East End / Bodden Town",
  "Cayman Brac / Little Cayman",
  "Other",
];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// C0/C1 control characters and the line/paragraph separators.
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;
// The same, but keeping tab and newline for multi-line messages.
const MESSAGE_CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029]/g;

export default {
  async fetch(request, env) {
    const origins = allowedOrigins(env);
    const origin = request.headers.get("Origin") || "";
    const originOk = origins.includes(origin);
    const cors = originOk ? corsHeaders(origin) : {};

    if (request.method === "OPTIONS") {
      return originOk ? new Response(null, { status: 204, headers: cors }) : reply(403, "origin", {});
    }
    if (request.method !== "POST") return reply(405, "method", cors, { Allow: "POST, OPTIONS" });
    if (!originOk) return reply(403, "origin", {});

    const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
    const route = Object.prototype.hasOwnProperty.call(ROUTES, path) ? ROUTES[path] : null;
    if (!route) return reply(404, "not_found", cors);

    const contentType = (request.headers.get("Content-Type") || "").toLowerCase();
    if (!contentType.startsWith("application/json")) return reply(415, "content_type", cors);

    const declared = Number(request.headers.get("Content-Length") || "0");
    if (declared > route.maxBytes) return reply(413, "too_large", cors);
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > route.maxBytes) return reply(413, "too_large", cors);

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return reply(400, "invalid", cors);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return reply(400, "invalid", cors);

    // Honeypot: bots fill the hidden "company" field. Pretend success, do nothing.
    if (typeof body.company === "string" && body.company.trim() !== "") {
      log("honeypot");
      return reply(200, null, cors);
    }

    const contact = path === "/contact";
    const input = contact ? validateContact(body) : validate(body);
    if (!input) return reply(400, "invalid", cors);

    const config = contact ? readContactConfig(env) : readConfig(env);
    if (!config) return reply(503, "unavailable", cors);

    const ip = request.headers.get("CF-Connecting-IP") || "";
    if (env.RATE_LIMITER && typeof env.RATE_LIMITER.limit === "function") {
      const { success } = await env.RATE_LIMITER.limit({ key: ip || "unknown" });
      if (!success) {
        log("rate_limited");
        return reply(429, "rate_limited", cors);
      }
    }

    const human = await verifyTurnstile(config.turnstileSecret, input.turnstileToken, ip, hostnamesOf(origins), route.action);
    if (!human) {
      log("turnstile_failed");
      return reply(403, "verification", cors);
    }

    if (contact) {
      const sent = await sendContactEmail(config, input);
      if (!sent.ok) {
        log("brevo_failed", { route: "contact", status: sent.status, code: sent.code });
        return reply(502, "upstream", cors);
      }
      log("contact_sent");
      return reply(200, null, cors);
    }

    const outcome = await createDoiContact(config, input);
    if (!outcome.ok) {
      log("brevo_failed", { status: outcome.status, code: outcome.code });
      return reply(502, "upstream", cors);
    }
    log("registered", { audience: input.audience });
    return reply(200, null, cors);
  },
};

function allowedOrigins(env) {
  if (typeof env.ALLOWED_ORIGINS === "string" && env.ALLOWED_ORIGINS.trim() !== "") {
    return env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return DEFAULT_ORIGINS;
}

function hostnamesOf(origins) {
  return origins.map((o) => {
    try {
      return new URL(o).hostname;
    } catch {
      return "";
    }
  }).filter(Boolean);
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function reply(status, error, cors, extra = {}) {
  const payload = error ? { ok: false, error } : { ok: true };
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...cors,
      ...extra,
    },
  });
}

function clean(value, max) {
  if (typeof value !== "string") return null;
  const s = value.replace(CONTROL_RE, "").trim();
  return s.length >= 1 && s.length <= max ? s : null;
}

function validate(body) {
  if (!AUDIENCES.includes(body.audience)) return null;
  if (body.consent !== true) return null;

  const firstName = clean(body.firstName, 60);
  const email = clean(body.email, 254);
  const turnstileToken = clean(body.turnstileToken, 2048);
  if (!firstName || !email || !turnstileToken) return null;
  if (!EMAIL_RE.test(email)) return null;

  let area = "";
  if (body.audience === "owner" && body.area !== undefined && body.area !== null && body.area !== "") {
    if (!AREAS.includes(body.area)) return null;
    area = body.area;
  }
  return { audience: body.audience, firstName, email: email.toLowerCase(), area, turnstileToken };
}

function validateContact(body) {
  const name = clean(body.name, 80);
  const email = clean(body.email, 254);
  const turnstileToken = clean(body.turnstileToken, 2048);
  if (!name || !email || !turnstileToken) return null;
  if (!EMAIL_RE.test(email)) return null;
  if (typeof body.message !== "string") return null;
  const message = body.message.replace(/\r\n?/g, "\n").replace(MESSAGE_CONTROL_RE, "").trim();
  if (message.length < 1 || message.length > MAX_MESSAGE_CHARS) return null;
  return { name, email, message, turnstileToken };
}

function readContactConfig(env) {
  const missing = [];
  if (!env.BREVO_API_KEY) missing.push("BREVO_API_KEY");
  if (!env.TURNSTILE_SECRET) missing.push("TURNSTILE_SECRET");
  if (!(typeof env.CONTACT_TO === "string" && EMAIL_RE.test(env.CONTACT_TO.trim()))) missing.push("CONTACT_TO");
  if (!(typeof env.CONTACT_FROM === "string" && EMAIL_RE.test(env.CONTACT_FROM.trim()))) missing.push("CONTACT_FROM");
  if (missing.length) {
    log("config_missing", { names: missing });
    return null;
  }
  return {
    brevoKey: env.BREVO_API_KEY,
    turnstileSecret: env.TURNSTILE_SECRET,
    to: env.CONTACT_TO.trim(),
    from: env.CONTACT_FROM.trim(),
  };
}

function readConfig(env) {
  const listId = Number.parseInt(env.BREVO_LIST_ID, 10);
  const templateId = Number.parseInt(env.BREVO_DOI_TEMPLATE_ID, 10);
  const missing = [];
  if (!env.BREVO_API_KEY) missing.push("BREVO_API_KEY");
  if (!env.TURNSTILE_SECRET) missing.push("TURNSTILE_SECRET");
  if (!(listId > 0)) missing.push("BREVO_LIST_ID");
  if (!(templateId > 0)) missing.push("BREVO_DOI_TEMPLATE_ID");
  if (missing.length) {
    log("config_missing", { names: missing });
    return null;
  }
  return {
    brevoKey: env.BREVO_API_KEY,
    turnstileSecret: env.TURNSTILE_SECRET,
    listId,
    templateId,
    redirectUrl: env.REDIRECT_URL || DEFAULT_REDIRECT,
  };
}

async function verifyTurnstile(secret, token, ip, hostnames, action) {
  const form = new URLSearchParams({ secret, response: token });
  if (ip) form.set("remoteip", ip);
  try {
    const res = await fetch(TURNSTILE_URL, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const data = await res.json();
    if (data.success !== true) return false;
    if (!hostnames.includes(data.hostname)) return false;
    if (data.action && data.action !== action) return false;
    return true;
  } catch {
    return false;
  }
}

async function createDoiContact(config, input) {
  const attributes = {
    FIRSTNAME: input.firstName,
    AUDIENCE: input.audience,
    CONSENT_AT: new Date().toISOString(),
  };
  if (input.area) attributes.AREA = input.area;

  try {
    const res = await fetch(BREVO_DOI_URL, {
      method: "POST",
      headers: {
        "api-key": config.brevoKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        email: input.email,
        attributes,
        includeListIds: [config.listId],
        templateId: config.templateId,
        redirectionUrl: config.redirectUrl,
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (res.status === 201 || res.status === 204) return { ok: true };
    let code = "";
    try {
      const err = await res.json();
      code = typeof err.code === "string" ? err.code.slice(0, 40) : "";
    } catch {
      code = "";
    }
    return { ok: false, status: res.status, code };
  } catch (e) {
    return { ok: false, status: 0, code: e && e.name === "TimeoutError" ? "timeout" : "network" };
  }
}

async function sendContactEmail(config, input) {
  try {
    const res = await fetch(BREVO_EMAIL_URL, {
      method: "POST",
      headers: {
        "api-key": config.brevoKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        sender: { name: "Seagrape Rentals website", email: config.from },
        to: [{ email: config.to }],
        replyTo: { email: input.email, name: input.name },
        subject: `Website enquiry from ${input.name}`,
        textContent: `Name: ${input.name}\nEmail: ${input.email}\n\n${input.message}\n\n(Sent from the contact form on seagraperentals.com. Reply to this email to answer.)`,
        tags: ["website-contact"],
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (res.status === 201) return { ok: true };
    let code = "";
    try {
      const err = await res.json();
      code = typeof err.code === "string" ? err.code.slice(0, 40) : "";
    } catch {
      code = "";
    }
    return { ok: false, status: res.status, code };
  } catch (e) {
    return { ok: false, status: 0, code: e && e.name === "TimeoutError" ? "timeout" : "network" };
  }
}

function log(event, fields = {}) {
  console.log(JSON.stringify({ event, ...fields }));
}
