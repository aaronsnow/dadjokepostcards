import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Send, ArrowLeft, MapPin, CreditCard, CheckCircle2, Loader2, Mail } from "lucide-react";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, CardElement, useStripe, useElements } from "@stripe/react-stripe-js";

const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || "");

const FONT_IMPORT = `
@import url('https://fonts.googleapis.com/css2?family=Special+Elite&family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&family=IBM+Plex+Mono:wght@400;500&display=swap');
`;

const PRICE_CENTS = 499;
const NOTE_LIMIT = 140;

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

function formatPrice(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

function Postmark({ stamped }) {
  return (
    <div className="relative w-20 h-20 shrink-0">
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
          className="text-[9px] tracking-widest uppercase"
          style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#BC4430" }}
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
    <div className="rounded-sm overflow-hidden" style={{ border: "1px solid #D8CFB8" }}>
      <div className="h-[6px]" style={stripeStyle} />
      <div style={{ backgroundColor: "#F7F1E3" }}>{children}</div>
      <div className="h-[6px]" style={stripeStyle} />
    </div>
  );
}

function PostcardFront({ joke, loading, stamped }) {
  return (
    <AirmailBorder>
      <div className="h-[240px] p-6 flex flex-col justify-between">
        <div className="flex justify-between items-start">
          <span
            className="text-[10px] tracking-[0.2em] uppercase"
            style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6558" }}
          >
            Dept. of Dad Humor
          </span>
          <Postmark stamped={stamped} />
        </div>
        <div className="flex-1 flex items-center justify-center px-2 py-6">
          {loading ? (
            <Loader2 className="animate-spin" size={28} color="#9C9483" />
          ) : (
            <p
              className="text-center text-lg leading-snug"
              style={{ fontFamily: "'Libre Baskerville', serif", color: "#24344A" }}
            >
              {joke}
            </p>
          )}
        </div>
      </div>
    </AirmailBorder>
  );
}

function PostcardBack({ joke, recipient, note, senderName }) {
  return (
    <AirmailBorder>
      <div className="h-[240px] p-5 grid grid-cols-5 gap-4">
        <div className="col-span-3 border-r pr-4 flex flex-col justify-between" style={{ borderColor: "#D8CFB8" }}>
          <p
            className="text-xs italic leading-snug"
            style={{ fontFamily: "'Libre Baskerville', serif", color: "#4A4636" }}
          >
            {note ? note : "No personal note added."}
          </p>
          <p
            className="text-xs"
            style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#24344A" }}
          >
            — {senderName || "A friend"}
          </p>
        </div>
        <div className="col-span-2 flex flex-col justify-between items-end">
          <StampCorner />
          <div
            className="text-right text-[11px] leading-snug"
            style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#24344A" }}
          >
            <div className="font-medium">{recipient.name || "Recipient name"}</div>
            <div>{recipient.line1 || "Street address"}</div>
            {recipient.line2 && <div>{recipient.line2}</div>}
            <div>
              {(recipient.city || "City") + ", " + (recipient.state || "ST") + " " + (recipient.zip || "00000")}
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
  const [joke, setJoke] = useState("");
  const [jokeLoading, setJokeLoading] = useState(false);
  const [jokeError, setJokeError] = useState(false);
  const [stamped, setStamped] = useState(false);

  const [recipient, setRecipient] = useState({ name: "", line1: "", line2: "", city: "", state: "", zip: "" });
  const [sender, setSender] = useState({ name: "" });
  const [note, setNote] = useState("");

  const [clientSecret, setClientSecret] = useState("");
  const [creatingIntent, setCreatingIntent] = useState(false);
  const [paymentError, setPaymentError] = useState("");
  const [paying, setPaying] = useState(false);
  const [orderId, setOrderId] = useState("");

  const fetchJoke = useCallback(async () => {
    setJokeLoading(true);
    setJokeError(false);
    setStamped(false);
    // Try your own backend first (this is the real production path — see
    // /api/joke in server.js). Only fall back to the public demo proxy if
    // no backend is configured, which is the case in this chat preview.
    try {
      if (API_BASE) {
        const res = await fetch(`${API_BASE}/api/joke`);
        if (!res.ok) throw new Error("backend error");
        const data = await res.json();
        setJoke(data.joke);
        return;
      }
      const res = await fetch(DEMO_PROXY, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error("proxy error");
      const data = await res.json();
      if (!data.joke) throw new Error("no joke in response");
      setJoke(data.joke);
    } catch (e) {
      setJokeError(true);
      setJoke(FALLBACK_JOKES[Math.floor(Math.random() * FALLBACK_JOKES.length)]);
    } finally {
      setJokeLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchJoke();
  }, [fetchJoke]);

  const acceptJoke = () => {
    setStamped(true);
    setTimeout(() => setStep("compose"), 380);
  };

  const recipientComplete =
    recipient.name && recipient.line1 && recipient.city && recipient.state && recipient.zip;

  // Called when the user clicks "Proceed to payment" on the review step.
  // Asks the backend to verify the address and start a Stripe PaymentIntent
  // before we ever show a card field.
  const goToPayment = async () => {
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
        body: JSON.stringify({ joke, note, recipient, sender }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not start payment");
      setClientSecret(data.clientSecret);
      setStep("payment");
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
        billing_details: { name: sender.name || recipient.name },
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
    setRecipient({ name: "", line1: "", line2: "", city: "", state: "", zip: "" });
    setSender({ name: "" });
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
            className="text-3xl sm:text-4xl tracking-tight"
            style={{ fontFamily: "'Special Elite', monospace", color: "#24344A" }}
          >
            Pun &amp; Post
          </h1>
          <p className="mt-2 text-sm italic" style={{ color: "#6B6558" }}>
            One groan-worthy joke, mailed to someone who deserves it.
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
            <div className="flex justify-center gap-3 mt-6">
              <button
                onClick={fetchJoke}
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
                className="text-sm uppercase tracking-wide mt-5 mb-3"
                style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6558" }}
              >
                From
              </h2>
              <input
                className="w-full px-3 py-2 text-sm rounded-sm"
                style={inputStyle}
                placeholder="Your name"
                value={sender.name}
                onChange={(e) => setSender({ name: e.target.value })}
              />

              <h2
                className="text-sm uppercase tracking-wide mt-5 mb-2"
                style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6558" }}
              >
                Add a note (optional)
              </h2>
              <textarea
                className="w-full px-3 py-2 text-sm rounded-sm resize-none"
                style={inputStyle}
                rows={3}
                maxLength={NOTE_LIMIT}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="There's room for a short line on the back of the card."
              />
              <p className="text-[11px] text-right mt-1" style={{ color: "#9C9483" }}>
                {note.length}/{NOTE_LIMIT}
              </p>

              <div className="flex justify-between mt-6">
                <button
                  onClick={() => setStep("browse")}
                  className="flex items-center gap-1 px-4 py-2 text-sm"
                  style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6558" }}
                >
                  <ArrowLeft size={14} /> Back
                </button>
                <button
                  onClick={() => setStep("review")}
                  disabled={!recipientComplete}
                  className="px-5 py-2.5 rounded-sm text-sm uppercase tracking-wide"
                  style={{
                    fontFamily: "'IBM Plex Mono', monospace",
                    backgroundColor: recipientComplete ? "#BC4430" : "#D8CFB8",
                    color: "#F7F1E3",
                  }}
                >
                  Review postcard
                </button>
              </div>
            </div>
          </div>
        )}

        {step === "review" && (
          <div>
            <div className="grid sm:grid-cols-2 gap-6">
              <div>
                <p
                  className="text-[11px] uppercase tracking-wide mb-2 text-center"
                  style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#9C9483" }}
                >
                  Front
                </p>
                <PostcardFront joke={joke} loading={false} stamped={true} />
              </div>
              <div>
                <p
                  className="text-[11px] uppercase tracking-wide mb-2 text-center"
                  style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#9C9483" }}
                >
                  Back
                </p>
                <PostcardBack joke={joke} recipient={recipient} note={note} senderName={sender.name} />
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
                {formatPrice(PRICE_CENTS)}
              </span>
            </div>

            {paymentError && (
              <p className="text-xs text-center mt-3 max-w-xs mx-auto" style={{ color: "#BC4430" }}>
                {paymentError}
              </p>
            )}

            <div className="flex justify-between mt-6 max-w-xs mx-auto">
              <button
                onClick={() => setStep("compose")}
                className="flex items-center gap-1 px-4 py-2 text-sm"
                style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6558" }}
              >
                <ArrowLeft size={14} /> Edit
              </button>
              <button
                onClick={goToPayment}
                disabled={creatingIntent}
                className="flex items-center gap-2 px-5 py-2.5 rounded-sm text-sm uppercase tracking-wide"
                style={{
                  fontFamily: "'IBM Plex Mono', monospace",
                  backgroundColor: "#BC4430",
                  color: "#F7F1E3",
                  opacity: creatingIntent ? 0.7 : 1,
                }}
              >
                {creatingIntent ? <Loader2 size={14} className="animate-spin" /> : null}
                {creatingIntent ? "Verifying address…" : "Proceed to payment"}
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
              Stripe test mode — use 4242 4242 4242 4242, any future date, any CVC
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
                  {formatPrice(PRICE_CENTS)}
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
          Fresh dad jokes, delivered by mail. Pun &amp; Post.
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
