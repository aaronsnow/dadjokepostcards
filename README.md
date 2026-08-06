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
npm start
```
It should print `Server listening on 3001`. Leave this running.

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
joke" a few times; you should see genuinely different jokes each time.
If you don't, check the backend terminal for errors first.

---

## 2. Accounts you need before going further

- **Stripe** — [stripe.com](https://stripe.com) — for taking payment
- **Lob** — [lob.com](https://lob.com) — for printing and mailing the postcard

Both give you free **test** API keys immediately on signup — no need to
verify your identity or add a bank account until you're ready to go live.

Put those test keys in `backend/.env`.

Optional:
- **OpenAI Moderation API** — [developers.openai.com](https://developers.openai.com/api/docs/guides/moderation) — for filtering out illegal/abusive entries (imperfectly)
- **GoatCounter** — [goatcounter.com](https://www.goatcounter.com) — for collecting some basic, privacy-protective analytics

For using these, see backend/.env.example and frontend/.env.example .

---

## 3. Deploying for real

(I use [Railway](https://railway.app) for both backend and frontend)

**Backend**:
1. Push this whole folder to a GitHub repo.
2. New Project → connect the repo → set the root directory to `backend`.
3. It auto-detects `npm start`. Add the same environment variables from
   `backend/.env.example`, filled in with your real (test, for now) keys.
4. Once deployed you'll get a URL like `https://yourapp.onrender.com`.

**Stripe webhook** (do this right after the backend is deployed):
1. Stripe dashboard → Developers → Webhooks → Add endpoint.
2. URL: `https://yourapp.onrender.com/api/stripe-webhook`
3. Event: `payment_intent.succeeded`
4. Copy the signing secret it gives you into your backend's
   `STRIPE_WEBHOOK_SECRET` environment variable, redeploy.

**Frontend**:
1. New Project → connect the same repo → root directory `frontend`.
2. Set environment variable `VITE_API_BASE` to your backend's URL from above.
3. Deploy. You'll get a URL like `https://yourapp.vercel.app`.

**Test it end-to-end** using Stripe's test card `4242 4242 4242 4242`,
any future expiry date, any 3-digit CVC. Confirm a test postcard shows up
in your Lob dashboard.

**Go live** by swapping every test key (Stripe + Lob) for a live key, in
your backend's environment variables. Stripe will ask you to verify your
identity/bank details before it lets you switch — that's normal. Send
yourself one real postcard before opening it up to anyone else.

---

## 4. Custom domain (optional)

Buy a domain from any registrar. In your frontend host's dashboard, add it as a custom domain and create the DNS record it asks for at your registrar. Do the same for the backend with a subdomain like `api.yourdomain.com` if you want a tidier URL, then update `VITE_API_BASE` to match. SSL is issued automatically.

If you change domains, remember to also update:
- The Stripe webhook URL (step above)
- `FRONTEND_ORIGIN` in the backend's environment variables
