import { useState, useEffect, useCallback, useRef, useLayoutEffect } from "react";
import { RefreshCw, Send, ArrowLeft, MapPin, CreditCard, CheckCircle2, Loader2, Mail } from "lucide-react";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, CardElement, useStripe, useElements } from "@stripe/react-stripe-js";

const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || "");
const IS_STRIPE_TEST_MODE = (import.meta.env.VITE_ENVIRONMENT_NAME || "").trim().toLowerCase() !== "production";
// Staging exists specifically for testing changes before they go live —
// counting that traffic would badly skew real visitor/funnel numbers, so
// analytics only actually fires in production, even though the GoatCounter
// script itself loads everywhere (see index.html's no_onload).
const ANALYTICS_ENABLED = (import.meta.env.VITE_ENVIRONMENT_NAME || "").trim().toLowerCase() === "production";

// Fires a GoatCounter event once per step per session (first arrival only —
// re-entering a step via "← Edit" etc. shouldn't inflate the funnel
// numbers). The first step doubles as the overall visitor count, so no
// separate pageview call is needed.
const trackedSteps = new Set();
function trackStep(step, attempt = 0) {
  if (!ANALYTICS_ENABLED || trackedSteps.has(step)) return;
  // count.js loads async, so it may not be ready yet on the very first
  // step (page load). Retry briefly rather than silently dropping the
  // event — don't mark as tracked until it's actually been sent.
  if (!window.goatcounter || !window.goatcounter.count) {
    if (attempt < 50) setTimeout(() => trackStep(step, attempt + 1), 100);
    return;
  }
  trackedSteps.add(step);
  window.goatcounter.count({ path: `step-${step}`, event: true });
}

const FONT_IMPORT = `
@import url('https://fonts.googleapis.com/css2?family=Special+Elite&family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&family=IBM+Plex+Mono:wght@400;500;700&display=swap');
`;

const DEFAULT_PRICE_CENTS = 499; // fallback shown only until /api/price responds
const NOTE_LIMIT = 280;

// Set VITE_API_BASE in your .env file (or your hosting provider's env vars)
// to your deployed backend's URL, e.g. "https://your-app.onrender.com".
// Until that's set, the app falls back to a public demo proxy so there's
// still something to look at — replace that before real users show up,
// since it's not a service you control or can rely on.
const API_BASE = import.meta.env.VITE_API_BASE || "";
const DEMO_PROXY = "https://api.allorigins.win/raw?url=" + encodeURIComponent(
  "https://icanhazdadjoke.com/jokes/random"
);

const FALLBACK_JOKES = [
  "Why don't skeletons fight each other? They don't have the guts.",
  "I would tell you a construction joke, but I'm still working on it.",
  "Why did the scarecrow win an award? He was outstanding in his field.",
];

// Auto-shrinks text to fit its container rather than letting it clip under
// AirmailBorder's overflow-hidden. Re-attempts at full scale whenever the
// watched content changes or the box is resized, then steps the scale down
// until the content's natural height fits, or we hit minScale.
function useFitScale(ref, deps, minScale = 0.75, step = 0.05) {
  const [scale, setScale] = useState(1);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setScale(1), deps);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.scrollHeight > el.clientHeight + 1 && scale > minScale) {
      setScale((s) => Math.max(minScale, +(s - step).toFixed(2)));
    }
  });

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setScale(1));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  return scale;
}

// Mirrors insertPunchlineBreaks in the backend's server.js — keep both in
// sync if this pattern changes. Breaks after each sentence-ending
// punctuation mark, optionally followed by a closing quote, so the
// punchline lands on its own line even though the joke API doesn't
// provide one itself.
function insertPunchlineBreaks(text) {
  if (!text) return text;
  return text.replace(/([.?!]['"\u2019\u201D]?)\s+/g, "$1\n");
}

function JokeText({ text }) {
  const lines = insertPunchlineBreaks(text).split("\n");
  return lines.map((line, i) => (
    <span key={i} style={{ display: "block", marginTop: i > 0 ? "1em" : 0 }}>
      {line}
    </span>
  ));
}

// Display-only mirror of the backend's ZIP normalization — inserts the
// hyphen for a bare 9-digit ZIP so the preview matches what actually gets
// stored and printed, without waiting on a round trip to the server.
function formatZip(zip) {
  const trimmed = (zip || "").trim();
  return /^\d{9}$/.test(trimmed) ? `${trimmed.slice(0, 5)}-${trimmed.slice(5)}` : trimmed;
}

function formatPrice(cents) {
  const dollars = cents / 100;
  return dollars % 1 === 0 ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

function Postmark({ stamped, scale = 1 }) {
  return (
    <div className="relative shrink-0" style={{ width: `${80 * scale}px`, height: `${80 * scale}px` }}>
      <div
        className="absolute inset-0 rounded-full border-2 flex items-center justify-center text-center leading-tight"
        style={{
          borderColor: "#BC4430",
          transform: stamped ? "rotate(-12deg) scale(1)" : "rotate(-12deg) scale(0.6)",
          opacity: stamped ? 1 : 0,
          transition: "all 420ms cubic-bezier(.34,1.56,.64,1)",
        }}
      >
        <span
          className="tracking-widest uppercase"
          style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#BC4430", fontSize: `${9 * scale}px` }}
        >
          Groan
          <br />
          -anteed
          <br />
          delivery
        </span>
      </div>
    </div>
  );
}

function StampCorner() {
  return (
    <div
      className="w-14 h-16 shrink-0 flex items-center justify-center"
      style={{
        border: "2px dashed #9C9483",
        backgroundColor: "#F0E9D8",
      }}
    >
      <Mail size={20} color="#9C9483" strokeWidth={1.5} />
    </div>
  );
}

function AirmailBorder({ children }) {
  const stripeStyle = {
    backgroundImage:
      "repeating-linear-gradient(-45deg, #BC4430 0 6px, #F7F1E3 6px 9px, #24344A 9px 15px, #F7F1E3 15px 18px)",
  };
  return (
    <div className="rounded-sm overflow-hidden aspect-[3/2] flex flex-col" style={{ border: "1px solid #D8CFB8" }}>
      <div className="h-[6px] shrink-0" style={stripeStyle} />
      <div className="flex-1 min-h-0" style={{ backgroundColor: "#F7F1E3" }}>{children}</div>
      <div className="h-[6px] shrink-0" style={stripeStyle} />
    </div>
  );
}

function PostcardFront({ joke, loading, stamped }) {
  const contentRef = useRef(null);
  const fitScale = useFitScale(contentRef, [joke, loading], 0.5);

  return (
    <AirmailBorder>
      <div ref={contentRef} className="h-full min-h-0 p-6 flex flex-col justify-between">
        <div className="flex justify-between items-start">
          <span
            className="tracking-[0.2em] uppercase"
            style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6558", fontSize: `${10 * fitScale}px` }}
          >
            Dept. of Questionable Humor
          </span>
          <Postmark stamped={stamped} scale={fitScale} />
        </div>
        <div className="flex-1 flex items-center justify-center px-2 py-6">
          {loading ? (
            <Loader2 className="animate-spin" size={28} color="#9C9483" />
          ) : (
            <p
              className="text-center leading-snug"
              style={{
                fontFamily: "'Libre Baskerville', serif",
                color: "#24344A",
                fontSize: `${18 * fitScale}px`,
              }}
            >
              <JokeText text={joke} />
            </p>
          )}
        </div>
      </div>
    </AirmailBorder>
  );
}

function PostcardBack({ joke, recipient, note }) {
  const contentRef = useRef(null);
  const fitScale = useFitScale(contentRef, [
    note,
    recipient.name,
    recipient.line1,
    recipient.line2,
    recipient.city,
    recipient.state,
    recipient.zip,
  ]);

  return (
    <AirmailBorder>
      <div ref={contentRef} className="h-full min-h-0 p-5 flex gap-3">
        <div style={{ flexBasis: "40%" }} className="min-w-0">
          <p
            className="italic leading-snug"
            style={{
              fontFamily: "'Libre Baskerville', serif",
              color: "#4A4636",
              fontSize: `${12 * fitScale}px`,
              overflowWrap: "break-word",
            }}
          >
            {note ? note : "No personal note added."}
          </p>
        </div>
        <div style={{ flexBasis: "58%" }} className="min-w-0 flex flex-col justify-between items-end">
          <p
            className="font-medium leading-snug tracking-wide text-right"
            style={{
              fontFamily: "'IBM Plex Mono', monospace",
              color: "#BC4430",
              fontSize: `${9 * fitScale}px`,
            }}
          >
            Somebody paid to send you this groaner. You can return the favor at <span style={{ fontWeight: 700 }}>dadjokepostcards.com</span>
          </p>
          <div className="flex flex-col items-end gap-2 shrink-0">
            <div style={{ transform: `scale(${fitScale})`, transformOrigin: "top right" }}>
              <StampCorner />
            </div>
            <div
              className="text-right leading-snug"
              style={{
                fontFamily: "'IBM Plex Mono', monospace",
                color: "#24344A",
                fontSize: `${11 * fitScale}px`,
              }}
            >
              <div className="font-medium">{recipient.name || "Recipient name"}</div>
              <div>{recipient.line1 || "Street address"}</div>
              {recipient.line2 && <div>{recipient.line2}</div>}
              <div>
                {(recipient.city || "City") + ", " + (recipient.state || "ST") + " " + (formatZip(recipient.zip) || "00000")}
              </div>
            </div>
          </div>
        </div>
      </div>
    </AirmailBorder>
  );
}

function StepLabel({ n, active, done, children }) {
  return (
    <div className="flex items-center gap-2">
      <div
        className="w-6 h-6 rounded-full flex items-center justify-center text-[11px]"
        style={{
          fontFamily: "'IBM Plex Mono', monospace",
          border: `1.5px solid ${active || done ? "#BC4430" : "#C9C0A9"}`,
          color: active || done ? "#BC4430" : "#9C9483",
          backgroundColor: done ? "#BC4430" : "transparent",
        }}
      >
        {done ? <CheckCircle2 size={13} color="#F7F1E3" /> : n}
      </div>
      <span
        className="text-[11px] uppercase tracking-wide hidden sm:inline"
        style={{
          fontFamily: "'IBM Plex Mono', monospace",
          color: active || done ? "#24344A" : "#9C9483",
        }}
      >
        {children}
      </span>
    </div>
  );
}

function PostcardApp() {
  const stripe = useStripe();
  const elements = useElements();

  const [step, setStep] = useState("browse");

  useEffect(() => {
    trackStep(step);
  }, [step]);

  const [joke, setJoke] = useState("");
  const [jokeLoading, setJokeLoading] = useState(false);
  const [jokeError, setJokeError] = useState(false);
  const [stamped, setStamped] = useState(false);
  // Linear history of jokes shown this session, plus a pointer into it.
  // "Previous joke" moves the pointer back (no fetch). "Next joke" moves
  // forward through anything already fetched; only once there's nothing
  // ahead does it fetch a new one and append it.
  const [jokeNav, setJokeNav] = useState({ history: [], index: -1 });

  const [recipient, setRecipient] = useState({ name: "", line1: "", line2: "", city: "", state: "", zip: "" });
  const [billingName, setBillingName] = useState("");
  const [note, setNote] = useState("");

  const [clientSecret, setClientSecret] = useState("");
  const [creatingIntent, setCreatingIntent] = useState(false);
  const [paymentError, setPaymentError] = useState("");
  const [paying, setPaying] = useState(false);
  const [orderId, setOrderId] = useState("");

  const [priceCents, setPriceCents] = useState(DEFAULT_PRICE_CENTS);

  useEffect(() => {
    if (!API_BASE) return; // demo/preview context — just use the default
    fetch(`${API_BASE}/api/price`)
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => {
        if (typeof data.priceCents === "number") setPriceCents(data.priceCents);
      })
      .catch(() => {
        // Keep DEFAULT_PRICE_CENTS — this is only a display value anyway;
        // the actual charge is always decided server-side regardless.
      });
  }, []);

  const fetchJoke = useCallback(async () => {
    setJokeLoading(true);
    setJokeError(false);
    setStamped(false);
    // Try your own backend first (this is the real production path — see
    // /api/joke in server.js). Only fall back to the public demo proxy if
    // no backend is configured, which is the case in this chat preview.
    const recordJoke = (newJoke) => {
      setJoke(newJoke);
      setJokeNav(({ history, index }) => {
        const truncated = history.slice(0, index + 1);
        return { history: [...truncated, newJoke], index: truncated.length };
      });
    };
    try {
      if (API_BASE) {
        const res = await fetch(`${API_BASE}/api/joke`);
        if (!res.ok) throw new Error("backend error");
        const data = await res.json();
        recordJoke(data.joke);
        return;
      }
      const res = await fetch(DEMO_PROXY, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error("proxy error");
      const data = await res.json();
      if (!data.joke) throw new Error("no joke in response");
      recordJoke(data.joke);
    } catch (e) {
      setJokeError(true);
      recordJoke(FALLBACK_JOKES[Math.floor(Math.random() * FALLBACK_JOKES.length)]);
    } finally {
      setJokeLoading(false);
    }
  }, []);

  // StrictMode intentionally double-invokes effects on mount in development
  // to surface exactly this kind of bug: without this guard, the initial
  // fetch would run twice and record two jokes in history instead of one,
  // leaving "Previous joke" active before anyone had clicked anything.
  const didInitRef = useRef(false);
  useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;
    fetchJoke();
  }, [fetchJoke]);

  const previousJoke = () => {
    if (jokeNav.index <= 0) return;
    setStamped(false);
    setJoke(jokeNav.history[jokeNav.index - 1]);
    setJokeNav((nav) => ({ ...nav, index: nav.index - 1 }));
  };

  const nextJoke = () => {
    if (jokeNav.index < jokeNav.history.length - 1) {
      // Already have a joke ahead of us (we stepped back at some point) —
      // move forward to it instead of fetching and overwriting it.
      setStamped(false);
      setJoke(jokeNav.history[jokeNav.index + 1]);
      setJokeNav((nav) => ({ ...nav, index: nav.index + 1 }));
      return;
    }
    fetchJoke();
  };

  const acceptJoke = () => {
    setStamped(true);
    setTimeout(() => setStep("compose"), 380);
  };

  const recipientComplete =
    recipient.name && recipient.line1 && recipient.city && recipient.state && recipient.zip;

  // Called when the user clicks "Proceed to payment" on the review step.
  // Asks the backend to verify the address and start a Stripe PaymentIntent
  // before we ever show a card field.
  const goToReview = async () => {
    setCreatingIntent(true);
    setPaymentError("");
    if (!API_BASE) {
      setPaymentError("No backend configured — set VITE_API_BASE in your .env file.");
      setCreatingIntent(false);
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/create-payment-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ joke, note, recipient }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not start payment");
      setClientSecret(data.clientSecret);
      setStep("review");
    } catch (err) {
      setPaymentError(err.message);
    } finally {
      setCreatingIntent(false);
    }
  };

  const submitPayment = async (e) => {
    e.preventDefault();
    if (!stripe || !elements || !clientSecret) return;
    setPaying(true);
    setPaymentError("");

    const { error, paymentIntent } = await stripe.confirmCardPayment(clientSecret, {
      payment_method: {
        card: elements.getElement(CardElement),
        billing_details: { name: billingName },
      },
    });

    if (error) {
      setPaymentError(error.message || "Payment failed — check your card details and try again.");
      setPaying(false);
      return;
    }

    setPaying(false);
    setOrderId(paymentIntent.id);
    setStep("done");
  };

  const resetAll = () => {
    setStep("browse");
    setJokeNav({ history: [], index: -1 });
    setRecipient({ name: "", line1: "", line2: "", city: "", state: "", zip: "" });
    setBillingName("");
    setNote("");
    setClientSecret("");
    setPaymentError("");
    setOrderId("");
    fetchJoke();
  };

  const inputStyle = {
    fontFamily: "'Libre Baskerville', serif",
    backgroundColor: "#FBF8F0",
    border: "1px solid #D8CFB8",
    color: "#24344A",
  };

  return (
    <div
      className="w-full min-h-full"
      style={{ backgroundColor: "#E8DCC3", fontFamily: "'Libre Baskerville', serif" }}
    >
      <style>{FONT_IMPORT}</style>

      <div className="max-w-3xl mx-auto px-5 py-10">
        <header className="mb-8 text-center">
          <h1
            onClick={resetAll}
            className="text-3xl sm:text-4xl tracking-tight cursor-pointer"
            style={{ fontFamily: "'Special Elite', monospace", color: "#24344A" }}
            title="Start over"
          >
            Pun &amp; Post
          </h1>
          <p className="mt-2 text-sm italic" style={{ color: "#6B6558" }}>
            One groan-worthy joke, mailed to someone who deserves it: {formatPrice(priceCents)}
          </p>
        </header>

        <div className="flex items-center justify-center gap-5 mb-8 flex-wrap">
          <StepLabel n={1} active={step === "browse"} done={["compose", "review", "payment", "done"].includes(step)}>
            Pick a joke
          </StepLabel>
          <div className="w-6 h-px" style={{ backgroundColor: "#C9C0A9" }} />
          <StepLabel n={2} active={step === "compose"} done={["review", "payment", "done"].includes(step)}>
            Address it
          </StepLabel>
          <div className="w-6 h-px" style={{ backgroundColor: "#C9C0A9" }} />
          <StepLabel n={3} active={step === "review"} done={["payment", "done"].includes(step)}>
            Review
          </StepLabel>
          <div className="w-6 h-px" style={{ backgroundColor: "#C9C0A9" }} />
          <StepLabel n={4} active={step === "payment"} done={step === "done"}>
            Pay &amp; send
          </StepLabel>
        </div>

        {step === "browse" && (
          <div>
            <PostcardFront joke={joke} loading={jokeLoading} stamped={stamped} />
            {jokeError && (
              <p className="text-xs text-center mt-3" style={{ color: "#BC4430" }}>
                Couldn't reach the joke service — showing a backup joke instead.
              </p>
            )}
            <div className="flex flex-wrap justify-center gap-3 mt-6">
              <button
                onClick={previousJoke}
                disabled={jokeLoading || jokeNav.index <= 0}
                className="flex items-center gap-2 px-4 py-2.5 rounded-sm text-sm uppercase tracking-wide"
                style={{
                  fontFamily: "'IBM Plex Mono', monospace",
                  border: "1.5px solid #24344A",
                  color: "#24344A",
                  opacity: jokeLoading || jokeNav.index <= 0 ? 0.5 : 1,
                }}
              >
                <ArrowLeft size={14} />
                Previous joke
              </button>
              <button
                onClick={nextJoke}
                disabled={jokeLoading}
                className="flex items-center gap-2 px-4 py-2.5 rounded-sm text-sm uppercase tracking-wide"
                style={{
                  fontFamily: "'IBM Plex Mono', monospace",
                  border: "1.5px solid #24344A",
                  color: "#24344A",
                  opacity: jokeLoading ? 0.5 : 1,
                }}
              >
                <RefreshCw size={14} />
                Next joke
              </button>
              <button
                onClick={acceptJoke}
                disabled={jokeLoading}
                className="flex items-center gap-2 px-5 py-2.5 rounded-sm text-sm uppercase tracking-wide"
                style={{
                  fontFamily: "'IBM Plex Mono', monospace",
                  backgroundColor: "#BC4430",
                  color: "#F7F1E3",
                  opacity: jokeLoading ? 0.5 : 1,
                }}
              >
                <Send size={14} />
                Send this one
              </button>
            </div>
          </div>
        )}

        {step === "compose" && (
          <div className="grid sm:grid-cols-5 gap-8">
            <div className="sm:col-span-2">
              <PostcardFront joke={joke} loading={false} stamped={true} />
            </div>
            <div className="sm:col-span-3">
              <h2
                className="text-sm uppercase tracking-wide mb-3"
                style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6558" }}
              >
                Who's it going to?
              </h2>
              <div className="grid grid-cols-2 gap-3">
                <input
                  className="col-span-2 px-3 py-2 text-sm rounded-sm"
                  style={inputStyle}
                  placeholder="Recipient name"
                  value={recipient.name}
                  onChange={(e) => setRecipient({ ...recipient, name: e.target.value })}
                />
                <input
                  className="col-span-2 px-3 py-2 text-sm rounded-sm"
                  style={inputStyle}
                  placeholder="Street address"
                  value={recipient.line1}
                  onChange={(e) => setRecipient({ ...recipient, line1: e.target.value })}
                />
                <input
                  className="col-span-2 px-3 py-2 text-sm rounded-sm"
                  style={inputStyle}
                  placeholder="Apt / unit (optional)"
                  value={recipient.line2}
                  onChange={(e) => setRecipient({ ...recipient, line2: e.target.value })}
                />
                <input
                  className="px-3 py-2 text-sm rounded-sm"
                  style={inputStyle}
                  placeholder="City"
                  value={recipient.city}
                  onChange={(e) => setRecipient({ ...recipient, city: e.target.value })}
                />
                <input
                  className="px-3 py-2 text-sm rounded-sm"
                  style={inputStyle}
                  placeholder="State"
                  value={recipient.state}
                  onChange={(e) => setRecipient({ ...recipient, state: e.target.value })}
                />
                <input
                  className="col-span-2 px-3 py-2 text-sm rounded-sm"
                  style={inputStyle}
                  placeholder="ZIP code"
                  value={recipient.zip}
                  onChange={(e) => setRecipient({ ...recipient, zip: e.target.value })}
                />
              </div>

              <h2
                className="text-sm uppercase tracking-wide mt-5 mb-2"
                style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6558" }}
              >
                Add a note (optional — don't forget to sign it!)
              </h2>
              <textarea
                className="w-full px-3 py-2 text-sm rounded-sm resize-none"
                style={inputStyle}
                rows={4}
                maxLength={NOTE_LIMIT}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Wish you were here! Miss you already. Love, Dad"
              />
              <p className="text-[11px] text-right mt-1" style={{ color: "#9C9483" }}>
                {note.length}/{NOTE_LIMIT}
              </p>

              {paymentError && (
                <p className="text-xs mt-3" style={{ color: "#BC4430" }}>
                  {paymentError}
                  {paymentError.includes("isn't allowed") && (
                    <>
                      {" "}
                      <a
                        href="/terms.html"
                        target="_blank"
                        rel="noopener"
                        style={{ color: "#BC4430", textDecoration: "underline" }}
                      >
                        See our Terms.
                      </a>
                    </>
                  )}
                </p>
              )}

              <div className="flex justify-between mt-6">
                <button
                  onClick={() => setStep("browse")}
                  className="flex items-center gap-1 px-4 py-2 text-sm"
                  style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6558" }}
                >
                  <ArrowLeft size={14} /> Back
                </button>
                <button
                  onClick={goToReview}
                  disabled={!recipientComplete || creatingIntent}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-sm text-sm uppercase tracking-wide"
                  style={{
                    fontFamily: "'IBM Plex Mono', monospace",
                    backgroundColor: recipientComplete ? "#BC4430" : "#D8CFB8",
                    color: "#F7F1E3",
                    opacity: creatingIntent ? 0.7 : 1,
                  }}
                >
                  {creatingIntent ? <Loader2 size={14} className="animate-spin" /> : null}
                  {creatingIntent ? "Verifying address…" : "Review postcard"}
                </button>
              </div>
            </div>
          </div>
        )}

        {step === "review" && (
          <div>
            <div className="grid sm:grid-cols-2 gap-6">
              <div className="h-full flex flex-col">
                <p
                  className="text-[11px] uppercase tracking-wide mb-2 text-center"
                  style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#9C9483" }}
                >
                  Front
                </p>
                <div className="flex-1">
                  <PostcardFront joke={joke} loading={false} stamped={true} />
                </div>
              </div>
              <div className="h-full flex flex-col">
                <p
                  className="text-[11px] uppercase tracking-wide mb-2 text-center"
                  style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#9C9483" }}
                >
                  Back
                </p>
                <div className="flex-1">
                  <PostcardBack joke={joke} recipient={recipient} note={note} />
                </div>
              </div>
            </div>

            <div
              className="mt-8 mx-auto max-w-xs p-4 rounded-sm flex justify-between items-center"
              style={{ backgroundColor: "#F7F1E3", border: "1px solid #D8CFB8" }}
            >
              <span className="text-sm" style={{ color: "#4A4636" }}>
                Printed postcard + postage
              </span>
              <span
                className="text-sm font-medium"
                style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#24344A" }}
              >
                {formatPrice(priceCents)}
              </span>
            </div>

            <div className="flex justify-between mt-6 max-w-xs mx-auto">
              <button
                onClick={() => setStep("compose")}
                className="flex items-center gap-1 px-4 py-2 text-sm"
                style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6558" }}
              >
                <ArrowLeft size={14} /> Edit
              </button>
              <button
                onClick={() => setStep("payment")}
                disabled={!clientSecret}
                className="px-5 py-2.5 rounded-sm text-sm uppercase tracking-wide"
                style={{
                  fontFamily: "'IBM Plex Mono', monospace",
                  backgroundColor: "#BC4430",
                  color: "#F7F1E3",
                  opacity: clientSecret ? 1 : 0.7,
                }}
              >
                Proceed to payment
              </button>
            </div>
          </div>
        )}

        {step === "payment" && (
          <div className="max-w-sm mx-auto">
            <div
              className="mb-4 px-3 py-2 rounded-sm text-[11px] text-center"
              style={{ backgroundColor: "#F0E9D8", color: "#6B6558", fontFamily: "'IBM Plex Mono', monospace" }}
            >
              {IS_STRIPE_TEST_MODE
                ? "Stripe test mode — use 4242 4242 4242 4242, any future date, any CVC"
                : "Payment is processed securely by Stripe. Your card details never touch our servers."}
            </div>
            <form onSubmit={submitPayment} className="space-y-3">
              <div className="flex items-center gap-2 mb-1">
                <CreditCard size={16} color="#6B6558" />
                <span
                  className="text-sm uppercase tracking-wide"
                  style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6558" }}
                >
                  Payment details
                </span>
              </div>

              <input
                className="w-full px-3 py-2 text-sm rounded-sm"
                style={inputStyle}
                placeholder="Name on card"
                required
                value={billingName}
                onChange={(e) => setBillingName(e.target.value)}
              />

              <div className="px-3 py-3 rounded-sm" style={inputStyle}>
                <CardElement
                  options={{
                    style: {
                      base: {
                        fontSize: "14px",
                        fontFamily: "'Libre Baskerville', serif",
                        color: "#24344A",
                        "::placeholder": { color: "#9C9483" },
                      },
                    },
                  }}
                />
              </div>

              {paymentError && (
                <p className="text-xs" style={{ color: "#BC4430" }}>
                  {paymentError}
                </p>
              )}

              <div
                className="flex justify-between items-center py-3 mt-2"
                style={{ borderTop: "1px solid #D8CFB8" }}
              >
                <span className="text-sm" style={{ color: "#4A4636" }}>
                  Total
                </span>
                <span
                  className="text-base font-medium"
                  style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#24344A" }}
                >
                  {formatPrice(priceCents)}
                </span>
              </div>

              <div className="flex justify-between items-center pt-2">
                <button
                  type="button"
                  onClick={() => setStep("review")}
                  className="flex items-center gap-1 px-4 py-2 text-sm"
                  style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6558" }}
                >
                  <ArrowLeft size={14} /> Back
                </button>
                <button
                  type="submit"
                  disabled={paying || !stripe}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-sm text-sm uppercase tracking-wide"
                  style={{
                    fontFamily: "'IBM Plex Mono', monospace",
                    backgroundColor: "#BC4430",
                    color: "#F7F1E3",
                    opacity: paying ? 0.7 : 1,
                  }}
                >
                  {paying ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                  {paying ? "Processing" : "Pay & mail it"}
                </button>
              </div>
            </form>
          </div>
        )}

        {step === "done" && (
          <div className="max-w-sm mx-auto text-center py-6">
            <CheckCircle2 size={40} color="#3E7C7C" className="mx-auto mb-4" />
            <h2 className="text-xl mb-2" style={{ fontFamily: "'Special Elite', monospace", color: "#24344A" }}>
              On its way
            </h2>
            <p className="text-sm mb-4" style={{ color: "#4A4636" }}>
              Order <span style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{orderId}</span> is confirmed. Your
              postcard is headed to {recipient.name} in {recipient.city}, {recipient.state} — typically 4–6
              business days once it's printed and in the mail.
            </p>
            <div className="flex items-center justify-center gap-2 text-xs mb-6" style={{ color: "#9C9483" }}>
              <MapPin size={12} />
              {recipient.city}, {recipient.state}
            </div>
            <button
              onClick={resetAll}
              className="px-5 py-2.5 rounded-sm text-sm uppercase tracking-wide"
              style={{ fontFamily: "'IBM Plex Mono', monospace", border: "1.5px solid #24344A", color: "#24344A" }}
            >
              Send another postcard
            </button>
          </div>
        )}

        <footer className="mt-12 text-center text-[11px]" style={{ color: "#9C9483" }}>
          Fresh dadjokes, delivered by mail. Pun &amp; Post.
          {" · "}
          <a href="/terms.html" style={{ color: "#9C9483", textDecoration: "underline" }}>
            Terms and Privacy
          </a>
        </footer>
      </div>
    </div>
  );
}

export default function DadJokePostcardApp() {
  return (
    <Elements stripe={stripePromise}>
      <PostcardApp />
    </Elements>
  );
}
