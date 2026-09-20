#!/usr/bin/env node
/**
 * bind.cjs — the window registry, and the trust anchor.
 *
 * THREE DESIGNS, TWO OF THEM WRONG. The protocol lives in lib/handshake.cjs;
 * this file is the registry and the CLI. Read that header for the full
 * reasoning — the short version:
 *
 *   v1 CONFIRM        the window asserts "I am W3". This is ARP: an
 *                     unsolicited assertion, believed because it arrived,
 *                     cached by the asker, no authority behind it.
 *   v2 bearer token   W0 mints a token, sends it, accepts it back as proof.
 *                     **W0 counting as evidence the thing W0 supplied** — the
 *                     split-horizon failure — and replayable forever.
 *   v3 challenge      W0 issues a single-use nonce; the window returns
 *                     HMAC(token, seq:nonce); W0 validates against its OWN
 *                     record and W0 writes the entry. The window can no longer
 *                     author its confirmation, only pass or fail a test it did
 *                     not set. The TCP-handshake asymmetry.
 *
 * IDENTITY COMES FROM THE HANDLE, NOT THE PAYLOAD. A kernel never asks a
 * process who it is — getpid() returns a value the kernel already held. W0's
 * belief comes from the address it can speak to, recorded here. Nothing a
 * window says about itself enters the record.
 *
 * SOFT STATE. Bindings are a DHCP lease, not a permanent fact: `expires_at` is
 * renewed only by a successful handshake, so a binding W0 stops refreshing
 * decays on its own and a dead window cannot hold an identity forever.
 *
 * PROVENANCE IS A PATH VECTOR. `asserted_by[]` is BGP's AS_PATH — who asserted
 * this identity, in order. A claim originating with the window itself shows as
 * a SELF-LOOP, and W0 being the only external asserter shows as SINGLE SOURCE,
 * because W0 accepting back what it supplied is not corroboration.
 *
 * THE TRUST ANCHOR — the residue that genuinely stays.
 *   Verification has to terminate somewhere outside the system: DNSSEC ends at
 *   a root key you were handed, a CA chain at a preloaded cert. Here it ends at
 *   **spawn-time channel possession plus the user's binding** — W0 believes
 *   what it believes because of what it can address, and because the user bound
 *   the terminal. Nothing inside can check the channel it arrived on; you
 *   cannot verify the kernel from inside the kernel.
 *
 *   Everything downstream reduces to that anchor. Two independent sources is
 *   what caught D4, when they disagreed.
 *
 * SCOPE, STATED NOT OVERCLAIMED. All four windows run as one uid on one machine
 * with the vault at 0755, so no marker or token is confidential. This is a CRC
 * against confusion — amnesia, stale respawn, a window acting on a bind it never
 * received — not a MAC against an adversary. There is no adversary here; every
 * observed failure was amnesia or corruption.
 *
 * USAGE
 *   bind.cjs mint W2 --address uds:/tmp/cc-socks/21978.sock [--by user]
 *   bind.cjs challenge W2                  → CHALLENGE(seq, nonce) to send
 *   bind.cjs respond W2 --seq N --proof X  → W0 validates and writes the entry
 *   bind.cjs show [W2] · verify W2 --epoch N --token T · revoke W2
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const hs = require(path.join(__dirname, 'lib', 'handshake.cjs'));

const ORCH = __dirname;
const DEFAULT_PROJECT = process.env.ORCH_PROJECT || 'cleaning';

function loadConfig(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ORCH, 'projects', `${name}.json`), 'utf8'));
  } catch (e) {
    process.stderr.write(`bind: no usable adapter '${name}'\n`);
    process.exit(2);
  }
}

function registryFile(cfg) {
  const dir = path.join(cfg.vault, '.claude', 'claims');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, '_registry.json');
}

function readRegistry(cfg) {
  try { return JSON.parse(fs.readFileSync(registryFile(cfg), 'utf8')); } catch (e) { return {}; }
}

function writeRegistry(cfg, reg) {
  fs.writeFileSync(registryFile(cfg), `${JSON.stringify(reg, null, 2)}\n`, { mode: 0o600 });
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) { out[a.slice(2)] = argv[++i]; continue; }
    out._.push(a);
  }
  return out;
}

function cmdMint(cfg, args) {
  const w = args._[1];
  if (!w || !cfg.windows[w]) {
    process.stderr.write(`bind: unknown window '${w}'. Known: ${Object.keys(cfg.windows).join(' ')}\n`);
    process.exit(2);
  }
  if (!args.address) {
    process.stderr.write('bind: --address is required. Identity derives from the handle W0 addresses,\n'
      + '      never from what a window says about itself.\n');
    process.exit(2);
  }
  const reg = readRegistry(cfg);
  const prev = reg[w];
  const epoch = (prev && Number.isInteger(prev.epoch) ? prev.epoch : 0) + 1;
  const token = crypto.randomBytes(12).toString('hex');

  reg[w] = {
    window: w,
    address: args.address,
    epoch,
    token,
    bound_at: new Date().toISOString(),
    bound_by: args.by || 'user',      // the second independent source
    supersedes: prev ? { epoch: prev.epoch, address: prev.address } : null,
    seq: 0,
    pending_challenge: null,
    expires_at: hs.renewLease(),        // soft state — a lease, not a permanent record
    asserted_by: [{ by: args.by || 'user', how: 'terminal binding', at: new Date().toISOString() }],
  };
  writeRegistry(cfg, reg);

  process.stdout.write(
    `bound ${w} · epoch ${epoch} · ${args.address}\n\n`
    + `Deliver OVER THE CHANNEL (not the filesystem — every window shares this uid):\n\n`
    + `  You are ${w}, epoch ${epoch}. Write this to .orchestrator/window in every worktree,\n`
    + `  before your first commit:\n\n`
    + `    {"window":"${w}","epoch":${epoch},"token":"${token}"}\n\n`
    + (prev ? `WARNING:  supersedes epoch ${prev.epoch} at ${prev.address} — any claim or marker carrying\n`
            + `    the old epoch is now STALE and will be refused.\n` : ''));
}

function cmdShow(cfg, args) {
  const reg = readRegistry(cfg);
  const only = args._[1];
  const rows = Object.values(reg).filter((r) => !only || r.window === only);
  if (!rows.length) { process.stdout.write('no bindings\n'); return; }
  for (const r of rows) {
    process.stdout.write(`${r.window}  epoch ${r.epoch}  ${r.address}  bound_by ${r.bound_by}  ${r.bound_at}\n`);
  }
}

/** W0 → CHALLENGE(seq, nonce). Single-use, short-lived, recorded on W0's side. */
function cmdChallenge(cfg, args) {
  const w = args._[1];
  const reg = readRegistry(cfg);
  const e = reg[w];
  if (!e) { process.stdout.write(`REFUSED — no binding for '${w}'. Mint one first.\n`); process.exit(1); }

  const c = hs.mintChallenge(e);
  e.pending_challenge = c;
  e.seq = c.seq;
  writeRegistry(cfg, reg);

  process.stdout.write(
    `CHALLENGE issued to ${w} · seq ${c.seq} · expires in ${Math.round(hs.NONCE_TTL_MS / 60000)}m\n\n`
    + `Send OVER THE CHANNEL to ${e.address}:\n\n`
    + `  CHALLENGE seq=${c.seq} nonce=${c.nonce}\n`
    + `  Reply: RESPOND seq=${c.seq} proof=HMAC-SHA256(key=<your token>, msg="${c.seq}:${c.nonce}")[:32]\n`
    + `    node -e 'console.log(require("crypto").createHmac("sha256",process.argv[1])`
    + `.update(process.argv[2]).digest("hex").slice(0,32))' <token> "${c.seq}:${c.nonce}"\n\n`
    + `The window cannot author a passing answer: it needs the token (from its bind) AND this\n`
    + `nonce (which it did not choose). W0 validates against its own record and writes the entry.\n`);
}

/** W? → RESPOND(seq, proof). W0 validates and — crucially — W0 writes the result. */
function cmdRespond(cfg, args) {
  const w = args._[1];
  const reg = readRegistry(cfg);
  const e = reg[w];
  if (!e) { process.stdout.write(`REFUSED — no binding for '${w}'\n`); process.exit(1); }

  const bad = hs.validate(e, { seq: args.seq, proof: args.proof });
  if (bad) {
    process.stdout.write(`REFUSED — ${w} failed the handshake\n  ${bad}\n`);
    e.pending_challenge = null;          // burn it either way; a nonce is single-use
    writeRegistry(cfg, reg);
    process.exit(1);
  }

  // The window never writes this entry. It only passes or fails a test it did
  // not set — the whole point of the asymmetry.
  e.pending_challenge = null;
  e.expires_at = hs.renewLease();
  e.last_verified = new Date().toISOString();
  e.asserted_by = (e.asserted_by || []).concat([{ by: 'W0', how: 'challenge-response', at: e.last_verified }]);
  writeRegistry(cfg, reg);

  const warn = hs.pathProblems(e);
  process.stdout.write(`ok — ${w} answered seq ${args.seq} correctly. Lease renewed to ${e.expires_at}.\n`);
  if (warn.length) process.stdout.write(warn.map((x) => `WARNING:  ${x}`).join('\n') + '\n');
}

/**
 * Integrity check, not authentication. Returns non-zero on any mismatch so a
 * caller can fail-stop.
 */
function cmdVerify(cfg, args) {
  const w = args._[1];
  const reg = readRegistry(cfg);
  const r = reg[w];
  if (!r || r.revoked) {
    process.stdout.write(`REFUSED — ${r && r.revoked ? `binding for '${w}' was REVOKED at epoch ${r.epoch}` : `no binding recorded for '${w}'`}. W0 has no live handle for it.\n`);
    process.exit(1);
  }
  const problems = [];
  if (args.epoch !== undefined && String(r.epoch) !== String(args.epoch)) {
    problems.push(`epoch mismatch: registry ${r.epoch}, presented ${args.epoch} — STALE HANDLE. `
      + `The window respawned or was re-bound; its channel became a lie.`);
  }
  if (args.token !== undefined && r.token !== args.token) {
    problems.push('token mismatch: presented value was not the one delivered to this window\'s address.');
  }
  if (problems.length) {
    process.stdout.write(`REFUSED — ${w}\n  ${problems.join('\n  ')}\n`);
    process.exit(1);
  }
  process.stdout.write(`ok — ${w} epoch ${r.epoch} matches the registry (integrity, not authentication)\n`);
}

function cmdRevoke(cfg, args) {
  const w = args._[1];
  const reg = readRegistry(cfg);
  if (!reg[w]) { process.stdout.write(`no binding for ${w}\n`); return; }
  // TOMBSTONE, never delete. D18 (2026-08-11): revoke used to `delete reg[w]`,
  // which destroyed the epoch counter — so the next mint restarted at 1 and a
  // stale marker from the PREVIOUS epoch-1 binding would validate against the
  // NEW one. A generation number that can repeat is not a generation number;
  // that is the whole property an NFS filehandle's generation count exists to
  // provide. The entry is kept, marked revoked, and its epoch preserved so the
  // next mint continues the sequence.
  const prev = reg[w];
  reg[w] = {
    window: w,
    revoked: true,
    revoked_at: new Date().toISOString(),
    epoch: prev.epoch,          // preserved: the next mint is epoch+1, never 1 again
    address: prev.address || null,
    token: null,                // the credential is destroyed; the counter is not
    pending_challenge: null,
    asserted_by: prev.asserted_by || [],
  };
  writeRegistry(cfg, reg);
  process.stdout.write(`revoked ${w} at epoch ${prev.epoch} — credential destroyed, counter preserved.\n`
    + `Next mint will be epoch ${prev.epoch + 1}; any marker carrying ${prev.epoch} is now refused.\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig(args.project || DEFAULT_PROJECT);
  switch (args._[0]) {
    case 'mint': return cmdMint(cfg, args);
    case 'show': return cmdShow(cfg, args);
    case 'challenge': return cmdChallenge(cfg, args);
    case 'respond': return cmdRespond(cfg, args);
    case 'verify': return cmdVerify(cfg, args);
    case 'revoke': return cmdRevoke(cfg, args);
    default:
      process.stderr.write('usage: bind.cjs mint W2 --address <addr> [--by user]\n'
        + '       bind.cjs challenge W2\n'
        + '       bind.cjs respond W2 --seq N --proof X\n'
        + '       bind.cjs show [W2]\n'
        + '       bind.cjs verify W2 --epoch N --token T\n'
        + '       bind.cjs revoke W2\n');
      process.exit(2);
  }
}

if (require.main === module) main();
module.exports = { readRegistry, registryFile, loadConfig };
