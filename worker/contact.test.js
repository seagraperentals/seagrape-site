// Behavioural tests for the Worker's /contact route. Run: node --test worker/
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "./index.js";

const ORIGIN = "https://seagraperentals.com";
const ENV = {
  BREVO_API_KEY: "brevo-test-key",
  TURNSTILE_SECRET: "turnstile-test-secret",
  CONTACT_TO: "inbox@example.org",
  CONTACT_FROM: "sender@example.org",
};
const NAME = "Jordan Rivers";
const EMAIL = "jordan.rivers@example.com";
const MESSAGE = "Hello,\nWe own a villa near Rum Point and would like to talk.";

let calls;
let logs;
let turnstileReply;
let brevoReply;
const realFetch = globalThis.fetch;
const realLog = console.log;

beforeEach(() => {
  calls = [];
  logs = [];
  turnstileReply = () => Response.json({ success: true, hostname: "seagraperentals.com", action: "contact" });
  brevoReply = () => Response.json({ messageId: "<abc@smtp-relay.mailin.fr>" }, { status: 201 });
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
  const secrets = [NAME, EMAIL, "Rum Point", ENV.BREVO_API_KEY, ENV.TURNSTILE_SECRET, ENV.CONTACT_TO, ENV.CONTACT_FROM, "tok-456"];
  for (const line of logs) {
    for (const secret of secrets) {
      assert.ok(!line.includes(secret), `log line leaks "${secret}": ${line}`);
    }
  }
});

function body(overrides = {}) {
  return { name: NAME, email: EMAIL, message: MESSAGE, company: "", turnstileToken: "tok-456", ...overrides };
}

function post(payload, { path = "/contact", origin = ORIGIN, raw } = {}) {
  const headers = { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" };
  if (origin) headers.Origin = origin;
  return new Request("https://seagrape-signup.example.workers.dev" + path, {
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
const sentEmail = () => JSON.parse(brevoCalls()[0].init.body);

/* ---------- Happy path and the Brevo contract ---------- */

test("a valid message is emailed to CONTACT_TO with the visitor as reply-to", async () => {
  const { res, json } = await run(post(body()));
  assert.equal(res.status, 200);
  assert.deepEqual(json, { ok: true });
  assert.equal(brevoCalls().length, 1);
  const call = brevoCalls()[0];
  assert.equal(call.url, "https://api.brevo.com/v3/smtp/email");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers["api-key"], ENV.BREVO_API_KEY);
  const mail = sentEmail();
  assert.deepEqual(mail.to, [{ email: ENV.CONTACT_TO }]);
  assert.equal(mail.sender.email, ENV.CONTACT_FROM);
  assert.deepEqual(mail.replyTo, { email: EMAIL, name: NAME });
  assert.equal(mail.subject, `Website enquiry from ${NAME}`);
  assert.ok(mail.textContent.includes(MESSAGE));
  assert.ok(mail.textContent.includes(EMAIL));
  assert.equal(mail.htmlContent, undefined, "plain text only, so visitor input is never rendered as HTML");
});

test("nothing is ever sent to the visitor's own address", async () => {
  await run(post(body()));
  const mail = sentEmail();
  assert.equal(mail.to.length, 1);
  assert.equal(mail.cc, undefined);
  assert.equal(mail.bcc, undefined);
});

test("a trailing slash on /contact is accepted", async () => {
  const { res } = await run(post(body(), { path: "/contact/" }));
  assert.equal(res.status, 200);
});

test("CONTACT_TO and CONTACT_FROM are trimmed", async () => {
  await run(post(body()), { ...ENV, CONTACT_TO: "  inbox@example.org ", CONTACT_FROM: " sender@example.org" });
  const mail = sentEmail();
  assert.equal(mail.to[0].email, "inbox@example.org");
  assert.equal(mail.sender.email, "sender@example.org");
});

test("the contact route does not need the sign-up list or template ids", async () => {
  const { res } = await run(post(body()), ENV);
  assert.equal(res.status, 200);
});

test("Brevo 201 is the only success", async () => {
  brevoReply = () => Response.json({}, { status: 200 });
  const { res } = await run(post(body()));
  assert.equal(res.status, 502);
});

test("Brevo 400 returns a generic 502 without echoing Brevo's message", async () => {
  brevoReply = () => Response.json({ code: "invalid_parameter", message: "sender not valid" }, { status: 400 });
  const { res, json } = await run(post(body()));
  assert.equal(res.status, 502);
  assert.deepEqual(json, { ok: false, error: "upstream" });
  assert.ok(logs.some((l) => l.includes('"route":"contact"') && l.includes("invalid_parameter")));
});

test("Brevo network failure returns 502", async () => {
  brevoReply = () => { throw new TypeError("network down"); };
  const { res } = await run(post(body()));
  assert.equal(res.status, 502);
});

/* ---------- Routing and shared protections ---------- */

test("an unknown path is refused with 404 and calls nothing", async () => {
  const { res, json } = await run(post(body(), { path: "/admin" }));
  assert.equal(res.status, 404);
  assert.deepEqual(json, { ok: false, error: "not_found" });
  assert.equal(calls.length, 0);
});

test("POST to /contact from another origin is refused", async () => {
  const { res } = await run(post(body(), { origin: "https://evil.example" }));
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
});

test("a filled honeypot pretends success and calls nothing", async () => {
  const { res, json } = await run(post(body({ company: "Acme" })));
  assert.equal(res.status, 200);
  assert.deepEqual(json, { ok: true });
  assert.equal(calls.length, 0);
});

test("rate limiter refusal returns 429 before Turnstile", async () => {
  const env = { ...ENV, RATE_LIMITER: { limit: async () => ({ success: false }) } };
  const { res } = await run(post(body()), env);
  assert.equal(res.status, 429);
  assert.equal(calls.length, 0);
});

test("body over 12288 bytes is refused", async () => {
  const { res } = await run(post(null, { raw: JSON.stringify(body({ message: "a".repeat(12300) })) }));
  assert.equal(res.status, 413);
  assert.equal(calls.length, 0);
});

/* ---------- Turnstile ---------- */

test("Turnstile failure returns 403 and Brevo is never called", async () => {
  turnstileReply = () => Response.json({ success: false });
  const { res } = await run(post(body()));
  assert.equal(res.status, 403);
  assert.equal(brevoCalls().length, 0);
});

test("a sign-up token (action register-interest) cannot be reused on /contact", async () => {
  turnstileReply = () => Response.json({ success: true, hostname: "seagraperentals.com", action: "register-interest" });
  const { res } = await run(post(body()));
  assert.equal(res.status, 403);
  assert.equal(brevoCalls().length, 0);
});

test("a contact token (action contact) cannot be reused on the sign-up route", async () => {
  const signup = { audience: "guest", firstName: "Sam", email: "sam@example.com", consent: true, turnstileToken: "tok-456" };
  const env = { ...ENV, BREVO_LIST_ID: "2", BREVO_DOI_TEMPLATE_ID: "7" };
  const { res } = await run(post(signup, { path: "/" }), env);
  assert.equal(res.status, 403);
  assert.equal(brevoCalls().length, 0);
});

test("Turnstile receives the secret, the token and the visitor IP", async () => {
  await run(post(body()));
  const form = turnstileCalls()[0].init.body;
  assert.equal(form.get("secret"), ENV.TURNSTILE_SECRET);
  assert.equal(form.get("response"), "tok-456");
  assert.equal(form.get("remoteip"), "203.0.113.9");
});

/* ---------- Configuration ---------- */

for (const [label, env] of [
  ["CONTACT_TO missing", { ...ENV, CONTACT_TO: undefined }],
  ["CONTACT_FROM missing", { ...ENV, CONTACT_FROM: undefined }],
  ["CONTACT_TO not an address", { ...ENV, CONTACT_TO: "inbox" }],
  ["BREVO_API_KEY missing", { ...ENV, BREVO_API_KEY: undefined }],
  ["TURNSTILE_SECRET missing", { ...ENV, TURNSTILE_SECRET: undefined }],
]) {
  test(`${label} returns 503 and calls nothing`, async () => {
    const { res, json } = await run(post(body()), env);
    assert.equal(res.status, 503);
    assert.deepEqual(json, { ok: false, error: "unavailable" });
    assert.equal(calls.length, 0);
  });
}

/* ---------- Input validation ---------- */

for (const [label, overrides] of [
  ["missing name", { name: undefined }],
  ["blank name", { name: "   " }],
  ["name over 80 characters", { name: "n".repeat(81) }],
  ["invalid email", { email: "not-an-email" }],
  ["missing message", { message: undefined }],
  ["whitespace-only message", { message: " \n\t " }],
  ["message over 2000 characters", { message: "m".repeat(2001) }],
  ["message that is not a string", { message: ["hi"] }],
  ["missing Turnstile token", { turnstileToken: "" }],
]) {
  test(`invalid input is refused before any upstream call: ${label}`, async () => {
    const { res, json } = await run(post(body(overrides)));
    assert.equal(res.status, 400);
    assert.deepEqual(json, { ok: false, error: "invalid" });
    assert.equal(calls.length, 0);
  });
}

test("a message of exactly 2000 characters is accepted, including multi-byte text", async () => {
  const { res } = await run(post(body({ message: "é".repeat(2000) })));
  assert.equal(res.status, 200);
});

test("line breaks are kept, CRLF is normalised and other control characters are stripped", async () => {
  await run(post(body({ message: "Line one\r\nLine two\u0007 \tindented\rLine three" })));
  assert.ok(sentEmail().textContent.includes("Line one\nLine two\tindented\nLine three"));
});

test("control characters in the name cannot inject extra headers into the subject", async () => {
  await run(post(body({ name: "Eve\r\nBcc: victim@example.net" })));
  const mail = sentEmail();
  assert.ok(!/[\r\n]/.test(mail.subject));
  assert.ok(!/[\r\n]/.test(mail.replyTo.name));
  assert.equal(mail.bcc, undefined);
});
