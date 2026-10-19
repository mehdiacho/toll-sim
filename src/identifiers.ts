/** Plate as ANPR and registration both store it: upper case, letters and digits only. */
export function normalizePlate(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Standard Botswana private plate: B 123 ABC. */
export function isStandardBotswanaPlate(plate: string): boolean {
  return /^B\d{3}[A-Z]{3}$/.test(normalizePlate(plate));
}

/**
 * Botswana mobile numbers are 8 digits starting with 7. Accepts 71234567,
 * 26771234567 or +267 71 234 567 and returns E.164 (+26771234567), or null.
 */
export function normalizeBotswanaMsisdn(raw: string): string | null {
  let digits = raw.replace(/[\s()-]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("267")) digits = digits.slice(3);
  return /^7\d{7}$/.test(digits) ? `+267${digits}` : null;
}

/** +26771234567 -> +267 71***567, for anything that gets stored or logged. */
export function maskMsisdn(e164: string): string {
  const local = e164.slice(4);
  return `+267 ${local.slice(0, 2)}***${local.slice(5)}`;
}
