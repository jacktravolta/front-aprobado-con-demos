export const SESSION_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;

function isIpv4Octet(value) {
  return /^\d{1,3}$/.test(value) && Number(value) <= 255;
}

export function isLoopbackHost(host) {
  const normalized = String(host ?? "").toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;

  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => isIpv4Octet(octet))
  );
}

export function resolveOwnerMode({ host, requestedPin } = {}) {
  const resolvedHost = String(host ?? "");
  const resolvedPin = String(requestedPin ?? "");
  const pinRequested = SESSION_ID_RE.test(resolvedPin);

  return {
    host: resolvedHost,
    requestedPin: resolvedPin,
    pinApplied: pinRequested && isLoopbackHost(resolvedHost),
  };
}
