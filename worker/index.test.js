// Behavioural tests for the register-interest Worker. Run: node --test worker/
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "./index.js";

const ORIGIN = "https://seagraperentals.com";
const ENV = {
  BREVO_API_KEY: "brevo-test-key",
  TURNSTILE_SECRET: "turnstile-test-secret",
  BREVO_LIST_ID: "2",
  BREVO_DOI_TEMPLATE_ID: "7",
};
const NAME = "Alexandra";
const EMAIL = "Alex.Owner@Example.com";

let calls;
let logs;
let turnstileReply;
let brevoReply;
const realFetch = globalThis.fetch;
const realLog = console.log;

beforeEach(() => {
  calls = [];
  logs = [];
  turnstileReply = () => Response.json({ success: true, hostname: "seagraperentals.com", action: "register-interest" });
  brevoReply = () => new Response("{}", { status: 201 });
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("turnstile")) return turnstileReply();
    if (String(url).includes("brevo")) return brevoReply();
    throw new Error("unexpected fetch " + url);
  };
  console.log = (...args) => logs.push(args.join(" "));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  for (const line of logs) {
    for (const secret of [NAME, EMAIL, EMAIL.toLowerCase(), ENV.BREVO_API_KEY, ENV.TURNSTILE_SECRET, "tok-123"]) {
      assert.ok(!line.includes(secret), `log line leaks "${secret}": ${line}`);
    }
  }
});

function body(overrides = {}) {
  return {
    audience: "guest",
    firstName: NAME,
    email: EMAIL,
    area: "",
    consent: true,
    company: "",
    turnstileToken: "tok-123",
    ...overrides,
  };
}

function post(payload, { origin = ORIGIN, contentType = "application/json", raw } = {}) {
  const headers = { "Content-Type": contentType, "CF-Connecting-IP": "203.0.113.9" };
  if (origin) headers.Origin = origin;
  return new Request("https://seagrape-signup.example.workers.dev/", {
    method: "POST",
    headers,
    body: raw !== undefined ? raw : JSON.stringify(payload),
  });
}

async function run(req, env = ENV) {
  const res = await worker.fetch(req, env);
  const text = await res.text();
  return { res, json: text ? JSON.parse(text) : null };
}

const brevoCalls = () => calls.filter((c) => c.url.includes("brevo"));
const turnstileCalls = () => calls.filter((c) => c.url.includes("turnstile"));

/* ---------- CORS and method ---------- */

test("preflight from an allowed origin returns 204 with CORS headers", async () => {
  const req = new Request("https://w/", { method: "OPTIONS", headers: { Origin: "https://www.seagraperentals.com" } });
  const res = await worker.fetch(req, ENV);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://www.seagraperentals.com");
  assert.match(res.headers.get("Access-Control-Allow-Methods"), /POST/);
});

test("preflight from another origin is refused without CORS headers", async () => {
  const req = new Request("https://w/", { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
  const res = await worker.fetch(req, ENV);
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
});

test("POST from another origin is refused and calls nothing upstream", async () => {
  const { res, json } = await run(post(body(), { origin: "https://evil.example" }));
  assert.equal(res.status, 403);
  assert.equal(json.ok, false);
  assert.equal(calls.length, 0);
});

test("POST with no Origin header is refused", async () => {
  const { res } = await run(post(body(), { origin: null }));
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
});

test("a lookalike origin (prefix match) is refused", async () => {
  const { res } = await run(post(body(), { origin: "https://seagraperentals.com.evil.example" }));
  assert.equal(res.status, 403);
});

test("GET is not allowed", async () => {
  const res = await worker.fetch(new Request("https://w/", { method: "GET", headers: { Origin: ORIGIN } }), ENV);
  assert.equal(res.status, 405);
});

test("ALLOWED_ORIGINS overrides the default list", async () => {
  const env = { ...ENV, ALLOWED_ORIGINS: "https://staging.example" };
  const { res } = await run(post(body()), env);
  assert.equal(res.status, 403);
});

/* ---------- Request shape ---------- */

test("non-JSON content type is refused", async () => {
  const { res } = await run(post(body(), { contentType: "text/plain" }));
  assert.equal(res.status, 415);
  assert.equal(calls.length, 0);
});

test("body over 4096 bytes is refused; exactly 4096 is accepted", async () => {
  const base = JSON.stringify(body({ firstName: "A" }));
  const pad = (n) => base.replace('"area":""', `"area":"","pad":"${"x".repeat(n)}"`);
  const fill = 4096 - pad(0).length;
  const atLimit = pad(fill);
  assert.equal(new TextEncoder().encode(atLimit).length, 4096);
  const ok = await run(post(null, { raw: atLimit }));
  assert.equal(ok.res.status, 200);
  const over = await run(post(null, { raw: pad(fill + 1) }));
  assert.equal(over.res.status, 413);
});

test("malformed JSON is refused", async () => {
  const { res } = await run(post(null, { raw: "{not json" }));
  assert.equal(res.status, 400);
});

test("a JSON array body is refused", async () => {
  const { res } = await run(post(null, { raw: "[]" }));
  assert.equal(res.status, 400);
});

/* ---------- Honeypot ---------- */

test("a filled honeypot pretends success and calls nothing", async () => {
  const { res, json } = await run(post(body({ company: "Acme Bots" })));
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(calls.length, 0);
});

test("a whitespace-only honeypot is treated as empty", async () => {
  const { res } = await run(post(body({ company: "   " })));
  assert.equal(res.status, 200);
  assert.equal(brevoCalls().length, 1);
});

/* ---------- Validation ---------- */

for (const [label, overrides] of [
  ["unknown audience", { audience: "agent" }],
  ["consent false", { consent: false }],
  ["consent as the string 'true'", { consent: "true" }],
  ["empty first name", { firstName: "   " }],
  ["first name of 61 characters", { firstName: "a".repeat(61) }],
  ["email without a dot in the domain", { email: "sam@nowhere" }],
  ["email with a one-letter TLD", { email: "sam@nowhere.c" }],
  ["email with a space", { email: "sam smith@example.com" }],
  ["email of 255 characters", { email: "a".repeat(243) + "@example.com" }],
  ["missing Turnstile token", { turnstileToken: "" }],
  ["owner with an unknown area", { audience: "owner", area: "Miami" }],
]) {
  test(`invalid input is refused before any upstream call: ${label}`, async () => {
    const { res, json } = await run(post(body(overrides)));
    assert.equal(res.status, 400);
    assert.equal(json.error, "invalid");
    assert.equal(calls.length, 0);
  });
}

test("first name of exactly 60 characters is accepted", async () => {
  const { res } = await run(post(body({ firstName: "a".repeat(60) })));
  assert.equal(res.status, 200);
});

test("email of exactly 254 characters is accepted", async () => {
  const email = "a".repeat(242) + "@example.com";
  assert.equal(email.length, 254);
  const { res } = await run(post(body({ email })));
  assert.equal(res.status, 200);
});

test("control characters are stripped from the first name", async () => {
  await run(post(body({ firstName: "Ann\u0000\u2028e" })));
  const sent = JSON.parse(brevoCalls()[0].init.body);
  assert.equal(sent.attributes.FIRSTNAME, "Anne");
});

/* ---------- Configuration ---------- */

for (const name of ["BREVO_API_KEY", "TURNSTILE_SECRET", "BREVO_LIST_ID", "BREVO_DOI_TEMPLATE_ID"]) {
  test(`missing ${name} returns 503 and calls nothing`, async () => {
    const env = { ...ENV };
    delete env[name];
    const { res } = await run(post(body()), env);
    assert.equal(res.status, 503);
    assert.equal(calls.length, 0);
    assert.ok(logs.some((l) => l.includes(name)), "names the missing setting in the log");
  });
}

test("a non-numeric list id counts as missing", async () => {
  const { res } = await run(post(body()), { ...ENV, BREVO_LIST_ID: "abc" });
  assert.equal(res.status, 503);
});

/* ---------- Rate limiting ---------- */

test("rate limiter refusal returns 429 before Turnstile", async () => {
  const keys = [];
  const env = { ...ENV, RATE_LIMITER: { limit: async ({ key }) => { keys.push(key); return { success: false }; } } };
  const { res } = await run(post(body()), env);
  assert.equal(res.status, 429);
  assert.deepEqual(keys, ["203.0.113.9"]);
  assert.equal(calls.length, 0);
});

test("rate limiter allowance lets the request through", async () => {
  const env = { ...ENV, RATE_LIMITER: { limit: async () => ({ success: true }) } };
  const { res } = await run(post(body()), env);
  assert.equal(res.status, 200);
});

/* ---------- Turnstile ---------- */

test("Turnstile failure returns 403 and Brevo is never called", async () => {
  turnstileReply = () => Response.json({ success: false, "error-codes": ["invalid-input-response"] });
  const { res, json } = await run(post(body()));
  assert.equal(res.status, 403);
  assert.equal(json.error, "verification");
  assert.equal(brevoCalls().length, 0);
});

test("Turnstile success for another hostname is refused", async () => {
  turnstileReply = () => Response.json({ success: true, hostname: "evil.example", action: "register-interest" });
  const { res } = await run(post(body()));
  assert.equal(res.status, 403);
  assert.equal(brevoCalls().length, 0);
});

test("Turnstile success for another action is refused", async () => {
  turnstileReply = () => Response.json({ success: true, hostname: "seagraperentals.com", action: "login" });
  const { res } = await run(post(body()));
  assert.equal(res.status, 403);
});

test("Turnstile HTTP error is refused", async () => {
  turnstileReply = () => new Response("oops", { status: 500 });
  const { res } = await run(post(body()));
  assert.equal(res.status, 403);
});

test("Turnstile network failure is refused", async () => {
  turnstileReply = () => { throw new TypeError("network down"); };
  const { res } = await run(post(body()));
  assert.equal(res.status, 403);
  assert.equal(brevoCalls().length, 0);
});

test("Turnstile receives the secret, the token and the visitor IP", async () => {
  await run(post(body()));
  const sent = new URLSearchParams(turnstileCalls()[0].init.body);
  assert.equal(sent.get("secret"), ENV.TURNSTILE_SECRET);
  assert.equal(sent.get("response"), "tok-123");
  assert.equal(sent.get("remoteip"), "203.0.113.9");
});

/* ---------- Brevo ---------- */

test("guest sign-up calls Brevo's DOI endpoint with the right contract", async () => {
  const { res, json } = await run(post(body()));
  assert.equal(res.status, 200);
  assert.deepEqual(json, { ok: true });
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);

  const [call] = brevoCalls();
  assert.equal(call.url, "https://api.brevo.com/v3/contacts/doubleOptinConfirmation");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers["api-key"], ENV.BREVO_API_KEY);
  const sent = JSON.parse(call.init.body);
  assert.equal(sent.email, EMAIL.toLowerCase());
  assert.deepEqual(sent.includeListIds, [2]);
  assert.equal(sent.templateId, 7);
  assert.equal(sent.redirectionUrl, "https://seagraperentals.com/confirmed.html");
  assert.equal(sent.attributes.FIRSTNAME, NAME);
  assert.equal(sent.attributes.AUDIENCE, "guest");
  assert.ok(!("AREA" in sent.attributes), "guests send no AREA");
  assert.ok(!Number.isNaN(Date.parse(sent.attributes.CONSENT_AT)), "CONSENT_AT is an ISO time");
});

test("owner sign-up sends AUDIENCE owner and the chosen AREA", async () => {
  await run(post(body({ audience: "owner", area: "West Bay" })));
  const sent = JSON.parse(brevoCalls()[0].init.body);
  assert.equal(sent.attributes.AUDIENCE, "owner");
  assert.equal(sent.attributes.AREA, "West Bay");
});

test("an area sent with a guest sign-up is ignored", async () => {
  await run(post(body({ audience: "guest", area: "West Bay" })));
  const sent = JSON.parse(brevoCalls()[0].init.body);
  assert.ok(!("AREA" in sent.attributes));
});

test("REDIRECT_URL overrides the confirmation page", async () => {
  await run(post(body()), { ...ENV, REDIRECT_URL: "https://seagraperentals.com/thanks.html" });
  assert.equal(JSON.parse(brevoCalls()[0].init.body).redirectionUrl, "https://seagraperentals.com/thanks.html");
});

test("Brevo 204 also counts as success", async () => {
  brevoReply = () => new Response(null, { status: 204 });
  const { res } = await run(post(body()));
  assert.equal(res.status, 200);
});

test("Brevo 200 is not treated as the documented success", async () => {
  brevoReply = () => new Response("{}", { status: 200 });
  const { res } = await run(post(body()));
  assert.equal(res.status, 502);
});

test("Brevo 400 returns a generic 502 without echoing Brevo's message", async () => {
  brevoReply = () => Response.json({ code: "invalid_parameter", message: `Invalid email ${EMAIL.toLowerCase()}` }, { status: 400 });
  const { res, json } = await run(post(body()));
  assert.equal(res.status, 502);
  assert.deepEqual(json, { ok: false, error: "upstream" });
  assert.ok(logs.some((l) => l.includes("invalid_parameter")), "logs Brevo's error code");
});

test("Brevo 401 (bad key) returns 502", async () => {
  brevoReply = () => Response.json({ code: "unauthorized", message: "Key not found" }, { status: 401 });
  const { res } = await run(post(body()));
  assert.equal(res.status, 502);
});

test("Brevo network failure returns 502", async () => {
  brevoReply = () => { throw new TypeError("network down"); };
  const { res } = await run(post(body()));
  assert.equal(res.status, 502);
});

test("every response is JSON and never cached", async () => {
  const { res } = await run(post(body()));
  assert.match(res.headers.get("Content-Type"), /application\/json/);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
});
