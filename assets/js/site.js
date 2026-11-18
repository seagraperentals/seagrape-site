/* Seagrape Rentals — register-your-interest form.
 *
 * The page holds no secrets. Live sign-ups POST to a Cloudflare Worker, which
 * verifies Turnstile and calls Brevo with a key stored only in the Worker.
 * Anywhere other than the production hostnames (local preview, mock-up links)
 * the form runs in demo mode and makes no network calls.
 */
(function () {
  "use strict";

  var CONFIG = {
    endpoint: "https://seagrape-signup.seagraperentals.workers.dev",
    turnstileSiteKey: "0x4AAAAAAGHjraIg07_tiO70",
    productionHosts: ["seagraperentals.com", "www.seagraperentals.com"],
    requestTimeoutMs: 15000
  };

  var COPY = {
    guest: { button: "Request early access" },
    owner: { button: "Register as an owner" },
    errors: {
      firstName: "Please enter your first name.",
      email: "Please enter a valid email address.",
      consent: "Please tick the box so we can send you updates.",
      verifying: "Just a moment while we verify your browser, then try again.",
      generic: "Sorry, something went wrong. Please try again in a few minutes."
    }
  };

  var params = new URLSearchParams(window.location.search);
  var LIVE = CONFIG.productionHosts.indexOf(window.location.hostname) !== -1 && !params.has("demo");

  var form = document.getElementById("interest-form");
  if (!form) return;
  var card = document.getElementById("register");
  var formPanel = card.querySelector('[data-state="form"]');
  var successPanel = card.querySelector('[data-state="success"]');
  var button = form.querySelector(".btn");
  var buttonLabel = form.querySelector(".btn-label");
  var status = document.getElementById("form-status");
  var fields = {
    firstName: document.getElementById("f-name"),
    email: document.getElementById("f-email"),
    area: document.getElementById("f-area"),
    consent: document.getElementById("f-consent"),
    company: document.getElementById("f-company")
  };

  var year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());

  /* ---------- Audience toggle ---------- */
  function audience() {
    var checked = form.querySelector('input[name="audience"]:checked');
    return checked ? checked.value : "guest";
  }
  function applyAudience() {
    var a = audience();
    card.querySelectorAll("[data-for]").forEach(function (el) {
      el.hidden = el.getAttribute("data-for") !== a;
    });
    buttonLabel.textContent = COPY[a].button;
    if (a !== "owner") fields.area.value = "";
  }
  form.querySelectorAll('input[name="audience"]').forEach(function (r) {
    r.addEventListener("change", applyAudience);
  });
  applyAudience();

  /* ---------- Validation ---------- */
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  function setError(name, message) {
    var input = fields[name];
    var out = document.getElementById(input.id + "-err");
    if (message) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
    if (out) out.textContent = message || "";
  }

  function validate() {
    var firstError = null;
    var name = fields.firstName.value.trim();
    var email = fields.email.value.trim();
    var checks = [
      ["firstName", name.length > 0 && name.length <= 60, COPY.errors.firstName],
      ["email", EMAIL_RE.test(email) && email.length <= 254, COPY.errors.email],
      ["consent", fields.consent.checked, COPY.errors.consent]
    ];
    checks.forEach(function (c) {
      setError(c[0], c[1] ? "" : c[2]);
      if (!c[1] && !firstError) firstError = fields[c[0]];
    });
    return firstError;
  }

  ["firstName", "email"].forEach(function (n) {
    fields[n].addEventListener("input", function () {
      if (fields[n].getAttribute("aria-invalid") === "true") setError(n, "");
    });
  });
  fields.consent.addEventListener("change", function () {
    if (fields.consent.checked) setError("consent", "");
  });

  /* ---------- Turnstile (live only) ---------- */
  var turnstileWidget = null;
  if (LIVE) {
    window.onSeagrapeTurnstile = function () {
      turnstileWidget = window.turnstile.render("#turnstile", {
        sitekey: CONFIG.turnstileSiteKey,
        theme: "dark",
        appearance: "interaction-only",
        action: "register-interest"
      });
    };
    var s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onSeagrapeTurnstile";
    s.async = true;
    s.defer = true;
    document.head.appendChild(s);
  }
  function turnstileToken() {
    if (!window.turnstile || turnstileWidget === null) return "";
    return window.turnstile.getResponse(turnstileWidget) || "";
  }
  function resetTurnstile() {
    if (window.turnstile && turnstileWidget !== null) window.turnstile.reset(turnstileWidget);
  }

  /* ---------- Submit ---------- */
  function busy(on) {
    button.disabled = on;
    button.setAttribute("aria-busy", on ? "true" : "false");
  }

  function showSuccess(email) {
    successPanel.querySelector(".success-email").textContent = email;
    formPanel.hidden = true;
    successPanel.hidden = false;
    successPanel.focus();
  }

  function send(payload) {
    if (!LIVE) {
      return new Promise(function (resolve) { setTimeout(function () { resolve(true); }, 900); });
    }
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, CONFIG.requestTimeoutMs) : null;
    return fetch(CONFIG.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        return res.ok && body && body.ok === true;
      });
    }).catch(function () {
      return false;
    }).finally(function () {
      if (timer) clearTimeout(timer);
    });
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    status.textContent = "";
    var invalid = validate();
    if (invalid) { invalid.focus(); return; }

    var token = LIVE ? turnstileToken() : "demo";
    if (LIVE && !token) { status.textContent = COPY.errors.verifying; return; }

    var payload = {
      audience: audience(),
      firstName: fields.firstName.value.trim(),
      email: fields.email.value.trim(),
      area: audience() === "owner" ? fields.area.value : "",
      consent: true,
      company: fields.company.value,
      turnstileToken: token
    };

    busy(true);
    send(payload).then(function (ok) {
      busy(false);
      if (ok) {
        showSuccess(payload.email);
      } else {
        status.textContent = COPY.errors.generic;
        resetTurnstile();
      }
    });
  });
})();
