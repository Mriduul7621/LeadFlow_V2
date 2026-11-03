/**
 * phone.ts — Bangladesh mobile normalization for outbound contact links.
 * ------------------------------------------------------------------
 * Single shared place that turns a stored lead mobile (which arrives
 * in whatever shape the import or the form produced) into the
 * international digits-only form external deep links expect:
 *
 *   '01711001122'      -> '8801711001122'
 *   '+880 1711-001122' -> '8801711001122'
 *   '8801711001122'    -> '8801711001122'
 *   '1711001122'       -> '8801711001122'
 *
 * Returns null for anything that is not a plausible BD mobile
 * (non-BD country codes, landlines, too short/long) so callers can
 * hide or disable the action instead of producing a broken link.
 * This is intentionally stricter than the server's normalizePhoneKey
 * (server/routes/leadImport.ts), which only builds a dedup key and
 * accepts partial numbers; a wa.me link with a wrong number messages
 * the wrong person, so here the full BD mobile shape is required:
 * national significant number = 1[3-9] followed by 8 digits.
 */

const BD_NSN_PATTERN = /^1[3-9]\d{8}$/;

export function normalizeBdMobileIntl(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  // Strip the separators people actually type: spaces, dashes,
  // parentheses and dots. A single leading '+' is kept for parsing.
  const cleaned = String(raw).trim().replace(/[\s\-().]/g, '');
  if (!cleaned) return null;

  let nsn: string | null = null;
  if (cleaned.startsWith('+')) {
    const digits = cleaned.slice(1);
    if (!/^\d+$/.test(digits)) return null;
    if (!digits.startsWith('880')) return null; // non-BD country code
    nsn = digits.slice(3);
  } else {
    if (!/^\d+$/.test(cleaned)) return null;
    if (cleaned.startsWith('880')) {
      nsn = cleaned.slice(3);
    } else if (cleaned.startsWith('0')) {
      nsn = cleaned.slice(1);
    } else {
      nsn = cleaned;
    }
  }

  if (!BD_NSN_PATTERN.test(nsn)) return null;
  return `880${nsn}`;
}
