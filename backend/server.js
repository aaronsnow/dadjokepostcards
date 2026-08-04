// server.js
// Minimal backend for the dad-joke postcard app.
// Handles: creating a Stripe payment, confirming it via webhook,
// then calling Lob to actually print & mail the postcard.
//
// Env vars needed (see .env.example):
//   STRIPE_SECRET_KEY
//   STRIPE_WEBHOOK_SECRET
//   LOB_API_KEY
//   RETURN_ADDRESS_* (your business return address, required by Lob/USPS)
//   FRONTEND_ORIGIN (for CORS)
//   PORT (optional, defaults to 3001)

import express from "express";
import cors from "cors";
import Stripe from "stripe";
import fetch from "node-fetch";
import "dotenv/config";

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const PRICE_CENTS = parseInt(process.env.PRICE_CENTS, 10) || 499;
// Mirrors NOTE_LIMIT in the frontend's App.jsx. Enforced here too since the
// frontend's maxLength is trivially bypassable by anyone calling this API
// directly.
const NOTE_LIMIT = 280;

// FRONTEND_ORIGIN can be a single URL or a comma-separated list (e.g. your
// custom domain plus the Railway-provided one, while you're transitioning
// between them). Falls back to allowing any origin if unset.
const allowedOrigins = (process.env.FRONTEND_ORIGIN || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.length
      ? allowedOrigins
      : "*",
  })
);

// Stripe can occasionally redeliver the same webhook event (e.g. after a
// slow response), and running two `stripe listen` sessions locally at once
// has the same effect. Track which event IDs we've already acted on so a
// duplicate delivery never triggers a second postcard for one payment.
const processedEventIds = new Set();

// Stripe webhooks need the RAW body to verify the signature, so this route
// is registered BEFORE the global express.json() middleware below.
app.post(
  "/api/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"],
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Acknowledge Stripe immediately — don't make it wait on Lob. This keeps
    // the response time well under Stripe's ~20s webhook timeout regardless
    // of how long the Lob call takes, and matters even more on a free-tier
    // host where a cold start alone can eat into that budget.
    res.json({ received: true });

    if (event.type === "payment_intent.succeeded") {
      const intent = event.data.object;

      // Stripe delivers every event to every registered destination in the
      // same mode (test/live) — it has no concept of "this one's only for
      // staging." So each backend has to recognize and ignore events that
      // weren't created by itself, or production and staging (and local
      // dev) will all independently process the same purchase.
      const eventEnv = intent.metadata?.environment;
      const myEnv = process.env.ENVIRONMENT_NAME || "unset";
      if (eventEnv !== myEnv) {
        console.log(`Ignoring event for environment "${eventEnv}" (I am "${myEnv}")`);
        return;
      }

      if (processedEventIds.has(event.id)) {
        console.log("Duplicate webhook delivery, skipping:", event.id);
        return;
      }
      processedEventIds.add(event.id);

      sendPostcard(intent.metadata).catch((err) => {
        // Payment already succeeded — log loudly and let a human intervene.
        // Don't let a Lob failure ever silently swallow a paid order.
        console.error("Postcard send FAILED for paid order:", intent.id, err);
      });
    }
  }
);

app.use(express.json());

// 0. The frontend calls this instead of hitting icanhazdadjoke.com directly.
//    Browsers can't call icanhazdadjoke.com from client-side JS — it doesn't
//    return CORS headers — so the request has to be proxied through here,
//    server-to-server, where CORS doesn't apply.
app.get("/api/joke", async (req, res) => {
  try {
    const jokeRes = await fetch("https://icanhazdadjoke.com/", {
      headers: {
        Accept: "application/json",
        // icanhazdadjoke asks API consumers to identify themselves
        "User-Agent": "Pun & Post (https://example.com)",
      },
    });
    if (!jokeRes.ok) throw new Error(`upstream ${jokeRes.status}`);
    const data = await jokeRes.json();
    res.json({ joke: data.joke });
  } catch (err) {
    console.error("Joke fetch failed:", err.message);
    res.status(502).json({ error: "Could not fetch a joke right now" });
  }
});

// The frontend fetches this instead of hardcoding its own copy of the
// price, so the on-screen display can never disagree with what's actually
// charged — that's still decided entirely by PRICE_CENTS above, this just
// lets the display reflect it without needing its own hardcoded value.
app.get("/api/price", (req, res) => {
  res.json({ priceCents: PRICE_CENTS });
});

// 1. Front end calls this once the user has picked a joke and filled in
//    the recipient address, BEFORE showing the card payment form.
app.post("/api/create-payment-intent", async (req, res) => {
  const { joke, note, recipient } = req.body;

  if (!joke || !recipient?.name || !recipient?.line1 || !recipient?.zip) {
    return res.status(400).json({ error: "Missing joke or recipient details" });
  }

  if (note && note.length > NOTE_LIMIT) {
    return res.status(400).json({ error: `Note is too long (${NOTE_LIMIT} character max).` });
  }

  try {
    // Optional but recommended: verify the US address before charging
    // anyone, so you're not billing people for undeliverable mail.
    const verified = await verifyAddress(recipient);
    if (!verified.deliverable) {
      return res.status(400).json({ error: "That address doesn't look deliverable — please double check it." });
    }

    const intent = await stripe.paymentIntents.create({
      amount: PRICE_CENTS,
      currency: "usd",
      payment_method_types: ["card"],
      // Stash everything the webhook will need to build the postcard.
      // Stripe metadata values must be strings.
      metadata: {
        environment: process.env.ENVIRONMENT_NAME || "unset",
        joke,
        note: note || "",
        recipientName: recipient.name,
        recipientLine1: recipient.line1,
        recipientLine2: recipient.line2 || "",
        recipientCity: recipient.city,
        recipientState: recipient.state,
        recipientZip: recipient.zip,
      },
    });

    res.json({ clientSecret: intent.client_secret });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not start payment" });
  }
});

// A diagonal striped bar drawn as ONE static SVG image spanning the full
// width — literal precomputed polygons, not a tiled <pattern>. Tiled
// patterns with patternTransform proved unreliable on this renderer
// (visible seams); a single flat drawing sidesteps tiling entirely.
function stripeBarHtml(position) {
  const width = 625; // 6.25in at 100 units/inch
  const height = 40; // 0.4in
  const shift = 40; // horizontal shift over the full height = 45deg slant
  const period = 90; // widened from 18 — same proportions, ~4x fewer shapes
  const widths = [30, 15, 30, 15];
  const colors = ["#BC4430", "#F7F1E3", "#24344A", "#F7F1E3"];
  let polys = "";
  for (let x = -shift - period; x < width + shift; x += period) {
    let localX = x;
    for (let i = 0; i < widths.length; i++) {
      const w = widths[i];
      const x0 = localX;
      const x1 = localX + w;
      polys += `<polygon points="${x0},${height} ${x1},${height} ${x1 + shift},0 ${x0 + shift},0" fill="${colors[i]}"/>`;
      localX += w;
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="6.25in" height="0.4in" preserveAspectRatio="none">${polys}</svg>`;
  return `<div style="position:absolute;left:0;right:0;${position}:0;height:0.4in;overflow:hidden;">${svg}</div>`;
}

const FONT_LINK =
  '<link href="https://fonts.googleapis.com/css2?family=Special+Elite&family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&family=IBM+Plex+Mono:wght@400;500;700&display=swap" rel="stylesheet">';

// 2. Called by the Stripe webhook above once payment has actually cleared.
async function sendPostcard(meta) {
  // Full bleed size per Lob's spec for a 4x6 postcard. Content that matters
  // stays inside the "safe area" (0.1875in inset) so nothing gets trimmed.
  const frontHtml = `
    <html><head><meta charset="UTF-8">${FONT_LINK}</head>
    <body style="margin:0;padding:0;width:6.25in;height:4.25in;position:relative;background:#E8DCC3;font-family:'Libre Baskerville',serif;">
      ${stripeBarHtml("top")}
      ${stripeBarHtml("bottom")}
      <div style="position:absolute;top:0.75in;left:0.4in;font-family:'IBM Plex Mono',monospace;font-size:9pt;letter-spacing:2px;text-transform:uppercase;color:#6B6558;">
        Dept. of Questionable Humor
      </div>
      <div style="position:absolute;top:0.65in;right:0.4in;width:1in;height:1in;">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="1in" height="1in">
          <circle cx="50" cy="50" r="47" fill="none" stroke="#BC4430" stroke-width="2"/>
          <g transform="rotate(-12 50 50)">
            <text x="50" y="42" text-anchor="middle" font-family="'IBM Plex Mono', monospace" font-size="8" letter-spacing="1" fill="#BC4430">GROAN</text>
            <text x="50" y="54" text-anchor="middle" font-family="'IBM Plex Mono', monospace" font-size="8" letter-spacing="1" fill="#BC4430">-ANTEED</text>
            <text x="50" y="66" text-anchor="middle" font-family="'IBM Plex Mono', monospace" font-size="8" letter-spacing="1" fill="#BC4430">DELIVERY</text>
          </g>
        </svg>
      </div>
      <div style="position:absolute;top:1.95in;left:0.5in;right:0.5in;text-align:center;font-size:16pt;line-height:1.4;color:#24344A;">
        ${jokeHtml(meta.joke)}
      </div>
    </body></html>`;

  // Lob's 4x6 back template: 5.75in safe-zone width, with a 3.2835in x 2.38in
  // address/postage block it auto-prints flush to the bottom-right, plus a
  // 0.15in buffer before the safe zone's right edge. That leaves exactly
  // 5.75 - 3.2835 - 0.15 = 2.3165in of usable width to the left of it —
  // our note column is sized to that, not to the left-column guess this
  // used before (which was wide enough to visually run into the address
  // block for anything longer than a couple of words).
  const backHtml = `
    <html><head><meta charset="UTF-8">${FONT_LINK}</head>
    <body style="margin:0;padding:0;width:6.25in;height:4.25in;position:relative;background:#F7F1E3;font-family:'Libre Baskerville',serif;">
      ${stripeBarHtml("top")}
      ${stripeBarHtml("bottom")}
      <div style="position:absolute;top:0.55in;left:0.25in;width:2.3165in;font-family:'Libre Baskerville',serif;font-size:11pt;font-style:italic;line-height:1.5;color:#4A4636;overflow-wrap:break-word;">
        ${escapeHtml(meta.note || "")}
      </div>
      <div style="position:absolute;top:0.55in;left:2.6in;right:0.4in;text-align:right;font-family:'IBM Plex Mono',monospace;font-size:7.5pt;font-weight:500;line-height:1.4;letter-spacing:0.02em;color:#BC4430;">
        Somebody paid to send you this groaner. You can return the favor at <span style="font-weight:700">dadjokepostcards.com</span>
      </div>
    </body></html>`;

  console.log(`Postcard HTML sizes — front: ${frontHtml.length} chars, back: ${backHtml.length} chars (Lob's limit is 10,000 each)`);

  const res = await fetch("https://api.lob.com/v1/postcards", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(process.env.LOB_API_KEY + ":").toString("base64"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      description: "Dad joke postcard",
      to: {
        name: meta.recipientName,
        address_line1: meta.recipientLine1,
        address_line2: meta.recipientLine2 || undefined,
        address_city: meta.recipientCity,
        address_state: meta.recipientState,
        address_zip: meta.recipientZip,
        address_country: "US",
      },
      from: {
        name: process.env.RETURN_ADDRESS_NAME,
        address_line1: process.env.RETURN_ADDRESS_LINE1,
        address_city: process.env.RETURN_ADDRESS_CITY,
        address_state: process.env.RETURN_ADDRESS_STATE,
        address_zip: process.env.RETURN_ADDRESS_ZIP,
        address_country: "US",
      },
      front: frontHtml,
      back: backHtml,
      size: "4x6",
      mail_type: "usps_first_class",
      // Lob requires every mailpiece to declare its purpose. This app sends
      // individually triggered, one-off postcards — not bulk advertising —
      // so "operational" is the accurate classification, not "marketing".
      use_type: "operational",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Lob error ${res.status}: ${body}`);
  }
  return res.json();
}

async function verifyAddress(recipient) {
  const res = await fetch("https://api.lob.com/v1/us_verifications", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(process.env.LOB_API_KEY + ":").toString("base64"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      primary_line: recipient.line1,
      secondary_line: recipient.line2 || "",
      city: recipient.city,
      state: recipient.state,
      zip_code: recipient.zip,
    }),
  });
  const data = await res.json();
  const deliverable = data.deliverability && data.deliverability !== "undeliverable";
  return { deliverable, data };
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Run on the raw joke text BEFORE escaping — escapeHtml turns a literal "
// into &quot;, which would break the "quote right after punctuation" check
// below if we ran this afterward.
function insertPunchlineBreaks(text) {
  if (!text) return text;
  return text.replace(/([.?!]['"\u2019\u201D]?)\s+/g, "$1\n");
}

// Renders each line as its own block with margin-top, mirroring the
// frontend's JokeText component, so the punchline reads as a paragraph
// break (a beat of a pause) rather than just a tight line wrap.
function jokeHtml(joke) {
  return escapeHtml(insertPunchlineBreaks(joke))
    .split("\n")
    .map((line, i) => `<span style="display:block;margin-top:${i > 0 ? "1em" : "0"};">${line}</span>`)
    .join("");
}

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`Server listening on ${port}`));
