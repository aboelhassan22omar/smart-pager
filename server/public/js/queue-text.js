// Queue copy for the customer card: "قدامك 2 طلب، حوالي 5–8 دقايق".
// The ETA arrives as absolute times and counts down locally (no polling).
export function aheadText(n) {
  if (n === 0) return 'طلبك الجاي';
  if (n === 1) return 'قدامك طلب واحد';
  if (n === 2) return 'قدامك طلبين';
  return `قدامك ${n} طلبات`;
}

export function etaText(eta, now = Date.now()) {
  if (!eta) return '';
  const high = Math.ceil((eta.highAt - now) / 60_000);
  if (high <= 0) return 'خلاص قرّب';
  const low = Math.max(1, Math.ceil((eta.lowAt - now) / 60_000));
  return low >= high ? `حوالي ${high} دقايق` : `حوالي ${low}–${high} دقايق`;
}
