# seagraperentals.com — coming-soon site

Static site served by GitHub Pages, with a register-your-interest form and a contact form.

```
Browser ──POST JSON──▶ Cloudflare Worker (worker/index.js)
                         POST /         ──▶ Turnstile check ──▶ Brevo double opt-in
                         POST /contact  ──▶ Turnstile check ──▶ Brevo transactional email to our inbox
```

No email address appears anywhere on the site or in this repository. Contact-form messages go only to the inbox named in the Worker setting `CONTACT_TO`, with the visitor as reply-to; nothing is sent back to the visitor, so the form cannot relay mail to third parties.

The page holds no secrets. The Brevo API key and the Turnstile secret live only in the Worker's encrypted settings.

## Layout

| Path | What |
|---|---|
| `index.html` | the page |
| `privacy.html` | privacy notice, linked from the consent box |
| `confirmed.html` | where Brevo sends people after they click the confirmation link |
| `contact.html` | contact form |
| `assets/` | CSS, JS, self-hosted fonts (SIL OFL, licences included), images |
| `worker/` | Cloudflare Worker source and its tests |
| `email/doi-template.html` | Brevo double-opt-in email template |
| `CNAME` | custom domain for GitHub Pages |

## Form modes

`assets/js/site.js` drives both forms. It runs **live** only on `seagraperentals.com` and `www.seagraperentals.com`. Everywhere else (local preview, review links) it runs in **demo** mode and makes no network calls. Add `?demo` to a production URL to force demo mode.

## Local preview

```
python3 -m http.server 8000
```
Then open http://localhost:8000/.

## Worker tests

Node 18 or later, no dependencies:
```
cd worker && node --test
```

## Worker settings (Cloudflare dashboard → Worker → Settings → Variables and Secrets)

| Name | Type | Value |
|---|---|---|
| `BREVO_API_KEY` | Secret | Brevo key used only by the Worker |
| `TURNSTILE_SECRET` | Secret | Turnstile widget secret key |
| `BREVO_LIST_ID` | Text | numeric list id |
| `BREVO_DOI_TEMPLATE_ID` | Text | numeric template id |
| `ALLOWED_ORIGINS` | Text | optional, comma-separated |
| `REDIRECT_URL` | Text | optional, defaults to `/confirmed.html` |
| `CONTACT_TO` | Text | inbox that receives contact-form messages |
| `CONTACT_FROM` | Text | Brevo-verified sender for those messages |

The contact route needs `BREVO_API_KEY`, `TURNSTILE_SECRET`, `CONTACT_TO` and `CONTACT_FROM`; it does not need the list or template ids. The Brevo key must be allowed to send transactional email.

Updating the Worker: open it in the dashboard → **Edit code** → paste `worker/index.js` → **Deploy**.

## Image credits

Photographs from [Pexels](https://www.pexels.com/license/) (free to use, no attribution required): photos [9400984](https://www.pexels.com/photo/9400984/) and [6461688](https://www.pexels.com/photo/6461688/). They are illustrative and are not Seagrape properties.
