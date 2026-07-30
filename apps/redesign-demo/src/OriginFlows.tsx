import { type ReactNode, useMemo, useState } from 'react';

import { Icon, type IconName } from './Icons';
import './origin-flows.css';

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

function FlowButton({
  children,
  icon,
  tone = 'secondary',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: IconName;
  tone?: 'primary' | 'secondary' | 'quiet' | 'danger';
}) {
  return (
    <button
      className={cx('origin-flow-button', `origin-flow-button--${tone}`)}
      type="button"
      {...props}
    >
      {icon ? <Icon name={icon} size={15} /> : null}
      {children}
    </button>
  );
}

function FlowShell({
  title,
  kicker,
  description,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  kicker: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <div className="origin-flow-layer" role="presentation" onMouseDown={onClose}>
      <section
        aria-label={title}
        aria-modal="true"
        className={cx('origin-flow', wide && 'origin-flow--wide')}
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="origin-flow__header">
          <span>
            <small>{kicker}</small>
            <strong>{title}</strong>
            {description ? <p>{description}</p> : null}
          </span>
          <button aria-label="Close" onClick={onClose} type="button">
            <Icon name="x" size={17} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function StepRail({
  steps,
  current,
}: {
  steps: Array<{ label: string; description: string; icon: IconName }>;
  current: number;
}) {
  return (
    <aside className="origin-flow-steps" aria-label="Flow progress">
      {steps.map((step, index) => (
        <span
          className={cx(index === current && 'is-active', index < current && 'is-complete')}
          key={step.label}
        >
          <i>
            {index < current ? (
              <Icon name="check" size={12} />
            ) : (
              <Icon name={step.icon} size={14} />
            )}
          </i>
          <span>
            <strong>{step.label}</strong>
            <small>{step.description}</small>
          </span>
        </span>
      ))}
    </aside>
  );
}

const euro = new Intl.NumberFormat('en-IE', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 2,
});

export type OriginAsset = {
  symbol: string;
  name: string;
  price: number;
  currency: 'EUR' | 'USD';
  venue: string;
  change: number;
};

export type OriginTradeResult = {
  id: string;
  asset: OriginAsset;
  portfolio: string;
  side: 'Buy' | 'Sell';
  orderType: 'Market' | 'Limit';
  units: number;
  gross: number;
  fees: number;
  cashImpact: number;
  recurring: boolean;
  basisStatus: 'covered' | 'missing';
  executedAt: string;
};

const tradeSteps = [
  { label: 'Order', description: 'Asset, side, and size', icon: 'assets' as IconName },
  { label: 'Review', description: 'Price, cash, and tax', icon: 'document' as IconName },
  { label: 'Route', description: 'Simulated execution', icon: 'activity' as IconName },
  { label: 'Receipt', description: 'Portfolio updated', icon: 'check' as IconName },
];

export function OriginTradeFlow({
  asset,
  portfolio,
  availableCash,
  heldUnits = 84.2341,
  receiptNumber = 1042,
  onClose,
  onComplete,
  onReceiptAction,
}: {
  asset: OriginAsset;
  portfolio: string;
  availableCash: number;
  heldUnits?: number;
  receiptNumber?: number;
  onClose: () => void;
  onComplete: (trade: OriginTradeResult) => void;
  onReceiptAction?: (action: 'download' | 'compare' | 'share', trade: OriginTradeResult) => void;
}) {
  const [step, setStep] = useState(0);
  const [side, setSide] = useState<'Buy' | 'Sell'>('Buy');
  const [orderType, setOrderType] = useState<'Market' | 'Limit'>('Market');
  const [inputMode, setInputMode] = useState<'value' | 'units'>('value');
  const [amount, setAmount] = useState('500');
  const [limitPrice, setLimitPrice] = useState(String((asset.price * 0.995).toFixed(2)));
  const [funding, setFunding] = useState('Cash · Personal wealth');
  const [recurring, setRecurring] = useState(false);
  const [schedule, setSchedule] = useState('Monthly · last business day');
  const [confirmed, setConfirmed] = useState(false);
  const [uncoveredAcknowledged, setUncoveredAcknowledged] = useState(false);

  const price = orderType === 'Limit' ? Number(limitPrice) || asset.price : asset.price;
  const units = inputMode === 'value' ? (Number(amount) || 0) / price : Number(amount) || 0;
  const gross = units * price;
  const fees = Math.max(side === 'Buy' ? 1 : 1.25, gross * 0.0008);
  const estimatedTax = side === 'Sell' ? Math.max(0, gross * 0.031) : 0;
  const cashImpact = side === 'Buy' ? -(gross + fees) : gross - fees - estimatedTax;
  const remainingCash = availableCash + cashImpact;
  const uncoveredUnits = side === 'Sell' ? Math.max(0, units - heldUnits) : 0;
  const canContinue =
    gross > 0 &&
    (side === 'Buy' ? remainingCash >= 0 : uncoveredUnits === 0 || uncoveredAcknowledged);
  const receipt = useMemo<OriginTradeResult>(
    () => ({
      id: `trade_${asset.symbol.toLowerCase()}_demo_${receiptNumber}`,
      asset,
      portfolio,
      side,
      orderType,
      units,
      gross,
      fees,
      cashImpact,
      recurring,
      basisStatus: uncoveredUnits > 0 ? 'missing' : 'covered',
      executedAt: 'Today, 10:42',
    }),
    [
      asset,
      cashImpact,
      fees,
      gross,
      orderType,
      portfolio,
      receiptNumber,
      recurring,
      side,
      uncoveredUnits,
      units,
    ],
  );

  function advance() {
    if (step === 0 && canContinue) setStep(1);
    else if (step === 1 && confirmed) setStep(2);
    else if (step === 2) setStep(3);
  }

  function finish() {
    onComplete(receipt);
  }

  return (
    <FlowShell
      description="A realistic preview only—no broker order leaves this browser."
      kicker={`${asset.venue} · ${asset.currency}`}
      onClose={onClose}
      title={`${side} ${asset.symbol}`}
      wide
    >
      <div className="origin-flow-layout">
        <StepRail current={step} steps={tradeSteps} />
        <main className="origin-trade">
          {step === 0 ? (
            <>
              <div className="origin-trade-asset">
                <span>{asset.symbol.slice(0, 2)}</span>
                <span>
                  <small>{asset.symbol}</small>
                  <strong>{asset.name}</strong>
                  <em>
                    {asset.currency === 'EUR' ? '€' : '$'}
                    {asset.price.toLocaleString('en-IE', { minimumFractionDigits: 2 })}
                    <i className={asset.change >= 0 ? 'is-positive' : 'is-negative'}>
                      {asset.change >= 0 ? '+' : ''}
                      {asset.change}% today
                    </i>
                  </em>
                </span>
                <span className="origin-market-state">
                  <i />
                  Market open
                </span>
              </div>

              <div className="origin-trade-side" aria-label="Trade side">
                {(['Buy', 'Sell'] as const).map((item) => (
                  <button
                    className={side === item ? 'is-active' : ''}
                    key={item}
                    onClick={() => setSide(item)}
                    type="button"
                  >
                    {item}
                  </button>
                ))}
              </div>

              <section className="origin-trade-ticket">
                <div className="origin-trade-mode">
                  <span>Size by</span>
                  <div>
                    <button
                      className={inputMode === 'value' ? 'is-active' : ''}
                      onClick={() => setInputMode('value')}
                      type="button"
                    >
                      Value
                    </button>
                    <button
                      className={inputMode === 'units' ? 'is-active' : ''}
                      onClick={() => setInputMode('units')}
                      type="button"
                    >
                      Units
                    </button>
                  </div>
                </div>
                <label className="origin-trade-amount">
                  <small>{inputMode === 'value' ? 'Order value' : 'Number of units'}</small>
                  <span>
                    {inputMode === 'value' ? <em>€</em> : null}
                    <input
                      aria-label={inputMode === 'value' ? 'Order value' : 'Number of units'}
                      inputMode="decimal"
                      onChange={(event) => setAmount(event.target.value)}
                      value={amount}
                    />
                    {inputMode === 'units' ? <em>units</em> : null}
                  </span>
                  <strong>
                    ≈ {units.toLocaleString('en-IE', { maximumFractionDigits: 6 })} units at{' '}
                    {euro.format(price)}
                  </strong>
                </label>
                <div className="origin-quick-values">
                  {['100', '250', '500', '1000'].map((value) => (
                    <button key={value} onClick={() => setAmount(value)} type="button">
                      {inputMode === 'value' ? `€${value}` : value}
                    </button>
                  ))}
                  <button
                    onClick={() =>
                      setAmount(
                        side === 'Sell'
                          ? inputMode === 'value'
                            ? String(Math.max(0, heldUnits * price).toFixed(2))
                            : String(heldUnits.toFixed(6))
                          : inputMode === 'value'
                            ? String(Math.max(0, Math.floor(availableCash)))
                            : String(Math.max(0, availableCash / price).toFixed(5)),
                      )
                    }
                    type="button"
                  >
                    Max
                  </button>
                </div>
                <div className="origin-field-grid">
                  <label>
                    Order type
                    <select
                      aria-label="Order type"
                      onChange={(event) => setOrderType(event.target.value as 'Market' | 'Limit')}
                      value={orderType}
                    >
                      <option>Market</option>
                      <option>Limit</option>
                    </select>
                  </label>
                  {orderType === 'Limit' ? (
                    <label>
                      Limit price
                      <span className="origin-inline-input">
                        €
                        <input
                          aria-label="Limit price"
                          inputMode="decimal"
                          onChange={(event) => setLimitPrice(event.target.value)}
                          value={limitPrice}
                        />
                      </span>
                    </label>
                  ) : (
                    <label>
                      Price protection
                      <span className="origin-static-field">Max. 0.50% slippage</span>
                    </label>
                  )}
                </div>
                <label>
                  {side === 'Buy' ? 'Pay from' : 'Deposit proceeds into'}
                  <select
                    aria-label="Funding source"
                    onChange={(event) => setFunding(event.target.value)}
                    value={funding}
                  >
                    <option>Cash · Personal wealth</option>
                    <option>Sparkasse •• 1842</option>
                    <option>Trade Republic cash</option>
                  </select>
                </label>
                {side === 'Sell' ? (
                  <section
                    className={cx('origin-position-check', uncoveredUnits > 0 && 'is-warning')}
                  >
                    <span>
                      <Icon name="portfolio" />
                    </span>
                    <span>
                      <small>RECORDED POSITION</small>
                      <strong>
                        {heldUnits.toLocaleString('en-IE', { maximumFractionDigits: 6 })}{' '}
                        {asset.symbol}
                      </strong>
                      <em>Estimated value {euro.format(heldUnits * price)}</em>
                    </span>
                    {uncoveredUnits === 0 ? (
                      <Icon name="check" size={14} />
                    ) : (
                      <label>
                        <input
                          checked={uncoveredAcknowledged}
                          onChange={(event) => setUncoveredAcknowledged(event.target.checked)}
                          type="checkbox"
                        />
                        <span>
                          <strong>Record {uncoveredUnits.toFixed(6)} uncovered units</strong>
                          <small>Create a missing-basis Review item after recording.</small>
                        </span>
                      </label>
                    )}
                  </section>
                ) : null}
                {side === 'Buy' ? (
                  <label className="origin-recurring">
                    <input
                      checked={recurring}
                      onChange={(event) => setRecurring(event.target.checked)}
                      type="checkbox"
                    />
                    <span>
                      <strong>Repeat this investment</strong>
                      <small>Create a reviewed automation after this order.</small>
                    </span>
                  </label>
                ) : null}
                {recurring ? (
                  <label>
                    Schedule
                    <select
                      aria-label="Investment schedule"
                      onChange={(event) => setSchedule(event.target.value)}
                      value={schedule}
                    >
                      <option>Monthly · last business day</option>
                      <option>Monthly · first business day</option>
                      <option>Every two weeks · Monday</option>
                      <option>Quarterly · first business day</option>
                    </select>
                  </label>
                ) : null}
              </section>

              <div className={cx('origin-trade-balance', remainingCash < 0 && 'is-negative')}>
                <span>
                  <small>Available cash</small>
                  <strong>{euro.format(availableCash)}</strong>
                </span>
                <Icon name="arrow-right" size={15} />
                <span>
                  <small>After order</small>
                  <strong>{euro.format(remainingCash)}</strong>
                </span>
                {remainingCash < 0 ? (
                  <em>Reduce the order by {euro.format(-remainingCash)}</em>
                ) : null}
              </div>
            </>
          ) : null}

          {step === 1 ? (
            <div className="origin-order-review">
              <div className="origin-review-hero">
                <span>
                  <Icon name={side === 'Buy' ? 'arrow-down' : 'arrow-up'} />
                </span>
                <small>REVIEW {orderType.toUpperCase()} ORDER</small>
                <h2>
                  {side} {units.toLocaleString('en-IE', { maximumFractionDigits: 6 })}{' '}
                  {asset.symbol}
                </h2>
                <p>
                  {portfolio} · {funding}
                </p>
              </div>
              <dl className="origin-review-facts">
                <div>
                  <dt>Estimated price</dt>
                  <dd>{euro.format(price)}</dd>
                </div>
                <div>
                  <dt>Gross order value</dt>
                  <dd>{euro.format(gross)}</dd>
                </div>
                <div>
                  <dt>Trading fee</dt>
                  <dd>{euro.format(fees)}</dd>
                </div>
                <div>
                  <dt>{side === 'Sell' ? 'Estimated tax reserve' : 'Estimated total'}</dt>
                  <dd>{euro.format(side === 'Sell' ? estimatedTax : gross + fees)}</dd>
                </div>
                <div>
                  <dt>Order validity</dt>
                  <dd>{orderType === 'Limit' ? 'End of day' : 'Immediate or cancel'}</dd>
                </div>
                <div>
                  <dt>Execution venue</dt>
                  <dd>{asset.venue} · best available route</dd>
                </div>
              </dl>
              {side === 'Sell' ? (
                <section className="origin-tax-preview">
                  <Icon name="document" />
                  <span>
                    <strong>Tax lot preview</strong>
                    <small>
                      {uncoveredUnits > 0
                        ? `Missing basis for ${uncoveredUnits.toFixed(6)} units · provisional tax reserve ${euro.format(estimatedTax)}`
                        : `FIFO · estimated realized gain ${euro.format(gross * 0.113)} · tax reserve ${euro.format(estimatedTax)}`}
                    </small>
                  </span>
                  <button type="button">Choose lots</button>
                </section>
              ) : null}
              {recurring ? (
                <section className="origin-automation-preview">
                  <Icon name="repeat" />
                  <span>
                    <strong>Automation proposal included</strong>
                    <small>
                      {euro.format(gross)} · {schedule}. It will remain paused until separately
                      approved.
                    </small>
                  </span>
                </section>
              ) : null}
              <label className="origin-confirm-order">
                <input
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                  type="checkbox"
                />
                <span>
                  <strong>I reviewed the order and simulation details.</strong>
                  <small>No real money or broker connection is used in this demo.</small>
                </span>
              </label>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="origin-routing">
              <span className="origin-routing-orbit">
                <i />
                <i />
                <Icon name="activity" />
              </span>
              <small>SIMULATED SMART ROUTING</small>
              <h2>Your order is ready to fill.</h2>
              <p>
                BetterTrack checked the portfolio scope, cash balance, review policy, tax estimate,
                and venue status.
              </p>
              <div className="origin-route-checks">
                {[
                  ['Portfolio permission', 'Allowed', 'shield'],
                  ['Cash or position', 'Available', 'wallet'],
                  ['Market data', 'Live · 84 ms', 'activity'],
                  ['Execution route', `${asset.venue} · €${fees.toFixed(2)} fee`, 'assets'],
                ].map(([label, value, icon]) => (
                  <span key={label}>
                    <Icon name={icon as IconName} size={14} />
                    <small>{label}</small>
                    <strong>{value}</strong>
                    <Icon name="check" size={13} />
                  </span>
                ))}
              </div>
              <div className="origin-demo-warning">
                <Icon name="help" />
                <span>
                  <strong>This is where a broker handoff would occur.</strong>
                  <small>
                    The demo records a realistic fill without sending an external order.
                  </small>
                </span>
              </div>
            </div>
          ) : null}

          {step === 3 ? (
            <div className="origin-trade-receipt">
              <span className="origin-success-mark">
                <Icon name="check" />
              </span>
              <small>ORDER FILLED · DEMO</small>
              <h2>
                {side === 'Buy' ? 'Added to' : 'Reduced in'} {portfolio}
              </h2>
              <p>
                {units.toLocaleString('en-IE', { maximumFractionDigits: 6 })} {asset.symbol} at{' '}
                {euro.format(price)}
              </p>
              <dl>
                <div>
                  <dt>Execution ID</dt>
                  <dd>
                    BT-DEMO-{asset.symbol}-{receiptNumber}
                  </dd>
                </div>
                <div>
                  <dt>Total cash impact</dt>
                  <dd className={cashImpact >= 0 ? 'is-positive' : ''}>
                    {euro.format(cashImpact)}
                  </dd>
                </div>
                <div>
                  <dt>New available cash</dt>
                  <dd>{euro.format(remainingCash)}</dd>
                </div>
                <div>
                  <dt>Portfolio effects</dt>
                  <dd>
                    Holding · allocation · performance · tax · audit
                    {uncoveredUnits > 0 ? ' · basis review' : ''}
                  </dd>
                </div>
              </dl>
              <div className="origin-receipt-actions">
                <button onClick={() => onReceiptAction?.('download', receipt)} type="button">
                  <Icon name="document" size={14} /> Download receipt
                </button>
                <button onClick={() => onReceiptAction?.('compare', receipt)} type="button">
                  <Icon name="workbench" size={14} /> Compare with scenario
                </button>
                <button onClick={() => onReceiptAction?.('share', receipt)} type="button">
                  <Icon name="share" size={14} /> Share with collaborator
                </button>
              </div>
            </div>
          ) : null}
        </main>
      </div>
      <footer className="origin-flow__footer">
        <span>
          <Icon name="shield" size={14} />
          {step < 3
            ? 'Simulation mode · review before every write'
            : 'Recorded in local demo state'}
        </span>
        <div>
          {step > 0 && step < 3 ? (
            <FlowButton onClick={() => setStep(step - 1)} tone="quiet">
              Back
            </FlowButton>
          ) : null}
          {step === 3 ? (
            <FlowButton icon="check" onClick={finish} tone="primary">
              View updated portfolio
            </FlowButton>
          ) : (
            <FlowButton
              disabled={(step === 0 && !canContinue) || (step === 1 && !confirmed)}
              icon={step === 2 ? 'activity' : 'arrow-right'}
              onClick={advance}
              tone="primary"
            >
              {step === 0 ? 'Review order' : step === 1 ? 'Confirm simulation' : 'Simulate fill'}
            </FlowButton>
          )}
        </div>
      </footer>
    </FlowShell>
  );
}

export type OriginPortfolioResult = {
  id: string;
  name: string;
  kind: string;
  parent: string;
  privacy: 'Private' | 'Shared' | 'Client';
  currency: string;
  target: string;
  modules: string[];
};

const portfolioSteps = [
  { label: 'Structure', description: 'Purpose and nesting', icon: 'layers' as IconName },
  { label: 'Rules', description: 'Ownership and defaults', icon: 'shield' as IconName },
  {
    label: 'Capabilities',
    description: 'Choose the starting surface',
    icon: 'sliders' as IconName,
  },
  { label: 'Ready', description: 'Create the data home', icon: 'check' as IconName },
];

export function OriginPortfolioCreateFlow({
  parentPortfolio,
  onClose,
  onComplete,
  onNextAction,
}: {
  parentPortfolio: string;
  onClose: () => void;
  onComplete: (portfolio: OriginPortfolioResult) => void;
  onNextAction?: (action: 'import' | 'invite', portfolio: OriginPortfolioResult) => void;
}) {
  const [step, setStep] = useState(0);
  const [kind, setKind] = useState('Personal investing');
  const [name, setName] = useState('Long-term investing');
  const [parent, setParent] = useState(
    parentPortfolio === 'All wealth' ? 'All wealth' : parentPortfolio,
  );
  const [privacy, setPrivacy] = useState<OriginPortfolioResult['privacy']>('Private');
  const [currency, setCurrency] = useState('EUR');
  const [target, setTarget] = useState('Balanced growth · 70/20/10');
  const [modules, setModules] = useState([
    'Holdings & performance',
    'Cash flow & recurring items',
    'Plans & targets',
    'Tax workspace',
  ]);
  const result: OriginPortfolioResult = {
    id: `portfolio_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'untitled'}`,
    name: name.trim() || 'Untitled portfolio',
    kind,
    parent,
    privacy,
    currency,
    target,
    modules,
  };

  function toggleModule(module: string) {
    setModules((current) =>
      current.includes(module) ? current.filter((item) => item !== module) : [...current, module],
    );
  }

  return (
    <FlowShell
      description="A portfolio is the source of truth. Everything else reads, models, or shares it."
      kicker="NEW DATA HOME"
      onClose={onClose}
      title="Create a portfolio"
      wide
    >
      <div className="origin-flow-layout">
        <StepRail current={step} steps={portfolioSteps} />
        <main className="origin-portfolio-flow">
          {step === 0 ? (
            <>
              <div className="origin-flow-intro">
                <small>01 · STRUCTURE</small>
                <h2>What should this portfolio represent?</h2>
                <p>
                  Keep one coherent financial context here. You can nest it into a larger view
                  without merging ownership, activity, or permissions.
                </p>
              </div>
              <div className="origin-choice-grid origin-choice-grid--four">
                {(
                  [
                    ['Personal investing', 'Brokerage, cash, goals, and taxes', 'wallet'],
                    ['Household or goal', 'Shared ownership and recurring life costs', 'house'],
                    [
                      'Company or entity',
                      'Operating assets, liabilities, and forecasts',
                      'briefcase',
                    ],
                    ['Client mandate', 'Scoped access, proposals, and reporting', 'people'],
                  ] as Array<[string, string, IconName]>
                ).map(([label, copy, icon]) => (
                  <button
                    className={kind === label ? 'is-active' : ''}
                    key={label}
                    onClick={() => setKind(label)}
                    type="button"
                  >
                    <Icon name={icon} />
                    <strong>{label}</strong>
                    <small>{copy}</small>
                    {kind === label ? <Icon name="check" size={14} /> : null}
                  </button>
                ))}
              </div>
              <div className="origin-field-grid origin-field-grid--wide">
                <label>
                  Portfolio name
                  <input
                    aria-label="Portfolio name"
                    onChange={(event) => setName(event.target.value)}
                    value={name}
                  />
                </label>
                <label>
                  Nest inside
                  <select
                    aria-label="Parent portfolio"
                    onChange={(event) => setParent(event.target.value)}
                    value={parent}
                  >
                    <option>All wealth</option>
                    <option>Personal wealth</option>
                    <option>Northstar Studio</option>
                    <option>Keep independent</option>
                  </select>
                </label>
              </div>
              <section className="origin-nesting-preview">
                <span className="origin-node origin-node--parent">
                  <Icon name="layers" />
                  <span>
                    <small>PARENT VIEW</small>
                    <strong>{parent}</strong>
                  </span>
                </span>
                <i />
                <span className="origin-node origin-node--new">
                  <Icon name="portfolio" />
                  <span>
                    <small>NEW SOURCE OF TRUTH</small>
                    <strong>{name || 'Untitled portfolio'}</strong>
                  </span>
                </span>
                <p>Aggregated value flows upward; data ownership and access stay here.</p>
              </section>
            </>
          ) : null}

          {step === 1 ? (
            <>
              <div className="origin-flow-intro">
                <small>02 · RULES</small>
                <h2>Set the boundaries before adding data.</h2>
                <p>These defaults protect future imports, collaborators, automations, and apps.</p>
              </div>
              <div className="origin-rule-grid">
                <section>
                  <span className="origin-section-icon">
                    <Icon name="lock" />
                  </span>
                  <small>ACCESS MODEL</small>
                  <h3>Who owns and changes this?</h3>
                  <div className="origin-segmented-list">
                    {(['Private', 'Shared', 'Client'] as const).map((item) => (
                      <button
                        className={privacy === item ? 'is-active' : ''}
                        key={item}
                        onClick={() => setPrivacy(item)}
                        type="button"
                      >
                        <strong>{item}</strong>
                        <small>
                          {item === 'Private'
                            ? 'Only you until invited'
                            : item === 'Shared'
                              ? 'Co-owners with granular roles'
                              : 'Advisor-managed with an approval trail'}
                        </small>
                        {privacy === item ? <Icon name="check" size={13} /> : null}
                      </button>
                    ))}
                  </div>
                </section>
                <section>
                  <span className="origin-section-icon">
                    <Icon name="cash" />
                  </span>
                  <small>ACCOUNTING DEFAULTS</small>
                  <h3>How should values behave?</h3>
                  <label>
                    Base currency
                    <select
                      aria-label="Portfolio currency"
                      onChange={(event) => setCurrency(event.target.value)}
                      value={currency}
                    >
                      <option>EUR</option>
                      <option>USD</option>
                      <option>GBP</option>
                      <option>CHF</option>
                    </select>
                  </label>
                  <label>
                    Performance method
                    <select aria-label="Performance method" defaultValue="Time-weighted return">
                      <option>Time-weighted return</option>
                      <option>Money-weighted return</option>
                      <option>Simple gain</option>
                    </select>
                  </label>
                  <label>
                    Tax residence
                    <select aria-label="Tax residence" defaultValue="Austria">
                      <option>Austria</option>
                      <option>Germany</option>
                      <option>Switzerland</option>
                      <option>Not configured</option>
                    </select>
                  </label>
                </section>
              </div>
              <label className="origin-policy-row">
                <input defaultChecked type="checkbox" />
                <Icon name="shield" />
                <span>
                  <strong>Require review for external writes</strong>
                  <small>
                    Imports, OAuth apps, MCP tools, AI, and collaborators propose changes before
                    portfolio data changes.
                  </small>
                </span>
                <em>Recommended</em>
              </label>
            </>
          ) : null}

          {step === 2 ? (
            <>
              <div className="origin-flow-intro">
                <small>03 · CAPABILITIES</small>
                <h2>Start focused. Nothing becomes another system.</h2>
                <p>Capabilities are views over this portfolio and can be enabled later.</p>
              </div>
              <div className="origin-module-list">
                {(
                  [
                    [
                      'Holdings & performance',
                      'Positions, lots, benchmarks, dividends, attribution',
                      'assets',
                    ],
                    [
                      'Cash flow & recurring items',
                      'Income, spending, bills, transfers, and runway',
                      'cash',
                    ],
                    [
                      'Plans & targets',
                      'Allocation bands, goals, scenarios, and life events',
                      'target',
                    ],
                    [
                      'Tax workspace',
                      'Realized gains, loss harvesting, documents, and reports',
                      'document',
                    ],
                    [
                      'Files & evidence',
                      'Statements, receipts, contracts, and Drive-backed files',
                      'folder',
                    ],
                    [
                      'Collaboration',
                      'Co-owners, advisor proposals, comments, and approvals',
                      'people',
                    ],
                  ] as Array<[string, string, IconName]>
                ).map(([label, copy, icon]) => {
                  const active = modules.includes(label);
                  return (
                    <button
                      className={active ? 'is-active' : ''}
                      key={label}
                      onClick={() => toggleModule(label)}
                      type="button"
                    >
                      <span>
                        <Icon name={icon} />
                      </span>
                      <span>
                        <strong>{label}</strong>
                        <small>{copy}</small>
                      </span>
                      <i className={cx('origin-switch', active && 'is-on')}>
                        <em />
                      </i>
                    </button>
                  );
                })}
              </div>
              <label className="origin-target-field">
                <span>
                  <Icon name="target" />
                  <span>
                    <strong>Starting target</strong>
                    <small>Used for drift, rebalance, and scenario comparisons.</small>
                  </span>
                </span>
                <select
                  aria-label="Starting target"
                  onChange={(event) => setTarget(event.target.value)}
                  value={target}
                >
                  <option>Balanced growth · 70/20/10</option>
                  <option>Global equity · 90/0/10</option>
                  <option>Capital preservation · 30/50/20</option>
                  <option>No target yet</option>
                </select>
              </label>
            </>
          ) : null}

          {step === 3 ? (
            <div className="origin-create-receipt">
              <span className="origin-success-mark">
                <Icon name="check" />
              </span>
              <small>STRUCTURE READY</small>
              <h2>{result.name}</h2>
              <p>
                A new {kind.toLowerCase()} portfolio is ready inside {parent}. Add data now or leave
                it clean until later.
              </p>
              <div className="origin-created-map">
                <span>
                  <Icon name="layers" />
                  <small>{parent}</small>
                </span>
                <i />
                <span>
                  <Icon name="portfolio" />
                  <small>{result.name}</small>
                  <em>{currency}</em>
                </span>
              </div>
              <dl className="origin-created-facts">
                <div>
                  <dt>Access</dt>
                  <dd>{privacy}</dd>
                </div>
                <div>
                  <dt>Capabilities</dt>
                  <dd>{modules.length} enabled</dd>
                </div>
                <div>
                  <dt>Target</dt>
                  <dd>{target}</dd>
                </div>
                <div>
                  <dt>Review policy</dt>
                  <dd>External writes require approval</dd>
                </div>
              </dl>
              <section className="origin-next-actions">
                <small>NEXT, IF YOU WANT</small>
                <button onClick={() => onNextAction?.('import', result)} type="button">
                  <Icon name="upload" />
                  <span>
                    <strong>Import existing history</strong>
                    <small>CSV, PDF, broker, Parqet, or Drive</small>
                  </span>
                  <Icon name="chevron-right" size={14} />
                </button>
                <button onClick={() => onNextAction?.('invite', result)} type="button">
                  <Icon name="people" />
                  <span>
                    <strong>Invite a co-owner</strong>
                    <small>Choose viewer, proposer, editor, or owner</small>
                  </span>
                  <Icon name="chevron-right" size={14} />
                </button>
              </section>
            </div>
          ) : null}
        </main>
      </div>
      <footer className="origin-flow__footer">
        <span>
          <Icon name="database" size={14} />
          {step === 3
            ? 'No separate subsystem created'
            : `${modules.length} portfolio capabilities selected`}
        </span>
        <div>
          {step > 0 && step < 3 ? (
            <FlowButton onClick={() => setStep(step - 1)} tone="quiet">
              Back
            </FlowButton>
          ) : null}
          {step === 3 ? (
            <FlowButton icon="portfolio" onClick={() => onComplete(result)} tone="primary">
              Open portfolio
            </FlowButton>
          ) : (
            <FlowButton
              disabled={step === 0 && !name.trim()}
              icon="arrow-right"
              onClick={() => setStep(step + 1)}
              tone="primary"
            >
              {step === 2 ? 'Create portfolio' : 'Continue'}
            </FlowButton>
          )}
        </div>
      </footer>
    </FlowShell>
  );
}

export type OriginCashFlowResult = {
  id: string;
  portfolio: string;
  kind: 'Expense' | 'Income' | 'Transfer';
  title: string;
  amount: number;
  category: string;
  account: string;
  counterparty: string;
  recurring: boolean;
  schedule: string | null;
  cashImpact: number;
  document: string | null;
  createdAt: string;
};

const cashFlowSteps = [
  { label: 'Activity', description: 'Type, amount, and source', icon: 'cash' as IconName },
  { label: 'Context', description: 'Category and recurrence', icon: 'layers' as IconName },
  { label: 'Review', description: 'Connected portfolio effects', icon: 'document' as IconName },
  { label: 'Receipt', description: 'Ledger and forecast updated', icon: 'check' as IconName },
];

export function OriginCashFlowFlow({
  portfolio,
  availableCash,
  initialKind = 'Expense',
  onClose,
  onComplete,
}: {
  portfolio: string;
  availableCash: number;
  initialKind?: OriginCashFlowResult['kind'];
  onClose: () => void;
  onComplete: (result: OriginCashFlowResult) => void;
}) {
  const [step, setStep] = useState(0);
  const [kind, setKind] = useState<OriginCashFlowResult['kind']>(initialKind);
  const [title, setTitle] = useState('Monthly workspace rent');
  const [amount, setAmount] = useState('820');
  const [account, setAccount] = useState('Cash · Personal wealth');
  const [counterparty, setCounterparty] = useState('Northstar Office GmbH');
  const [category, setCategory] = useState('Housing & workspace');
  const [recurring, setRecurring] = useState(true);
  const [schedule, setSchedule] = useState('Monthly · 1st business day');
  const [document, setDocument] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const numericAmount = Math.max(0, Number(amount) || 0);
  const cashImpact = kind === 'Income' ? numericAmount : kind === 'Expense' ? -numericAmount : 0;
  const afterCash = availableCash + cashImpact;
  const result: OriginCashFlowResult = {
    id: `cash_${kind.toLowerCase()}_${title.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
    portfolio,
    kind,
    title: title.trim() || `${kind} activity`,
    amount: numericAmount,
    category,
    account,
    counterparty,
    recurring,
    schedule: recurring ? schedule : null,
    cashImpact,
    document,
    createdAt: 'Today, 10:42',
  };
  const effectRows = [
    ['Activity ledger', `Add ${kind.toLowerCase()} with source lineage`, 'list'],
    [
      'Available cash',
      kind === 'Transfer'
        ? 'Move between two portfolio accounts'
        : `${euro.format(availableCash)} → ${euro.format(afterCash)}`,
      'wallet',
    ],
    [
      'Cash-flow forecast',
      recurring ? `${schedule} included in every projection` : 'One-time impact on July',
      'activity',
    ],
    ['Plan & reports', `${category} totals, runway, tax, and exports update together`, 'document'],
  ] as Array<[string, string, IconName]>;

  function changeKind(next: OriginCashFlowResult['kind']) {
    setKind(next);
    if (next === 'Expense') {
      setTitle('Monthly workspace rent');
      setAmount('820');
      setCategory('Housing & workspace');
      setRecurring(true);
    } else if (next === 'Income') {
      setTitle('Consulting retainer');
      setAmount('2400');
      setCategory('Business income');
      setRecurring(true);
    } else {
      setTitle('Move to tax reserve');
      setAmount('700');
      setCategory('Internal transfer');
      setRecurring(false);
    }
  }

  return (
    <FlowShell
      description="Cash flow belongs to this portfolio and automatically feeds its plan, reports, and audit trail."
      kicker="PORTFOLIO ACTIVITY"
      onClose={onClose}
      title={`Record ${kind.toLowerCase()}`}
      wide
    >
      <div className="origin-flow-layout">
        <StepRail current={step} steps={cashFlowSteps} />
        <main className="origin-cash-flow">
          {step === 0 ? (
            <>
              <div className="origin-flow-intro">
                <small>01 · ACTIVITY</small>
                <h2>One entry, connected everywhere it matters.</h2>
                <p>
                  Record the real-world cash event here. BetterTrack derives cash flow, plan,
                  budget, tax, and reporting context from the same ledger item.
                </p>
              </div>
              <div className="origin-cash-kind">
                {(['Expense', 'Income', 'Transfer'] as const).map((item) => (
                  <button
                    className={kind === item ? 'is-active' : ''}
                    key={item}
                    onClick={() => changeKind(item)}
                    type="button"
                  >
                    <Icon
                      name={
                        item === 'Expense'
                          ? 'arrow-up'
                          : item === 'Income'
                            ? 'arrow-down'
                            : 'repeat'
                      }
                    />
                    <span>
                      <strong>{item}</strong>
                      <small>
                        {item === 'Expense'
                          ? 'Money leaves this portfolio'
                          : item === 'Income'
                            ? 'Money enters this portfolio'
                            : 'Value moves without changing wealth'}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
              <section className="origin-cash-ticket">
                <label className="origin-cash-amount">
                  <small>{kind} amount</small>
                  <span>
                    <em>€</em>
                    <input
                      aria-label={`${kind} amount`}
                      inputMode="decimal"
                      onChange={(event) => setAmount(event.target.value)}
                      value={amount}
                    />
                  </span>
                </label>
                <div className="origin-field-grid origin-field-grid--wide">
                  <label>
                    Description
                    <input
                      aria-label="Cash activity description"
                      onChange={(event) => setTitle(event.target.value)}
                      value={title}
                    />
                  </label>
                  <label>
                    Counterparty
                    <input
                      aria-label="Cash activity counterparty"
                      onChange={(event) => setCounterparty(event.target.value)}
                      value={counterparty}
                    />
                  </label>
                </div>
                <div className="origin-field-grid">
                  <label>
                    {kind === 'Income'
                      ? 'Deposit into'
                      : kind === 'Transfer'
                        ? 'Move from'
                        : 'Pay from'}
                    <select
                      aria-label="Cash account"
                      onChange={(event) => setAccount(event.target.value)}
                      value={account}
                    >
                      <option>Cash · Personal wealth</option>
                      <option>Sparkasse •• 1842</option>
                      <option>Trade Republic cash</option>
                    </select>
                  </label>
                  <label>
                    Activity date
                    <input aria-label="Activity date" defaultValue="2026-07-27" type="date" />
                  </label>
                </div>
                {kind === 'Transfer' ? (
                  <label>
                    Move into
                    <select
                      aria-label="Transfer destination"
                      defaultValue="Tax reserve · Personal wealth"
                    >
                      <option>Tax reserve · Personal wealth</option>
                      <option>Cash · Northstar Studio</option>
                      <option>Family reserve</option>
                    </select>
                  </label>
                ) : null}
              </section>
              <div className={cx('origin-trade-balance', afterCash < 0 && 'is-negative')}>
                <span>
                  <small>Available cash</small>
                  <strong>{euro.format(availableCash)}</strong>
                </span>
                <Icon name="arrow-right" size={15} />
                <span>
                  <small>After activity</small>
                  <strong>{euro.format(afterCash)}</strong>
                </span>
                {afterCash < 0 ? <em>This account needs {euro.format(-afterCash)} more.</em> : null}
              </div>
            </>
          ) : null}

          {step === 1 ? (
            <>
              <div className="origin-flow-intro">
                <small>02 · CONTEXT</small>
                <h2>Teach the portfolio once.</h2>
                <p>
                  Useful context makes future imports, forecasts, reports, and automations cleaner.
                </p>
              </div>
              <section className="origin-cash-context">
                <label>
                  Portfolio category
                  <select
                    aria-label="Cash flow category"
                    onChange={(event) => setCategory(event.target.value)}
                    value={category}
                  >
                    <option>Housing & workspace</option>
                    <option>Food & household</option>
                    <option>Business income</option>
                    <option>Salary & compensation</option>
                    <option>Taxes</option>
                    <option>Internal transfer</option>
                    <option>Investment income</option>
                  </select>
                </label>
                <div className="origin-category-path">
                  <Icon name="portfolio" />
                  <span>
                    <small>DATA PATH</small>
                    <strong>{portfolio}</strong>
                  </span>
                  <Icon name="chevron-right" />
                  <span>
                    <small>CASH FLOW</small>
                    <strong>{category}</strong>
                  </span>
                </div>
                <label className="origin-recurring">
                  <input
                    checked={recurring}
                    onChange={(event) => setRecurring(event.target.checked)}
                    type="checkbox"
                  />
                  <span>
                    <strong>This happens repeatedly</strong>
                    <small>
                      Add the expected item to forecasts without inventing a second ledger.
                    </small>
                  </span>
                </label>
                {recurring ? (
                  <div className="origin-field-grid">
                    <label>
                      Schedule
                      <select
                        aria-label="Cash flow schedule"
                        onChange={(event) => setSchedule(event.target.value)}
                        value={schedule}
                      >
                        <option>Monthly · 1st business day</option>
                        <option>Monthly · last business day</option>
                        <option>Weekly · Monday</option>
                        <option>Quarterly · 1st business day</option>
                        <option>Yearly · 1 January</option>
                      </select>
                    </label>
                    <label>
                      Forecast until
                      <select aria-label="Forecast end" defaultValue="Until I stop it">
                        <option>Until I stop it</option>
                        <option>31 December 2026</option>
                        <option>31 December 2027</option>
                      </select>
                    </label>
                  </div>
                ) : null}
                <button
                  className={cx('origin-document-attach', document && 'is-attached')}
                  onClick={() => setDocument('Workspace_rent_July.pdf')}
                  type="button"
                >
                  <Icon name={document ? 'check' : 'document'} />
                  <span>
                    <strong>{document ?? 'Attach evidence'}</strong>
                    <small>
                      {document
                        ? 'Stored with this activity · 184 KB'
                        : 'Receipt, invoice, agreement, or note'}
                    </small>
                  </span>
                  <em>{document ? 'Attached' : 'Choose file'}</em>
                </button>
              </section>
            </>
          ) : null}

          {step === 2 ? (
            <div className="origin-cash-review">
              <div className="origin-review-hero">
                <span>
                  <Icon
                    name={
                      kind === 'Expense' ? 'arrow-up' : kind === 'Income' ? 'arrow-down' : 'repeat'
                    }
                  />
                </span>
                <small>REVIEW {kind.toUpperCase()}</small>
                <h2>{euro.format(numericAmount)}</h2>
                <p>
                  {title} · {portfolio}
                </p>
              </div>
              <div className="origin-effect-list">
                {effectRows.map(([label, value, icon]) => (
                  <span key={label}>
                    <Icon name={icon} />
                    <small>{label}</small>
                    <strong>{value}</strong>
                    <Icon name="check" size={13} />
                  </span>
                ))}
              </div>
              <dl className="origin-cash-facts">
                <div>
                  <dt>Account</dt>
                  <dd>{account}</dd>
                </div>
                <div>
                  <dt>Category</dt>
                  <dd>{category}</dd>
                </div>
                <div>
                  <dt>Counterparty</dt>
                  <dd>{counterparty}</dd>
                </div>
                <div>
                  <dt>Evidence</dt>
                  <dd>{document ?? 'None'}</dd>
                </div>
              </dl>
              <label className="origin-confirm-order">
                <input
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                  type="checkbox"
                />
                <span>
                  <strong>I reviewed the connected effects.</strong>
                  <small>The demo records one activity and derives the other views from it.</small>
                </span>
              </label>
            </div>
          ) : null}

          {step === 3 ? (
            <div className="origin-trade-receipt">
              <span className="origin-success-mark">
                <Icon name="check" />
              </span>
              <small>ACTIVITY RECORDED</small>
              <h2>{title}</h2>
              <p>
                {euro.format(numericAmount)} · {category}
              </p>
              <dl>
                <div>
                  <dt>Ledger ID</dt>
                  <dd>BT-DEMO-CASH-1042</dd>
                </div>
                <div>
                  <dt>Cash impact</dt>
                  <dd className={cashImpact >= 0 ? 'is-positive' : ''}>
                    {euro.format(cashImpact)}
                  </dd>
                </div>
                <div>
                  <dt>Forecast</dt>
                  <dd>{recurring ? schedule : 'One-time activity'}</dd>
                </div>
                <div>
                  <dt>Lineage</dt>
                  <dd>Manual · Alex Morgan · {document ?? 'No attachment'}</dd>
                </div>
              </dl>
            </div>
          ) : null}
        </main>
      </div>
      <footer className="origin-flow__footer">
        <span>
          <Icon name="link" size={14} />
          {step === 3 ? 'One source of truth · all derived views updated' : portfolio}
        </span>
        <div>
          {step > 0 && step < 3 ? (
            <FlowButton onClick={() => setStep(step - 1)} tone="quiet">
              Back
            </FlowButton>
          ) : null}
          {step === 3 ? (
            <FlowButton icon="activity" onClick={() => onComplete(result)} tone="primary">
              View cash-flow ledger
            </FlowButton>
          ) : (
            <FlowButton
              disabled={
                (step === 0 && (!numericAmount || afterCash < 0 || !title.trim())) ||
                (step === 2 && !confirmed)
              }
              icon={step === 2 ? 'check' : 'arrow-right'}
              onClick={() => setStep(step + 1)}
              tone="primary"
            >
              {step === 0 ? 'Add context' : step === 1 ? 'Review effects' : 'Record activity'}
            </FlowButton>
          )}
        </div>
      </footer>
    </FlowShell>
  );
}
