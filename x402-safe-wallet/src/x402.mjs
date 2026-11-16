// Minimal x402 "exact" scheme support for EVM: parse a 402, pick an option, sign an EIP-3009 authorization.
// Only plain transferWithAuthorization on USDC is supported. No approvals, no Permit2, no permits, no "upto".
import { getAddress, toHex } from 'viem';

export function decodeB64Json(s) { return JSON.parse(Buffer.from(s, 'base64').toString('utf8')); }
export function encodeB64Json(o) { return Buffer.from(JSON.stringify(o)).toString('base64'); }

// Returns the parsed PaymentRequired object (v1 body or v2 header), or throws.
export function parsePaymentRequired(headers, bodyText) {
  const h = headers.get('payment-required');
  if (h) return decodeB64Json(h);
  const j = JSON.parse(bodyText);
  if (!j || !Array.isArray(j.accepts)) throw new Error('402 response has no accepts list');
  return j;
}

export function optionAmount(o) { return BigInt(o.amount ?? o.maxAmountRequired); }

// Explains, for every option the seller offered, whether this wallet will use it and why not.
export function classifyOptions(pr, net) {
  return (pr.accepts || []).map((o, index) => {
    const why = [];
    if (o.scheme !== 'exact') why.push(`scheme ${o.scheme} (only "exact")`);
    if (!(o.network === net.caip2 || o.network === net.v1Name)) why.push(`network ${o.network} (wallet is on ${net.caip2})`);
    let asset = null; try { asset = getAddress(o.asset); } catch { why.push('asset is not an EVM address'); }
    if (asset && asset !== getAddress(net.usdc)) why.push('asset is not Circle USDC for this network');
    if (!net.usdcDomainNames.includes(o.extra?.name) || o.extra?.version !== '2') why.push('EIP-712 domain is not USDC v2');
    if (o.extra?.assetTransferMethod && o.extra.assetTransferMethod !== 'eip3009') why.push(`transfer method ${o.extra.assetTransferMethod} (only eip3009)`);
    try { getAddress(o.payTo); } catch { why.push('payTo is not an EVM address'); }
    let amountAtomic = null; try { amountAtomic = optionAmount(o); if (amountAtomic <= 0n) why.push('amount is not positive'); } catch { why.push('no valid amount'); }
    return { index, scheme: o.scheme, network: o.network, payTo: o.payTo, amountAtomic: amountAtomic?.toString() ?? null,
      amountUsd: amountAtomic != null ? Number(amountAtomic) / 1e6 : null, usable: why.length === 0, rejectedBecause: why };
  });
}

// Cheapest usable option wins. Ties keep the seller's order.
export function chooseOption(pr, net) {
  const classified = classifyOptions(pr, net);
  const usable = classified.filter((c) => c.usable).sort((a, b) => (BigInt(a.amountAtomic) < BigInt(b.amountAtomic) ? -1 : BigInt(a.amountAtomic) > BigInt(b.amountAtomic) ? 1 : a.index - b.index));
  return { classified, chosen: usable[0] ? { ...usable[0], requirement: pr.accepts[usable[0].index] } : null };
}

const TWA_TYPES = { TransferWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' } ] };

export function twaTypedData(req, net, auth) {
  return {
    domain: { name: req.extra.name, version: req.extra.version, chainId: net.chainId, verifyingContract: getAddress(req.asset) },
    types: TWA_TYPES, primaryType: 'TransferWithAuthorization',
    message: { from: auth.from, to: auth.to, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce },
  };
}

// Signs exactly the chosen amount to exactly the chosen payTo. Validity window is short (<= 5 minutes).
export async function signPayment(account, pr, req, net, nowSec = Math.floor(Date.now() / 1000)) {
  const auth = {
    from: account.address, to: getAddress(req.payTo), value: optionAmount(req).toString(),
    validAfter: '0', validBefore: String(nowSec + Math.min(Number(req.maxTimeoutSeconds) || 300, 300)),
    nonce: toHex(crypto.getRandomValues(new Uint8Array(32))),
  };
  const signature = await account.signTypedData(twaTypedData(req, net, auth));
  const version = pr.x402Version ?? 1;
  const payload = version === 1
    ? { x402Version: 1, scheme: 'exact', network: req.network, payload: { signature, authorization: auth } }
    : { x402Version: version, ...(pr.resource ? { resource: pr.resource } : {}), accepted: req, payload: { signature, authorization: auth } };
  // v2: echo PaymentRequired.extensions unchanged (x402 spec §5.1.2 / bazaar.md). Do not invent a field when the 402 had none.
  if (version !== 1 && Object.prototype.hasOwnProperty.call(pr, 'extensions')) {
    payload.extensions = structuredClone(pr.extensions);
  }
  return { header: version === 1 ? 'X-PAYMENT' : 'PAYMENT-SIGNATURE', value: encodeB64Json(payload), payload, authorization: auth };
}

export function readSettlement(headers) {
  const h = headers.get('payment-response') || headers.get('x-payment-response');
  if (!h) return null;
  try { return decodeB64Json(h); } catch { return { unparseable: true }; }
}
