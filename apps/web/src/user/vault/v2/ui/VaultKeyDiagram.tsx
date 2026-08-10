import { useId } from 'react';

import { useT } from '../../../../i18n';

/**
 * The `docs/VAULTS_V2_DESIGN.md` §2 key diagram, drawn rather than ASCII-arted.
 *
 * Every colour is a `--bt-*` token, so it inverts correctly in light mode and
 * the structural literal scanner stays quiet. It scales with its container via
 * `viewBox` + `width: 100%`, and it carries a `<title>`/`<desc>` pair plus
 * `role="img"` so a screen reader gets the same explanation the picture gives.
 */
export function VaultKeyDiagram() {
  const t = useT();
  const titleId = useId();
  const descId = useId();
  const arrow = useId();

  return (
    <div className="w-full" style={{ overflowX: 'auto' }}>
      <svg
        aria-describedby={descId}
        aria-labelledby={titleId}
        role="img"
        style={{ width: '100%', minWidth: 560, height: 'auto' }}
        viewBox="0 0 720 430"
        xmlns="http://www.w3.org/2000/svg"
      >
        <title id={titleId}>{t('vault.v2.explainer.diagram.title')}</title>
        <desc id={descId}>{t('vault.v2.explainer.diagram.desc')}</desc>

        <defs>
          <marker
            id={arrow}
            markerHeight="6"
            markerWidth="6"
            orient="auto"
            refX="5"
            refY="3"
            viewBox="0 0 6 6"
          >
            <path d="M0 0 L6 3 L0 6 z" fill="var(--bt-gold-graphic)" />
          </marker>
        </defs>

        <g
          fill="none"
          stroke="var(--bt-gold-graphic)"
          strokeWidth="1.6"
          markerEnd={`url(#${arrow})`}
        >
          <path d="M160 62 L160 96" />
          <path d="M160 140 L160 174" />
          <path d="M160 218 L160 252" />
          <path d="M545 62 L545 96" />
          <path d="M545 140 L545 174" />
          <path d="M545 200 C545 232 400 232 360 232" />
          <path d="M160 296 L160 330" />
        </g>

        <Node label={t('vault.v2.explainer.diagram.nodes.passphrase')} width={280} x={20} y={20} />
        <Node label={t('vault.v2.explainer.diagram.nodes.kdfVault')} width={280} x={20} y={98} />
        <Node label={t('vault.v2.explainer.diagram.nodes.masterKey')} width={280} x={20} y={176} />
        <Node
          accent
          label={t('vault.v2.explainer.diagram.nodes.contentKey')}
          width={280}
          x={20}
          y={254}
        />
        <Node
          accent
          label={t('vault.v2.explainer.diagram.nodes.blobs')}
          width={600}
          x={20}
          y={332}
        />

        <Node
          label={t('vault.v2.explainer.diagram.nodes.devicePassword')}
          width={280}
          x={405}
          y={20}
        />
        <Node label={t('vault.v2.explainer.diagram.nodes.kdfDevice')} width={280} x={405} y={98} />
        <Node label={t('vault.v2.explainer.diagram.nodes.deviceKey')} width={280} x={405} y={176} />

        <text fill="var(--bt-muted)" fontSize="11" textAnchor="end" x="690" y="252">
          {t('vault.v2.explainer.diagram.wrapsPassphrase')}
        </text>
      </svg>
    </div>
  );
}

function Node({
  x,
  y,
  width,
  label,
  accent = false,
}: {
  x: number;
  y: number;
  width: number;
  label: string;
  accent?: boolean;
}) {
  return (
    <g>
      <rect
        fill={accent ? 'var(--bt-surface-strong)' : 'var(--bt-surface-soft)'}
        height="42"
        rx="8"
        stroke={accent ? 'var(--bt-gold-graphic)' : 'var(--bt-border-strong)'}
        strokeWidth="1"
        width={width}
        x={x}
        y={y}
      />
      <text
        dominantBaseline="middle"
        fill="var(--bt-text)"
        fontSize="13"
        textAnchor="middle"
        x={x + width / 2}
        y={y + 22}
      >
        {label}
      </text>
    </g>
  );
}
