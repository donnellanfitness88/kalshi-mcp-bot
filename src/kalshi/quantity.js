// Exchange quantities are fixed-point hundredths of a contract, never cents
// of money. Keep addition/subtraction in integer units and do not floor fills.
export function quantityUnits(raw, signed = false) {
  let units;
  if (typeof raw === 'string') {
    if (!/^-?\d+(?:\.\d{1,2})?$/.test(raw)) throw new Error('Invalid contract quantity: ' + raw);
    const negative = raw.startsWith('-');
    const [whole, fraction = ''] = raw.replace(/^-/, '').split('.');
    const exact = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
    if (exact > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Contract quantity exceeds safe range');
    units = Number(exact) * (negative ? -1 : 1);
  } else if (typeof raw === 'number' && Number.isFinite(raw)) {
    units = Math.round(raw * 100);
    if (!Number.isSafeInteger(units) || Math.abs(raw * 100 - units) > 1e-7) {
      throw new Error('Invalid contract quantity precision');
    }
  } else throw new Error('Missing or invalid contract quantity');
  if (!signed && units < 0) throw new Error('Negative contract quantity');
  return units;
}
export function contractQuantity(raw, signed = false) { return quantityUnits(raw, signed) / 100; }
export function validQuantity(raw) {
  try { quantityUnits(raw); return true; } catch { return false; }
}
export function addQuantity(a, b) { return contractQuantity((quantityUnits(a) + quantityUnits(b)) / 100); }
export function subtractQuantity(a, b) { return contractQuantity((quantityUnits(a) - quantityUnits(b)) / 100); }
