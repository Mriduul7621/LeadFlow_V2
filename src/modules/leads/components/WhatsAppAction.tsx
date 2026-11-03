import React, { useState } from 'react';
import { ChevronDown, MessageCircle } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { normalizeBdMobileIntl } from '../../shared/utils/phone';
import {
  WHATSAPP_TEMPLATES,
  buildWhatsAppHref,
  renderWhatsAppTemplate,
  type WhatsAppTemplateId,
} from '../utils/whatsappTemplates';

/**
 * WhatsAppAction — free WhatsApp click-to-chat for a lead.
 * ------------------------------------------------------------------
 * Renders a WhatsApp button that opens a small template picker
 * (mirrors the AppLayout menu pattern: backdrop click closes, panel
 * anchored under the button). Choosing a template opens
 * https://wa.me/<number>?text=<prefilled Bangla message> in a new
 * tab — the agent sends from their own WhatsApp. No API, no cost.
 *
 * Renders NOTHING when the lead's mobile is not a valid BD mobile,
 * so a broken link can never be produced. The menu links are pure
 * anchors: no backend call happens when one is clicked (initiating
 * a chat is therefore not written to the lead activity timeline —
 * the follow-up/status endpoint is the only activity write path
 * and it is reserved for real status updates).
 */

export function WhatsAppTemplateLinks({
  mobile,
  name,
  onSelect,
}: {
  mobile: unknown;
  name?: string | null;
  onSelect?: (templateId: WhatsAppTemplateId) => void;
}) {
  return (
    <>
      {WHATSAPP_TEMPLATES.map((template) => {
        const href = buildWhatsAppHref(mobile, template.id, name);
        if (!href) return null;
        return (
          <a
            key={template.id}
            href={href}
            target="_blank"
            rel="noreferrer"
            role="menuitem"
            onClick={() => onSelect?.(template.id)}
            className="block px-4 py-2.5 text-left hover:bg-emerald-50"
          >
            <span className="block text-xs font-bold text-stone-800">{template.label}</span>
            <span className="mt-0.5 line-clamp-2 block text-[11px] leading-relaxed text-stone-500">
              {renderWhatsAppTemplate(template, name)}
            </span>
          </a>
        );
      })}
    </>
  );
}

export default function WhatsAppAction({
  mobile,
  name,
  variant = 'labeled',
  className,
}: {
  mobile: unknown;
  name?: string | null;
  variant?: 'labeled' | 'icon';
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  // Hide the action entirely for numbers wa.me cannot reach.
  if (!normalizeBdMobileIntl(mobile)) return null;

  return (
    <div className={cn('relative', className)}>
      {variant === 'icon' ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label="Send WhatsApp message"
          title="WhatsApp"
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white hover:bg-emerald-700"
        >
          <MessageCircle className="h-[18px] w-[18px]" />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-haspopup="menu"
          className="inline-flex min-h-10 items-center gap-2 rounded-[10px] bg-emerald-600 px-3 text-xs font-semibold text-white hover:bg-emerald-700"
        >
          <MessageCircle className="h-3.5 w-3.5" /> WhatsApp
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      )}
      {open && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-40 cursor-default"
            aria-label="Close WhatsApp templates"
            onClick={() => setOpen(false)}
          />
          <div
            className="absolute right-0 top-[110%] z-50 w-72 max-w-[92vw] overflow-hidden rounded-[12px] border border-stone-100 bg-white py-2 shadow-xl"
            role="menu"
            aria-label="WhatsApp message templates"
          >
            <p className="px-4 pb-1 pt-1.5 text-[10px] font-black uppercase tracking-widest text-stone-400">
              WhatsApp message
            </p>
            <WhatsAppTemplateLinks mobile={mobile} name={name} onSelect={() => setOpen(false)} />
          </div>
        </>
      )}
    </div>
  );
}
