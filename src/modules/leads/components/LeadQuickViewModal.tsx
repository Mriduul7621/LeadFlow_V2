import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { X } from 'lucide-react';
import type { Lead } from '../../shared/types';
import { getLeadStatusColorClasses } from '../../workflow/utils/leadStatusMeta';

/**
 * LeadQuickViewModal — the "Lead details" quick view (Agent
 * workspace rebuild, 2026-11-20, Mahadi's demo screenshot 3).
 * ------------------------------------------------------------------
 * A read-only glance at one lead: name, ID, phone, email, source,
 * owner, priority, stage, notes. Lead360 stays the full detail
 * page — this modal is the quick view, with a path to it and to
 * the update flow ("+ Log activity"). A missing value shows as
 * "—" rather than a blank box; a missing email means the lead has
 * none on file, not that the modal failed.
 */
export function LeadQuickViewModal({
  lead,
  ownerName,
  onClose,
}: {
  lead: Lead;
  ownerName: string;
  onClose: () => void;
}) {
  const field = (label: string, value: string, extra?: ReactNode) => (
    <div className="ep-quickview-field">
      <span>{label}</span>
      <strong>{value}</strong>
      {extra}
    </div>
  );

  return (
    <div
      className="ep-dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Lead details for ${lead.prospectName || 'Unnamed lead'}`}
      onClick={onClose}
    >
      <div className="ep-dialog" onClick={e => e.stopPropagation()}>
        <div className="ep-dialog-head">
          <div>
            <h3>Lead details</h3>
            <div className="ep-muted">A quick view — the full workspace stays on the lead page.</div>
          </div>
          <button type="button" className="ep-btn" onClick={onClose} aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="ep-dialog-body">
          <div className="ep-quickview-grid">
            {field('Lead name', lead.prospectName || 'Unnamed lead')}
            {field('Lead ID', lead.id)}
            {field('Phone', lead.mobile || '—')}
            {field('Email', lead.email || '—')}
            {field('Source', lead.source || '—')}
            {field('Owner', ownerName)}
            {field('Priority', lead.priority || '—')}
            <div className="ep-quickview-field">
              <span>Stage</span>
              <span className={`ep-pill ${getLeadStatusColorClasses(lead.currentStatus)}`}>
                {lead.currentStatus}
              </span>
            </div>
            <div className="ep-quickview-field ep-quickview-notes">
              <span>Notes</span>
              <strong>{lead.otherInfo || 'No notes recorded.'}</strong>
            </div>
          </div>
        </div>
        <div className="ep-dialog-foot">
          <Link
            className="ep-btn"
            to={`/leads/${encodeURIComponent(lead.id)}`}
            onClick={onClose}
          >
            Open full lead workspace →
          </Link>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="ep-btn" onClick={onClose}>
              Close
            </button>
            <Link
              className="ep-btn ep-btn-primary"
              to={`/leads/${encodeURIComponent(lead.id)}/update`}
              onClick={onClose}
            >
              ＋ Log activity
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
