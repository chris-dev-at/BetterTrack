import { useState } from 'react';

import type { EndpointVaultState } from '../vault/keystore';
import type { PortfolioVaultStub } from './lockedPortfolio';

import { useT } from '../../i18n';
import { Badge, Button, Disclosure, LinkButton, PageHead } from '../../ui/origin';
import type { PortfolioVaultMoveCapture } from '../vault/portfolioVaultMove';
import { rerunVaultedPortfolioStores } from '../vault/useVaultedPortfolioStores';
import { VaultProvidePhraseDialog } from '../vault/ui/VaultProvidePhraseDialog';
import { VaultStateAction } from '../vault/ui/VaultStateAction';
import { vaultRetryTimeLabel } from '../vault/ui/retryTime';
import { useVaultEndpointState } from '../vault/ui/useVaultEndpointState';
import type { VaultedPortfolioFailure } from '../vault/vaultedPortfolioStores';
import { endpointVaultStateCase, vaultStateActionHref } from '../vault/vaultStateAffordance';
import { portfolioDisplayName } from './lockedPortfolio';
import { PortfolioMoveOutAction } from './PortfolioMoveOutAction';

/**
 * What a vaulted portfolio shows while this device cannot render its contents.
 *
 * ONE STEP, HERE. The owner's oracle for this surface is a sentence — "open
 * the portfolio, get prompted for the password if not unlocked, and then it
 * unlocks the portfolio, ez" — and every state below resolves to exactly one
 * primary act performed on this page:
 *
 *   • locked → **Unlock** (the in-place dialog);
 *   • words not on this device → **Enter recovery words** (in-place dialog);
 *   • unlocked but not yet resolved → "opening…", nothing to press;
 *   • unlocked and the open FAILED → the failure, in words, with **Retry** —
 *     never a "Locked" badge with an "Open" link, which is what a swallowed
 *     resolver error used to paint after a perfectly good unlock;
 *   • locked out → when the password is accepted again, and the one link that
 *     is genuinely a settings-sized act (reset this device);
 *   • device storage invalid → that same reset link.
 *
 * The §10 move-out stays offered from the stub itself, as before.
 */
export function LockedPortfolioStub({
  portfolio,
  state: suppliedState,
  capture,
  onMoved,
  failure = null,
}: {
  portfolio: PortfolioVaultStub;
  state?: EndpointVaultState;
  capture?: PortfolioVaultMoveCapture | null;
  onMoved?: () => void;
  /** Why this device could not open the portfolio although its vault is unlocked. */
  failure?: VaultedPortfolioFailure | null;
}) {
  const t = useT();
  const stateQuery = useVaultEndpointState(suppliedState ? null : portfolio.vaultId);
  const state = suppliedState ?? stateQuery.data;
  const alias = portfolioDisplayName(portfolio, t('vault.lockedStub.fallbackAlias'));
  const [wordsOpen, setWordsOpen] = useState(false);

  const stateCase = state ? endpointVaultStateCase(state) : null;
  const unlocked =
    stateCase === 'stored+wrapped:unlocked:open-silently' ||
    stateCase === 'stored+plain:open-silently';

  return (
    <section className="bt-money-surface flex flex-col gap-4" data-testid="locked-portfolio-stub">
      <PageHead sub={t('vault.lockedStub.subtitle')} title={alias} />
      <div className="bt-panel flex flex-col items-start gap-3 p-4">
        {!state ? (
          <Button
            disabled={stateQuery.isPending}
            onClick={() => void stateQuery.refetch()}
            size="sm"
            type="button"
            variant="quiet"
          >
            {stateQuery.isError ? t('common.retry') : t('common.loading')}
          </Button>
        ) : unlocked && failure ? (
          <div className="flex flex-col gap-3" role="alert">
            <Badge tone="neg">{t('vault.manager.state.ready')}</Badge>
            <p className="bt-row-title">{t('vault.lockedStub.openFailedTitle')}</p>
            <p className="bt-soft text-sm">{t('vault.lockedStub.openFailedBody')}</p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => rerunVaultedPortfolioStores()} size="sm" type="button">
                {t('common.retry')}
              </Button>
              <LinkButton size="sm" to="/control/privacy" variant="quiet">
                {t('vault.lockedStub.manage')}
              </LinkButton>
            </div>
            <Disclosure summary={t('vault.lockedStub.openFailedDetail')}>
              <p className="bt-mono bt-muted text-xs" data-testid="locked-portfolio-failure">
                {failure.code} · {failure.message}
              </p>
            </Disclosure>
          </div>
        ) : unlocked ? (
          <p className="bt-soft text-sm" role="status">
            {t('vault.lockedStub.opening')}
          </p>
        ) : stateCase === 'not-on-this-endpoint:provide-phrase' ? (
          <>
            <Badge tone="blue">{t('vault.manager.state.notOnEndpoint')}</Badge>
            <p className="bt-soft text-sm">{t('vault.lockedStub.wordsNeededBody')}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => setWordsOpen(true)} size="sm" type="button">
                {t('vault.lockedStub.enterWords')}
              </Button>
              {/* The second §12 method for this state. Scanning needs a camera or
                  a pasted transfer code and is a settings-sized flow (E7), so it
                  keeps its link — quiet, beside the one-step primary act. */}
              <LinkButton
                size="sm"
                to={vaultStateActionHref(portfolio.vaultId, 'scan-qr')}
                variant="quiet"
              >
                {t('vault.manager.action.scanQr')}
              </LinkButton>
            </div>
            {wordsOpen ? (
              <VaultProvidePhraseDialog
                onClose={() => setWordsOpen(false)}
                vaultId={portfolio.vaultId}
                vaultName={portfolio.vaultAlias ?? undefined}
              />
            ) : null}
          </>
        ) : stateCase === 'stored+wrapped:locked:wait-or-reset' ? (
          <>
            <Badge tone="neg">{t('vault.manager.state.locked')}</Badge>
            <p className="bt-soft text-sm">
              {t('vault.lockedStub.lockedOutBody', {
                time:
                  state.status === 'stored+wrapped' &&
                  state.session === 'locked' &&
                  state.requiredAction.kind === 'wait-or-reset'
                    ? vaultRetryTimeLabel(state.requiredAction.retryAt)
                    : '',
              })}
            </p>
            <LinkButton
              size="sm"
              to={vaultStateActionHref(portfolio.vaultId, 'reset-endpoint')}
              variant="quiet"
            >
              {t('vault.manager.action.resetEndpoint')}
            </LinkButton>
          </>
        ) : (
          <>
            <Badge tone="gold">{t('vault.lockedStub.badge')}</Badge>
            <p className="bt-soft text-sm">{t('vault.lockedStub.body')}</p>
            <VaultStateAction
              emphasis="primary"
              inPlace
              state={state}
              vaultId={portfolio.vaultId}
              vaultName={alias}
            />
          </>
        )}
        {/* §10: leaving the vault is always offered from the stub itself. */}
        <PortfolioMoveOutAction
          capture={capture}
          displayName={alias}
          onMoved={onMoved}
          portfolio={portfolio}
          state={state}
        />
      </div>
    </section>
  );
}
