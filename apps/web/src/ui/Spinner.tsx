import { useT } from '../i18n';

/** Compact, token-coloured loading status shared by user and chart surfaces. */
export function Spinner({ label }: { label?: string }) {
  const t = useT();
  return (
    <div className="bt-muted flex items-center gap-3 text-sm" role="status">
      <span
        className="h-4 w-4 animate-spin rounded-full border-2"
        style={{ borderColor: 'var(--bt-border-strong)', borderTopColor: 'var(--bt-gold-graphic)' }}
        aria-hidden="true"
      />
      <span>{label ?? t('common.loading')}</span>
    </div>
  );
}
