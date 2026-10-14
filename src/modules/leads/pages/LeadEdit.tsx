import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import { leadService } from '../services/leadService';
import { metadataService } from '../../metadata/services/metadataService';
import { useAuthStore } from '../../auth/store/authStore';
import { usePermissions } from '../../shared/hooks/usePermissions';
import type { Lead } from '../../shared/types';

type LeadForm = Pick<Lead, 'prospectName' | 'mobile' | 'email' | 'profession' | 'area' | 'productName' | 'campaignName' | 'source'>;

const emptyForm: LeadForm = {
  prospectName: '',
  mobile: '',
  email: '',
  profession: '',
  area: '',
  productName: '',
  campaignName: '',
  source: '',
};

export default function LeadEdit() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const { canAccess } = usePermissions();
  const canEditLead = canAccess('lead_tracking', 'edit');
  const [lead, setLead] = useState<Lead | null>(null);
  const [form, setForm] = useState<LeadForm>(emptyForm);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sourceOptions, setSourceOptions] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    leadService.getLead(id)
      .then(result => {
        if (cancelled) return;
        if (!result) {
          setLoadError('Lead not found, or you do not have access to it.');
          return;
        }
        setLead(result);
        setForm({
          prospectName: result.prospectName || '',
          mobile: result.mobileNumber || result.mobile || '',
          email: result.email || '',
          profession: result.profession || '',
          area: result.area || '',
          productName: result.productName || '',
          campaignName: result.campaignName || '',
          source: result.source || '',
        });
      })
      .catch(error => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : 'Could not load this lead.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    metadataService.getActiveValues('Source', true)
      .then(options => { if (!cancelled) setSourceOptions(options); })
      .catch(error => {
        if (!cancelled) toast.error(error instanceof Error ? error.message : 'Lead sources could not be loaded.');
      });
    return () => { cancelled = true; };
  }, []);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!lead) return;
    if (!canEditLead) {
      toast.error('You do not have permission to edit this lead.');
      return;
    }
    const prospectName = form.prospectName.trim();
    const mobile = form.mobile.trim();
    if (!prospectName || !mobile) {
      toast.error('Name and mobile number are required.');
      return;
    }
    setSaving(true);
    try {
      await leadService.updateLead(lead.id, {
        prospectName,
        mobile,
        mobileNumber: mobile,
        email: form.email.trim(),
        profession: form.profession.trim(),
        area: form.area.trim(),
        productName: form.productName.trim(),
        campaignName: form.campaignName.trim(),
        source: form.source.trim(),
      }, user?.name || 'LeadFlow');
      toast.success('Lead details updated.');
      navigate(`/leads/${encodeURIComponent(lead.id)}`, { replace: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update this lead.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="py-12 text-center text-sm text-stone-500">Loading lead…</p>;
  if (loadError || !lead) {
    return (
      <div className="mx-auto max-w-xl space-y-4 py-12 text-center">
        <p className="text-sm text-stone-600">{loadError || 'Lead not found.'}</p>
        <Link to="/leads" className="text-sm font-semibold text-[#756c1b]">Back to leads</Link>
      </div>
    );
  }
  if (!canEditLead) {
    return (
      <div className="mx-auto max-w-xl space-y-3 py-12 text-center">
        <h1 className="text-lg font-semibold text-stone-800">Edit access unavailable</h1>
        <p className="text-sm text-stone-600">Your role does not have permission to edit lead details.</p>
        <Link to={`/leads/${encodeURIComponent(lead.id)}`} className="text-sm font-semibold text-[#756c1b]">Back to lead</Link>
      </div>
    );
  }

  const fields: Array<{ key: keyof LeadForm; label: string; type?: string }> = [
    { key: 'prospectName', label: 'Client name' },
    { key: 'mobile', label: 'Mobile number', type: 'tel' },
    { key: 'email', label: 'Email address', type: 'email' },
    { key: 'profession', label: 'Profession' },
    { key: 'area', label: 'Area' },
    { key: 'productName', label: 'Product' },
    { key: 'campaignName', label: 'Campaign' },
    { key: 'source', label: 'Source' },
  ];

  return (
    <div className="mx-auto max-w-2xl space-y-6 pb-10">
      <div className="flex items-center gap-3">
        <Link
          to={`/leads/${encodeURIComponent(lead.id)}`}
          aria-label="Back to lead details"
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-stone-200 bg-white text-stone-600 hover:bg-stone-50"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight text-brand-text">Update lead</h1>
          <p className="truncate text-sm text-stone-500">{lead.prospectName}</p>
        </div>
      </div>
      <form onSubmit={save} className="space-y-4 border-y border-stone-100 bg-white px-4 py-5 sm:px-6">
        {fields.map(field => (
          <label key={field.key} className="block space-y-1.5">
            <span className="text-xs font-medium text-stone-600">{field.label}</span>
            {field.key === 'source' ? (
              <select
                value={form.source}
                onChange={event => setForm(current => ({ ...current, source: event.target.value }))}
                className="select-standard"
              >
                <option value="">Select source</option>
                {form.source && !sourceOptions.includes(form.source) && <option value={form.source}>{form.source}</option>}
                {sourceOptions.map(source => <option key={source} value={source}>{source}</option>)}
              </select>
            ) : (
              <input
                type={field.type || 'text'}
                value={form[field.key] || ''}
                onChange={event => setForm(current => ({ ...current, [field.key]: event.target.value }))}
                className="input-standard"
                required={field.key === 'prospectName' || field.key === 'mobile'}
                autoComplete={field.key === 'prospectName' ? 'name' : field.key === 'mobile' ? 'tel' : field.key === 'email' ? 'email' : undefined}
              />
            )}
          </label>
        ))}
        <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
          <Link to={`/leads/${encodeURIComponent(lead.id)}`} className="btn-secondary min-h-11 normal-case tracking-normal">
            Cancel
          </Link>
          <button type="submit" disabled={saving} className="btn-primary min-h-11 normal-case tracking-normal">
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </div>
  );
}
