/* Seagrape Rentals — website forms (register interest, contact).
 *
 * The page holds no secrets. Live submissions POST to a Cloudflare Worker, which
 * verifies Turnstile and calls Brevo with a key stored only in the Worker.
 * Anywhere other than the production hostnames (local preview, mock-up links)
 * the forms run in demo mode and make no network calls.
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
      name: "Please enter your name.",
      email: "Please enter a valid email address.",
      message: "Please write a message (up to 2,000 characters).",
      consent: "Please tick the box so we can send you updates.",
      verifying: "Just a moment while we verify your browser, then try again.",
      generic: "Sorry, something went wrong. Please try again in a few minutes."
    }
  };

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var MAX_MESSAGE = 2000;

  var params = new URLSearchParams(window.location.search);
  var LIVE = CONFIG.productionHosts.indexOf(window.location.hostname) !== -1 && !params.has("demo");

  var year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());

  /* ---------- Shared helpers ---------- */
  function setError(input, message) {
    var out = document.getElementById(input.id + "-err");
    if (message) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
    if (out) out.textContent = message || "";
  }

  function clearOnInput(input) {
    input.addEventListener("input", function () {
      if (input.getAttribute("aria-invalid") === "true") setError(input, "");
    });
  }

  // Runs [input, isValid, message] checks; returns the first invalid input, or null.
  function runChecks(checks) {
    var firstError = null;
    checks.forEach(function (c) {
      setError(c[0], c[1] ? "" : c[2]);
      if (!c[1] && !firstError) firstError = c[0];
    });
    return firstError;
  }

  /* ---------- Turnstile (live only; one widget per page) ---------- */
  var turnstileWidget = null;
  function startTurnstile(action) {
    if (!LIVE) return;
    window.onSeagrapeTurnstile = function () {
      turnstileWidget = window.turnstile.render("#turnstile", {
        sitekey: CONFIG.turnstileSiteKey,
        theme: "dark",
        appearance: "interaction-only",
        action: action
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

  /* ---------- Submission ---------- */
  function send(path, payload) {
    if (!LIVE) {
      return new Promise(function (resolve) { setTimeout(function () { resolve(true); }, 900); });
    }
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, CONFIG.requestTimeoutMs) : null;
    return fetch(CONFIG.endpoint + path, {
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

  // Wires validation, Turnstile and the success panel for one card.
  function wireForm(opts) {
    var form = opts.form;
    var card = opts.card;
    var formPanel = card.querySelector('[data-state="form"]');
    var successPanel = card.querySelector('[data-state="success"]');
    var button = form.querySelector(".btn");
    var status = form.querySelector(".form-status");

    startTurnstile(opts.action);

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      status.textContent = "";
      var invalid = opts.validate();
      if (invalid) { invalid.focus(); return; }

      var token = LIVE ? turnstileToken() : "demo";
      if (LIVE && !token) { status.textContent = COPY.errors.verifying; return; }

      var payload = opts.payload();
      payload.turnstileToken = token;

      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      send(opts.path, payload).then(function (ok) {
        button.disabled = false;
        button.setAttribute("aria-busy", "false");
        if (ok) {
          if (opts.onSuccess) opts.onSuccess(successPanel, payload);
          formPanel.hidden = true;
          successPanel.hidden = false;
          successPanel.focus();
        } else {
          status.textContent = COPY.errors.generic;
          resetTurnstile();
        }
      });
    });
  }

  /* ---------- Register-interest form (home page) ---------- */
  var interestForm = document.getElementById("interest-form");
  if (interestForm) {
    var card = document.getElementById("register");
    var buttonLabel = interestForm.querySelector(".btn-label");
    var f = {
      firstName: document.getElementById("f-name"),
      email: document.getElementById("f-email"),
      area: document.getElementById("f-area"),
      consent: document.getElementById("f-consent"),
      company: document.getElementById("f-company")
    };

    var audience = function () {
      var checked = interestForm.querySelector('input[name="audience"]:checked');
      return checked ? checked.value : "guest";
    };
    var applyAudience = function () {
      var a = audience();
      card.querySelectorAll("[data-for]").forEach(function (el) {
        el.hidden = el.getAttribute("data-for") !== a;
      });
      buttonLabel.textContent = COPY[a].button;
      if (a !== "owner") f.area.value = "";
    };
    interestForm.querySelectorAll('input[name="audience"]').forEach(function (r) {
      r.addEventListener("change", applyAudience);
    });
    applyAudience();

    clearOnInput(f.firstName);
    clearOnInput(f.email);
    f.consent.addEventListener("change", function () {
      if (f.consent.checked) setError(f.consent, "");
    });

    wireForm({
      form: interestForm,
      card: card,
      path: "/",
      action: "register-interest",
      validate: function () {
        var name = f.firstName.value.trim();
        var email = f.email.value.trim();
        return runChecks([
          [f.firstName, name.length > 0 && name.length <= 60, COPY.errors.firstName],
          [f.email, EMAIL_RE.test(email) && email.length <= 254, COPY.errors.email],
          [f.consent, f.consent.checked, COPY.errors.consent]
        ]);
      },
      payload: function () {
        return {
          audience: audience(),
          firstName: f.firstName.value.trim(),
          email: f.email.value.trim(),
          area: audience() === "owner" ? f.area.value : "",
          consent: true,
          company: f.company.value
        };
      },
      onSuccess: function (panel, payload) {
        panel.querySelector(".success-email").textContent = payload.email;
      }
    });
  }

  /* ---------- Contact form (contact page) ---------- */
  var contactForm = document.getElementById("contact-form");
  if (contactForm) {
    var c = {
      name: document.getElementById("c-name"),
      email: document.getElementById("c-email"),
      message: document.getElementById("c-message"),
      company: document.getElementById("c-company")
    };
    var counter = document.getElementById("c-message-count");
    var updateCount = function () {
      if (counter) counter.textContent = c.message.value.length + " / " + MAX_MESSAGE;
    };
    c.message.addEventListener("input", updateCount);
    updateCount();
    clearOnInput(c.name);
    clearOnInput(c.email);
    clearOnInput(c.message);

    wireForm({
      form: contactForm,
      card: document.getElementById("contact"),
      path: "/contact",
      action: "contact",
      validate: function () {
        var name = c.name.value.trim();
        var email = c.email.value.trim();
        var message = c.message.value.trim();
        return runChecks([
          [c.name, name.length > 0 && name.length <= 80, COPY.errors.name],
          [c.email, EMAIL_RE.test(email) && email.length <= 254, COPY.errors.email],
          [c.message, message.length > 0 && message.length <= MAX_MESSAGE, COPY.errors.message]
        ]);
      },
      payload: function () {
        return {
          name: c.name.value.trim(),
          email: c.email.value.trim(),
          message: c.message.value.trim(),
          company: c.company.value
        };
      }
    });
  }
})();
