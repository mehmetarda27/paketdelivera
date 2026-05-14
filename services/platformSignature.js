const crypto = require("crypto");

function trimmed(value) {
  return String(value ?? "").trim();
}

function safeEqual(left, right) {
  const leftValue = Buffer.from(trimmed(left));
  const rightValue = Buffer.from(trimmed(right));
  if (!leftValue.length || leftValue.length !== rightValue.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftValue, rightValue);
}

function hmacHex(secret, payload) {
  return crypto
    .createHmac("sha256", secret)
    .update(typeof payload === "string" ? payload : JSON.stringify(payload || {}))
    .digest("hex");
}

function header(req, name) {
  return trimmed(req?.headers?.[name.toLowerCase()]);
}

function verifyHmacSignature({ req, secret, rawBody }) {
  const configuredSecret = trimmed(secret);
  if (!configuredSecret || rawBody === undefined || rawBody === null) {
    return false;
  }

  const candidates = [
    header(req, "x-platform-signature"),
    header(req, "x-webhook-signature"),
    header(req, "x-hub-signature-256").replace(/^sha256=/i, ""),
  ].filter(Boolean);

  if (!candidates.length) {
    return false;
  }

  const expected = hmacHex(configuredSecret, rawBody);
  return candidates.some((candidate) => safeEqual(candidate, expected));
}

function verifyTokenFallback({ req, account, restaurant }) {
  const authorization = header(req, "authorization");
  const bearerToken = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  const incoming = [
    bearerToken,
    header(req, "x-platform-secret"),
    header(req, "x-webhook-secret"),
    header(req, "x-api-key"),
    header(req, "x-webhook-token"),
    header(req, "x-static-token"),
    header(req, "x-partner-token"),
    header(req, "x-yemeksepeti-token"),
  ].filter(Boolean);
  const allowed = [
    account?.webhookSecret,
    account?.staticToken,
    account?.webhookApiKey,
    restaurant?.webhookSecret,
  ].map(trimmed).filter(Boolean);

  return incoming.some((token) => allowed.some((allowedToken) => safeEqual(token, allowedToken)));
}

function verifyPlatformSignature({ req, account, restaurant, rawBody }) {
  const hmacSecret = account?.webhookSecret || account?.apiSecret || restaurant?.webhookSecret;
  if (verifyHmacSignature({ req, secret: hmacSecret, rawBody })) {
    return { ok: true, mode: "hmac_sha256" };
  }
  if (verifyTokenFallback({ req, account, restaurant })) {
    return { ok: true, mode: "token_fallback" };
  }
  return { ok: false, mode: "none" };
}

module.exports = {
  hmacHex,
  safeEqual,
  verifyHmacSignature,
  verifyPlatformSignature,
  verifyTokenFallback,
};
