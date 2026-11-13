/**
 * whatsappTemplates.ts — WhatsApp click-to-chat message templates.
 * ==================================================================
 * The templates in this file are the built-in DEFAULTS. The live
 * list is admin-managed in the Metadata Engine (type
 * `WhatsAppTemplates`, seeded from these defaults — see
 * `resolveWhatsAppTemplates` below and Settings → WhatsApp
 * Templates). To change the DEFAULT wording of a message, edit the
 * `body` strings below — nothing else needs to change.
 * ------------------------------------------------------------------
 * ZERO-COST DESIGN: messages are sent through free wa.me
 * click-to-chat links (https://wa.me/<number>?text=<message>). The
 * agent's own WhatsApp opens with the message prefilled and the
 * agent presses send. There is NO WhatsApp Business API, no
 * third-party gateway and no backend sending — so there is no
 * per-message cost and no template approval process. The flip side:
 * delivery/read state cannot be tracked, which is why initiating a
 * WhatsApp message is not written to the lead activity timeline
 * (see PR notes; activity logging is a possible follow-up).
 *
 * Templates are in Bangla, professional Shanta Life tone, and make
 * no pricing, return or commitment claims. `{name}` is replaced
 * with the lead's name at send time.
 */

import { normalizeBdMobileIntl } from '../../shared/utils/phone';

export type WhatsAppTemplateId = 'first_contact' | 'follow_up' | 'meeting_confirmation';

export interface WhatsAppTemplate {
  id: WhatsAppTemplateId;
  /** Short English label shown in the template picker (UI language). */
  label: string;
  /** Bangla message body; `{name}` is interpolated with the lead name. */
  body: string;
}

export const WHATSAPP_TEMPLATES: WhatsAppTemplate[] = [
  {
    id: 'first_contact',
    label: 'First contact',
    body: 'আসসালামু আলাইকুম {name}, আমি শান্তা লাইফ ইন্স্যুরেন্স থেকে বলছি। আপনার সুবিধামতো সময়ে আমাদের জীবন বীমা পরিকল্পনা সম্পর্কে সংক্ষেপে জানাতে চাই। কখন কথা বললে ভালো হয়, অনুগ্রহ করে জানাবেন। ধন্যবাদ।',
  },
  {
    id: 'follow_up',
    label: 'Follow-up',
    body: 'আসসালামু আলাইকুম {name}, শান্তা লাইফ ইন্স্যুরেন্স থেকে ফলো-আপ করছি। আপনার জীবন বীমা পরিকল্পনা নিয়ে আগের আলোচনার বিষয়ে কোনো প্রশ্ন থাকলে অনুগ্রহ করে জানাবেন — আমি সাহায্য করতে প্রস্তুত আছি। ধন্যবাদ।',
  },
  {
    id: 'meeting_confirmation',
    label: 'Meeting confirmation',
    body: 'আসসালামু আলাইকুম {name}, শান্তা লাইফ ইন্স্যুরেন্স থেকে আমাদের নির্ধারিত সাক্ষাতের বিষয়টি নিশ্চিত করতে বার্তা পাঠাচ্ছি। অনুগ্রহ করে সময়মতো উপস্থিত থাকবেন; কোনো পরিবর্তন প্রয়োজন হলে আগে থেকে জানালে কৃতজ্ঞ থাকব। ধন্যবাদ।',
  },
];

export function getWhatsAppTemplate(id: WhatsAppTemplateId): WhatsAppTemplate {
  const found = WHATSAPP_TEMPLATES.find((t) => t.id === id);
  if (!found) throw new Error(`Unknown WhatsApp template: ${id}`);
  return found;
}

/* ====================================================================
 * FIX-1 — admin-managed templates (Metadata Engine) + direct open.
 * ------------------------------------------------------------------
 * The three templates above are now DEFAULTS. The live list lives in
 * the Metadata Engine as options of type `WhatsAppTemplates` (seeded
 * with these defaults; an admin adds / edits / deactivates them in
 * Settings → WhatsApp Templates, gated `settings.manage`). The option
 * shape is: value = template slug, label = picker label, meta.body =
 * the Bangla message text (with the same `{name}` slot).
 *
 * Every picker resolves its list through `resolveWhatsAppTemplates`:
 * stored Active options with a non-empty body win; when nothing is
 * stored (fresh install, demo mode, read failure) the built-in
 * defaults apply, so the action can never end up empty.
 * ================================================================== */

export const WHATSAPP_TEMPLATES_TYPE = 'WhatsAppTemplates';

/** A template as the picker renders it — built-in or admin-stored. */
export interface ResolvedWhatsAppTemplate {
  id: string;
  label: string;
  body: string;
}

/** The built-in defaults in resolved shape. */
export const DEFAULT_WHATSAPP_TEMPLATES: ResolvedWhatsAppTemplate[] = WHATSAPP_TEMPLATES.map(
  (t) => ({ id: t.id, label: t.label, body: t.body }),
);

/** The minimal option shape the resolver reads (DropdownOption-compatible). */
export interface WhatsAppTemplateOptionLike {
  value: string;
  label?: string;
  status?: string;
  meta?: Record<string, unknown> | null;
}

/**
 * Map stored metadata options to picker templates. Returns null when
 * nothing usable is stored (no options, all inactive, or no option
 * carries a message body) — the caller then uses the defaults.
 */
export function resolveWhatsAppTemplates(
  options: WhatsAppTemplateOptionLike[] | null | undefined,
): ResolvedWhatsAppTemplate[] | null {
  if (!options || options.length === 0) return null;
  const resolved: ResolvedWhatsAppTemplate[] = [];
  for (const option of options) {
    if (option.status && option.status !== 'Active') continue;
    const body = typeof option.meta?.body === 'string' ? option.meta.body.trim() : '';
    if (!body) continue;
    resolved.push({
      id: option.value,
      label: (option.label || option.value || '').trim() || option.value,
      body,
    });
  }
  return resolved.length > 0 ? resolved : null;
}

/**
 * Build the wa.me href for ANY resolved template (built-in or stored),
 * or null when the mobile is not a valid BD mobile.
 */
export function buildWhatsAppHrefForTemplate(
  mobile: unknown,
  template: ResolvedWhatsAppTemplate,
  name?: string | null,
): string | null {
  const intl = normalizeBdMobileIntl(mobile);
  if (!intl) return null;
  const text = renderWhatsAppTemplate(template, name);
  return `https://wa.me/${intl}?text=${encodeURIComponent(text)}`;
}

/**
 * The second option the owner asked for: open the WhatsApp chat with
 * NO prefilled message at all (a bare wa.me link), or null when the
 * mobile is not a valid BD mobile.
 */
export function buildWhatsAppDirectHref(mobile: unknown): string | null {
  const intl = normalizeBdMobileIntl(mobile);
  if (!intl) return null;
  return `https://wa.me/${intl}`;
}

/**
 * Replace `{name}` with the lead's name. A missing/blank name falls
 * back to a respectful generic address so the message never renders
 * a raw placeholder or an empty gap.
 */
export function renderWhatsAppTemplate(template: Pick<WhatsAppTemplate, 'body'>, name?: string | null): string {
  const trimmed = (name || '').trim();
  const displayName = trimmed || 'স্যার/ম্যাডাম';
  return template.body.split('{name}').join(displayName);
}

/**
 * Build the full wa.me click-to-chat href for a lead, or null when
 * the stored mobile is not a valid BD mobile (caller hides the
 * action). The Bangla message is percent-encoded with
 * encodeURIComponent, as wa.me requires.
 */
export function buildWhatsAppHref(
  mobile: unknown,
  templateId: WhatsAppTemplateId,
  name?: string | null,
): string | null {
  const intl = normalizeBdMobileIntl(mobile);
  if (!intl) return null;
  const text = renderWhatsAppTemplate(getWhatsAppTemplate(templateId), name);
  return `https://wa.me/${intl}?text=${encodeURIComponent(text)}`;
}
