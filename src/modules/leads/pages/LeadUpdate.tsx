import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, CalendarClock, FileText, Target } from 'lucide-react';
import { toast } from 'sonner';
import { leadService } from '../services/leadService';
import { scheduledActivityService } from '../../scheduledActivities/services/scheduledActivityService';
import { metadataService } from '../../metadata/services/metadataService';
import { preloadLeadStatuses, getLeadStatusColorClasses } from '../../workflow/utils/leadStatusMeta';
import { useTranslation } from '../../shared/utils/translations';
import { cn } from '../../../lib/utils';
import { validateLeadStatusFields } from '../utils/leadStatusRules';
import type { Lead } from '../../shared/types';

/**
 * LeadUpdate — the agent's "Update Lead" tracking form.
 * ------------------------------------------------------------------
 * This is the dynamic business flow the app was designed around:
 *
 *   - Every status change goes through this one form.
 *   - A brand new lead starts at the dictionary's untouched state; from
 *     there the agent moves it forward.
 *   - Interested              → a mandatory "Next Action" appears
 *     (Need Follow-Up / Meeting Fixed / Proposal Sent / Not Interested).
 *   - Need Follow-Up          → date & time picker (maps to the
 *     dictionary status "Follow-up Set").
 *   - Meeting Fixed           → date & time picker (+ meeting type), and
 *     the meeting is mirrored onto the Task Calendar.
 *   - Proposal Sent           → product, sum assured, projected FYCP.
 *   - Converted               → product, sum assured, collected FYCP.
 *   - Not Interested          → a loss reason is mandatory.
 *   - Remarks                 → always available, for every update —
 *     the server appends every change (with actor & timestamp) to the
 *     lead's immutable history, so the full trail is preserved.
 *
 * The status vocabulary is never hardcoded: it comes from the canonical
 * FollowUpStatus dictionary (admin-configurable via the metadata engine),
 * which is exactly what the server validates against.
 */

const NEED_FOLLOW_UP = 'Need Follow-Up';
const MEETING_FIXED = 'Meeting Fixed';
const PROPOSAL_SENT = 'Proposal Sent';
const NOT_INTERESTED = 'Not Interested';
const FOLLOW_UP_SET = 'Follow-up Set';

/** Next-action choices offered once a lead is marked Interested. */
const NEXT_ACTIONS = [NEED_FOLLOW_UP, MEETING_FIXED, PROPOSAL_SENT, NOT_INTERESTED] as const;
type NextAction = (typeof NEXT_ACTIONS)[number];

/** Maps a Next Action choice to the canonical dictionary status. */
function statusForNextAction(action: NextAction): string {
  if (action === NEED_FOLLOW_UP) return FOLLOW_UP_SET;
  return action;
}

const inputCls =
  'w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm font-medium text-stone-800 outline-none transition focus:border-[#978C21] focus:ring-2 focus:ring-[#978C21]/20';
const labelCls = 'mb-1.5 block text-[11px] font-black uppercase tracking-widest text-stone-500';
const errCls = 'mt-1 text-xs font-semibold text-rose-500';

/** A translation key the `t()` helper accepts. */
type TranslationKey = Parameters<ReturnType<typeof useTranslation>['t']>[0];

/** API field name -> the form's local error key. */
const FORM_ERROR_KEY_BY_API_FIELD: Record<string, string> = {
  nextFollowUpDate: 'followUpAt',
  meetingDate: 'meetingAt',
  productName: 'productName',
  sumAssured: 'sumAssured',
  projectedNCP: 'projectedNCP',
  collectedNCP: 'collectedNCP',
  lossReason: 'lossReason',
};

/** API field name -> translation key (falls back to the API's own sentence). */
const FORM_MESSAGE_KEY_BY_API_FIELD: Record<string, string> = {
  nextFollowUpDate: 'updErrFollowUpDate',
  meetingDate: 'updErrMeetingDate',
  productName: 'updErrProduct',
  sumAssured: 'updErrSumAssured',
  projectedNCP: 'updErrProjectedNCP',
  collectedNCP: 'updErrCollectedNCP',
  lossReason: 'updErrLossReason',
};

/**
 * yyyy-MM-ddTHH:mm for `<input type="datetime-local">`, derived from a real
 * instant (the lead's own next follow-up when the server has one).
 *
 * F10: the form used to pre-fill BOTH the follow-up and the meeting picker
 * with "now + 1 hour". An operator who did not notice saved a meeting at a
 * time nobody agreed to, and the value then flowed into the Task Calendar.
 * An appointment time is data about the real world — the form must not invent
 * it. Fields start empty and the per-status rule (F6) refuses to save without
 * them; when the lead already has a next follow-up, that real value is used.
 */
function localDateTimeValue(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function LeadUpdate() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const [lead, setLead] = useState<Lead | null>(null);
  const [loadingLead, setLoadingLead] = useState(true);

  const [statusList, setStatusList] = useState<string[]>([]);
  const [status, setStatus] = useState('');
  const [nextAction, setNextAction] = useState<NextAction | ''>('');

  const [followUpAt, setFollowUpAt] = useState('');
  const [meetingAt, setMeetingAt] = useState('');
  const [meetingType, setMeetingType] = useState('');
  const [productName, setProductName] = useState('');
  const [sumAssured, setSumAssured] = useState('');
  const [projectedNCP, setProjectedNCP] = useState('');
  const [collectedNCP, setCollectedNCP] = useState('');
  const [lossReason, setLossReason] = useState('');
  const [remarks, setRemarks] = useState('');

  const [products, setProducts] = useState<string[]>([]);
  // Suggestions merge dictionary 'Product' values with the lead's current product;
  // the input itself is free-text so an unconfigured dictionary cannot block submission.
  const productSuggestions = Array.from(
    new Set([...products, lead?.productName || ''].filter((v): v is string => !!v)),
  );
  const [meetingTypes, setMeetingTypes] = useState<string[]>([]);
  const [lossReasons, setLossReasons] = useState<string[]>([]);

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingLead(true);
      try {
        const [fetched, statuses] = await Promise.all([
          id ? leadService.getLead(decodeURIComponent(id)) : Promise.resolve(null),
          preloadLeadStatuses(),
        ]);
        if (cancelled) return;
        setLead(fetched);
        const values = statuses.map((s) => s.value).filter(Boolean);
        setStatusList(values);
        if (fetched?.currentStatus && values.includes(fetched.currentStatus)) {
          setStatus(fetched.currentStatus);
        }
        // Real data only: the lead's existing next follow-up, never an
        // invented "now + 1 hour" (F10).
        if (fetched) {
          const existing = (fetched as any).nextFollowUpDate || (fetched as any).nextFollowUpAt || '';
          if (existing) setFollowUpAt(localDateTimeValue(String(existing)));
        }
      } finally {
        if (!cancelled) setLoadingLead(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [p, m, l] = await Promise.all([
        metadataService.getActiveValues('Product').catch(() => [] as string[]),
        metadataService.getActiveValues('MeetingType').catch(() => [] as string[]),
        metadataService.getActiveValues('LossReason').catch(() => [] as string[]),
      ]);
      if (cancelled) return;
      setProducts(p);
      setMeetingTypes(m);
      setLossReasons(l);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** The status that will actually be persisted (Interested resolves via Next Action). */
  const effectiveStatus = useMemo(() => {
    if (status === 'Interested') {
      return nextAction ? statusForNextAction(nextAction as NextAction) : '';
    }
    return status;
  }, [status, nextAction]);

  const needsNextAction = status === 'Interested';
  const needsFollowUpAt = effectiveStatus === FOLLOW_UP_SET;
  const needsMeeting = effectiveStatus === MEETING_FIXED;
  const needsProposalFields = effectiveStatus === PROPOSAL_SENT;
  const needsConvertedFields = effectiveStatus === 'Converted';
  const needsLossReason = effectiveStatus === NOT_INTERESTED;

  /**
   * F6 — the conditional fields are validated from the SAME table the server
   * enforces (`validateLeadStatusFields`), so the form can never ask for less
   * (or more) than the API accepts. Only the copy differs: the form keeps its
   * translated messages, the API returns a plain sentence for non-UI callers.
   */
  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!status) e.status = t('updErrStatusRequired');
    // The Next Action choice is a UI shortcut (it resolves Interested into a
    // final status); the server does not demand it, so it stays client-side.
    if (needsNextAction && !nextAction) e.nextAction = t('updErrNextAction');

    const violations = validateLeadStatusFields(effectiveStatus, {
      nextFollowUpDate: followUpAt,
      meetingDate: meetingAt,
      productName,
      sumAssured: sumAssured.trim() === '' ? undefined : Number(sumAssured),
      projectedNCP: projectedNCP.trim() === '' ? undefined : Number(projectedNCP),
      collectedNCP: collectedNCP.trim() === '' ? undefined : Number(collectedNCP),
      lossReason,
    });
    for (const violation of violations) {
      const key = FORM_ERROR_KEY_BY_API_FIELD[violation.field] || violation.field;
      const messageKey = FORM_MESSAGE_KEY_BY_API_FIELD[violation.field] as TranslationKey | undefined;
      if (!e[key]) e[key] = messageKey ? t(messageKey) : violation.message;
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const asIso = (local: string): string | undefined => {
    if (!local) return undefined;
    const d = new Date(local);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  };

  const handleSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!lead || submitting) return;
    if (!validate()) return;

    const statusToSend = needsNextAction ? statusForNextAction(nextAction as NextAction) : effectiveStatus;
    if (!statusToSend) return;

    setSubmitting(true);
    try {
      await leadService.updateLeadStatus(
        lead.id,
        statusToSend as any,
        needsConvertedFields && collectedNCP.trim() !== '' ? Number(collectedNCP) : undefined,
        remarks.trim() || undefined,
        needsFollowUpAt ? asIso(followUpAt) : undefined,
        undefined,
        undefined,
        needsMeeting ? asIso(meetingAt) : undefined,
        sumAssured.trim() !== '' ? Number(sumAssured) : undefined,
        productName || undefined,
        needsProposalFields && projectedNCP.trim() !== '' ? Number(projectedNCP) : undefined,
        needsLossReason ? lossReason : undefined,
        needsMeeting && meetingType ? meetingType : undefined,
      );

      // Mirror a fixed meeting onto the Task Calendar (server assigns it to
      // the lead's owner and resolves the external lead id).
      if (needsMeeting) {
        try {
          await scheduledActivityService.create({
            leadId: lead.id,
            activityType: 'meeting',
            title: `Meeting - ${lead.prospectName}`,
            scheduledAt: asIso(meetingAt)!,
            meetingType: meetingType || undefined,
            remarks: remarks.trim() || undefined,
          });
        } catch (calErr) {
          console.warn('[lead-update] calendar mirror failed (status was saved):', calErr);
          toast.message(t('updMeetingCalendarSkipped'));
        }
      }

      toast.success(t('updSuccess'));
      navigate(`/leads/${encodeURIComponent(lead.id)}`);
    } catch (err: any) {
      console.error('[lead-update] save failed:', err);
      toast.error(err?.message || t('updError'));
    } finally {
      setSubmitting(false);
    }
  };

  if (loadingLead) {
    return (
      <div className="space-y-4 p-4">
        <div className="h-9 w-40 animate-pulse rounded-xl bg-stone-100" />
        <div className="h-64 animate-pulse rounded-3xl bg-stone-100" />
      </div>
    );
  }

  if (!lead) {
    return (
      <div className="p-6">
        <button onClick={() => navigate(-1)} className="flex items-center gap-2 text-sm font-medium text-slate-500 hover:text-[#978C21]">
          <ArrowLeft className="h-3.5 w-3.5" /> {t('backToLeads') || 'Back'}
        </button>
        <p className="mt-4 text-sm font-semibold text-stone-600">{t('updLeadNotFound')}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 p-4 pb-28">
      <button onClick={() => navigate(-1)} className="flex items-center gap-2 text-sm font-medium text-slate-500 transition-colors hover:text-[#978C21]">
        <ArrowLeft className="h-3.5 w-3.5" /> {t('backToLeads') || 'Back'}
      </button>

      {/* Lead context */}
      <section className="rounded-3xl border border-stone-100 bg-white p-5 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-black tracking-tight text-stone-900">{t('updTitle')}</h1>
            <p className="mt-1 truncate text-xs font-semibold text-stone-500">
              {lead.prospectName} · {lead.mobile}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-[10px] font-black uppercase tracking-widest text-stone-400">{t('updCurrentStatus')}</p>
            <span className={cn('mt-1 inline-block rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-widest', getLeadStatusColorClasses(lead.currentStatus))}>
              {lead.currentStatus}
            </span>
          </div>
        </div>
      </section>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Status */}
        <section className="rounded-3xl border border-stone-100 bg-white p-5 shadow-sm">
          <div className="mb-3 flex items-center gap-2">
            <Target className="h-4 w-4 text-[#978C21]" />
            <h2 className="text-[12px] font-black uppercase tracking-widest text-stone-700">{t('updNewStatus')}</h2>
          </div>
          <label className="block">
            <span className={labelCls}>{t('updNewStatus')} *</span>
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setNextAction('');
                setErrors((prev) => ({ ...prev, status: '', nextAction: '' }));
              }}
              className={inputCls}
            >
              <option value="">{t('updSelectStatus')}</option>
              {statusList.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
          {errors.status ? <p className={errCls}>{errors.status}</p> : null}

          {/* Next Action — only for Interested */}
          {needsNextAction ? (
            <div className="mt-4 rounded-2xl border border-[#978C21]/30 bg-[#97BC21]/5 p-4">
              <span className={labelCls}>{t('updNextAction')} *</span>
              <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2">
                {NEXT_ACTIONS.filter((a) => statusList.includes(statusForNextAction(a)) || statusList.includes(a) || a === NOT_INTERESTED).map((a) => (
                  <button
                    key={a}
                    type="button"
                    onClick={() => {
                      setNextAction(a as NextAction);
                      setErrors((prev) => ({ ...prev, nextAction: '' }));
                    }}
                    className={cn(
                      'rounded-xl border px-3 py-3 text-left text-xs font-black uppercase tracking-widest transition',
                      nextAction === a
                        ? 'border-[#978C21] bg-[#978C21] text-white shadow'
                        : 'border-stone-200 bg-white text-stone-600 hover:border-[#978C21]/50'
                    )}
                  >
                    {a}
                  </button>
                ))}
              </div>
              {errors.nextAction ? <p className={errCls}>{errors.nextAction}</p> : null}
            </div>
          ) : null}

          {/* Follow-up date & time */}
          {needsFollowUpAt ? (
            <div className="mt-4">
              <span className={labelCls}>{t('updFollowUpAt')} *</span>
              <input type="datetime-local" value={followUpAt} onChange={(e) => setFollowUpAt(e.target.value)} className={inputCls} />
              <p className="mt-1.5 text-[11px] font-medium text-stone-400">
                No time is assumed — pick the exact moment your lead agreed to.
              </p>
              {errors.followUpAt ? <p className={errCls}>{errors.followUpAt}</p> : null}
            </div>
          ) : null}

          {/* Meeting date & time + type */}
          {needsMeeting ? (
            <div className="mt-4 space-y-4">
              <div>
                <span className={labelCls}>{t('updMeetingAt')} *</span>
                <input type="datetime-local" value={meetingAt} onChange={(e) => setMeetingAt(e.target.value)} className={inputCls} />
                <p className="mt-1.5 text-[11px] font-medium text-stone-400">
                  No time is assumed — this is mirrored onto the Task Calendar.
                </p>
                {errors.meetingAt ? <p className={errCls}>{errors.meetingAt}</p> : null}
              </div>
              <div>
                <span className={labelCls}>{t('updMeetingType')}</span>
                <select value={meetingType} onChange={(e) => setMeetingType(e.target.value)} className={inputCls}>
                  <option value="">{t('updSelectMeetingType')}</option>
                  {meetingTypes.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
              <p className="flex items-center gap-1.5 text-[11px] font-semibold text-stone-400">
                <CalendarClock className="h-3.5 w-3.5" /> {t('updMeetingCalendarNote')}
              </p>
            </div>
          ) : null}

          {/* Proposal Sent */}
          {needsProposalFields ? (
            <div className="mt-4 space-y-4 rounded-2xl border border-cyan-200 bg-cyan-50/50 p-4">
              <div>
                <span className={labelCls}>{t('product')} *</span>
                <input
                  list="upd-product-suggestions"
                  value={productName}
                  onChange={(e) => setProductName(e.target.value)}
                  className={inputCls}
                  placeholder={t('selectProduct')}
                />
                {errors.productName ? <p className={errCls}>{errors.productName}</p> : null}
              </div>
              <div>
                <span className={labelCls}>{t('updSumAssured')} *</span>
                <input type="number" min="0" inputMode="numeric" value={sumAssured} onChange={(e) => setSumAssured(e.target.value)} className={inputCls} placeholder="e.g. 1000000" />
                {errors.sumAssured ? <p className={errCls}>{errors.sumAssured}</p> : null}
              </div>
              <div>
                <span className={labelCls}>{t('updProjectedFYCP')} *</span>
                <input type="number" min="0" inputMode="numeric" value={projectedNCP} onChange={(e) => setProjectedNCP(e.target.value)} className={inputCls} placeholder="e.g. 45000" />
                {errors.projectedNCP ? <p className={errCls}>{errors.projectedNCP}</p> : null}
              </div>
            </div>
          ) : null}

          {/* Converted */}
          {needsConvertedFields ? (
            <div className="mt-4 space-y-4 rounded-2xl border border-emerald-200 bg-emerald-50/50 p-4">
              <div>
                <span className={labelCls}>{t('product')} *</span>
                <input
                  list="upd-product-suggestions"
                  value={productName}
                  onChange={(e) => setProductName(e.target.value)}
                  className={inputCls}
                  placeholder={t('selectProduct')}
                />
                {errors.productName ? <p className={errCls}>{errors.productName}</p> : null}
              </div>
              <div>
                <span className={labelCls}>{t('updSumAssured')} *</span>
                <input type="number" min="0" inputMode="numeric" value={sumAssured} onChange={(e) => setSumAssured(e.target.value)} className={inputCls} placeholder="e.g. 1000000" />
                {errors.sumAssured ? <p className={errCls}>{errors.sumAssured}</p> : null}
              </div>
              <div>
                <span className={labelCls}>{t('updCollectedFYCP')} *</span>
                <input type="number" min="0" inputMode="numeric" value={collectedNCP} onChange={(e) => setCollectedNCP(e.target.value)} className={inputCls} placeholder="e.g. 42000" />
                {errors.collectedNCP ? <p className={errCls}>{errors.collectedNCP}</p> : null}
              </div>
            </div>
          ) : null}

          {/* Not Interested → loss reason */}
          {needsLossReason ? (
            <div className="mt-4">
              <span className={labelCls}>{t('updLossReason')} *</span>
              <select value={lossReason} onChange={(e) => setLossReason(e.target.value)} className={inputCls}>
                <option value="">{t('updSelectLossReason')}</option>
                {lossReasons.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
              {errors.lossReason ? <p className={errCls}>{errors.lossReason}</p> : null}
            </div>
          ) : null}

          {/* Product suggestions for Proposal/Converted free-text product fields.
              Dictionary-driven when admins configure 'Product' values; typing any
              product name stays allowed so submission never deadlocks. */}
          <datalist id="upd-product-suggestions">
            {productSuggestions.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>

          {/* Remarks — always */}
          <div className="mt-4">
            <span className={labelCls}>
              <FileText className="mr-1 inline h-3.5 w-3.5" /> {t('remarks')}
            </span>
            <textarea
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              rows={3}
              className={cn(inputCls, 'resize-none')}
              placeholder={t('updRemarksPlaceholder')}
            />
          </div>
        </section>

        <button
          type="submit"
          disabled={submitting}
          className="inline-flex w-full items-center justify-center rounded-xl bg-[#978C21] px-4 py-4 text-sm font-black uppercase tracking-widest text-white shadow-lg shadow-[#978C21]/20 transition active:scale-[0.99] disabled:opacity-60"
        >
          {submitting ? t('updSaving') : t('updSave')}
        </button>
      </form>
    </div>
  );
}
