import { useEffect, useRef, useState } from 'react';
import { leadService, type CorporateClientOption } from '../services/leadService';

/**
 * CorporateClientPicker — the Corporate Client field on Add Lead
 * (migration 065, Mahadi 2026-11-24).
 * ------------------------------------------------------------------
 * Renders ONLY when the lead's Source is "Corporate Client Group
 * Insurance" (the parent gates it). Type a company name; the list
 * narrows as you type (server ranks exact matches first). Each row
 * shows Name + Code; selecting stores both — the code is the link,
 * the name is the snapshot.
 *
 * When the Corporate Clients sheet cannot be read (the tab does not
 * exist yet, or Sheets is down), the search answers available:false
 * and the picker offers a MANUAL code input instead: the lead still
 * saves with the hand-typed code (name blank, resolved later).
 * Creation never depends on Sheets availability.
 */
export interface CorporateClientSelection {
  code: string;
  name: string;
}

interface CorporateClientPickerProps {
  value: CorporateClientSelection | null;
  onChange: (client: CorporateClientSelection | null) => void;
  /** Manual code fallback (sheet unavailable). Owned by the parent. */
  manualCode: string;
  onManualCodeChange: (code: string) => void;
  disabled?: boolean;
  /** Validation message from the parent (corporate source, no client). */
  error?: string;
}

const INPUT_CLS =
  'w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-sm font-black uppercase tracking-tight italic focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none';

export default function CorporateClientPicker({
  value,
  onChange,
  manualCode,
  onManualCodeChange,
  disabled,
  error,
}: CorporateClientPickerProps) {
  const [text, setText] = useState(value?.name || '');
  const [options, setOptions] = useState<CorporateClientOption[]>([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [sheetAvailable, setSheetAvailable] = useState(true);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestRef = useRef(0);

  // The parent owns the selection: when it clears (source changed
  // away, edit pre-fill landed), the input follows.
  useEffect(() => {
    setText(value?.name || '');
    if (!value) setOptions([]);
  }, [value]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const runSearch = (q: string) => {
    const query = q.trim();
    if (!query) {
      setOptions([]);
      setSearched(false);
      setOpen(false);
      return;
    }
    setSearching(true);
    const stamp = ++requestRef.current;
    leadService
      .searchCorporateClients(query)
      .then(result => {
        if (stamp !== requestRef.current) return;
        setSheetAvailable(result.available);
        setSheetError(result.error || null);
        setOptions(result.clients);
        setSearched(true);
        setOpen(true);
      })
      .catch(() => {
        if (stamp !== requestRef.current) return;
        setSheetAvailable(false);
        setSheetError('The Corporate Clients sheet could not be read. Enter the client code manually.');
        setOptions([]);
        setSearched(true);
        setOpen(false);
      })
      .finally(() => {
        if (stamp === requestRef.current) setSearching(false);
      });
  };

  const onTextChange = (next: string) => {
    setText(next);
    // Typing after a selection un-selects: the typed text is a new query.
    if (value) onChange(null);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => runSearch(next), 300);
  };

  const select = (client: CorporateClientOption) => {
    onChange({ code: client.code, name: client.name });
    setText(client.name);
    setOpen(false);
  };

  return (
    <div className="space-y-3" ref={boxRef}>
      <label className="text-sm font-medium text-slate-700">
        Corporate Client *
      </label>
      <div className="relative">
        <input
          type="text"
          value={text}
          disabled={disabled}
          onChange={e => onTextChange(e.target.value)}
          onFocus={() => {
            if (options.length > 0) setOpen(true);
          }}
          placeholder="Type the company name…"
          className={INPUT_CLS}
          autoComplete="off"
        />
        {searching && (
          <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs text-slate-400">Searching…</span>
        )}
        {open && options.length > 0 && (
          <ul className="absolute z-20 mt-1 w-full max-h-60 overflow-auto rounded-sm border border-slate-200 bg-white shadow-lg">
            {options.map(client => (
              <li key={client.code}>
                <button
                  type="button"
                  onClick={() => select(client)}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-[#FBFAF8]"
                >
                  <span className="text-sm font-semibold text-slate-800">{client.name || client.code}</span>
                  <span className="shrink-0 rounded-sm bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-600">
                    {client.code}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {open && searched && sheetAvailable && options.length === 0 && (
          <p className="absolute z-20 mt-1 w-full rounded-sm border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500 shadow-lg">
            No companies match. Check the spelling, or ask MIS to add the client to the Corporate Clients sheet.
          </p>
        )}
      </div>
      {value && (
        <p className="text-xs text-slate-500">
          Selected: <span className="font-semibold text-slate-700">{value.name}</span>{' '}
          <span className="font-mono">({value.code})</span>
        </p>
      )}
      {!sheetAvailable && (
        <div className="space-y-2 rounded-sm border border-amber-200 bg-amber-50 p-3">
          <p className="text-xs text-amber-800">{sheetError}</p>
          <label className="block text-xs font-medium text-slate-700">Corporate Client Code (manual)</label>
          <input
            type="text"
            value={manualCode}
            disabled={disabled}
            onChange={e => onManualCodeChange(e.target.value)}
            placeholder="e.g. CG-001"
            className="w-full rounded-sm border border-slate-200 bg-white px-3 py-2 font-mono text-sm outline-none focus:border-[#978C21]"
            autoComplete="off"
          />
          <p className="text-xs text-slate-500">
            The code is saved as typed; the company name fills in once the sheet is available.
          </p>
        </div>
      )}
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}
