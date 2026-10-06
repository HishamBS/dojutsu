// round(value, digits) as Python computes it: the nearest decimal to the exact binary value,
// and an exact tie goes to the even digit (round(1.25, 1) is 1.2, where toFixed gives 1.3).
const TIE_BASE = 2;

export function pyRound(value: number, digits: number): number {
  if (!Number.isFinite(value)) return value;
  const scale = 10 ** digits;
  // A tie is exactly representable only when value * 2^(digits + 1) is an odd integer; the
  // multiplication by a power of two is exact, so the test cannot misfire on rounding noise.
  const doubled = value * TIE_BASE ** (digits + 1);
  const isExactTie = Number.isInteger(doubled) && Math.abs(doubled) % 2 === 1;
  if (!isExactTie) return Number(value.toFixed(digits));
  const lower = Math.floor(value * scale);
  return (lower % 2 === 0 ? lower : lower + 1) / scale;
}
