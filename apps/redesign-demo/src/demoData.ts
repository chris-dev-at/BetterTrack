import type { IconName } from './Icons';

export type Destination = 'home' | 'portfolios' | 'workbench' | 'assets' | 'people' | 'developer';
export type PortfolioTab =
  | 'overview'
  | 'activity'
  | 'holdings'
  | 'cash-flow'
  | 'analysis'
  | 'plan'
  | 'automate'
  | 'files'
  | 'people'
  | 'tax';

export type Scope = {
  id: string;
  name: string;
  eyebrow: string;
  value: number;
  change: number;
  changePct: number;
  icon: IconName;
  accent: string;
  childCount: number;
  chart: number[];
};

export const scopes: Scope[] = [
  {
    id: 'all',
    name: 'All wealth',
    eyebrow: '4 portfolios · 2 currencies',
    value: 642480.62,
    change: 5284.3,
    changePct: 0.83,
    icon: 'layers',
    accent: '#d9b778',
    childCount: 4,
    chart: [
      571, 574, 570, 579, 583, 581, 588, 586, 594, 599, 604, 601, 608, 613, 610, 619, 617, 624, 629,
      626, 633, 637, 634, 642,
    ],
  },
  {
    id: 'personal',
    name: 'Personal wealth',
    eyebrow: 'Primary · private',
    value: 284920.18,
    change: 3481.22,
    changePct: 1.24,
    icon: 'wallet',
    accent: '#cbb083',
    childCount: 0,
    chart: [
      244, 247, 245, 249, 251, 253, 252, 257, 260, 259, 263, 266, 264, 269, 270, 273, 271, 276, 278,
      277, 281, 280, 283, 285,
    ],
  },
  {
    id: 'northstar',
    name: 'Northstar Studio',
    eyebrow: 'Company · 100% owned',
    value: 191430.44,
    change: 968.34,
    changePct: 0.51,
    icon: 'briefcase',
    accent: '#8cb6a8',
    childCount: 2,
    chart: [
      179, 181, 180, 182, 181, 183, 184, 183, 185, 186, 184, 187, 188, 187, 189, 190, 188, 190, 191,
      189, 190, 191, 190, 191.4,
    ],
  },
  {
    id: 'rental',
    name: 'Riverside property',
    eyebrow: 'Property · shared with Mia',
    value: 138400,
    change: 750,
    changePct: 0.54,
    icon: 'house',
    accent: '#8d9dba',
    childCount: 0,
    chart: [
      130, 130, 131, 132, 132, 132, 133, 133, 134, 134, 135, 135, 135, 136, 136, 136, 137, 137, 137,
      138, 138, 138, 138, 138.4,
    ],
  },
  {
    id: 'family',
    name: 'Family reserve',
    eyebrow: 'Shared · 3 members',
    value: 27730,
    change: 84.74,
    changePct: 0.31,
    icon: 'people',
    accent: '#b296a9',
    childCount: 0,
    chart: [
      25.8, 25.9, 26, 26.1, 26, 26.2, 26.3, 26.2, 26.4, 26.6, 26.5, 26.7, 26.8, 26.7, 26.9, 27,
      27.1, 27, 27.2, 27.3, 27.4, 27.5, 27.6, 27.73,
    ],
  },
];

export const destinationItems: Array<{
  id: Destination;
  label: string;
  icon: IconName;
  hint: string;
}> = [
  { id: 'home', label: 'Home', icon: 'home', hint: 'Your command center' },
  { id: 'portfolios', label: 'Portfolios', icon: 'portfolio', hint: 'The source of truth' },
  { id: 'workbench', label: 'Workbench', icon: 'workbench', hint: 'Test and plan' },
  { id: 'assets', label: 'Assets', icon: 'assets', hint: 'Research and discover' },
  { id: 'people', label: 'People', icon: 'people', hint: 'Own and work together' },
  { id: 'developer', label: 'Developer', icon: 'code', hint: 'Build on your data' },
];

export const portfolioTabs: Array<{ id: PortfolioTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'activity', label: 'Activity' },
  { id: 'holdings', label: 'Holdings' },
  { id: 'cash-flow', label: 'Cash flow' },
  { id: 'analysis', label: 'Analysis' },
  { id: 'plan', label: 'Plan' },
  { id: 'automate', label: 'Automate' },
  { id: 'files', label: 'Files' },
  { id: 'people', label: 'People' },
  { id: 'tax', label: 'Tax' },
];

export type Holding = {
  symbol: string;
  name: string;
  type: string;
  value: number;
  allocation: number;
  change: number;
  color: string;
};

export const holdings: Holding[] = [
  {
    symbol: 'VWCE',
    name: 'Vanguard FTSE All-World',
    type: 'ETF',
    value: 109310.46,
    allocation: 38.36,
    change: 1.18,
    color: '#b9a277',
  },
  {
    symbol: 'AAPL',
    name: 'Apple',
    type: 'Stock',
    value: 38824.1,
    allocation: 13.63,
    change: 2.34,
    color: '#8fa69e',
  },
  {
    symbol: 'CASH',
    name: 'Cash & equivalents',
    type: 'Cash',
    value: 35492.87,
    allocation: 12.46,
    change: 0.01,
    color: '#d6c9ac',
  },
  {
    symbol: 'BTC',
    name: 'Bitcoin',
    type: 'Crypto',
    value: 28491.4,
    allocation: 10,
    change: -1.42,
    color: '#9c8e76',
  },
  {
    symbol: 'MSFT',
    name: 'Microsoft',
    type: 'Stock',
    value: 24630.34,
    allocation: 8.64,
    change: 0.72,
    color: '#738b94',
  },
];

export type ReviewItem = {
  id: string;
  icon: IconName;
  title: string;
  description: string;
  portfolio: string;
  tone: 'amber' | 'red' | 'blue' | 'green';
  action: string;
};

export const initialReviewItems: ReviewItem[] = [
  {
    id: 'categorize',
    icon: 'cash',
    title: 'Categorize 3 activities',
    description: 'Two card payments and one incoming transfer need a category.',
    portfolio: 'Personal wealth',
    tone: 'amber',
    action: 'Review',
  },
  {
    id: 'drift',
    icon: 'target',
    title: 'Allocation drift reached 4.8%',
    description: 'Your Global Core target moved outside its preferred band.',
    portfolio: 'Personal wealth',
    tone: 'blue',
    action: 'Rebalance',
  },
  {
    id: 'approval',
    icon: 'user-plus',
    title: 'Mia proposed a value update',
    description: 'Riverside property · appraisal increased by €6,500.',
    portfolio: 'Riverside property',
    tone: 'green',
    action: 'Inspect',
  },
  {
    id: 'sync',
    icon: 'refresh',
    title: 'Sparkasse needs attention',
    description: 'The last bank sync was interrupted 2 days ago.',
    portfolio: 'Family reserve',
    tone: 'red',
    action: 'Reconnect',
  },
];

export const upcomingItems = [
  {
    date: 'Today',
    title: 'Salary',
    detail: 'Personal wealth · expected',
    amount: 4280,
    icon: 'arrow-down' as IconName,
  },
  {
    date: '29 Jul',
    title: 'VWCE monthly plan',
    detail: 'Automation · Personal wealth',
    amount: -500,
    icon: 'repeat' as IconName,
  },
  {
    date: '01 Aug',
    title: 'Riverside mortgage',
    detail: 'Riverside property · recurring',
    amount: -1240,
    icon: 'house' as IconName,
  },
  {
    date: '05 Aug',
    title: 'Microsoft dividend',
    detail: 'Personal wealth · estimated',
    amount: 67.84,
    icon: 'calendar' as IconName,
  },
];

export const assetRows = [
  {
    symbol: 'VWCE',
    name: 'Vanguard FTSE All-World',
    price: '€141.18',
    change: 1.18,
    owned: 'Personal wealth',
    spark: [12, 13, 12, 14, 15, 14, 16, 17, 18],
  },
  {
    symbol: 'AAPL',
    name: 'Apple',
    price: '$238.42',
    change: 2.34,
    owned: '2 portfolios',
    spark: [12, 11, 13, 12, 14, 17, 16, 18, 20],
  },
  {
    symbol: 'NVDA',
    name: 'NVIDIA',
    price: '$192.08',
    change: -1.72,
    owned: 'Watchlist',
    spark: [20, 19, 21, 18, 17, 19, 16, 15, 14],
  },
  {
    symbol: 'BTC',
    name: 'Bitcoin',
    price: '€99,840',
    change: -1.42,
    owned: 'Personal wealth',
    spark: [18, 20, 19, 18, 21, 17, 16, 15, 14],
  },
  {
    symbol: 'MSFT',
    name: 'Microsoft',
    price: '$521.64',
    change: 0.72,
    owned: 'Personal wealth',
    spark: [11, 12, 13, 13, 14, 13, 15, 16, 16],
  },
];

export const activities = [
  {
    id: 'a1',
    date: 'Today, 09:42',
    title: 'Grocery store',
    detail: 'Expense · Food & household',
    amount: -84.26,
    source: 'Sparkasse •• 1842',
    status: 'Synced',
    icon: 'cash' as IconName,
  },
  {
    id: 'a2',
    date: 'Yesterday',
    title: 'Bought 3.54 VWCE',
    detail: 'Trade · €141.18 per share',
    amount: -499.78,
    source: 'Trade Republic',
    status: 'Imported',
    icon: 'arrow-down' as IconName,
  },
  {
    id: 'a3',
    date: '25 Jul',
    title: 'Microsoft dividend',
    detail: 'Dividend · withholding tax included',
    amount: 62.47,
    source: 'Trade Republic',
    status: 'Confirmed',
    icon: 'arrow-up' as IconName,
  },
  {
    id: 'a4',
    date: '24 Jul',
    title: 'Monthly studio transfer',
    detail: 'Transfer between portfolios',
    amount: 1200,
    source: 'Northstar Studio',
    status: 'Matched',
    icon: 'repeat' as IconName,
  },
];
