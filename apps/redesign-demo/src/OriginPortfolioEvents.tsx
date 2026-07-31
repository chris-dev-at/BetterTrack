import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';

import { Icon, type IconName } from './Icons';
import type { OriginReviewEntry } from './OriginReviewCenter';
import { useAccessibleDialog } from './useAccessibleDialog';
import './origin-portfolio-events.css';

export type OriginPortfolioEventType =
  | 'cash-dividend'
  | 'dividend-reinvestment'
  | 'split'
  | 'rights-issue'
  | 'merger-spin-off'
  | 'capital-return'
  | 'delisting';

export type OriginPortfolioEventStatus =
  | 'ready'
  | 'needs-evidence'
  | 'needs-decision'
  | 'in-review'
  | 'completed';

export type OriginPortfolioEvent = {
  id: string;
  type: OriginPortfolioEventType;
  title: string;
  issuer: string;
  ticker: string;
  isin: string;
  summary: string;
  status: OriginPortfolioEventStatus;
  safeToConfirm: boolean;
  source: {
    connection: string;
    account: string;
    notice: string;
    discoveredAt: string;
    confidence: number;
  };
  dates: {
    announced: string;
    exDate: string;
    recordDate: string;
    payDate: string;
  };
  impact: {
    holdingBefore: string;
    holdingAfter: string;
    cashBefore: string;
    cashAfter: string;
    basisBefore: string;
    basisAfter: string;
    difference: string;
  };
  taxImpact: {
    classification: string;
    estimate: string;
    jurisdiction: string;
    note: string;
    confidence: 'verified' | 'estimated' | 'unresolved';
  };
  assumptions: Array<{
    id: string;
    label: string;
    value: string;
    helper: string;
    editable: boolean;
  }>;
  evidence: Array<{
    id: string;
    name: string;
    kind: string;
    state: 'linked' | 'missing' | 'derived';
    updatedAt: string;
  }>;
  lineage: Array<{
    label: string;
    detail: string;
    at: string;
    state: 'verified' | 'external' | 'derived' | 'warning';
  }>;
  audit: Array<{
    id: string;
    at: string;
    actor: string;
    action: string;
    detail: string;
  }>;
  receiptId?: string;
};

export type OriginPortfolioEventsProps = {
  portfolio: {
    id: string;
    name: string;
    currency?: string;
  };
  privateMode: boolean;
  onClose: () => void;
  onOpenFiles: () => void;
  onOpenTax: () => void;
  onOpenReview: () => void;
  onSubmitReview: (entry: OriginReviewEntry) => void;
  onConfirmed: (events: OriginPortfolioEvent[], receipt: OriginPortfolioEventReceipt) => void;
  onToast: (message: string) => void;
};

type EventsView = 'inbox' | 'completed' | 'audit';
type StatusFilter = OriginPortfolioEventStatus | 'all' | 'actionable';
type EventTypeFilter = OriginPortfolioEventType | 'all';

export type OriginPortfolioEventReceipt = {
  id: string;
  at: string;
  actor: string;
  action: 'confirmed' | 'bulk-confirmed' | 'review-submitted' | 'assumptions-updated';
  eventIds: string[];
  eventTitles: string[];
  reason: string;
  destination?: string;
};

type GlobalAuditEntry = {
  id: string;
  at: string;
  actor: string;
  action: string;
  detail: string;
  eventId: string;
  receiptId?: string;
};

type PersistedEventsState = {
  version: 1;
  portfolioId: string;
  events: OriginPortfolioEvent[];
  receipts: OriginPortfolioEventReceipt[];
  audit: GlobalAuditEntry[];
};

type WorkflowDialog =
  | {
      kind: 'confirm';
      eventIds: string[];
      bulk: boolean;
    }
  | {
      kind: 'review';
      eventIds: [string];
    }
  | {
      kind: 'assumptions';
      eventIds: [string];
    }
  | null;

const typeMeta: Record<OriginPortfolioEventType, { label: string; short: string; icon: IconName }> =
  {
    'cash-dividend': { label: 'Cash dividend', short: 'Dividend', icon: 'cash' },
    'dividend-reinvestment': { label: 'Dividend reinvestment', short: 'DRIP', icon: 'repeat' },
    split: { label: 'Share split', short: 'Split', icon: 'assets' },
    'rights-issue': { label: 'Rights issue', short: 'Rights', icon: 'plus' },
    'merger-spin-off': { label: 'Merger / spin-off', short: 'Merger', icon: 'layers' },
    'capital-return': { label: 'Capital return', short: 'Capital', icon: 'arrow-down' },
    delisting: { label: 'Delisting', short: 'Delisting', icon: 'minus' },
  };

const statusMeta: Record<
  OriginPortfolioEventStatus,
  { label: string; icon: IconName; tone: string }
> = {
  ready: { label: 'Ready to confirm', icon: 'check', tone: 'positive' },
  'needs-evidence': { label: 'Evidence needed', icon: 'document', tone: 'warning' },
  'needs-decision': { label: 'Decision needed', icon: 'activity', tone: 'attention' },
  'in-review': { label: 'In Review', icon: 'inbox', tone: 'review' },
  completed: { label: 'Completed', icon: 'check', tone: 'complete' },
};

function nowLabel() {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date());
}

function makeId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function makeReference(prefix: string) {
  return `${prefix}-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 8999)}`;
}

function storageKey(portfolioId: string) {
  const scope =
    portfolioId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'portfolio';
  return `bt-origin-portfolio-events-v1-${scope}`;
}

function seedEvents(currency = 'EUR'): OriginPortfolioEvent[] {
  const symbol = currency === 'USD' ? '$' : currency === 'GBP' ? '£' : '€';
  return [
    {
      id: 'event_msft_div_2026q2',
      type: 'cash-dividend',
      title: 'Quarterly cash dividend',
      issuer: 'Microsoft Corporation',
      ticker: 'MSFT',
      isin: 'US5949181045',
      summary: '142 shares are eligible for a USD 0.91 per-share cash distribution.',
      status: 'ready',
      safeToConfirm: true,
      source: {
        connection: 'Interactive Brokers',
        account: 'Main securities · ••4812',
        notice: 'MSFT dividend confirmation · 21 Jul 2026.pdf',
        discoveredAt: '21 Jul 2026 · 06:42',
        confidence: 99,
      },
      dates: {
        announced: '16 Jun 2026',
        exDate: '20 Aug 2026',
        recordDate: '20 Aug 2026',
        payDate: '10 Sep 2026',
      },
      impact: {
        holdingBefore: '142.000 shares',
        holdingAfter: '142.000 shares',
        cashBefore: `${symbol}18,420.38`,
        cashAfter: `${symbol}18,531.67`,
        basisBefore: `${symbol}48,906.20`,
        basisAfter: `${symbol}48,906.20`,
        difference: `+${symbol}111.29 net cash`,
      },
      taxImpact: {
        classification: 'Foreign dividend income',
        estimate: `${symbol}18.02 estimated withholding`,
        jurisdiction: 'United States → Austria',
        note: 'Treaty rate of 15% applied to the translated gross amount.',
        confidence: 'verified',
      },
      assumptions: [
        {
          id: 'gross',
          label: 'Gross distribution',
          value: 'USD 129.22',
          helper: '142 shares × USD 0.91',
          editable: false,
        },
        {
          id: 'fx',
          label: 'Settlement FX',
          value: '1 USD = 0.984 EUR',
          helper: 'Provider settlement rate',
          editable: false,
        },
        {
          id: 'withholding',
          label: 'Withholding rate',
          value: '15.00%',
          helper: 'Verified treaty rate',
          editable: false,
        },
      ],
      evidence: [
        {
          id: 'msft_notice',
          name: 'MSFT dividend confirmation · 21 Jul 2026.pdf',
          kind: 'Issuer notice',
          state: 'linked',
          updatedAt: '21 Jul · 06:42',
        },
        {
          id: 'msft_position',
          name: 'IBKR position snapshot · 20 Aug 2026',
          kind: 'Connection evidence',
          state: 'linked',
          updatedAt: '20 Aug · 23:11',
        },
      ],
      lineage: [
        {
          label: 'Connection event discovered',
          detail: 'Interactive Brokers reported MSFT cash distribution CA-874221.',
          at: '21 Jul 2026 · 06:42',
          state: 'external',
        },
        {
          label: 'Notice linked in Files',
          detail: 'Issuer notice matched by ISIN and announced date.',
          at: '21 Jul 2026 · 06:43',
          state: 'verified',
        },
        {
          label: 'Portfolio impact calculated',
          detail: 'Eligible quantity, settlement FX, withholding, and cash delta reconciled.',
          at: '20 Aug 2026 · 23:12',
          state: 'derived',
        },
      ],
      audit: [
        {
          id: 'aud_msft_1',
          at: '20 Aug 2026 · 23:12',
          actor: 'BetterTrack checks',
          action: 'Marked ready',
          detail: 'Connection quantity and linked notice agree.',
        },
      ],
    },
    {
      id: 'event_novo_drip_2026',
      type: 'dividend-reinvestment',
      title: 'Dividend reinvestment election',
      issuer: 'Novo Nordisk A/S',
      ticker: 'NOVO-B',
      isin: 'DK0062498333',
      summary:
        'A dividend was reinvested, but the fractional share price differs from the broker notice.',
      status: 'needs-evidence',
      safeToConfirm: false,
      source: {
        connection: 'Saxo Bank',
        account: 'Nordics sleeve · ••0951',
        notice: 'NOVO-B DRIP advice · 18 Jun 2026.pdf',
        discoveredAt: '18 Jun 2026 · 09:16',
        confidence: 76,
      },
      dates: {
        announced: '27 Mar 2026',
        exDate: '25 May 2026',
        recordDate: '26 May 2026',
        payDate: '17 Jun 2026',
      },
      impact: {
        holdingBefore: '64.000 shares',
        holdingAfter: '64.482 shares',
        cashBefore: `${symbol}7,108.42`,
        cashAfter: `${symbol}7,108.42`,
        basisBefore: `${symbol}5,942.18`,
        basisAfter: `${symbol}6,284.74`,
        difference: `+0.482 shares · +${symbol}342.56 basis`,
      },
      taxImpact: {
        classification: 'Dividend followed by acquisition',
        estimate: `${symbol}91.44 estimated dividend tax`,
        jurisdiction: 'Denmark → Austria',
        note: 'Gross dividend and acquisition should remain separate tax-lot events.',
        confidence: 'estimated',
      },
      assumptions: [
        {
          id: 'reinvestment-price',
          label: 'Reinvestment price',
          value: 'DKK 5,301.25',
          helper: 'Provider activity says DKK 5,292.10',
          editable: true,
        },
        {
          id: 'fractional-fee',
          label: 'Fractional execution fee',
          value: 'DKK 12.00',
          helper: 'Not itemised in source activity',
          editable: true,
        },
        {
          id: 'tax-method',
          label: 'Tax treatment',
          value: 'Dividend + acquisition',
          helper: 'Recommended for Austrian reporting',
          editable: true,
        },
      ],
      evidence: [
        {
          id: 'novo_notice',
          name: 'NOVO-B DRIP advice · 18 Jun 2026.pdf',
          kind: 'Broker notice',
          state: 'linked',
          updatedAt: '18 Jun · 09:16',
        },
        {
          id: 'novo_execution',
          name: 'Fractional execution contract',
          kind: 'Contract note',
          state: 'missing',
          updatedAt: 'Requested 18 Jun',
        },
      ],
      lineage: [
        {
          label: 'Connection event discovered',
          detail: 'Saxo reported one dividend and one reinvestment activity.',
          at: '18 Jun 2026 · 09:16',
          state: 'external',
        },
        {
          label: 'Broker notice linked in Files',
          detail: 'Notice confirms election and quantity, but not the execution fee.',
          at: '18 Jun 2026 · 09:18',
          state: 'warning',
        },
        {
          label: 'Basis difference detected',
          detail: 'Implied price differs by DKK 9.15 per share from provider activity.',
          at: '18 Jun 2026 · 09:19',
          state: 'derived',
        },
      ],
      audit: [
        {
          id: 'aud_novo_1',
          at: '18 Jun 2026 · 09:19',
          actor: 'BetterTrack checks',
          action: 'Requested evidence',
          detail: 'Fractional execution contract is required to finalise basis.',
        },
      ],
    },
    {
      id: 'event_nvidia_split_2026',
      type: 'split',
      title: '4-for-1 share split',
      issuer: 'NVIDIA Corporation',
      ticker: 'NVDA',
      isin: 'US67066G1040',
      summary: 'The issuer and custodian both confirm a 4-for-1 split with no cash component.',
      status: 'ready',
      safeToConfirm: true,
      source: {
        connection: 'Flatex',
        account: 'Growth portfolio · ••9204',
        notice: 'NVDA split notice · 08 Jul 2026.pdf',
        discoveredAt: '08 Jul 2026 · 05:51',
        confidence: 100,
      },
      dates: {
        announced: '11 Jun 2026',
        exDate: '13 Jul 2026',
        recordDate: '10 Jul 2026',
        payDate: '13 Jul 2026',
      },
      impact: {
        holdingBefore: '38.000 shares',
        holdingAfter: '152.000 shares',
        cashBefore: `${symbol}18,420.38`,
        cashAfter: `${symbol}18,420.38`,
        basisBefore: `${symbol}4,848.76`,
        basisAfter: `${symbol}4,848.76`,
        difference: '+114.000 shares · no value change',
      },
      taxImpact: {
        classification: 'Non-taxable share split',
        estimate: `${symbol}0.00 taxable amount`,
        jurisdiction: 'United States → Austria',
        note: 'Existing basis is allocated across four times the share count.',
        confidence: 'verified',
      },
      assumptions: [
        {
          id: 'ratio',
          label: 'Split ratio',
          value: '4 new : 1 old',
          helper: 'Issuer and custodian agree',
          editable: false,
        },
        {
          id: 'fractional',
          label: 'Fractional handling',
          value: 'Not applicable',
          helper: 'Result is a whole-share quantity',
          editable: false,
        },
      ],
      evidence: [
        {
          id: 'nvda_notice',
          name: 'NVDA split notice · 08 Jul 2026.pdf',
          kind: 'Custodian notice',
          state: 'linked',
          updatedAt: '08 Jul · 05:51',
        },
        {
          id: 'nvda_issuer',
          name: 'NVIDIA investor relations announcement',
          kind: 'Issuer source',
          state: 'linked',
          updatedAt: '11 Jun · 16:04',
        },
      ],
      lineage: [
        {
          label: 'Issuer event discovered',
          detail: 'Public issuer announcement matched by ISIN.',
          at: '11 Jun 2026 · 16:04',
          state: 'external',
        },
        {
          label: 'Connection notice linked',
          detail: 'Flatex notice confirms ratio and effective date.',
          at: '08 Jul 2026 · 05:51',
          state: 'verified',
        },
        {
          label: 'Lots simulated',
          detail: 'All 3 lots retain total basis with per-share basis divided by four.',
          at: '08 Jul 2026 · 05:52',
          state: 'derived',
        },
      ],
      audit: [
        {
          id: 'aud_nvda_1',
          at: '08 Jul 2026 · 05:52',
          actor: 'BetterTrack checks',
          action: 'Marked ready',
          detail: 'Ratio, dates, and eligible quantity reconcile.',
        },
      ],
    },
    {
      id: 'event_bayer_rights_2026',
      type: 'rights-issue',
      title: 'Tradable subscription rights',
      issuer: 'Bayer AG',
      ticker: 'BAYN',
      isin: 'DE000BAY0017',
      summary:
        'Choose whether to subscribe, sell, or let 31 rights expire before the election cutoff.',
      status: 'needs-decision',
      safeToConfirm: false,
      source: {
        connection: 'Deutsche Bank',
        account: 'European equities · ••1138',
        notice: 'BAYN rights election · 24 Jul 2026.pdf',
        discoveredAt: '24 Jul 2026 · 07:30',
        confidence: 94,
      },
      dates: {
        announced: '20 Jul 2026',
        exDate: '23 Jul 2026',
        recordDate: '24 Jul 2026',
        payDate: '06 Aug 2026',
      },
      impact: {
        holdingBefore: '186.000 shares',
        holdingAfter: '217.000 shares if subscribed',
        cashBefore: `${symbol}18,420.38`,
        cashAfter: `${symbol}17,300.18 if subscribed`,
        basisBefore: `${symbol}6,870.42`,
        basisAfter: `${symbol}7,990.62 if subscribed`,
        difference: `31 rights · ${symbol}1,120.20 election`,
      },
      taxImpact: {
        classification: 'Election-dependent',
        estimate: 'Unresolved until election',
        jurisdiction: 'Germany → Austria',
        note: 'Subscription adds basis; sale or expiry can create a taxable result.',
        confidence: 'unresolved',
      },
      assumptions: [
        {
          id: 'election',
          label: 'Election',
          value: 'Subscribe all 31 rights',
          helper: 'Alternatives: sell or expire',
          editable: true,
        },
        {
          id: 'subscription-price',
          label: 'Subscription price',
          value: `${symbol}36.00 per share`,
          helper: 'Issuer notice',
          editable: true,
        },
        {
          id: 'fees',
          label: 'Estimated fees',
          value: `${symbol}4.20`,
          helper: 'Custodian tariff estimate',
          editable: true,
        },
      ],
      evidence: [
        {
          id: 'bayer_notice',
          name: 'BAYN rights election · 24 Jul 2026.pdf',
          kind: 'Election notice',
          state: 'linked',
          updatedAt: '24 Jul · 07:30',
        },
        {
          id: 'bayer_decision',
          name: 'Election instruction',
          kind: 'Portfolio decision',
          state: 'missing',
          updatedAt: 'Due 02 Aug',
        },
      ],
      lineage: [
        {
          label: 'Connection event discovered',
          detail: 'Deutsche Bank sent an election notice for 31 rights.',
          at: '24 Jul 2026 · 07:30',
          state: 'external',
        },
        {
          label: 'Notice linked in Files',
          detail: 'Terms, deadline, and ratio were extracted from the signed PDF.',
          at: '24 Jul 2026 · 07:31',
          state: 'verified',
        },
        {
          label: 'Decision required',
          detail: 'No portfolio election has been approved yet.',
          at: '24 Jul 2026 · 07:32',
          state: 'warning',
        },
      ],
      audit: [
        {
          id: 'aud_bayer_1',
          at: '24 Jul 2026 · 07:32',
          actor: 'BetterTrack checks',
          action: 'Flagged decision',
          detail: 'Election cutoff is 02 Aug 2026 · 12:00 CEST.',
        },
      ],
    },
    {
      id: 'event_unilever_spinoff_2026',
      type: 'merger-spin-off',
      title: 'Ice-cream business spin-off',
      issuer: 'Unilever PLC',
      ticker: 'ULVR',
      isin: 'GB00B10RZP78',
      summary: 'New shares and a fractional cash component require a defensible basis allocation.',
      status: 'needs-evidence',
      safeToConfirm: false,
      source: {
        connection: 'Interactive Brokers',
        account: 'Main securities · ••4812',
        notice: 'Unilever separation terms · 02 Jul 2026.pdf',
        discoveredAt: '02 Jul 2026 · 13:08',
        confidence: 83,
      },
      dates: {
        announced: '14 May 2026',
        exDate: '30 Jun 2026',
        recordDate: '01 Jul 2026',
        payDate: '03 Jul 2026',
      },
      impact: {
        holdingBefore: '210.000 ULVR shares',
        holdingAfter: '210.000 ULVR + 42.000 TMC shares',
        cashBefore: `${symbol}18,420.38`,
        cashAfter: `${symbol}18,426.71`,
        basisBefore: `${symbol}9,382.10`,
        basisAfter: `${symbol}7,928.54 + ${symbol}1,453.56`,
        difference: `+42.000 shares · +${symbol}6.33 cash`,
      },
      taxImpact: {
        classification: 'Potential tax-neutral demerger',
        estimate: `${symbol}6.33 fractional cash may be taxable`,
        jurisdiction: 'United Kingdom → Austria',
        note: 'Final issuer tax memorandum is required before assigning basis.',
        confidence: 'unresolved',
      },
      assumptions: [
        {
          id: 'basis-allocation',
          label: 'Basis allocation',
          value: '84.51% ULVR · 15.49% TMC',
          helper: 'Derived from opening market values',
          editable: true,
        },
        {
          id: 'fractional',
          label: 'Fractional cash',
          value: `${symbol}6.33`,
          helper: 'Connection activity',
          editable: true,
        },
        {
          id: 'tax-neutral',
          label: 'Tax classification',
          value: 'Tax-neutral demerger',
          helper: 'Awaiting issuer memorandum',
          editable: true,
        },
      ],
      evidence: [
        {
          id: 'ulvr_terms',
          name: 'Unilever separation terms · 02 Jul 2026.pdf',
          kind: 'Issuer terms',
          state: 'linked',
          updatedAt: '02 Jul · 13:08',
        },
        {
          id: 'ulvr_tax',
          name: 'Final cross-border tax memorandum',
          kind: 'Tax evidence',
          state: 'missing',
          updatedAt: 'Requested 03 Jul',
        },
        {
          id: 'ulvr_price',
          name: 'Opening price basis worksheet',
          kind: 'Derived calculation',
          state: 'derived',
          updatedAt: '03 Jul · 09:14',
        },
      ],
      lineage: [
        {
          label: 'Connection event discovered',
          detail: 'New TMC position and fractional cash arrived together.',
          at: '02 Jul 2026 · 13:08',
          state: 'external',
        },
        {
          label: 'Terms linked in Files',
          detail: 'Distribution ratio is verified; tax memorandum is outstanding.',
          at: '02 Jul 2026 · 13:09',
          state: 'warning',
        },
        {
          label: 'Basis allocation simulated',
          detail: 'Opening market values produce an 84.51 / 15.49 allocation.',
          at: '03 Jul 2026 · 09:14',
          state: 'derived',
        },
      ],
      audit: [
        {
          id: 'aud_ulvr_1',
          at: '03 Jul 2026 · 09:14',
          actor: 'BetterTrack checks',
          action: 'Held for evidence',
          detail: 'Basis will not change until tax classification is reviewed.',
        },
      ],
    },
    {
      id: 'event_vw_capital_2026',
      type: 'capital-return',
      title: 'Return of capital',
      issuer: 'Volkswagen AG',
      ticker: 'VOW3',
      isin: 'DE0007664039',
      summary: 'A special distribution may reduce lot basis rather than count entirely as income.',
      status: 'in-review',
      safeToConfirm: false,
      source: {
        connection: 'Flatex',
        account: 'European holdings · ••9204',
        notice: 'VOW3 capital measure · 12 Jun 2026.pdf',
        discoveredAt: '12 Jun 2026 · 05:17',
        confidence: 88,
      },
      dates: {
        announced: '18 May 2026',
        exDate: '08 Jun 2026',
        recordDate: '09 Jun 2026',
        payDate: '11 Jun 2026',
      },
      impact: {
        holdingBefore: '74.000 shares',
        holdingAfter: '74.000 shares',
        cashBefore: `${symbol}17,982.52`,
        cashAfter: `${symbol}18,420.38`,
        basisBefore: `${symbol}9,114.82`,
        basisAfter: `${symbol}8,676.96 proposed`,
        difference: `+${symbol}437.86 cash · −${symbol}437.86 basis`,
      },
      taxImpact: {
        classification: 'Return of capital · pending review',
        estimate: `${symbol}0.00 current income proposed`,
        jurisdiction: 'Germany → Austria',
        note: 'Proposal BT-REV-2148 is waiting in Review.',
        confidence: 'estimated',
      },
      assumptions: [
        {
          id: 'capital-share',
          label: 'Capital component',
          value: '100.00%',
          helper: 'From issuer classification',
          editable: true,
        },
        {
          id: 'basis-floor',
          label: 'Basis floor',
          value: `${symbol}0.00`,
          helper: 'No lot falls below zero',
          editable: false,
        },
      ],
      evidence: [
        {
          id: 'vw_notice',
          name: 'VOW3 capital measure · 12 Jun 2026.pdf',
          kind: 'Issuer notice',
          state: 'linked',
          updatedAt: '12 Jun · 05:17',
        },
        {
          id: 'vw_review',
          name: 'Tax classification worksheet',
          kind: 'Derived calculation',
          state: 'derived',
          updatedAt: '12 Jun · 05:20',
        },
      ],
      lineage: [
        {
          label: 'Connection cash discovered',
          detail: 'Flatex activity was labelled Sonderausschüttung.',
          at: '12 Jun 2026 · 05:17',
          state: 'external',
        },
        {
          label: 'Issuer notice linked',
          detail: 'Notice describes the payment as a capital measure.',
          at: '12 Jun 2026 · 05:18',
          state: 'verified',
        },
        {
          label: 'Proposal staged',
          detail: 'Basis reduction is awaiting an authorised review.',
          at: '12 Jun 2026 · 05:20',
          state: 'derived',
        },
      ],
      audit: [
        {
          id: 'aud_vw_1',
          at: '12 Jun 2026 · 05:20',
          actor: 'You',
          action: 'Sent to Review',
          detail: 'Proposed full basis reduction with issuer evidence.',
        },
      ],
    },
    {
      id: 'event_wirecard_delisting',
      type: 'delisting',
      title: 'Delisting and worthless security',
      issuer: 'Wirecard AG',
      ticker: 'WDI',
      isin: 'DE0007472060',
      summary:
        'The position remains in the portfolio because no disposal or worthless-security evidence is linked.',
      status: 'needs-evidence',
      safeToConfirm: false,
      source: {
        connection: 'Legacy CSV',
        account: 'Archived trading · import 2024-11',
        notice: 'No source notice linked',
        discoveredAt: '19 Jul 2026 · 04:00',
        confidence: 61,
      },
      dates: {
        announced: '17 Nov 2021',
        exDate: 'Not applicable',
        recordDate: '15 Nov 2021',
        payDate: 'Not applicable',
      },
      impact: {
        holdingBefore: '80.000 shares',
        holdingAfter: '0.000 shares proposed',
        cashBefore: `${symbol}18,420.38`,
        cashAfter: `${symbol}18,420.38`,
        basisBefore: `${symbol}7,846.20`,
        basisAfter: `${symbol}0.00 proposed`,
        difference: `−${symbol}7,846.20 realised loss proposed`,
      },
      taxImpact: {
        classification: 'Worthless-security loss',
        estimate: `${symbol}7,846.20 loss · evidence dependent`,
        jurisdiction: 'Germany → Austria',
        note: 'A broker derecognition statement or tax certificate is required.',
        confidence: 'unresolved',
      },
      assumptions: [
        {
          id: 'disposal-date',
          label: 'Deemed disposal date',
          value: '15 Nov 2021',
          helper: 'Exchange delisting date',
          editable: true,
        },
        {
          id: 'proceeds',
          label: 'Deemed proceeds',
          value: `${symbol}0.00`,
          helper: 'Requires documentary support',
          editable: true,
        },
      ],
      evidence: [
        {
          id: 'wdi_import',
          name: 'Portfolio activity import · November 2024.csv',
          kind: 'Imported source',
          state: 'linked',
          updatedAt: '19 Jul · 04:00',
        },
        {
          id: 'wdi_statement',
          name: 'Broker derecognition statement',
          kind: 'Tax evidence',
          state: 'missing',
          updatedAt: 'Requested 19 Jul',
        },
      ],
      lineage: [
        {
          label: 'Stale holding detected',
          detail: 'Legacy import contains 80 shares with no later disposal.',
          at: '19 Jul 2026 · 04:00',
          state: 'warning',
        },
        {
          label: 'Exchange status verified',
          detail: 'Security is delisted, but portfolio disposal evidence is absent.',
          at: '19 Jul 2026 · 04:01',
          state: 'external',
        },
        {
          label: 'Loss excluded',
          detail: 'Tax and performance calculations retain the position until reviewed.',
          at: '19 Jul 2026 · 04:02',
          state: 'derived',
        },
      ],
      audit: [
        {
          id: 'aud_wdi_1',
          at: '19 Jul 2026 · 04:02',
          actor: 'BetterTrack checks',
          action: 'Requested evidence',
          detail: 'Position and basis remain unchanged.',
        },
      ],
    },
  ];
}

function seedState(portfolioId: string, currency?: string): PersistedEventsState {
  return {
    version: 1,
    portfolioId,
    events: seedEvents(currency),
    receipts: [],
    audit: [
      {
        id: 'event_audit_seed_1',
        at: 'Today · 05:18',
        actor: 'BetterTrack checks',
        action: 'Portfolio events reconciled',
        detail: '7 issuer events checked across 4 source accounts; 2 are safe to confirm.',
        eventId: 'portfolio',
      },
    ],
  };
}

function loadState(portfolio: OriginPortfolioEventsProps['portfolio']): PersistedEventsState {
  if (typeof window === 'undefined') return seedState(portfolio.id, portfolio.currency);
  try {
    const raw = window.localStorage.getItem(storageKey(portfolio.id));
    if (!raw) return seedState(portfolio.id, portfolio.currency);
    const parsed = JSON.parse(raw) as PersistedEventsState;
    if (
      parsed.version !== 1 ||
      parsed.portfolioId !== portfolio.id ||
      !Array.isArray(parsed.events) ||
      !Array.isArray(parsed.receipts) ||
      !Array.isArray(parsed.audit)
    ) {
      return seedState(portfolio.id, portfolio.currency);
    }
    return parsed;
  } catch {
    return seedState(portfolio.id, portfolio.currency);
  }
}

function isInboxStatus(status: OriginPortfolioEventStatus) {
  return status !== 'completed';
}

function eventSearchText(event: OriginPortfolioEvent) {
  return [
    event.title,
    event.issuer,
    event.ticker,
    event.isin,
    event.summary,
    typeMeta[event.type].label,
    statusMeta[event.status].label,
    event.source.connection,
    event.source.account,
    event.source.notice,
  ]
    .join(' ')
    .toLowerCase();
}

function sensitive(privateMode: boolean, value: string) {
  if (!privateMode) return value;
  return /[$€£]|USD|EUR|GBP/.test(value) ? '••••••' : value;
}

function confidenceLabel(confidence: number) {
  if (confidence >= 95) return 'High confidence';
  if (confidence >= 80) return 'Moderate confidence';
  return 'Low confidence';
}

function StatusBadge({ status }: { status: OriginPortfolioEventStatus }) {
  const meta = statusMeta[status];
  return (
    <span className={`ope-status is-${meta.tone}`}>
      <Icon name={meta.icon} size={11} />
      {meta.label}
    </span>
  );
}

export function OriginPortfolioEvents({
  portfolio,
  privateMode,
  onClose,
  onOpenFiles,
  onOpenTax,
  onOpenReview,
  onSubmitReview,
  onConfirmed,
  onToast,
}: OriginPortfolioEventsProps) {
  const [state, setState] = useState<PersistedEventsState>(() => loadState(portfolio));
  const [view, setView] = useState<EventsView>('inbox');
  const [selectedId, setSelectedId] = useState('event_msft_div_2026q2');
  const [selectedSafeIds, setSelectedSafeIds] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('actionable');
  const [typeFilter, setTypeFilter] = useState<EventTypeFilter>('all');
  const [workflow, setWorkflow] = useState<WorkflowDialog>(null);
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [reasonTouched, setReasonTouched] = useState(false);
  const [assumptionDraft, setAssumptionDraft] = useState<Record<string, string>>({});
  const [receipt, setReceipt] = useState<OriginPortfolioEventReceipt | null>(null);
  const loadedScopeRef = useRef(portfolio.id);
  const workspaceDialogRef = useAccessibleDialog<HTMLElement>({
    open: true,
    onClose,
    initialFocusSelector: '[aria-label="Close portfolio events"]',
  });
  const workflowDialogRef = useAccessibleDialog<HTMLFormElement>({
    open: Boolean(workflow),
    onClose: () => setWorkflow(null),
    initialFocusSelector: 'textarea, input',
  });
  const receiptDialogRef = useAccessibleDialog<HTMLElement>({
    open: Boolean(receipt),
    onClose: () => setReceipt(null),
    initialFocusSelector: '[data-receipt-close]',
  });

  useEffect(() => {
    loadedScopeRef.current = portfolio.id;
    const next = loadState(portfolio);
    setState(next);
    setSelectedId(next.events.find((event) => isInboxStatus(event.status))?.id ?? '');
    setSelectedSafeIds([]);
    setWorkflow(null);
    setReceipt(null);
  }, [portfolio.id, portfolio.name, portfolio.currency]);

  useEffect(() => {
    if (state.portfolioId !== loadedScopeRef.current) return;
    try {
      window.localStorage.setItem(storageKey(portfolio.id), JSON.stringify(state));
    } catch {
      // Local persistence is progressive enhancement in the demo.
    }
  }, [portfolio.id, state]);

  const inboxEvents = useMemo(
    () => state.events.filter((event) => isInboxStatus(event.status)),
    [state.events],
  );
  const completedEvents = useMemo(
    () => state.events.filter((event) => event.status === 'completed'),
    [state.events],
  );
  const safeEvents = useMemo(
    () => inboxEvents.filter((event) => event.safeToConfirm && event.status === 'ready'),
    [inboxEvents],
  );

  const visibleEvents = useMemo(() => {
    if (view === 'audit') return [];
    const normalized = query.trim().toLowerCase();
    const source = view === 'completed' ? completedEvents : inboxEvents;
    return source.filter((event) => {
      if (normalized && !eventSearchText(event).includes(normalized)) return false;
      if (typeFilter !== 'all' && event.type !== typeFilter) return false;
      if (statusFilter === 'actionable' && event.status === 'in-review') return false;
      if (
        statusFilter !== 'all' &&
        statusFilter !== 'actionable' &&
        event.status !== statusFilter
      ) {
        return false;
      }
      return true;
    });
  }, [completedEvents, inboxEvents, query, statusFilter, typeFilter, view]);

  useEffect(() => {
    if (view === 'audit') return;
    if (!visibleEvents.some((event) => event.id === selectedId)) {
      setSelectedId(visibleEvents[0]?.id ?? '');
    }
  }, [selectedId, view, visibleEvents]);

  const selectedEvent = state.events.find((event) => event.id === selectedId) ?? null;
  const missingEvidenceCount = state.events.reduce(
    (count, event) =>
      count + event.evidence.filter((evidence) => evidence.state === 'missing').length,
    0,
  );

  function resetWorkflowFields() {
    setReason('');
    setConfirmed(false);
    setReasonTouched(false);
    setAssumptionDraft({});
  }

  function beginConfirm(ids: string[], bulk = false) {
    const eligible = ids.filter((id) =>
      state.events.some(
        (event) => event.id === id && event.safeToConfirm && event.status === 'ready',
      ),
    );
    if (!eligible.length) return;
    resetWorkflowFields();
    setWorkflow({ kind: 'confirm', eventIds: eligible, bulk });
  }

  function beginReview(event: OriginPortfolioEvent) {
    resetWorkflowFields();
    setWorkflow({ kind: 'review', eventIds: [event.id] });
  }

  function beginAssumptions(event: OriginPortfolioEvent) {
    resetWorkflowFields();
    setAssumptionDraft(
      Object.fromEntries(event.assumptions.map((assumption) => [assumption.id, assumption.value])),
    );
    setWorkflow({ kind: 'assumptions', eventIds: [event.id] });
  }

  function makeAudit(
    event: OriginPortfolioEvent,
    action: string,
    detail: string,
    at: string,
    receiptId?: string,
  ): GlobalAuditEntry {
    return {
      id: makeId('event_audit'),
      at,
      actor: 'You',
      action,
      detail,
      eventId: event.id,
      receiptId,
    };
  }

  function submitConfirmation(event: FormEvent) {
    event.preventDefault();
    if (!workflow || workflow.kind !== 'confirm') return;
    setReasonTouched(true);
    if (reason.trim().length < 8 || !confirmed) return;

    const items = state.events.filter((item) => workflow.eventIds.includes(item.id));
    if (!items.length) return;
    const at = nowLabel();
    const nextReceipt: OriginPortfolioEventReceipt = {
      id: makeReference(workflow.bulk ? 'EVT-BULK' : 'EVT'),
      at,
      actor: 'You',
      action: workflow.bulk ? 'bulk-confirmed' : 'confirmed',
      eventIds: items.map((item) => item.id),
      eventTitles: items.map((item) => `${item.ticker} · ${item.title}`),
      reason: reason.trim(),
    };
    const audits = items.map((item) =>
      makeAudit(
        item,
        workflow.bulk ? 'Confirmed in safe-event batch' : 'Confirmed corporate action',
        `${typeMeta[item.type].label} applied to portfolio truth. ${reason.trim()}`,
        at,
        nextReceipt.id,
      ),
    );
    setState((current) => ({
      ...current,
      events: current.events.map((item) =>
        workflow.eventIds.includes(item.id)
          ? {
              ...item,
              status: 'completed',
              receiptId: nextReceipt.id,
              audit: [
                {
                  id: makeId('event_history'),
                  at,
                  actor: 'You',
                  action: 'Confirmed and applied',
                  detail: reason.trim(),
                },
                ...item.audit,
              ],
            }
          : item,
      ),
      receipts: [nextReceipt, ...current.receipts],
      audit: [...audits, ...current.audit],
    }));
    setSelectedSafeIds((current) => current.filter((id) => !workflow.eventIds.includes(id)));
    setWorkflow(null);
    setReceipt(nextReceipt);
    onConfirmed(items, nextReceipt);
    onToast(
      workflow.bulk
        ? `${items.length} safe portfolio events confirmed.`
        : `${items[0]?.ticker ?? 'Portfolio'} event confirmed.`,
    );
  }

  function submitAssumptions(event: FormEvent) {
    event.preventDefault();
    if (!workflow || workflow.kind !== 'assumptions') return;
    setReasonTouched(true);
    if (reason.trim().length < 8) return;
    const item = state.events.find((candidate) => candidate.id === workflow.eventIds[0]);
    if (!item) return;
    const changes = item.assumptions.filter(
      (assumption) =>
        assumption.editable &&
        (assumptionDraft[assumption.id] ?? assumption.value).trim() !== assumption.value,
    );
    if (!changes.length) return;

    const at = nowLabel();
    const nextReceipt: OriginPortfolioEventReceipt = {
      id: makeReference('EVT-ASM'),
      at,
      actor: 'You',
      action: 'assumptions-updated',
      eventIds: [item.id],
      eventTitles: [`${item.ticker} · ${item.title}`],
      reason: reason.trim(),
    };
    const detail = `${changes.length} assumption${changes.length === 1 ? '' : 's'} updated. ${reason.trim()}`;
    setState((current) => ({
      ...current,
      events: current.events.map((candidate) =>
        candidate.id === item.id
          ? {
              ...candidate,
              assumptions: candidate.assumptions.map((assumption) => ({
                ...assumption,
                value:
                  assumption.editable && assumptionDraft[assumption.id] !== undefined
                    ? assumptionDraft[assumption.id]!.trim()
                    : assumption.value,
              })),
              audit: [
                {
                  id: makeId('event_history'),
                  at,
                  actor: 'You',
                  action: 'Assumptions updated',
                  detail,
                },
                ...candidate.audit,
              ],
            }
          : candidate,
      ),
      receipts: [nextReceipt, ...current.receipts],
      audit: [
        makeAudit(item, 'Event assumptions updated', detail, at, nextReceipt.id),
        ...current.audit,
      ],
    }));
    setWorkflow(null);
    setReceipt(nextReceipt);
    onToast('Event assumptions updated and logged.');
  }

  function submitReviewRequest(event: FormEvent) {
    event.preventDefault();
    if (!workflow || workflow.kind !== 'review') return;
    setReasonTouched(true);
    if (reason.trim().length < 8 || !confirmed) return;
    const item = state.events.find((candidate) => candidate.id === workflow.eventIds[0]);
    if (!item) return;

    const at = nowLabel();
    const reviewId = makeId('portfolio_event_review');
    const nextReceipt: OriginPortfolioEventReceipt = {
      id: makeReference('EVT-REV'),
      at,
      actor: 'You',
      action: 'review-submitted',
      eventIds: [item.id],
      eventTitles: [`${item.ticker} · ${item.title}`],
      reason: reason.trim(),
      destination: 'Review',
    };
    const review: OriginReviewEntry = {
      id: reviewId,
      kind: 'tax',
      title: `${item.ticker} · ${item.title}`,
      summary: `${item.summary} Reviewer context: ${reason.trim()}`,
      portfolio: {
        id: portfolio.id,
        name: portfolio.name,
        path: `${portfolio.name} / Events`,
      },
      source: {
        label: 'Portfolio events',
        detail: `${item.source.connection} · ${item.source.notice}`,
        actor: 'You',
        connectionId: item.source.account,
      },
      requestedAt: new Date().toISOString(),
      requestedBy: 'You',
      status: 'pending',
      priority: item.type === 'rights-issue' || item.type === 'delisting' ? 'high' : 'normal',
      risk:
        item.taxImpact.confidence === 'unresolved'
          ? 'high'
          : item.taxImpact.confidence === 'estimated'
            ? 'medium'
            : 'low',
      affectedCount: 1,
      tags: ['portfolio-event', item.type, item.ticker.toLowerCase()],
      approveLabel: 'Apply event',
      rejectLabel: 'Return to inbox',
      diff: [
        {
          label: 'Holding',
          before: item.impact.holdingBefore,
          after: item.impact.holdingAfter,
          tone: 'neutral',
          detail: typeMeta[item.type].label,
        },
        {
          label: 'Cash',
          before: item.impact.cashBefore,
          after: item.impact.cashAfter,
          tone: 'neutral',
          detail: item.impact.difference,
        },
        {
          label: 'Cost basis',
          before: item.impact.basisBefore,
          after: item.impact.basisAfter,
          tone:
            item.taxImpact.confidence === 'unresolved' || item.taxImpact.confidence === 'estimated'
              ? 'warning'
              : 'neutral',
          detail: item.taxImpact.classification,
        },
        ...item.assumptions
          .filter((assumption) => assumption.editable)
          .map((assumption) => ({
            label: assumption.label,
            before: 'Source / default',
            after: assumption.value,
            tone: 'warning' as const,
            detail: assumption.helper,
          })),
      ],
      calculations: [
        {
          label: 'Portfolio impact',
          value: item.impact.difference,
          detail: `${item.impact.holdingBefore} → ${item.impact.holdingAfter}`,
          tone: 'neutral',
        },
        {
          label: 'Tax estimate',
          value: item.taxImpact.estimate,
          detail: `${item.taxImpact.jurisdiction} · ${item.taxImpact.classification}`,
          tone:
            item.taxImpact.confidence === 'unresolved'
              ? 'warning'
              : item.taxImpact.confidence === 'verified'
                ? 'positive'
                : 'neutral',
        },
        {
          label: 'Source confidence',
          value: `${item.source.confidence}%`,
          detail: `${item.source.connection} and ${item.evidence.length} evidence objects`,
          tone: item.source.confidence >= 90 ? 'positive' : 'warning',
        },
      ],
      lineage: item.lineage,
      permissions: [
        {
          label: 'Read issuer notice',
          detail: item.source.notice,
          outcome: 'allowed',
        },
        {
          label: 'Change holdings and basis',
          detail: 'No portfolio truth changes until this request is approved.',
          outcome: 'review',
        },
        {
          label: 'Execute with custodian',
          detail: 'BetterTrack does not send instructions to the connected provider.',
          outcome: 'blocked',
        },
      ],
      policies: [
        {
          title: 'Evidence-heavy corporate action',
          description: 'Complex events require a human review before holdings or tax lots change.',
          status: 'warning',
        },
        {
          title: 'Source lineage preserved',
          description:
            'Connection activity, linked notice, assumptions, and reason travel together.',
          status: 'pass',
        },
        {
          title: 'No external execution',
          description: 'Approval changes only this portfolio record.',
          status: 'pass',
        },
      ],
    };
    onSubmitReview(review);
    setState((current) => ({
      ...current,
      events: current.events.map((candidate) =>
        candidate.id === item.id
          ? {
              ...candidate,
              status: 'in-review',
              receiptId: nextReceipt.id,
              audit: [
                {
                  id: makeId('event_history'),
                  at,
                  actor: 'You',
                  action: 'Sent to Review',
                  detail: reason.trim(),
                },
                ...candidate.audit,
              ],
            }
          : candidate,
      ),
      receipts: [nextReceipt, ...current.receipts],
      audit: [
        makeAudit(
          item,
          'Corporate action sent to Review',
          `${reason.trim()} Portfolio truth remains unchanged.`,
          at,
          nextReceipt.id,
        ),
        ...current.audit,
      ],
    }));
    setWorkflow(null);
    setReceipt(nextReceipt);
    onToast(`${item.ticker} event sent to Review.`);
  }

  function selectView(nextView: EventsView) {
    setView(nextView);
    setQuery('');
    setTypeFilter('all');
    setStatusFilter(nextView === 'inbox' ? 'actionable' : 'all');
  }

  function toggleSafeSelection(eventId: string, checked: boolean) {
    setSelectedSafeIds((current) =>
      checked ? Array.from(new Set([...current, eventId])) : current.filter((id) => id !== eventId),
    );
  }

  const dialogItems =
    workflow?.eventIds
      .map((id) => state.events.find((event) => event.id === id))
      .filter((event): event is OriginPortfolioEvent => Boolean(event)) ?? [];
  const assumptionsChanged =
    workflow?.kind === 'assumptions' &&
    dialogItems[0]?.assumptions.some(
      (assumption) =>
        assumption.editable &&
        (assumptionDraft[assumption.id] ?? assumption.value).trim() !== assumption.value,
    );
  const reasonInvalid = reasonTouched && reason.trim().length < 8;

  return (
    <section
      aria-labelledby="ope-page-title"
      aria-modal="true"
      className="origin-portfolio-events"
      data-accessible-dialog-layer
      ref={workspaceDialogRef}
      role="dialog"
      tabIndex={-1}
    >
      <header className="ope-global-header">
        <div className="ope-brand" aria-label="BetterTrack">
          <span className="ope-brand__mark" aria-hidden="true" />
          <span>
            <strong>
              Better<span>Track</span>
            </strong>
            <small>Portfolio workspace</small>
          </span>
        </div>
        <div className="ope-breadcrumb" aria-label="Current location">
          <span>Portfolios</span>
          <Icon name="chevron-right" size={12} />
          <strong>{portfolio.name}</strong>
          <Icon name="chevron-right" size={12} />
          <span>Events</span>
        </div>
        <div className="ope-global-actions">
          <span className="ope-saved">
            <i />
            Saved locally
          </span>
          <button onClick={onClose} type="button" aria-label="Close portfolio events">
            <Icon name="x" size={15} />
          </button>
        </div>
      </header>

      <main className="ope-page">
        <div className="ope-page-heading">
          <div>
            <span className="ope-kicker">Portfolio truth · issuer events</span>
            <h1 id="ope-page-title">Events inbox</h1>
            <p>
              Reconcile dividends, splits, elections, and restructurings inside{' '}
              <strong>{portfolio.name}</strong>. Every decision keeps its source, assumptions,
              evidence, and receipt.
            </p>
          </div>
          <div className="ope-page-heading__actions">
            <span>
              Last reconciled <strong>Today · 05:18</strong>
            </span>
            <button
              className="ope-button ope-button--secondary"
              onClick={onOpenFiles}
              type="button"
            >
              <Icon name="folder" size={13} />
              Open evidence
            </button>
          </div>
        </div>

        <div className="ope-metrics" aria-label="Portfolio event summary">
          <article>
            <span className="ope-metric-icon">
              <Icon name="inbox" size={15} />
            </span>
            <div>
              <span>Open events</span>
              <strong>{inboxEvents.length}</strong>
              <small>
                {inboxEvents.filter((event) => event.status === 'in-review').length} in Review
              </small>
            </div>
          </article>
          <article>
            <span className="ope-metric-icon is-positive">
              <Icon name="check" size={15} />
            </span>
            <div>
              <span>Safe to confirm</span>
              <strong>{safeEvents.length}</strong>
              <small>Issuer and source agree</small>
            </div>
          </article>
          <article>
            <span className="ope-metric-icon is-warning">
              <Icon name="document" size={15} />
            </span>
            <div>
              <span>Missing evidence</span>
              <strong>{missingEvidenceCount}</strong>
              <small>
                Across {inboxEvents.filter((event) => event.status === 'needs-evidence').length}{' '}
                events
              </small>
            </div>
          </article>
          <article>
            <span className="ope-metric-icon">
              <Icon name="activity" size={15} />
            </span>
            <div>
              <span>Estimated net impact</span>
              <strong>{privateMode ? '••••••' : '+€555.48'}</strong>
              <small>Cash from open events</small>
            </div>
          </article>
        </div>

        <nav className="ope-tabs" aria-label="Portfolio event sections" role="tablist">
          <button
            aria-controls="ope-panel-inbox"
            aria-selected={view === 'inbox'}
            className={view === 'inbox' ? 'is-active' : ''}
            id="ope-tab-inbox"
            onClick={() => selectView('inbox')}
            role="tab"
            type="button"
          >
            Inbox
            <span>{inboxEvents.length}</span>
          </button>
          <button
            aria-controls="ope-panel-completed"
            aria-selected={view === 'completed'}
            className={view === 'completed' ? 'is-active' : ''}
            id="ope-tab-completed"
            onClick={() => selectView('completed')}
            role="tab"
            type="button"
          >
            Completed
            <span>{completedEvents.length}</span>
          </button>
          <button
            aria-controls="ope-panel-audit"
            aria-selected={view === 'audit'}
            className={view === 'audit' ? 'is-active' : ''}
            id="ope-tab-audit"
            onClick={() => selectView('audit')}
            role="tab"
            type="button"
          >
            Audit & receipts
            <span>{state.receipts.length}</span>
          </button>
        </nav>

        {view !== 'audit' ? (
          <section
            aria-labelledby={`ope-tab-${view}`}
            className="ope-events-panel"
            id={`ope-panel-${view}`}
            role="tabpanel"
          >
            <div className="ope-toolbar">
              <label className="ope-search">
                <span className="ope-sr-only">Search portfolio events</span>
                <Icon name="search" size={14} />
                <input
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search issuer, ticker, ISIN, source…"
                  type="search"
                  value={query}
                />
              </label>
              <label>
                <span>Event type</span>
                <select
                  onChange={(event) => setTypeFilter(event.target.value as EventTypeFilter)}
                  value={typeFilter}
                >
                  <option value="all">All event types</option>
                  {Object.entries(typeMeta).map(([id, meta]) => (
                    <option key={id} value={id}>
                      {meta.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Status</span>
                <select
                  onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
                  value={statusFilter}
                >
                  {view === 'inbox' ? <option value="actionable">Needs action</option> : null}
                  <option value="all">All statuses</option>
                  <option value="ready">Ready to confirm</option>
                  <option value="needs-evidence">Evidence needed</option>
                  <option value="needs-decision">Decision needed</option>
                  <option value="in-review">In Review</option>
                  <option value="completed">Completed</option>
                </select>
              </label>
              {view === 'inbox' ? (
                <button
                  className="ope-button ope-button--primary ope-bulk-button"
                  disabled={!selectedSafeIds.length}
                  onClick={() => beginConfirm(selectedSafeIds, true)}
                  type="button"
                >
                  <Icon name="check" size={13} />
                  Confirm selected
                  {selectedSafeIds.length ? <span>{selectedSafeIds.length}</span> : null}
                </button>
              ) : null}
            </div>

            <div className="ope-event-workspace">
              <aside className="ope-event-list" aria-label={`${view} portfolio events`}>
                <div className="ope-event-list__heading">
                  <span>
                    <strong>{visibleEvents.length}</strong> events
                  </span>
                  <small>{view === 'inbox' ? 'Ordered by action needed' : 'Newest first'}</small>
                </div>
                {visibleEvents.length ? (
                  visibleEvents.map((event) => {
                    const meta = typeMeta[event.type];
                    const canBulk = event.safeToConfirm && event.status === 'ready';
                    return (
                      <article
                        className={event.id === selectedId ? 'is-selected' : ''}
                        key={event.id}
                      >
                        {view === 'inbox' ? (
                          <label
                            className={`ope-select-safe ${canBulk ? '' : 'is-disabled'}`}
                            title={
                              canBulk
                                ? 'Include in safe confirmation'
                                : 'This event requires review'
                            }
                          >
                            <input
                              aria-label={`Select ${event.ticker} ${event.title} for safe confirmation`}
                              checked={selectedSafeIds.includes(event.id)}
                              disabled={!canBulk}
                              onChange={(input) =>
                                toggleSafeSelection(event.id, input.target.checked)
                              }
                              type="checkbox"
                            />
                            <span aria-hidden="true">
                              <Icon name="check" size={10} />
                            </span>
                          </label>
                        ) : null}
                        <button
                          aria-pressed={event.id === selectedId}
                          className="ope-event-list__select"
                          onClick={() => setSelectedId(event.id)}
                          type="button"
                        >
                          <span className={`ope-event-icon is-${event.type}`}>
                            <Icon name={meta.icon} size={14} />
                          </span>
                          <span className="ope-event-list__copy">
                            <span className="ope-event-list__meta">
                              <em>{meta.label}</em>
                              <StatusBadge status={event.status} />
                            </span>
                            <strong>{event.title}</strong>
                            <span>
                              {event.ticker} · {event.issuer}
                            </span>
                            <small>
                              {event.dates.payDate} · {event.source.connection}
                            </small>
                          </span>
                          <Icon name="chevron-right" size={13} />
                        </button>
                      </article>
                    );
                  })
                ) : (
                  <div className="ope-empty">
                    <Icon name={view === 'completed' ? 'check' : 'search'} size={19} />
                    <strong>
                      {view === 'completed' ? 'No completed events yet' : 'No events match'}
                    </strong>
                    <span>
                      {view === 'completed'
                        ? 'Confirmed events and their receipts will appear here.'
                        : 'Clear a filter or search a different issuer.'}
                    </span>
                    {query || typeFilter !== 'all' || statusFilter !== 'all' ? (
                      <button
                        onClick={() => {
                          setQuery('');
                          setTypeFilter('all');
                          setStatusFilter('all');
                        }}
                        type="button"
                      >
                        Clear filters
                      </button>
                    ) : null}
                  </div>
                )}
              </aside>

              {selectedEvent && visibleEvents.some((event) => event.id === selectedEvent.id) ? (
                <article className="ope-event-detail">
                  <div className="ope-detail-heading">
                    <div>
                      <span className="ope-object-label">{typeMeta[selectedEvent.type].label}</span>
                      <h2>{selectedEvent.title}</h2>
                      <p>{selectedEvent.summary}</p>
                    </div>
                    <div className="ope-detail-heading__badges">
                      <span className="ope-ticker">{selectedEvent.ticker}</span>
                      <StatusBadge status={selectedEvent.status} />
                    </div>
                  </div>

                  <div className="ope-source-strip">
                    <span className="ope-source-strip__icon">
                      <Icon name="link" size={16} />
                    </span>
                    <span>
                      <small>Discovered from connection</small>
                      <strong>{selectedEvent.source.connection}</strong>
                      <em>{selectedEvent.source.account}</em>
                    </span>
                    <span>
                      <small>Linked notice in Files</small>
                      <strong>{selectedEvent.source.notice}</strong>
                      <em>{selectedEvent.source.discoveredAt}</em>
                    </span>
                    <span className="ope-confidence">
                      <small>{confidenceLabel(selectedEvent.source.confidence)}</small>
                      <strong>{selectedEvent.source.confidence}%</strong>
                      <progress
                        aria-label={`Source confidence ${selectedEvent.source.confidence} percent`}
                        max={100}
                        value={selectedEvent.source.confidence}
                      />
                    </span>
                    <button onClick={onOpenFiles} type="button">
                      Inspect evidence
                      <Icon name="arrow-right" size={12} />
                    </button>
                  </div>

                  <section className="ope-dates" aria-label="Corporate action dates">
                    {(
                      [
                        ['Announced', selectedEvent.dates.announced],
                        ['Ex-date', selectedEvent.dates.exDate],
                        ['Record date', selectedEvent.dates.recordDate],
                        ['Pay / effective', selectedEvent.dates.payDate],
                      ] as const
                    ).map(([label, value]) => (
                      <span key={label}>
                        <small>{label}</small>
                        <strong>{value}</strong>
                      </span>
                    ))}
                  </section>

                  <section className="ope-section">
                    <div className="ope-section-heading">
                      <span>
                        <strong>Proposed portfolio change</strong>
                        <small>No value changes until this event is confirmed or approved.</small>
                      </span>
                      <span className="ope-impact-summary">
                        <Icon name="activity" size={12} />
                        {sensitive(privateMode, selectedEvent.impact.difference)}
                      </span>
                    </div>
                    <div className="ope-diff-grid">
                      {(
                        [
                          [
                            'Holding',
                            selectedEvent.impact.holdingBefore,
                            selectedEvent.impact.holdingAfter,
                            false,
                          ],
                          [
                            'Cash',
                            selectedEvent.impact.cashBefore,
                            selectedEvent.impact.cashAfter,
                            true,
                          ],
                          [
                            'Cost basis',
                            selectedEvent.impact.basisBefore,
                            selectedEvent.impact.basisAfter,
                            true,
                          ],
                        ] as const
                      ).map(([label, before, after, isSensitive]) => (
                        <article key={label}>
                          <span>{label}</span>
                          <div>
                            <small>Before</small>
                            <strong>{isSensitive ? sensitive(privateMode, before) : before}</strong>
                          </div>
                          <Icon name="arrow-right" size={13} />
                          <div>
                            <small>After</small>
                            <strong>{isSensitive ? sensitive(privateMode, after) : after}</strong>
                          </div>
                        </article>
                      ))}
                    </div>
                  </section>

                  <div className="ope-detail-grid">
                    <section className="ope-section ope-tax-card">
                      <div className="ope-section-heading">
                        <span>
                          <strong>Tax treatment</strong>
                          <small>{selectedEvent.taxImpact.jurisdiction}</small>
                        </span>
                        <span
                          className={`ope-tax-confidence is-${selectedEvent.taxImpact.confidence}`}
                        >
                          {selectedEvent.taxImpact.confidence}
                        </span>
                      </div>
                      <div className="ope-tax-card__body">
                        <span className="ope-tax-card__icon">
                          <Icon name="document" size={15} />
                        </span>
                        <span>
                          <small>{selectedEvent.taxImpact.classification}</small>
                          <strong>
                            {sensitive(privateMode, selectedEvent.taxImpact.estimate)}
                          </strong>
                          <p>{selectedEvent.taxImpact.note}</p>
                        </span>
                      </div>
                      <button className="ope-text-button" onClick={onOpenTax} type="button">
                        Inspect tax & lots
                        <Icon name="arrow-right" size={11} />
                      </button>
                    </section>

                    <section className="ope-section ope-assumptions">
                      <div className="ope-section-heading">
                        <span>
                          <strong>Assumptions</strong>
                          <small>Inputs that shape the proposed event.</small>
                        </span>
                        {selectedEvent.assumptions.some((assumption) => assumption.editable) &&
                        selectedEvent.status !== 'completed' ? (
                          <button
                            className="ope-text-button"
                            onClick={() => beginAssumptions(selectedEvent)}
                            type="button"
                          >
                            Edit assumptions
                            <Icon name="sliders" size={11} />
                          </button>
                        ) : null}
                      </div>
                      <dl>
                        {selectedEvent.assumptions.map((assumption) => (
                          <div key={assumption.id}>
                            <dt>
                              {assumption.label}
                              {assumption.editable ? <em>Editable</em> : null}
                            </dt>
                            <dd>{sensitive(privateMode, assumption.value)}</dd>
                            <small>{assumption.helper}</small>
                          </div>
                        ))}
                      </dl>
                    </section>
                  </div>

                  <div className="ope-detail-grid">
                    <section className="ope-section ope-evidence">
                      <div className="ope-section-heading">
                        <span>
                          <strong>Linked evidence</strong>
                          <small>Source documents and derived calculations.</small>
                        </span>
                        <button className="ope-text-button" onClick={onOpenFiles} type="button">
                          Open Files
                          <Icon name="arrow-right" size={11} />
                        </button>
                      </div>
                      <div className="ope-evidence-list">
                        {selectedEvent.evidence.map((evidence) => (
                          <button key={evidence.id} onClick={onOpenFiles} type="button">
                            <span className={`is-${evidence.state}`}>
                              <Icon
                                name={
                                  evidence.state === 'linked'
                                    ? 'check'
                                    : evidence.state === 'missing'
                                      ? 'plus'
                                      : 'code'
                                }
                                size={12}
                              />
                            </span>
                            <span>
                              <strong>{evidence.name}</strong>
                              <small>
                                {evidence.kind} · {evidence.updatedAt}
                              </small>
                            </span>
                            <em>{evidence.state}</em>
                            <Icon name="chevron-right" size={12} />
                          </button>
                        ))}
                      </div>
                    </section>

                    <section className="ope-section ope-lineage">
                      <div className="ope-section-heading">
                        <span>
                          <strong>Discovery lineage</strong>
                          <small>How the event became this proposal.</small>
                        </span>
                      </div>
                      <ol>
                        {selectedEvent.lineage.map((step) => (
                          <li className={`is-${step.state}`} key={`${step.label}-${step.at}`}>
                            <i>
                              <Icon
                                name={
                                  step.state === 'verified'
                                    ? 'check'
                                    : step.state === 'warning'
                                      ? 'activity'
                                      : step.state === 'external'
                                        ? 'link'
                                        : 'code'
                                }
                                size={10}
                              />
                            </i>
                            <span>
                              <strong>{step.label}</strong>
                              <small>{step.detail}</small>
                              <em>{step.at}</em>
                            </span>
                          </li>
                        ))}
                      </ol>
                    </section>
                  </div>

                  <section className="ope-section ope-event-audit">
                    <div className="ope-section-heading">
                      <span>
                        <strong>Event history</strong>
                        <small>Persistent actions on this corporate action.</small>
                      </span>
                      {selectedEvent.receiptId ? (
                        <button
                          className="ope-receipt-chip"
                          onClick={() =>
                            setReceipt(
                              state.receipts.find(
                                (candidate) => candidate.id === selectedEvent.receiptId,
                              ) ?? null,
                            )
                          }
                          type="button"
                        >
                          <Icon name="document" size={11} />
                          {selectedEvent.receiptId}
                        </button>
                      ) : null}
                    </div>
                    <div className="ope-event-audit__list">
                      {selectedEvent.audit.map((entry) => (
                        <span key={entry.id}>
                          <i />
                          <span>
                            <strong>{entry.action}</strong>
                            <small>{entry.detail}</small>
                          </span>
                          <em>
                            {entry.actor} · {entry.at}
                          </em>
                        </span>
                      ))}
                    </div>
                  </section>

                  <footer className="ope-detail-actions">
                    <span>
                      <Icon name={selectedEvent.safeToConfirm ? 'shield' : 'lock'} size={14} />
                      <span>
                        <strong>
                          {selectedEvent.safeToConfirm ? 'Safe event' : 'Evidence-heavy event'}
                        </strong>
                        <small>
                          {selectedEvent.safeToConfirm
                            ? 'Source, quantity, dates, and tax treatment agree.'
                            : 'Holdings and basis stay unchanged until a reviewer approves.'}
                        </small>
                      </span>
                    </span>
                    <div>
                      {selectedEvent.status === 'in-review' ? (
                        <button
                          className="ope-button ope-button--primary"
                          onClick={onOpenReview}
                          type="button"
                        >
                          <Icon name="inbox" size={13} />
                          Open Review
                        </button>
                      ) : selectedEvent.status === 'completed' ? (
                        <button
                          className="ope-button ope-button--secondary"
                          onClick={() =>
                            setReceipt(
                              state.receipts.find(
                                (candidate) => candidate.id === selectedEvent.receiptId,
                              ) ?? null,
                            )
                          }
                          type="button"
                        >
                          <Icon name="document" size={13} />
                          View receipt
                        </button>
                      ) : selectedEvent.safeToConfirm ? (
                        <button
                          className="ope-button ope-button--primary"
                          onClick={() => beginConfirm([selectedEvent.id])}
                          type="button"
                        >
                          <Icon name="check" size={13} />
                          Confirm event
                        </button>
                      ) : (
                        <>
                          <button
                            className="ope-button ope-button--secondary"
                            onClick={() => beginAssumptions(selectedEvent)}
                            type="button"
                          >
                            Edit assumptions
                          </button>
                          <button
                            className="ope-button ope-button--primary"
                            onClick={() => beginReview(selectedEvent)}
                            type="button"
                          >
                            <Icon name="inbox" size={13} />
                            Send to Review
                          </button>
                        </>
                      )}
                    </div>
                  </footer>
                </article>
              ) : (
                <div className="ope-no-selection">
                  <Icon name={view === 'completed' ? 'check' : 'inbox'} size={22} />
                  <strong>Select a portfolio event</strong>
                  <span>Its source, proposed impact, evidence, and history will appear here.</span>
                </div>
              )}
            </div>
          </section>
        ) : (
          <section
            aria-labelledby="ope-tab-audit"
            className="ope-audit-panel"
            id="ope-panel-audit"
            role="tabpanel"
          >
            <div className="ope-view-heading">
              <div>
                <span className="ope-kicker">Persistent portfolio history</span>
                <h2>Event decisions and receipts</h2>
                <p>
                  Each decision records the actor, reason, affected events, and the portfolio
                  boundary it changed.
                </p>
              </div>
              <span className="ope-audit-count">{state.audit.length} audit entries</span>
            </div>

            <div className="ope-audit-layout">
              <section className="ope-audit-table" aria-label="Portfolio event audit history">
                <div className="ope-audit-table__head">
                  <span>Action</span>
                  <span>Portfolio object</span>
                  <span>Actor & time</span>
                  <span>Receipt</span>
                </div>
                {state.audit.map((entry) => {
                  const linkedEvent = state.events.find((event) => event.id === entry.eventId);
                  return (
                    <article key={entry.id}>
                      <span>
                        <strong>{entry.action}</strong>
                        <small>{entry.detail}</small>
                      </span>
                      <span>
                        <em className="ope-mobile-label">Portfolio object</em>
                        <strong>
                          {linkedEvent
                            ? `${linkedEvent.ticker} · ${linkedEvent.title}`
                            : portfolio.name}
                        </strong>
                        <small>
                          {linkedEvent ? typeMeta[linkedEvent.type].label : 'Events inbox'}
                        </small>
                      </span>
                      <span>
                        <em className="ope-mobile-label">Actor & time</em>
                        <strong>{entry.actor}</strong>
                        <small>{entry.at}</small>
                      </span>
                      <span>
                        <em className="ope-mobile-label">Receipt</em>
                        {entry.receiptId ? (
                          <button
                            onClick={() =>
                              setReceipt(
                                state.receipts.find(
                                  (candidate) => candidate.id === entry.receiptId,
                                ) ?? null,
                              )
                            }
                            type="button"
                          >
                            {entry.receiptId}
                          </button>
                        ) : (
                          <small>System check</small>
                        )}
                      </span>
                    </article>
                  );
                })}
              </section>

              <aside className="ope-receipt-stack">
                <div className="ope-section-heading">
                  <span>
                    <strong>Recent receipts</strong>
                    <small>Proof of confirmed and staged changes.</small>
                  </span>
                </div>
                {state.receipts.length ? (
                  state.receipts.map((item) => (
                    <button key={item.id} onClick={() => setReceipt(item)} type="button">
                      <span>
                        <Icon
                          name={item.action === 'review-submitted' ? 'inbox' : 'check'}
                          size={13}
                        />
                      </span>
                      <span>
                        <strong>{item.id}</strong>
                        <small>
                          {item.eventTitles.length} event
                          {item.eventTitles.length === 1 ? '' : 's'} · {item.at}
                        </small>
                      </span>
                      <Icon name="chevron-right" size={12} />
                    </button>
                  ))
                ) : (
                  <div className="ope-receipt-empty">
                    <Icon name="document" size={17} />
                    <strong>No receipts yet</strong>
                    <span>Confirm or submit an event to create one.</span>
                  </div>
                )}
              </aside>
            </div>
          </section>
        )}
      </main>

      {workflow ? (
        <div className="ope-modal-layer" role="presentation">
          <form
            aria-describedby="ope-workflow-description"
            aria-labelledby="ope-workflow-title"
            aria-modal="true"
            className="ope-modal"
            data-accessible-dialog-layer
            onSubmit={
              workflow.kind === 'confirm'
                ? submitConfirmation
                : workflow.kind === 'review'
                  ? submitReviewRequest
                  : submitAssumptions
            }
            ref={workflowDialogRef}
            role="dialog"
            tabIndex={-1}
          >
            <div className="ope-modal__header">
              <span className="ope-modal__icon">
                <Icon
                  name={
                    workflow.kind === 'confirm'
                      ? 'check'
                      : workflow.kind === 'review'
                        ? 'inbox'
                        : 'sliders'
                  }
                  size={17}
                />
              </span>
              <div>
                <span>
                  {workflow.kind === 'confirm'
                    ? workflow.bulk
                      ? 'Safe batch'
                      : 'Safe event'
                    : workflow.kind === 'review'
                      ? 'Human checkpoint'
                      : 'Recorded assumptions'}
                </span>
                <h2 id="ope-workflow-title">
                  {workflow.kind === 'confirm'
                    ? workflow.bulk
                      ? `Confirm ${dialogItems.length} portfolio events`
                      : 'Confirm corporate action'
                    : workflow.kind === 'review'
                      ? 'Send event to Review'
                      : 'Edit event assumptions'}
                </h2>
                <p id="ope-workflow-description">
                  {workflow.kind === 'confirm'
                    ? 'This applies the proposed holdings, cash, basis, and tax treatment to this portfolio.'
                    : workflow.kind === 'review'
                      ? 'This creates a review proposal. Portfolio truth remains unchanged until approval.'
                      : 'Edits remain inside the event proposal and are preserved in its audit history.'}
                </p>
              </div>
              <button
                aria-label="Close event workflow"
                onClick={() => setWorkflow(null)}
                type="button"
              >
                <Icon name="x" size={14} />
              </button>
            </div>

            <div className="ope-modal__events">
              {dialogItems.map((item) => (
                <span key={item.id}>
                  <i>
                    <Icon name={typeMeta[item.type].icon} size={13} />
                  </i>
                  <span>
                    <strong>
                      {item.ticker} · {item.title}
                    </strong>
                    <small>{sensitive(privateMode, item.impact.difference)}</small>
                  </span>
                  <StatusBadge status={item.status} />
                </span>
              ))}
            </div>

            {workflow.kind === 'assumptions' && dialogItems[0] ? (
              <div className="ope-modal__assumptions">
                {dialogItems[0].assumptions.map((assumption) => (
                  <label key={assumption.id}>
                    <span>
                      {assumption.label}
                      <small>{assumption.helper}</small>
                    </span>
                    <input
                      disabled={!assumption.editable}
                      onChange={(input) =>
                        setAssumptionDraft((current) => ({
                          ...current,
                          [assumption.id]: input.target.value,
                        }))
                      }
                      value={assumptionDraft[assumption.id] ?? assumption.value}
                    />
                  </label>
                ))}
              </div>
            ) : null}

            <label className="ope-reason">
              <span>
                Reason <em>Required · at least 8 characters</em>
              </span>
              <textarea
                aria-describedby={reasonInvalid ? 'ope-reason-error' : undefined}
                aria-invalid={reasonInvalid}
                onBlur={() => setReasonTouched(true)}
                onChange={(input) => setReason(input.target.value)}
                placeholder={
                  workflow.kind === 'confirm'
                    ? 'Why is it safe to apply this event?'
                    : workflow.kind === 'review'
                      ? 'What should the reviewer verify?'
                      : 'Why are these assumptions being changed?'
                }
                rows={3}
                value={reason}
              />
              {reasonInvalid ? (
                <small className="ope-field-error" id="ope-reason-error" role="alert">
                  Add a specific reason of at least 8 characters.
                </small>
              ) : null}
            </label>

            {workflow.kind !== 'assumptions' ? (
              <label className="ope-confirm-check">
                <input
                  checked={confirmed}
                  onChange={(input) => setConfirmed(input.target.checked)}
                  type="checkbox"
                />
                <span>
                  <strong>
                    {workflow.kind === 'confirm'
                      ? 'I confirm the proposed portfolio change'
                      : 'I confirm this event should enter Review'}
                  </strong>
                  <small>
                    {workflow.kind === 'confirm'
                      ? 'A receipt will record the source, values, actor, and reason.'
                      : 'No external trade or provider instruction will be sent.'}
                  </small>
                </span>
              </label>
            ) : null}

            <div className="ope-modal__boundary">
              <Icon name="shield" size={13} />
              <span>
                <strong>Portfolio boundary</strong>
                {workflow.kind === 'confirm'
                  ? `Only ${portfolio.name} changes. Connected providers remain read-only.`
                  : workflow.kind === 'review'
                    ? 'Review receives the full source, difference, tax calculation, evidence lineage, and your reason.'
                    : 'Holdings, cash, and basis remain unchanged.'}
              </span>
            </div>

            <div className="ope-modal__actions">
              <button
                className="ope-button ope-button--quiet"
                onClick={() => setWorkflow(null)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="ope-button ope-button--primary"
                disabled={
                  reason.trim().length < 8 ||
                  (workflow.kind !== 'assumptions' && !confirmed) ||
                  (workflow.kind === 'assumptions' && !assumptionsChanged)
                }
                type="submit"
              >
                {workflow.kind === 'confirm'
                  ? workflow.bulk
                    ? `Confirm ${dialogItems.length} events`
                    : 'Confirm & apply'
                  : workflow.kind === 'review'
                    ? 'Submit to Review'
                    : 'Save assumptions'}
                <Icon name="arrow-right" size={12} />
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {receipt ? (
        <div className="ope-modal-layer is-receipt" role="presentation">
          <section
            aria-labelledby="ope-receipt-title"
            aria-modal="true"
            className="ope-receipt"
            data-accessible-dialog-layer
            ref={receiptDialogRef}
            role="dialog"
            tabIndex={-1}
          >
            <header>
              <span className="ope-receipt__mark">
                <Icon name={receipt.action === 'review-submitted' ? 'inbox' : 'check'} size={20} />
              </span>
              <div>
                <span>Portfolio event receipt</span>
                <h2 id="ope-receipt-title">
                  {receipt.action === 'review-submitted'
                    ? 'Proposal delivered to Review'
                    : receipt.action === 'assumptions-updated'
                      ? 'Assumptions recorded'
                      : receipt.eventIds.length > 1
                        ? 'Safe event batch confirmed'
                        : 'Portfolio event confirmed'}
                </h2>
                <p>
                  {receipt.action === 'review-submitted'
                    ? 'Portfolio truth has not changed. The proposal is waiting for a decision.'
                    : receipt.action === 'assumptions-updated'
                      ? 'The event proposal now uses these inputs; portfolio truth has not changed.'
                      : 'The proposed event change is now part of the portfolio record.'}
                </p>
              </div>
            </header>
            <dl>
              <div>
                <dt>Reference</dt>
                <dd>{receipt.id}</dd>
              </div>
              <div>
                <dt>Actor</dt>
                <dd>{receipt.actor}</dd>
              </div>
              <div>
                <dt>Recorded</dt>
                <dd>{receipt.at}</dd>
              </div>
              <div>
                <dt>Scope</dt>
                <dd>{portfolio.name}</dd>
              </div>
            </dl>
            <div className="ope-receipt__events">
              <span>Affected event{receipt.eventIds.length === 1 ? '' : 's'}</span>
              {receipt.eventTitles.map((title) => (
                <strong key={title}>
                  <Icon name="check" size={11} />
                  {title}
                </strong>
              ))}
            </div>
            <blockquote>
              <span>Recorded reason</span>
              {receipt.reason}
            </blockquote>
            <div className="ope-receipt__footer">
              <span>
                <Icon name="lock" size={12} />
                Stored in this portfolio&apos;s audit history
              </span>
              <div>
                {receipt.destination === 'Review' ? (
                  <button
                    className="ope-button ope-button--secondary"
                    onClick={onOpenReview}
                    type="button"
                  >
                    Open Review
                  </button>
                ) : null}
                <button
                  className="ope-button ope-button--primary"
                  data-receipt-close
                  onClick={() => setReceipt(null)}
                  type="button"
                >
                  Close receipt
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}

      <div className="ope-sr-only" aria-live="polite">
        {selectedSafeIds.length
          ? `${selectedSafeIds.length} safe event${selectedSafeIds.length === 1 ? '' : 's'} selected`
          : ''}
      </div>
    </section>
  );
}
