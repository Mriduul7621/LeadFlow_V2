import { ArrowLeft } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { useGoBack } from '../hooks/useGoBack';

/**
 * BackButton — one back affordance for the pages the left sidebar opens.
 * It always returns to the PREVIOUS page (history back) and only falls back
 * to a landing route when there is no in-app history behind the current one.
 */
export default function BackButton({
  fallback = '/',
  label = 'Back',
  className,
}: {
  fallback?: string;
  label?: string;
  className?: string;
}) {
  const goBack = useGoBack(fallback);
  return (
    <button
      type="button"
      onClick={goBack}
      aria-label={label}
      className={cn('lf-back-button', className)}
    >
      <ArrowLeft className="h-4 w-4" />
      <span>{label}</span>
    </button>
  );
}
