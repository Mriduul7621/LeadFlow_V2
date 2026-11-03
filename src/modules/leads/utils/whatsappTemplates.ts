/**
 * whatsappTemplates.ts — WhatsApp click-to-chat message templates.
 * ==================================================================
 * EDIT ME: this is the ONE place the built-in WhatsApp message
 * templates live. To change the wording of a message agents send,
 * edit the `body` strings below — nothing else needs to change.
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

/**
 * Replace `{name}` with the lead's name. A missing/blank name falls
 * back to a respectful generic address so the message never renders
 * a raw placeholder or an empty gap.
 */
export function renderWhatsAppTemplate(template: WhatsAppTemplate, name?: string | null): string {
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
