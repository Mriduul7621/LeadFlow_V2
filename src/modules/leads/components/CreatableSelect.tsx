import React, { useState } from 'react';
import { Check, Plus, X } from 'lucide-react';

/**
 * CreatableSelect — a dropdown with a "+" beside it (Add Lead form).
 * ------------------------------------------------------------------
 * Mahadi's rule: if the needed option is not in the list, the user
 * adds it on the spot and it appears in EVERYONE's dropdown. The
 * persistence lives server-side (metadataService.quickAddOption);
 * this component is only the interaction:
 *
 *   select mode  →  [+] switches to an inline input
 *   add mode     →  confirm calls onCreateOption, which resolves with
 *                   the canonical value to select (the parent toasts
 *                   "added" / "already exists"); Escape or [x] cancels
 *                   and leaves the current selection untouched.
 *
 * On a failed add the component STAYS in add mode with the typed text
 * intact (the parent has already toasted the reason), so the user can
 * fix, retry, or cancel — the form is never left broken.
 *
 * All buttons are type="button" and Enter is intercepted: this lives
 * inside the lead <form>, and a stray submit would lose the lead.
 */
interface CreatableSelectProps {
  value: string;
  options: string[];
  onChange: (value: string) => void;
  /** Persist a new option; resolves with the canonical value to select. */
  onCreateOption: (rawValue: string) => Promise<string>;
  placeholder: string;
  /** Classes for the <select>, so each usage keeps the form's styling. */
  selectClassName?: string;
  disabled?: boolean;
}

export default function CreatableSelect({
  value,
  options,
  onChange,
  onCreateOption,
  placeholder,
  selectClassName,
  disabled,
}: CreatableSelectProps) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const cancel = () => {
    setAdding(false);
    setDraft('');
  };

  const confirm = async () => {
    const raw = draft.trim();
    if (!raw) {
      cancel();
      return;
    }
    setBusy(true);
    try {
      const canonical = await onCreateOption(raw);
      onChange(canonical);
      setAdding(false);
      setDraft('');
    } catch {
      // Parent toasted the reason; keep the draft for retry/cancel.
    } finally {
      setBusy(false);
    }
  };

  if (adding) {
    return (
      <div className="flex gap-2">
        <input
          autoFocus
          value={draft}
          disabled={busy}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void confirm();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
            }
          }}
          placeholder="Type the new option"
          className="flex-1 min-w-0 px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-sm font-bold focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none"
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => void confirm()}
          title="Add option"
          className="shrink-0 px-4 bg-slate-900 text-white rounded-sm hover:bg-black transition-all disabled:opacity-50 flex items-center justify-center"
        >
          <Check className="w-4 h-4" />
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={cancel}
          title="Cancel"
          className="shrink-0 px-4 bg-[#FBFAF8] border border-slate-100 text-slate-500 rounded-sm hover:text-slate-700 transition-all disabled:opacity-50 flex items-center justify-center"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex gap-2">
      <div className="flex-1 min-w-0">
        <select
          value={value}
          disabled={disabled}
          onChange={e => onChange(e.target.value)}
          className={selectClassName}
        >
          <option value="">{placeholder}</option>
          {options.map(o => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setAdding(true)}
        title="Add a new option — it will be available for everyone"
        className="shrink-0 px-4 bg-[#FBFAF8] border border-slate-100 text-slate-500 rounded-sm hover:text-[#978C21] hover:border-[#978C21] transition-all disabled:opacity-50 flex items-center justify-center"
      >
        <Plus className="w-4 h-4" />
      </button>
    </div>
  );
}
