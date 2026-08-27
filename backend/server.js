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
//   OPENAI_API_KEY (optional — note moderation is skipped, not blocked, if unset)

import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import Stripe from "stripe";
import fetch from "node-fetch";
import "dotenv/config";

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const PRICE_CENTS = parseInt(process.env.PRICE_CENTS, 10) || 499;
// The 50 states, DC, USPS-recognized territories, and military
// designations (AA/AE/AP for APO/FPO addresses). Used as a free, local
// sanity check on the state field — catches "XX"-style typos at zero cost,
// with no way for anyone to run up a bill against it since it's just a
// set lookup, not an API call.
const US_STATE_CODES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA",
  "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK",
  "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
  "DC", "AS", "GU", "MP", "PR", "VI",
  "AA", "AE", "AP",
]);
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

if (allowedOrigins.length === 0) {
  // Not fatal — the app still runs — but this means ANY website can call
  // these APIs cross-origin, so it's worth knowing loudly rather than
  // silently, especially once this is getting real traffic.
  console.warn(
    "WARNING: FRONTEND_ORIGIN is not set — CORS is wide open (any origin allowed). " +
      "Set FRONTEND_ORIGIN in this environment's variables to restrict it."
  );
}

app.use(helmet());

app.use(
  cors({
    origin: allowedOrigins.length
      ? allowedOrigins
      : "*",
  })
);

// A generous ceiling on the whole API — not meant to stop a determined
// abuser (that's what the stricter per-route limits below are for), just to
// cap total request volume from any one IP so a runaway script or bot can't
// hammer the server indefinitely.
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(generalLimiter);

// /api/joke proxies to icanhazdadjoke.com, a free public API. Hammering
// this endpoint risks getting OUR server rate-limited or blocked by THEM —
// which would break the joke feature for every real visitor, not just the
// abuser. Kept tighter than the general limiter for that reason.
const jokeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please slow down." },
});

// Each call here creates a real (if uncharged) Stripe PaymentIntent.
// Uncapped, a script could create an unbounded number of these — not
// directly costly since nothing is charged until payment, but it's the
// closest thing to a real abuse surface in this app, so it gets the
// tightest limit of the three.
const createIntentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts — please wait a bit and try again." },
});

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
app.get("/api/joke", jokeLimiter, async (req, res) => {
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

// OpenAI's default harassment threshold turned out to be too sensitive for
// this app's normal tone — affectionate-but-blunt sign-offs ("Clean up your
// act, kid!") were tripping it in the 0.40-0.53 range while near-identical
// notes with a different word choice scored under it. Testing suggested 0.6
// as a cutoff that still catches genuinely hostile language without
// blocking typical dad-joke-postcard ribbing. Only overriding this one
// category — every other category (violence, hate, sexual content,
// self-harm, etc.) still uses OpenAI's own default judgment.
const HARASSMENT_THRESHOLD = 0.6;

// Checks the note against OpenAI's free moderation endpoint before letting
// an order through. Deliberately fails OPEN, not closed: if OPENAI_API_KEY
// isn't set, the request errors, or OpenAI is having a bad day, we let the
// order proceed rather than block a real customer over an infrastructure
// hiccup on our end. This is a first-pass filter, not a guarantee — see the
// Content policy section on the Terms page for what it actually covers.
async function isFlagged(note) {
  if (!note || !note.trim() || !process.env.OPENAI_API_KEY) return false;
  try {
    const res = await fetch("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "omni-moderation-latest", input: note }),
    });
    if (!res.ok) {
      console.error("Moderation API returned", res.status, "— allowing note through");
      return false;
    }
    const data = await res.json();
    const result = data.results?.[0];
    if (!result) return false;

    const categories = result.categories || {};
    const scores = result.category_scores || {};

    // Same as OpenAI's own verdict for every category except harassment,
    // where the raised threshold above applies instead of their default.
    const finalFlagged = Object.entries(categories).some(([category, catFlagged]) => {
      if (!catFlagged) return false;
      if (category === "harassment") return (scores.harassment ?? 1) >= HARASSMENT_THRESHOLD;
      return true;
    });

    if (result.flagged || finalFlagged) {
      // Without this, a flagged (or overridden) note is a black box — you
      // know it was blocked or let through but not why. Logging which
      // category actually tripped (and its score), plus whether our
      // harassment threshold changed OpenAI's own verdict, turns "why did
      // this happen?" from a guess into something you can just look up.
      // Logs the note text too, since it's already been sent to OpenAI
      // regardless; drop that part if you'd rather these logs not include
      // what people wrote.
      const triggered = Object.entries(categories)
        .filter(([, catFlagged]) => catFlagged)
        .map(([category]) => `${category} (${scores[category]?.toFixed(3)})`)
        .join(", ");
      const overrideNote =
        result.flagged !== finalFlagged
          ? finalFlagged
            ? " [harassment threshold override: now BLOCKED]"
            : " [harassment threshold override: now ALLOWED]"
          : "";
      console.log(
        `Note ${finalFlagged ? "flagged" : "allowed despite OpenAI flag"} — categories: ${triggered || "none listed"}${overrideNote} — note: ${JSON.stringify(note)}`
      );
    }

    return finalFlagged;
  } catch (err) {
    console.error("Moderation check failed, allowing note through:", err.message);
    return false;
  }
}

// 1. Front end calls this once the user has picked a joke and filled in
//    the recipient address, BEFORE showing the card payment form.
app.post("/api/create-payment-intent", createIntentLimiter, async (req, res) => {
  const { joke, note, recipient } = req.body;

  if (!joke || !recipient?.name || !recipient?.line1 || !recipient?.zip) {
    return res.status(400).json({ error: "Missing joke or recipient details" });
  }

  if (note && note.length > NOTE_LIMIT) {
    return res.status(400).json({ error: `Note is too long (${NOTE_LIMIT} character max).` });
  }

  // Stripe metadata values cap at 500 characters and would otherwise reject
  // these with an unhelpful error — catch absurdly long input here instead,
  // with a message that makes sense to a real person.
  const RECIPIENT_FIELD_LIMIT = 200;
  const recipientFields = {
    name: recipient.name,
    line1: recipient.line1,
    line2: recipient.line2,
    city: recipient.city,
  };
  for (const [field, value] of Object.entries(recipientFields)) {
    if (value && value.length > RECIPIENT_FIELD_LIMIT) {
      return res.status(400).json({ error: `That ${field === "line1" || field === "line2" ? "address line" : field} is too long.` });
    }
  }

  if (await isFlagged(note)) {
    return res.status(400).json({ error: "That note isn't allowed — please revise it." });
  }

  // Free, local format checks only — no Lob deliverability call here. That
  // call is a real, billed API request every time it fires, and gating it
  // on this pre-payment step means anyone (or any bot) could rack up
  // unlimited charges against us just by submitting garbage addresses,
  // with nothing to stop them since no payment is required to reach this
  // point. A bad-but-plausible-looking address is now accepted and simply
  // charged for — see the Terms page for how that's handled.
  let zip = (recipient.zip || "").trim();
  if (/^\d{9}$/.test(zip)) zip = `${zip.slice(0, 5)}-${zip.slice(5)}`; // e.g. "208953402" -> "20895-3402"
  if (!/^\d{5}(-\d{4})?$/.test(zip)) {
    return res.status(400).json({ error: "That doesn't look like a valid 5- or 9-digit ZIP code." });
  }
  if (!US_STATE_CODES.has((recipient.state || "").trim().toUpperCase())) {
    return res.status(400).json({ error: "That doesn't look like a valid state abbreviation." });
  }

  try {
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
        recipientZip: zip,
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
