import { HttpError } from './errors.js';

// Optional contact details of a brand owner: email and phone. Empty means "none" (null).

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const EMAIL_MAX = 200;

/** A trimmed email, null when empty; 400 on anything that isn't one. */
export function cleanEmail(value, field = 'email') {
  if (value == null) return null;
  const email = String(value).trim();
  if (!email) return null;
  if (email.length > EMAIL_MAX || !EMAIL_RE.test(email)) throw new HttpError(400, 'الإيميل مش مظبوط', { field });
  return email;
}

/**
 * A phone number as digits with an optional leading +, null when empty. Arabic and Persian
 * digits, spaces, dashes, dots and brackets are accepted as typed: "٠١٠ ١٢٣٤ ٥٦٧٨" -> "01012345678".
 */
export function cleanPhone(value, field = 'phone') {
  if (value == null) return null;
  const typed = String(value)
    .trim()
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  if (!typed) return null;
  const phone = typed.replace(/[\s\-.()‎‏]/g, '');
  if (!/^\+?\d{7,15}$/.test(phone)) throw new HttpError(400, 'رقم التليفون مش مظبوط (من 7 لـ 15 رقم)', { field });
  return phone;
}
