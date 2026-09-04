import { useState, useEffect, useCallback, useRef, useLayoutEffect } from "react";
import { RefreshCw, Send, ArrowLeft, CreditCard, CheckCircle2, Loader2, Share2, Copy } from "lucide-react";
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

// Fallback values only, used until /api/config responds (or if it fails) —
// the backend is the real source of truth for all of these now (see
// /api/config in server.js), fetched once on load via the config state
// below. This eliminates the old failure mode of updating one of these in
// server.js and forgetting to also update it here.
//
// terms.html is the one remaining place NOT covered by this — it's a
// static file, not part of this React app, so it still has its own
// hand-written copy of the charity pledge language. Keep that in sync by
// hand if the charity or amount ever changes.
const DEFAULT_NOTE_LIMIT = 280;
const DEFAULT_CHARITY_NAME = "the Jazz Foundation of America";
const DEFAULT_CHARITY_URL = "https://jazzfoundation.org";
const DEFAULT_CHARITY_PER_CARD = "$2";
const DEFAULT_RETURN_ADDRESS = { name: "Pun & Post", line1: "", city: "Smallville", state: "KS", zip: "66002" };

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

// Matches Tailwind's "sm" breakpoint (640px), already used elsewhere in this
// file (e.g. the step labels) as the mobile/desktop line. Used for postcard
// preview elements that need different sizing above vs. below that width —
// see PostcardFront and PostcardBack.
function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(
    typeof window !== "undefined" ? window.innerWidth >= 640 : true
  );
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 640px)");
    const onChange = () => setIsDesktop(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return isDesktop;
}

// A second, narrower breakpoint below the general mobile/desktop split
// above. 360px sits between the Galaxy Z Fold 5's folded width (344px,
// needs this) and the iPhone SE's (375px, doesn't) — the narrowest and
// second-narrowest devices checked against this preview.
function useIsUltraNarrow() {
  const [isUltraNarrow, setIsUltraNarrow] = useState(
    typeof window !== "undefined" ? window.innerWidth < 360 : false
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 359px)");
    const onChange = () => setIsUltraNarrow(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return isUltraNarrow;
}

// Mirrors insertPunchlineBreaks in the backend's server.js — keep both in
// sync if this pattern changes. Breaks after each sentence-ending
// punctuation mark, optionally followed by a closing quote, so the
// punchline lands on its own line even though the joke API doesn't
// provide one itself.
function insertPunchlineBreaks(text) {
  if (!text) return text;
  // A run of 2+ periods used as a dramatic pause (". . . ." or "......")
  // needs to survive intact — some jokes' punchline depends on actually
  // seeing the pause. Temporarily swap the spacing within such a run for
  // a placeholder that won't match the split below, then restore it
  // afterward, so the dots stay together as one unbroken run.
  const PAUSE_PLACEHOLDER = "\u0000";
  const guarded = text.replace(/(?:\.\s*){2,}/g, (run) => run.replace(/\s/g, PAUSE_PLACEHOLDER));
  const withBreaks = guarded.replace(/([.?!]['"\u2019\u201D]?)\s+/g, "$1\n");
  return withBreaks.split(PAUSE_PLACEHOLDER).join(" ");
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

function AirmailBorder({ children }) {
  const stripeStyle = {
    backgroundImage:
      "repeating-linear-gradient(-45deg, #BC4430 0 12px, #F7F1E3 12px 18px, #24344A 18px 30px, #F7F1E3 30px 36px)",
  };
  return (
    <div className="rounded-sm overflow-hidden aspect-[3/2] flex flex-col" style={{ border: "1px solid #D8CFB8" }}>
      <div className="h-[12px] shrink-0" style={stripeStyle} />
      <div className="flex-1 min-h-0" style={{ backgroundColor: "#F7F1E3" }}>{children}</div>
      <div className="h-[12px] shrink-0" style={stripeStyle} />
    </div>
  );
}

function PostcardFront({ joke, loading, stamped, size = "normal" }) {
  const contentRef = useRef(null);
  const fitScale = useFitScale(contentRef, [joke, loading], 0.5);
  const isDesktop = useIsDesktop();
  const isLarge = size === "large";
  const isCompose = size === "compose";

  // Three variants, each in a different container width, each needing
  // different desktop sizing:
  // - "large" (browse step, shown alone at full width): full, undiminished
  //   size — the big hero preview.
  // - "compose" (Address it step, sharing a 5-column grid with the form):
  //   a moderate reduction — this column is narrower than "large" but
  //   wider than "normal" ends up looking right at.
  // - "normal" (Review step, a 2-column grid split with the back of the
  //   card): the most reduced — this is also where the stamp specifically
  //   needed an *extra* reduction on top of the shared scale, since it was
  //   disproportionately large relative to the label/joke there. Compose
  //   didn't have that problem — its stamp scales evenly with the rest.
  // All still multiply by fitScale, so a long joke still auto-shrinks to
  // fit rather than overflowing.
  const deskScale = !isDesktop ? 1 : isLarge ? 1 : isCompose ? 0.88 : 0.78;
  const scale = fitScale * deskScale;
  const labelPx = isLarge && isDesktop ? 14 * fitScale : 10 * scale;
  const jokePx = isLarge && isDesktop ? 24 * fitScale : 18 * scale;
  const stampScale = isLarge && isDesktop
    ? fitScale * 1.35
    : isDesktop && !isCompose
      ? scale * 0.825 // ~17.5% smaller than label/joke — review-specific fix
      : scale;

  return (
    <AirmailBorder>
      <div ref={contentRef} className={`h-full min-h-0 ${isLarge ? "p-6" : "p-4"} flex flex-col justify-between`}>
        <div className="flex justify-between items-start">
          <span
            className="tracking-[0.2em] uppercase"
            style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6558", fontSize: `${labelPx}px` }}
          >
            Dept. of Questionable Humor
          </span>
          <Postmark stamped={stamped} scale={stampScale} />
        </div>
        <div className="flex-1 flex items-center justify-center px-2 pt-2 pb-6">
          {loading ? (
            <Loader2 className="animate-spin" size={28} color="#9C9483" />
          ) : (
            <p
              className="text-center leading-snug"
              style={{
                fontFamily: "'Libre Baskerville', serif",
                color: "#24344A",
                fontSize: `${jokePx}px`,
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

function PostcardBack({ joke, recipient, note, charityName, charityUrl, charityPerCard, returnAddress }) {
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
  const isDesktop = useIsDesktop();
  const isUltraNarrow = useIsUltraNarrow();
  // Fixed sizes, deliberately NOT multiplied by fitScale. This text is
  // constant app copy, not user-entered content — it doesn't need to
  // participate in the auto-shrink-to-fit mechanism meant for
  // unpredictable note/address length. (Previously multiplying by
  // fitScale caused a second, unwanted shrink on top of these already-
  // correct target sizes whenever fitScale legitimately dropped for OTHER
  // reasons — e.g. a long note — in the same card.)
  const taglineBasePx = isDesktop ? 6 : isUltraNarrow ? 5 : 6;
  const jfaBasePx = isDesktop ? 5.36 : isUltraNarrow ? 5 : 6;

  return (
    <AirmailBorder>
      <div ref={contentRef} className="h-full min-h-0 p-2 pb-0 relative">
        <div className="h-full flex gap-3">
          <div style={{ flexBasis: "40%" }} className="min-w-0">
            {note && (
              <p
                className="italic leading-snug"
                style={{
                  fontFamily: "'Libre Baskerville', serif",
                  color: "#4A4636",
                  fontSize: isDesktop ? `${12 * fitScale}px` : isUltraNarrow ? "9px" : "10px",
                  overflowWrap: "break-word",
                }}
              >
                {note}
              </p>
            )}
          </div>
          <div style={{ flexBasis: "58%" }} className="min-w-0 flex flex-col items-end">
            <p
              className="font-medium leading-snug tracking-wide text-right"
              style={{
                fontFamily: "'IBM Plex Mono', monospace",
                color: "#BC4430",
                fontSize: `${taglineBasePx}px`,
              }}
            >
              Somebody paid to send you this groaner. You can
              <br />
              return the favor at <span style={{ fontWeight: 700 }}>dadjokepostcards.com</span>
            </p>
            <p
              className="leading-snug tracking-wide text-right italic"
              style={{
                fontFamily: "'IBM Plex Mono', monospace",
                color: "#605A4F",
                fontSize: `${jfaBasePx}px`,
                marginTop: "12px",
              }}
            >
              {charityPerCard} of every card sold goes to
              <br />
              <span style={{ color: "#196A9C" }}>{charityName}</span>
            </p>
          </div>
        </div>

        {/* Approximates Lob's auto-placed address block: white background,
            flush bottom-right, overlapping the top half of the bottom
            stripe. This is illustrative only — Lob positions the real one
            automatically; we don't control it, just try to preview it
            accurately.

            Fixed target sizes below, not multiplied by fitScale — same
            reasoning as the tagline/JFA text: fitScale dropping to its own
            0.75 floor was silently shrinking these on top of already-
            correct target sizes (the exact 4.5px/30x24 vs. intended
            6px/40x32 mismatch that surfaced this). Only the destination
            address on desktop is left fitScale-linked, since that's
            unbounded user-entered text that may need to shrink to avoid
            overflowing the block; the return address and stamp are fixed
            content/shape, same as the tagline case. */}
        <div
          className="absolute flex flex-col"
          style={{
            right: `${6 * fitScale}px`,
            bottom: "-6px", // half of AirmailBorder's 12px stripe height
            width: "53%",
            height: "65%",
            backgroundColor: "#FFFFFF",
            padding: isDesktop
              ? `${12 * fitScale}px ${15 * fitScale}px ${4.5 * fitScale}px ${6 * fitScale}px`
              : "12px 12px 9px 12px",
          }}
        >
          <div className="flex justify-between items-start gap-2">
            <div
              className="text-left leading-tight uppercase"
              style={{
                fontFamily: "Arial, sans-serif",
                color: "#000000",
                fontSize: "6px",
              }}
            >
              {returnAddress.name || "Return address"}
              <br />
              {returnAddress.line1 && (
                <>
                  {returnAddress.line1}
                  <br />
                </>
              )}
              {returnAddress.city || "City"}, {returnAddress.state || "ST"} {returnAddress.zip || "00000"}
            </div>
            <div
              className="shrink-0"
              style={{
                width: isDesktop ? "45px" : "40px",
                height: isDesktop ? "36px" : "32px",
                border: "1px dashed #9C9483",
              }}
            />
          </div>
          <div
            className="text-left leading-snug uppercase"
            style={{
              fontFamily: "Arial, sans-serif",
              color: "#000000",
              fontSize: isDesktop ? `${10 * fitScale}px` : "7.5px",
              marginTop: isDesktop ? "3em" : "1em",
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
    </AirmailBorder>
  );
}

function StepLabel({ n, active, done, children }) {
  return (
    <div className="flex items-center gap-2" aria-current={active ? "step" : undefined}>
      <div
        aria-hidden="true"
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
        className="text-[11px] uppercase tracking-wide sr-only sm:not-sr-only sm:inline"
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
  const [linkCopied, setLinkCopied] = useState(false);

  const shareData = {
    title: "Pun & Post",
    text: "I just mailed a real postcard with a dad joke on it — check out Pun & Post.",
    url: window.location.origin,
  };

  const handleNativeShare = async () => {
    try {
      await navigator.share(shareData);
    } catch (err) {
      // User canceled the share sheet, or it failed silently — either
      // way, nothing useful to show them, so just do nothing.
    }
  };

  const handleCopyLink = async () => {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(shareData.url);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch (err) {
      // Clipboard write failed (permissions, older browser) — nothing
      // more we can reasonably do here.
    }
  };


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

  const [config, setConfig] = useState({
    noteLimit: DEFAULT_NOTE_LIMIT,
    charityName: DEFAULT_CHARITY_NAME,
    charityUrl: DEFAULT_CHARITY_URL,
    charityPerCard: DEFAULT_CHARITY_PER_CARD,
    returnAddress: DEFAULT_RETURN_ADDRESS,
  });

  useEffect(() => {
    if (!API_BASE) return; // demo/preview context — just use the defaults
    fetch(`${API_BASE}/api/config`)
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => {
        setConfig((prev) => ({
          noteLimit: typeof data.noteLimit === "number" ? data.noteLimit : prev.noteLimit,
          charityName: data.charityName || prev.charityName,
          charityUrl: data.charityUrl || prev.charityUrl,
          charityPerCard: data.charityPerCard || prev.charityPerCard,
          returnAddress: data.returnAddress || prev.returnAddress,
        }));
      })
      .catch(() => {
        // Keep the defaults above — same reasoning as the price fetch.
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
        // VITE_TEST_LONG_JOKES is a local-dev-only convenience — set it in
        // your own .env, never in Railway's env vars for staging/production
        // (the backend independently refuses to honor this outside local
        // dev regardless, via isLocalDev in server.js, but there's no
        // reason to rely on that as the only safeguard).
        const longParam = import.meta.env.VITE_TEST_LONG_JOKES ? "?long=1" : "";
        const res = await fetch(`${API_BASE}/api/joke${longParam}`);
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
          <p className="mt-2 text-sm italic" style={{ color: "#605A4F" }}>
            One groan-worthy joke, mailed to someone who deserves it: {formatPrice(priceCents)}
          </p>
          <p
            className="mt-2 text-[11px] tracking-wide"
            style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#24344A" }}
          >
            {config.charityPerCard} of every card sold goes to{" "}
            <a
              href={config.charityUrl}
              target="_blank"
              rel="noopener"
              style={{ color: "#24344A", textDecoration: "underline" }}
            >
              {config.charityName}
            </a>
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
            <PostcardFront joke={joke} loading={jokeLoading} stamped={stamped} size="large" />
            {jokeError && (
              <p className="text-xs text-center mt-3" style={{ color: "#9F3928" }}>
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
              <PostcardFront joke={joke} loading={false} stamped={true} size="compose" />
            </div>
            <div className="sm:col-span-3">
              <h2
                className="text-sm uppercase tracking-wide mb-3"
                style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#605A4F" }}
              >
                Who's it going to?
              </h2>
              <div className="grid grid-cols-2 gap-3">
                <label htmlFor="recipient-name" className="sr-only">Recipient name</label>
                <input
                  id="recipient-name"
                  className="col-span-2 px-3 py-2 text-sm rounded-sm"
                  style={inputStyle}
                  placeholder="Recipient name"
                  maxLength={40}
                  value={recipient.name}
                  onChange={(e) => setRecipient({ ...recipient, name: e.target.value })}
                />
                <label htmlFor="recipient-line1" className="sr-only">Street address</label>
                <input
                  id="recipient-line1"
                  className="col-span-2 px-3 py-2 text-sm rounded-sm"
                  style={inputStyle}
                  placeholder="Street address"
                  maxLength={40}
                  value={recipient.line1}
                  onChange={(e) => setRecipient({ ...recipient, line1: e.target.value })}
                />
                <label htmlFor="recipient-line2" className="sr-only">Apartment or unit (optional)</label>
                <input
                  id="recipient-line2"
                  className="col-span-2 px-3 py-2 text-sm rounded-sm"
                  style={inputStyle}
                  placeholder="Apt / unit (optional)"
                  maxLength={40}
                  value={recipient.line2}
                  onChange={(e) => setRecipient({ ...recipient, line2: e.target.value })}
                />
                <label htmlFor="recipient-city" className="sr-only">City</label>
                <input
                  id="recipient-city"
                  className="px-3 py-2 text-sm rounded-sm"
                  style={inputStyle}
                  placeholder="City"
                  maxLength={40}
                  value={recipient.city}
                  onChange={(e) => setRecipient({ ...recipient, city: e.target.value })}
                />
                <label htmlFor="recipient-state" className="sr-only">State</label>
                <input
                  id="recipient-state"
                  className="px-3 py-2 text-sm rounded-sm"
                  style={inputStyle}
                  placeholder="State"
                  maxLength={2}
                  value={recipient.state}
                  onChange={(e) => setRecipient({ ...recipient, state: e.target.value })}
                />
                <label htmlFor="recipient-zip" className="sr-only">ZIP code</label>
                <input
                  id="recipient-zip"
                  className="col-span-2 px-3 py-2 text-sm rounded-sm"
                  style={inputStyle}
                  placeholder="ZIP code"
                  maxLength={10}
                  value={recipient.zip}
                  onChange={(e) => setRecipient({ ...recipient, zip: e.target.value })}
                />
              </div>

              <h2
                className="text-sm uppercase tracking-wide mt-5 mb-2"
                style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#605A4F" }}
              >
                Add a note (optional — don't forget to sign it!)
              </h2>
              <label htmlFor="postcard-note" className="sr-only">Note to include on the postcard</label>
              <textarea
                id="postcard-note"
                className="w-full px-3 py-2 text-sm rounded-sm resize-none"
                style={inputStyle}
                rows={4}
                maxLength={config.noteLimit}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Wish you were here! Miss you already. Love, Dad"
              />
              <p className="text-[11px] text-right mt-1" style={{ color: "#6B5B45" }}>
                {note.length}/{config.noteLimit}
              </p>

              {paymentError && (
                <p className="text-xs mt-3" style={{ color: "#9F3928" }}>
                  {paymentError}
                  {paymentError.includes("isn't allowed") && (
                    <>
                      {" "}
                      <a
                        href="/terms.html#content-policy"
                        target="_blank"
                        rel="noopener"
                        style={{ color: "#9F3928", textDecoration: "underline" }}
                      >
                        See our content policy
                      </a>
                    </>
                  )}
                </p>
              )}

              <div className="flex justify-between mt-6">
                <button
                  onClick={() => setStep("browse")}
                  className="flex items-center gap-1 px-4 py-2 text-sm"
                  style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#605A4F" }}
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
                  style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#656055" }}
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
                  style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#656055" }}
                >
                  Back
                </p>
                <div className="flex-1">
                  <PostcardBack
                    joke={joke}
                    recipient={recipient}
                    note={note}
                    charityName={config.charityName}
                    charityUrl={config.charityUrl}
                    charityPerCard={config.charityPerCard}
                    returnAddress={config.returnAddress}
                  />
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
                style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#605A4F" }}
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
                <CreditCard size={16} color="#605A4F" />
                <span
                  className="text-sm uppercase tracking-wide"
                  style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#605A4F" }}
                >
                  Payment details
                </span>
              </div>

              <label htmlFor="billing-name" className="sr-only">Name on card</label>
              <input
                id="billing-name"
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
                        "::placeholder": { color: "#656055" },
                      },
                    },
                  }}
                />
              </div>

              {paymentError && (
                <p className="text-xs" style={{ color: "#9F3928" }}>
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
                  style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#605A4F" }}
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
            <p className="text-sm mb-6" style={{ color: "#4A4636" }}>
              Order <span style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{orderId}</span> is confirmed:
              Your postcard is headed to {recipient.name} in {recipient.city}, {recipient.state}.
            </p>
            <p
              className="text-sm mb-6"
              style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#4A4636" }}
            >
              Thank you, and, no joke, thanks for supporting{" "}
              <a
                href={config.charityUrl}
                target="_blank"
                rel="noopener"
                style={{ color: "#4A4636", textDecoration: "underline" }}
              >
                {config.charityName}
              </a>
              !
            </p>
            <button
              onClick={resetAll}
              className="px-5 py-2.5 rounded-sm text-sm uppercase tracking-wide"
              style={{ fontFamily: "'IBM Plex Mono', monospace", border: "1.5px solid #24344A", color: "#24344A", marginTop: "1em" }}
            >
              Send another postcard
            </button>
            <p
              className="text-xs"
              style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#656055", marginTop: "1em" }}
            >
              Know someone who'd love this?
            </p>
            <div className="flex items-center justify-center gap-4" style={{ marginTop: "0.4em" }}>
              {typeof navigator !== "undefined" && navigator.share && (
                <button
                  onClick={handleNativeShare}
                  className="flex items-center gap-1.5 text-xs font-medium"
                  style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#316363" }}
                >
                  <Share2 size={12} />
                  Share
                </button>
              )}
              <button
                onClick={handleCopyLink}
                className="flex items-center gap-1.5 text-xs font-medium"
                style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#316363" }}
              >
                <Copy size={12} />
                {linkCopied ? "Copied!" : "Copy link"}
              </button>
            </div>
          </div>
        )}

        <footer className="mt-12 text-center text-[11px]" style={{ color: "#656055" }}>
          Fresh dadjokes, delivered by mail. Pun &amp; Post.
          &nbsp; &nbsp;
          <a href="/terms.html" target="_blank" rel="noopener" style={{ color: "#656055", textDecoration: "underline" }}>
            Terms and Privacy
          </a>
          {" | "}
          <a href="/terms.html#built-with" target="_blank" rel="noopener" style={{ color: "#656055", textDecoration: "underline" }}>
            Built With
          </a>
          {" | "}
          <a href="/terms.html#contact" target="_blank" rel="noopener" style={{ color: "#656055", textDecoration: "underline" }}>
            Contact
          </a>
          {" | "}
          <a
            href="https://github.com/aaronsnow/dadjokepostcards"
            target="_blank"
            rel="noopener"
            style={{ color: "#656055", textDecoration: "underline" }}
          >
            GitHub
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
