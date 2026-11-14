// Append-only JSONL receipt log. Every quote, refusal, payment, sweep and breaker reset is one line.
// Lines are never rewritten; later events (for example a breaker reset) are new lines.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const STATUS = Object.freeze({
  QUOTE: 'QUOTE',
  REFUSED: 'REFUSED',                       // stopped before signing; nothing was signed
  DELIVERED: 'DELIVERED',                   // paid, 2xx, non-empty body
  PAID_NOT_DELIVERED: 'PAID_NOT_DELIVERED', // seller reported settlement (or 2xx) but the body was empty or an error
  REJECTED_UNPAID: 'REJECTED_UNPAID',       // seller rejected the signed payment and reported no settlement
  UNKNOWN: 'UNKNOWN',                       // signed payment sent, no usable answer (timeout, network error)
});

// Results that may have moved money. They count toward caps (conservative: a signed authorization
// stays valid until validBefore, so even a rejection is counted until proven otherwise).
export const COUNTED = new Set([STATUS.DELIVERED, STATUS.PAID_NOT_DELIVERED, STATUS.REJECTED_UNPAID, STATUS.UNKNOWN]);
// Results that open a seller's circuit breaker.
export const BREAKER_TRIP = new Set([STATUS.PAID_NOT_DELIVERED, STATUS.UNKNOWN]);

export class Ledger {
  constructor(home) {
    this.file = path.join(home, 'receipts.jsonl');
    this.home = home;
  }
  all() {
    if (!fs.existsSync(this.file)) return [];
    return fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
  append(entry) {
    const rec = { id: `r_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`, ts: new Date().toISOString(), ...entry };
    fs.appendFileSync(this.file, JSON.stringify(rec) + '\n', { mode: 0o600, flag: 'a' });
    return rec;
  }
  find(id) { return this.all().find((r) => r.id === id) || null; }

  payments(network) { return this.all().filter((r) => r.kind === 'pay' && r.network === network && COUNTED.has(r.status)); }

  totals(network, now = Date.now()) {
    const pays = this.payments(network);
    const dayAgo = now - 24 * 3600 * 1000;
    const sum = (xs) => Math.round(xs.reduce((a, r) => a + (r.amountUsd || 0), 0) * 1e6) / 1e6;
    const today = pays.filter((r) => Date.parse(r.ts) >= dayAgo);
    return {
      network,
      last24hUsd: sum(today),
      lifetimeUsd: sum(pays),
      topupsLast24hUsd: sum(today.filter((r) => r.topup)),
      payments: pays.length,
      byStatus: pays.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {}),
    };
  }

  // A seller is blocked once it has `threshold` paid-not-delivered/unknown results since its last human reset.
  breaker(network, host, threshold = 1) {
    const evs = this.all().filter((r) => r.network === network && r.host === host);
    let lastReset = -1;
    evs.forEach((r, i) => { if (r.kind === 'breaker_reset') lastReset = i; });
    const trips = evs.slice(lastReset + 1).filter((r) => r.kind === 'pay' && BREAKER_TRIP.has(r.status));
    return { open: trips.length >= threshold, trips: trips.map((r) => r.id) };
  }
  openBreakers(network, threshold = 1) {
    const hosts = [...new Set(this.all().filter((r) => r.network === network && r.host).map((r) => r.host))];
    return hosts.map((h) => ({ host: h, ...this.breaker(network, h, threshold) })).filter((b) => b.open);
  }

  // Idempotency: has this key, or this exact request without a caller key, already led to a signed payment?
  priorPayment(network, { idempotencyKey, requestHash }, windowHours) {
    const since = Date.now() - windowHours * 3600 * 1000;
    return this.all().find((r) => r.kind === 'pay' && r.network === network && COUNTED.has(r.status) && Date.parse(r.ts) >= since
      && ((idempotencyKey && r.idempotencyKey === idempotencyKey) || (!idempotencyKey && r.requestHash === requestHash))) || null;
  }
}

export function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

export function requestHash({ method, url, body }) {
  return sha256(`${String(method).toUpperCase()}\n${url}\n${body ?? ''}`);
}
