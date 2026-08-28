# Pun & Post

Pick a dad joke, mail it as a real postcard to someone.

This folder has two parts that deploy separately:

- `frontend/` — the React app people actually see and use
- `backend/` — the server that talks to Stripe (payment) and Lob (printing + mailing)

---

## 1. Try it locally first (recommended before deploying anything)

You'll need [Node.js](https://nodejs.org) installed (the LTS version is fine).

**Backend:**
```
cd backend
npm install
cp .env.example .env
```
Open `.env` and fill in your Stripe test key and Lob test key (see accounts
section below). Then:
```
npm run dev
```
This auto-restarts the server whenever you save a change to `server.js` —
handy while you're actively working on it. (`npm start` also works, for a
one-off run with no auto-restart.) It should print `Server listening on
3001`. Leave this running.

**Frontend**, in a second terminal:
```
cd frontend
npm install
cp .env.example .env
```
Open `.env` and set `VITE_API_BASE=http://localhost:3001`. Then:
```
npm run dev
```
It'll print a `localhost` URL — open that in your browser. Click "Next
joke" a few times; you should see genuinely different jokes each time —
and "Previous joke" should take you back through ones you've already
seen, without fetching a new one. If Next joke doesn't work, check the
backend terminal for errors first.

> **⚠️ Before you test a real payment locally: Stripe test mode and
> Lob test mode are two completely independent switches, and both need
> to be off.** There's nothing in this code that ties them together.
> A successful *Stripe test* payment (using their fake `4242...` card)
> still fires a real webhook — and if `LOB_API_KEY` in your `.env`
> happens to be a **live** key at that moment, it'll create and mail
> a real, billed postcard anyway, Stripe test mode notwithstanding.
> Always double-check `LOB_API_KEY` starts with `test_` before doing
> any local checkout testing — this isn't hypothetical, it's exactly
> how a real card ended up getting mailed during development.

---

## 2. Accounts you need before going further

- **Stripe** — [stripe.com](https://stripe.com) — for taking payment
- **Lob** — [lob.com](https://lob.com) — for printing and mailing the postcard

Both give you free **test** API keys immediately on signup — no need to
verify your identity or add a bank account until you're ready to go live.

Put those test keys in `backend/.env`.

Optional:
- **OpenAI Moderation API** — [developers.openai.com](https://developers.openai.com/api/docs/guides/moderation) — for filtering out illegal/abusive entries (imperfectly). The endpoint itself is free, but OpenAI still requires a small **prepaid balance** on the account before any API key works at all. If your very first request comes back `429`, that's almost always this, not real rate limiting — add a few dollars of credit under Settings → Billing.
- **GoatCounter** — [goatcounter.com](https://www.goatcounter.com) — for collecting some basic, privacy-protective analytics. You'll need your own site code — see `VITE_GOATCOUNTER_CODE` in `frontend/.env.example`, deliberately left unset in any environment other than your real production deploy.

For using these, see `backend/.env.example` and `frontend/.env.example` .

---

## 3. Deploying for real

(I use [Railway](https://railway.app) for both backend and frontend —
one project, two services pointed at the same repo, different root
directories. But this can work pretty much anywhere.)

**Backend**:
1. Push this whole folder to a GitHub repo.
2. New Project → connect the repo → set the root directory to `backend`.
3. It auto-detects `npm start`. Add the same environment variables from
   `backend/.env.example`, filled in with your real (test, for now) keys.
4. Once deployed you'll get a URL like `https://yourapp.up.railway.app`.

**Stripe webhook** (do this right after the backend is deployed):
1. Stripe dashboard → Developers → Webhooks → Add endpoint.
2. URL: `https://yourapp.up.railway.app/api/stripe-webhook`
3. Event: `payment_intent.succeeded`
4. Copy the signing secret it gives you into your backend's
   `STRIPE_WEBHOOK_SECRET` environment variable, redeploy.

**Frontend**:
1. New Project (or new service in the same project) → connect the same
   repo → root directory `frontend`.
2. Set environment variable `VITE_API_BASE` to your backend's URL from
   above.
3. Also set `VITE_SITE_URL` (this environment's own public URL — e.g. the
   Railway-generated one for staging, your real domain for production) and
   `VITE_ROBOTS` (`index, follow` for production, `noindex, nofollow` for
   staging/preview environments). **These two are required** — unlike
   `VITE_GOATCOUNTER_CODE`, leaving either unset makes the build itself
   fail outright, not just degrade gracefully. See `frontend/.env.example`
   for the full explanation.
4. Deploy. You'll get a URL like `https://yourapp-frontend.up.railway.app`.

**Test it end-to-end** using Stripe's test card `4242 4242 4242 4242`,
any future expiry date, any 3-digit CVC. Confirm a test postcard shows up
in your Lob dashboard.

**Go live** by swapping every test key (Stripe + Lob) for a live key, in
your production backend and frontend environment variables. ⚠️ Note: Stripe will ask you to verify your
identity and bank details before it lets you switch; it's normal, but note that it can take a couple business days. Send
yourself one real postcard before opening it up to anyone else.

---

## 4. Custom domain (optional)

Buy a domain from any registrar. In your frontend host's dashboard, add it as a custom domain and create the DNS record it asks for at your registrar. Do the same for the backend with a subdomain like `api.yourdomain.com` if you want a tidier URL, then update `VITE_API_BASE` to match. SSL is issued automatically.

If you change domains, remember to also update:
- The Stripe webhook URL (step above)
- `FRONTEND_ORIGIN` in the backend's environment variables

---

## 5. A few things worth knowing

- **Rate limiting**: a general cap is implemented for all api calls; the cap on `/api/joke` is more generous (people might want to browse lots of jokes quickly), but all the other endpoints are pretty tightly constrained. See the `*Limiter` constants near the top of `server.js`.
- **Security headers**: `helmet()` is applied globally in `server.js` for
  a sane baseline (no custom configuration beyond its defaults).
- **Moderation threshold**: see the note next to `OPENAI_API_KEY` in
  `backend/.env.example`.

### Production vs local 404 handling

This app has no client-side router — it's one page driven by internal
state, plus the static pages in `frontend/public`. A missing path should
return a genuine 404, not silently fall back to the homepage (Vite's
default behavior for single-page apps, but not what I wanted here).

**Locally**, `npm run dev` / `npm run preview` get this from Vite itself:
`appType: "mpa"` in `vite.config.js` makes unmatched paths return a real
404, and a small plugin (`custom404Plugin`, same file) fills in the
response body with `frontend/public/404.html` instead of leaving it
empty. (See the comments in that file for why it's built the way it is —
getting it right took a few wrong turns worth not repeating.)

**In production, none of that runs at all.** Railpack instead serves the
built `dist/` folder directly via its own Caddy instance and the frontend
service is just static files. The `frontend/Caddyfile` makes this work
correctly. Without that file, Railway auto-generates a Caddyfile for you,
and its default doesn't include error-page handling: a missing path gets a
bare 404 status return, served by Railway's edge rather than reaching your
app's logic at all. (See the `handle_errors` block in this file.)
