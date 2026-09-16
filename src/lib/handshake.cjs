/**
 * handshake.cjs — challenge-response identity for the 1+5 windows.
 *
 * ─── WHY THE PREVIOUS TWO DESIGNS WERE BOTH WRONG ───────────────────────────
 *
 * v1, CONFIRM: the window asserts "I am W3". This is ARP. An unsolicited
 * assertion, believed because it arrived, cached by the asker, with no
 * authority behind it — which is precisely why ARP spoofing works.
 *
 * v2, bearer token: W0 mints a token, sends it, and accepts it back as proof.
 * Better, and still wrong: **W0 is counting as evidence the thing W0 itself
 * supplied.** That is the failure split horizon exists to prevent — a router
 * "confirming" a route that is its own advertisement echoed back. A bearer
 * token also replays forever, so a stale window that kept its token keeps
 * passing.
 *
 * ─── THE GOVERNING PRINCIPLE ────────────────────────────────────────────────
 *
 * Data is not self-verifying. Every bitstring is potentially legitimate, so the
 * only defence is to REDUCE THE SPACE OF ADMISSIBLE STRINGS until an
 * illegitimate one is detectable. A self-authored CONFIRM reduces it not at
 * all: the window can emit any identity claim and all of them parse.
 *
 * So the window no longer authors its confirmation. It answers a question it
 * did not set:
 *
 *     W0 → CHALLENGE(seq, nonce)          nonce freshly minted, single-use
 *     W? → RESPOND(seq, proof)            proof = HMAC(token, seq:nonce)
 *     W0 validates against ITS OWN record of the nonce, then W0 — not the
 *     window — writes the confirmed entry.
 *
 * The asymmetry is the TCP handshake's: anyone can send a SYN, but the ACK must
 * echo a number you never chose. The window cannot author a passing response
 * without having received both the bind (token) and this challenge (nonce).
 *
 * ─── WHAT EACH PIECE BUYS, AND WHAT IT DOES NOT ─────────────────────────────
 *
 *   nonce, single-use      kills replay. A stale window's old proof is dead.
 *   seq, monotonic         orders the exchange; an out-of-order reply aborts.
 *   epoch                  NFS generation number. A respawned window carrying
 *                          the old epoch is a stale handle, detected not
 *                          guessed.
 *   expires_at, soft state DHCP lease, not a permanent record. A binding W0
 *                          stops refreshing decays on its own, so a dead
 *                          window cannot hold identity forever.
 *   asserted_by[]          BGP AS_PATH. Provenance in order, so a claim that
 *                          originates with the window itself shows as a LOOP
 *                          rather than being inferred later by a human.
 *
 * NOT bought, and not claimed: confidentiality. All four windows run as one uid
 * on one machine, so any window can read another's marker or token. This is a
 * CRC against confusion — amnesia, stale respawn, a window acting on a bind it
 * never received — not a MAC against an adversary. There is no adversary here;
 * every observed failure was amnesia or corruption. Right-sized deliberately.
 *
 * ─── THE END-TO-END ARGUMENT ────────────────────────────────────────────────
 *
 * Verification terminates outside the system: DNSSEC ends at a root key you
 * were handed, a CA chain at a cert someone preloaded. Here it ends at the user
 * binding the terminal and W0 possessing an address to speak to. Nothing inside
 * can check the channel it arrived on.
 *
 * So the endpoints that care — the user and W0 — are the only places the check
 * means anything, and everything a window does internally is a hop-by-hop
 * optimisation. The marker file is therefore DEMOTED to a fast-path hint. The
 * registry lookup is the end-to-end check, and it is cheap enough to always
 * run. Never trust the hint when the check disagrees.
 */

'use strict';

const crypto = require('crypto');

// 60 min, raised from 10 on 2026-08-11. W2: "a 10-minute TTL and a protocol
// whose steps can block on the user are in tension — expect expiries whenever I
// have to stop and ask, which is exactly when the handshake matters most." It
// expired a correct proof twice while a window waited on a human answering a
// question. The nonce is still single-use and still W0-chosen, so the property
// that matters is unchanged; only the window in which a REPLAYED nonce could be
// answered widens, and replay is already refused by burning the challenge.
const NONCE_TTL_MS = 60 * 60 * 1000;
const LEASE_MS = 12 * 60 * 60 * 1000;  // soft state: refreshed on every success

/** proof = HMAC(token, "seq:nonce"). The window can compute this; nobody who missed either input can. */
function proofFor(token, seq, nonce) {
  return crypto.createHmac('sha256', String(token))
    .update(`${seq}:${nonce}`)
    .digest('hex')
    .slice(0, 32);
}

function mintChallenge(entry) {
  const seq = (Number.isInteger(entry.seq) ? entry.seq : 0) + 1;
  return {
    seq,
    nonce: crypto.randomBytes(16).toString('hex'),
    issued_at: Date.now(),
    expires_at: Date.now() + NONCE_TTL_MS,
  };
}

/**
 * Validate a response against W0's OWN record. Returns null on success, or a
 * string naming the first failure. Fail-stop: the caller aborts, never proceeds
 * under an unvalidated identity.
 */
function validate(entry, { seq, proof }) {
  const c = entry.pending_challenge;
  if (!c) return 'no outstanding challenge — a response nobody asked for is an ARP announcement, refused';
  if (String(c.seq) !== String(seq)) {
    return `sequence mismatch: challenged ${c.seq}, answered ${seq} — out of order or replayed`;
  }
  if (Date.now() > c.expires_at) {
    return `challenge expired (issued ${new Date(c.issued_at).toISOString()}) — re-challenge; `
         + 'a stale nonce must not be answerable';
  }
  const expected = proofFor(entry.token, c.seq, c.nonce);
  if (expected !== proof) {
    return 'proof mismatch — the response was not computed from this window\'s token and this nonce';
  }
  return null;
}

/**
 * BGP-style loop detection over the provenance path. An identity whose only
 * assertion originates with the window itself is exactly the ARP case, and it
 * becomes visible here instead of being reconstructed by a human afterwards.
 */
function pathProblems(entry) {
  const path = entry.asserted_by || [];
  const out = [];
  const external = path.filter((h) => h.by !== entry.window);
  if (!external.length) {
    out.push(`SELF-LOOP — every assertion of ${entry.window}'s identity originates with `
           + `${entry.window}. No external source. This is the ARP shape.`);
  }
  // Split horizon: W0 must not count back what W0 supplied as independent
  // corroboration. It is a delivery receipt, not a second opinion.
  const nonW0 = external.filter((h) => h.by !== 'W0');
  if (!nonW0.length) {
    out.push('SINGLE SOURCE — W0 is the only external asserter. W0 supplied this identity, so '
           + 'accepting it back is not corroboration (split horizon). Get the user to confirm, '
           + 'or treat the binding as provisional.');
  }
  return out;
}

function isExpired(entry) {
  return !entry.expires_at || Date.now() > Date.parse(entry.expires_at);
}

function renewLease() {
  return new Date(Date.now() + LEASE_MS).toISOString();
}

module.exports = {
  proofFor, mintChallenge, validate, pathProblems, isExpired, renewLease,
  NONCE_TTL_MS, LEASE_MS,
};
