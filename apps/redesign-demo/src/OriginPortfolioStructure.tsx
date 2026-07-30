import {
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';

import { Icon, type IconName } from './Icons';
import type { OriginReviewEntry, OriginReviewReceipt } from './OriginReviewCenter';
import { useAccessibleDialog } from './useAccessibleDialog';
import './origin-portfolio-structure.css';

export type OriginStructureNodeKind =
  | 'root'
  | 'portfolio'
  | 'property'
  | 'business'
  | 'reserve'
  | 'liability'
  | 'person'
  | 'trust';

export type OriginStructureNode = {
  id: string;
  name: string;
  kind: OriginStructureNodeKind;
  value: number;
  currency: string;
  description: string;
  reference: string;
  status: 'active' | 'attention' | 'archived';
  updatedAt: string;
};

export type OriginStructureEdgeKind = 'contains' | 'owns' | 'secures';

export type OriginStructureEdge = {
  id: string;
  kind: OriginStructureEdgeKind;
  from: string;
  to: string;
  percentage?: number;
  label?: string;
  createdAt: string;
};

export type OriginStructureReviewLink = {
  decision: OriginReviewReceipt['decision'];
  reference: string;
  decidedAt: string;
  decidedBy: string;
};

export type OriginStructureAuditEntry = {
  id: string;
  at: string;
  actor: string;
  action: string;
  detail: string;
  objectId: string;
  mutationId?: string;
  review?: OriginStructureReviewLink;
  tone: 'neutral' | 'positive' | 'warning';
};

export type OriginStructureAudit = OriginStructureAuditEntry;

export type OriginStructureGraph = {
  version: 1;
  rootId: string;
  nodes: OriginStructureNode[];
  edges: OriginStructureEdge[];
  audit: OriginStructureAuditEntry[];
  updatedAt: string;
};

export type OriginStructureReparentMutation = {
  id: string;
  type: 'reparent';
  nodeId: string;
  fromParentId: string;
  toParentId: string;
  reason: string;
  requestedAt: string;
  requestedBy: string;
};

export type OriginStructureOwnershipAllocation = {
  ownerId: string;
  percentage: number;
};

export type OriginStructureOwnershipMutation = {
  id: string;
  type: 'ownership-change';
  nodeId: string;
  before: OriginStructureOwnershipAllocation[];
  allocations: OriginStructureOwnershipAllocation[];
  reason: string;
  requestedAt: string;
  requestedBy: string;
};

export type OriginStructureMutation =
  | OriginStructureReparentMutation
  | OriginStructureOwnershipMutation;

export type OriginStructureMutationValidation = {
  valid: boolean;
  errors: string[];
};

export type OriginPortfolioStructureProps = {
  portfolio: {
    id: string;
    name: string;
    value: number;
    currency?: string;
  };
  graph: OriginStructureGraph;
  privateMode: boolean;
  onClose: () => void;
  onSelectPortfolio: (id: string) => void;
  onCreateChild: (parentName: string) => void;
  onOpenPeople: () => void;
  onOpenReview: () => void;
  onOpenWorkbench: (context: string) => void;
  onPropose: (entry: OriginReviewEntry, mutation: OriginStructureMutation) => void;
  onToast: (message: string) => void;
};

type StructureView = 'overview' | 'ownership' | 'relationships' | 'lifecycle';
type Workflow = 'reparent' | 'ownership' | null;

const views: Array<{ id: StructureView; label: string; icon: IconName }> = [
  { id: 'overview', label: 'Structure', icon: 'layers' },
  { id: 'ownership', label: 'Ownership', icon: 'people' },
  { id: 'relationships', label: 'Relationships', icon: 'link' },
  { id: 'lifecycle', label: 'Lifecycle & audit', icon: 'clock' },
];

const kindMeta: Record<
  OriginStructureNodeKind,
  { label: string; icon: IconName; structural: boolean }
> = {
  root: { label: 'Wealth group', icon: 'layers', structural: true },
  portfolio: { label: 'Portfolio', icon: 'portfolio', structural: true },
  property: { label: 'Property', icon: 'house', structural: true },
  business: { label: 'Private business', icon: 'briefcase', structural: true },
  reserve: { label: 'Reserve', icon: 'shield', structural: true },
  liability: { label: 'Liability', icon: 'bank', structural: true },
  person: { label: 'Person', icon: 'people', structural: false },
  trust: { label: 'Trust', icon: 'lock', structural: false },
};

const nowIso = () => new Date().toISOString();

function makeId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function nodeById(graph: OriginStructureGraph, id: string) {
  return graph.nodes.find((node) => node.id === id);
}

function incomingEdges(graph: OriginStructureGraph, id: string, kind: OriginStructureEdgeKind) {
  return graph.edges.filter((edge) => edge.to === id && edge.kind === kind);
}

function outgoingEdges(graph: OriginStructureGraph, id: string, kind: OriginStructureEdgeKind) {
  return graph.edges.filter((edge) => edge.from === id && edge.kind === kind);
}

function descendantIds(graph: OriginStructureGraph, id: string) {
  const descendants = new Set<string>();
  const queue = outgoingEdges(graph, id, 'contains').map((edge) => edge.to);
  while (queue.length) {
    const candidate = queue.shift();
    if (!candidate || descendants.has(candidate)) continue;
    descendants.add(candidate);
    outgoingEdges(graph, candidate, 'contains').forEach((edge) => queue.push(edge.to));
  }
  return descendants;
}

function ownershipDescendantIds(graph: OriginStructureGraph, id: string) {
  const descendants = new Set<string>();
  const queue = outgoingEdges(graph, id, 'owns').map((edge) => edge.to);
  while (queue.length) {
    const candidate = queue.shift();
    if (!candidate || descendants.has(candidate)) continue;
    descendants.add(candidate);
    outgoingEdges(graph, candidate, 'owns').forEach((edge) => queue.push(edge.to));
  }
  return descendants;
}

function normalizeAllocations(allocations: OriginStructureOwnershipAllocation[]) {
  return allocations
    .filter((allocation) => allocation.percentage > 0)
    .map((allocation) => ({
      ownerId: allocation.ownerId,
      percentage: Math.round(allocation.percentage * 100) / 100,
    }))
    .sort((left, right) => left.ownerId.localeCompare(right.ownerId));
}

function sameAllocations(
  left: OriginStructureOwnershipAllocation[],
  right: OriginStructureOwnershipAllocation[],
) {
  const normalizedLeft = normalizeAllocations(left);
  const normalizedRight = normalizeAllocations(right);
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every(
      (allocation, index) =>
        allocation.ownerId === normalizedRight[index]?.ownerId &&
        Math.abs(allocation.percentage - (normalizedRight[index]?.percentage ?? 0)) <= 0.005,
    )
  );
}

function canContainStructureNode(node: OriginStructureNode | undefined) {
  return node?.kind === 'root' || node?.kind === 'portfolio';
}

export function validateOriginStructureMutation(
  graph: OriginStructureGraph,
  mutation: OriginStructureMutation,
): OriginStructureMutationValidation {
  const errors: string[] = [];
  const target = nodeById(graph, mutation.nodeId);
  if (!target) errors.push('The structure object no longer exists.');

  if (mutation.type === 'reparent') {
    const fromParent = nodeById(graph, mutation.fromParentId);
    const toParent = nodeById(graph, mutation.toParentId);
    const currentEdge = graph.edges.find(
      (edge) =>
        edge.kind === 'contains' &&
        edge.from === mutation.fromParentId &&
        edge.to === mutation.nodeId,
    );
    if (!fromParent || !currentEdge) errors.push('The current parent has changed.');
    if (!canContainStructureNode(toParent)) {
      errors.push('Choose a valid destination portfolio.');
    }
    if (mutation.nodeId === graph.rootId) errors.push('The root wealth group cannot be moved.');
    if (mutation.nodeId === mutation.toParentId) {
      errors.push('An object cannot contain itself.');
    }
    if (descendantIds(graph, mutation.nodeId).has(mutation.toParentId)) {
      errors.push('This move would create a cycle in the portfolio tree.');
    }
    if (mutation.fromParentId === mutation.toParentId) {
      errors.push('Choose a different parent.');
    }
    const otherParents = incomingEdges(graph, mutation.nodeId, 'contains').filter(
      (edge) => edge.from !== mutation.fromParentId,
    );
    if (otherParents.length) {
      errors.push('This object already has another structural parent and would be double-counted.');
    }
  } else {
    const currentAllocations = directAllocations(graph, mutation.nodeId);
    const allocations = normalizeAllocations(mutation.allocations);
    const total = allocations.reduce((sum, allocation) => sum + allocation.percentage, 0);
    const ownerIds = mutation.allocations.map((allocation) => allocation.ownerId);
    if (!allocations.length) errors.push('Assign at least one owner.');
    if (
      mutation.allocations.some(
        (allocation) =>
          !Number.isFinite(allocation.percentage) ||
          allocation.percentage <= 0 ||
          allocation.percentage > 100,
      )
    ) {
      errors.push('Each included owner needs an allocation between 0% and 100%.');
    }
    if (new Set(ownerIds).size !== ownerIds.length) {
      errors.push('Each owner can appear only once.');
    }
    if (Math.abs(total - 100) > 0.005) {
      errors.push(`Ownership must equal 100%. Current total is ${total.toFixed(2)}%.`);
    }
    if (allocations.some((allocation) => !nodeById(graph, allocation.ownerId))) {
      errors.push('One or more owners no longer exist.');
    }
    if (
      allocations.some(
        (allocation) =>
          allocation.ownerId === mutation.nodeId ||
          descendantIds(graph, mutation.nodeId).has(allocation.ownerId) ||
          ownershipDescendantIds(graph, mutation.nodeId).has(allocation.ownerId),
      )
    ) {
      errors.push('An object cannot be owned by itself or one of its descendants.');
    }
    if (!sameAllocations(mutation.before, currentAllocations)) {
      errors.push('Current ownership changed after this proposal was prepared.');
    }
    if (sameAllocations(currentAllocations, allocations)) {
      errors.push('Change at least one ownership allocation.');
    }
  }

  if (!mutation.reason.trim()) errors.push('Add a reason for the audit trail.');
  return { valid: errors.length === 0, errors };
}

/**
 * Applies an approved structure change without mutating the supplied graph.
 * App integrations can keep the mutation beside its Review item and call this
 * helper only when that item is approved.
 */
export function applyOriginStructureMutation(
  graph: OriginStructureGraph,
  mutation: OriginStructureMutation,
  reviewReceipt?: OriginReviewReceipt,
): OriginStructureGraph {
  if (reviewReceipt?.decision === 'rejected') {
    throw new Error('A rejected structure proposal cannot be applied.');
  }
  if (graph.audit.some((entry) => entry.mutationId === mutation.id)) return graph;
  const validation = validateOriginStructureMutation(graph, mutation);
  if (!validation.valid) throw new Error(validation.errors.join(' '));

  const at = reviewReceipt?.decidedAt ?? mutation.requestedAt;
  const actor = reviewReceipt?.decidedBy ?? mutation.requestedBy;
  let edges = graph.edges.map((edge) => ({ ...edge }));
  let action: string;
  let detail: string;

  if (mutation.type === 'reparent') {
    const target = nodeById(graph, mutation.nodeId)!;
    const previous = nodeById(graph, mutation.fromParentId)!;
    const next = nodeById(graph, mutation.toParentId)!;
    edges = edges.map((edge) =>
      edge.kind === 'contains' && edge.from === mutation.fromParentId && edge.to === mutation.nodeId
        ? {
            ...edge,
            id: `contains-${mutation.toParentId}-${mutation.nodeId}`,
            from: mutation.toParentId,
            createdAt: at,
          }
        : edge,
    );
    action = 'Structure parent changed';
    detail = `${target.name} moved from ${previous.name} to ${next.name}. ${mutation.reason}`;
  } else {
    const target = nodeById(graph, mutation.nodeId)!;
    const allocations = normalizeAllocations(mutation.allocations);
    edges = [
      ...edges.filter((edge) => !(edge.kind === 'owns' && edge.to === mutation.nodeId)),
      ...allocations.map((allocation) => ({
        id: `owns-${allocation.ownerId}-${mutation.nodeId}`,
        kind: 'owns' as const,
        from: allocation.ownerId,
        to: mutation.nodeId,
        percentage: allocation.percentage,
        label: 'Direct ownership',
        createdAt: at,
      })),
    ];
    action = 'Ownership changed';
    detail = `${target.name} ownership replaced with ${allocations
      .map(
        (allocation) =>
          `${nodeById(graph, allocation.ownerId)?.name ?? allocation.ownerId} ${allocation.percentage}%`,
      )
      .join(', ')}. ${mutation.reason}`;
  }

  const audit: OriginStructureAuditEntry = {
    id: `structure-audit-${mutation.id}-${reviewReceipt?.reference ?? 'applied'}`,
    at,
    actor,
    action,
    detail,
    objectId: mutation.nodeId,
    mutationId: mutation.id,
    ...(reviewReceipt
      ? {
          review: {
            decision: reviewReceipt.decision,
            reference: reviewReceipt.reference,
            decidedAt: reviewReceipt.decidedAt,
            decidedBy: reviewReceipt.decidedBy,
          },
        }
      : {}),
    tone: 'positive',
  };

  return {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === mutation.nodeId ? { ...node, updatedAt: at } : { ...node },
    ),
    edges,
    audit: [audit, ...graph.audit.map((entry) => ({ ...entry }))],
    updatedAt: at,
  };
}

export function createOriginStructureSeedGraph(): OriginStructureGraph {
  const createdAt = '2026-07-27T05:20:00.000Z';
  const nodes: OriginStructureNode[] = [
    {
      id: 'all-wealth',
      name: 'All wealth',
      kind: 'root',
      value: 642_480.62,
      currency: 'EUR',
      description: 'The control view shared by Home and every connected portfolio workspace.',
      reference: 'GROUP-ALL-01',
      status: 'active',
      updatedAt: createdAt,
    },
    {
      id: 'personal',
      name: 'Personal wealth',
      kind: 'portfolio',
      value: 284_920.18,
      currency: 'EUR',
      description: 'Primary personal portfolio with nested public and private assets.',
      reference: 'PORT-PERSONAL-01',
      status: 'active',
      updatedAt: createdAt,
    },
    {
      id: 'global-core',
      name: 'Global Core',
      kind: 'portfolio',
      value: 284_920.18,
      currency: 'EUR',
      description: 'Long-term listed holdings, cash, and recurring investment plans.',
      reference: 'PORT-CORE-03',
      status: 'active',
      updatedAt: createdAt,
    },
    {
      id: 'riverside-property',
      name: 'Riverside property',
      kind: 'property',
      value: 302_400,
      currency: 'EUR',
      description: 'Residential property tracked at gross value with linked financing.',
      reference: 'ASSET-RIVER-01',
      status: 'attention',
      updatedAt: '2026-02-28T11:23:00.000Z',
    },
    {
      id: 'northstar',
      name: 'Northstar Studio',
      kind: 'business',
      value: 191_430.44,
      currency: 'EUR',
      description: 'Private operating company tracked as its own portfolio branch.',
      reference: 'BIZ-NORTHSTAR-01',
      status: 'active',
      updatedAt: '2026-07-24T14:40:00.000Z',
    },
    {
      id: 'family-reserve',
      name: 'Family reserve',
      kind: 'reserve',
      value: 27_730,
      currency: 'EUR',
      description: 'Ring-fenced liquidity governed by the family trust.',
      reference: 'PORT-RESERVE-02',
      status: 'active',
      updatedAt: '2026-07-25T08:10:00.000Z',
    },
    {
      id: 'riverside-mortgage',
      name: 'Riverside mortgage',
      kind: 'liability',
      value: -164_000,
      currency: 'EUR',
      description: 'Secured mortgage connected directly to the Riverside property.',
      reference: 'DEBT-RIVER-01',
      status: 'active',
      updatedAt: '2026-07-26T06:02:00.000Z',
    },
    {
      id: 'owner-you',
      name: 'You',
      kind: 'person',
      value: 0,
      currency: 'EUR',
      description: 'Primary account owner.',
      reference: 'PERSON-YOU',
      status: 'active',
      updatedAt: createdAt,
    },
    {
      id: 'owner-mia',
      name: 'Mia',
      kind: 'person',
      value: 0,
      currency: 'EUR',
      description: 'Household member.',
      reference: 'PERSON-MARIA',
      status: 'active',
      updatedAt: createdAt,
    },
    {
      id: 'family-trust',
      name: 'Family trust',
      kind: 'trust',
      value: 0,
      currency: 'EUR',
      description: 'Household trust used for reserve governance.',
      reference: 'TRUST-FAMILY-01',
      status: 'active',
      updatedAt: createdAt,
    },
  ];

  const contains = (from: string, to: string, created = createdAt): OriginStructureEdge => ({
    id: `contains-${from}-${to}`,
    kind: 'contains',
    from,
    to,
    label: 'Contains',
    createdAt: created,
  });
  const owns = (from: string, to: string, percentage: number): OriginStructureEdge => ({
    id: `owns-${from}-${to}`,
    kind: 'owns',
    from,
    to,
    percentage,
    label: 'Direct ownership',
    createdAt,
  });

  return {
    version: 1,
    rootId: 'all-wealth',
    nodes,
    edges: [
      contains('all-wealth', 'personal'),
      contains('personal', 'global-core'),
      contains('all-wealth', 'northstar'),
      contains('all-wealth', 'riverside-property'),
      contains('all-wealth', 'family-reserve'),
      contains('all-wealth', 'riverside-mortgage'),
      owns('owner-you', 'all-wealth', 100),
      owns('all-wealth', 'personal', 100),
      owns('personal', 'global-core', 100),
      owns('owner-you', 'riverside-property', 72),
      owns('owner-mia', 'riverside-property', 28),
      owns('owner-you', 'northstar', 100),
      owns('family-trust', 'family-reserve', 100),
      owns('owner-you', 'family-trust', 60),
      owns('owner-mia', 'family-trust', 40),
      owns('personal', 'riverside-mortgage', 100),
      {
        id: 'secures-riverside-mortgage',
        kind: 'secures',
        from: 'riverside-mortgage',
        to: 'riverside-property',
        label: 'Secured against',
        createdAt,
      },
    ],
    audit: [
      {
        id: 'structure-audit-003',
        at: '2026-07-26T06:02:00.000Z',
        actor: 'Flatex connection',
        action: 'Liability balance reconciled',
        detail: 'Riverside mortgage balance updated from €164,820 to €164,000.',
        objectId: 'riverside-mortgage',
        tone: 'positive',
      },
      {
        id: 'structure-audit-002',
        at: '2026-07-25T08:10:00.000Z',
        actor: 'You',
        action: 'Ownership evidence verified',
        detail: 'Family reserve trust deed linked and 60/40 beneficial split confirmed.',
        objectId: 'family-reserve',
        tone: 'positive',
      },
      {
        id: 'structure-audit-001',
        at: '2026-07-21T12:31:00.000Z',
        actor: 'BetterTrack',
        action: 'Structure graph created',
        detail:
          'Personal wealth, Northstar Studio, Riverside property, Family reserve, and its linked mortgage reconcile to €642,480.62.',
        objectId: 'all-wealth',
        tone: 'neutral',
      },
    ],
    updatedAt: createdAt,
  };
}

function formatMoney(value: number, currency: string, privateMode: boolean) {
  if (privateMode) return '••••••';
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDate(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function directAllocations(graph: OriginStructureGraph, nodeId: string) {
  return incomingEdges(graph, nodeId, 'owns')
    .map((edge) => ({
      ownerId: edge.from,
      percentage: edge.percentage ?? 0,
    }))
    .sort((left, right) => right.percentage - left.percentage);
}

function effectiveAllocations(graph: OriginStructureGraph, nodeId: string) {
  const totals = new Map<string, number>();

  function expand(ownerId: string, percentage: number, path: Set<string>) {
    if (path.has(ownerId)) {
      totals.set(ownerId, (totals.get(ownerId) ?? 0) + percentage);
      return;
    }
    const ownerEdges = incomingEdges(graph, ownerId, 'owns');
    if (!ownerEdges.length) {
      totals.set(ownerId, (totals.get(ownerId) ?? 0) + percentage);
      return;
    }
    const nextPath = new Set(path);
    nextPath.add(ownerId);
    ownerEdges.forEach((edge) =>
      expand(edge.from, percentage * ((edge.percentage ?? 0) / 100), nextPath),
    );
  }

  directAllocations(graph, nodeId).forEach((allocation) =>
    expand(allocation.ownerId, allocation.percentage, new Set([nodeId])),
  );
  return Array.from(totals, ([ownerId, percentage]) => ({ ownerId, percentage })).sort(
    (left, right) => right.percentage - left.percentage,
  );
}

function visibleChildren(graph: OriginStructureGraph, parentId: string) {
  return outgoingEdges(graph, parentId, 'contains')
    .map((edge) => nodeById(graph, edge.to))
    .filter((node): node is OriginStructureNode => Boolean(node));
}

function ownerName(graph: OriginStructureGraph, ownerId: string) {
  return nodeById(graph, ownerId)?.name ?? 'Unknown owner';
}

function percentTotal(allocations: OriginStructureOwnershipAllocation[]) {
  return allocations.reduce((total, allocation) => total + allocation.percentage, 0);
}

function ownershipSummary(
  graph: OriginStructureGraph,
  allocations: OriginStructureOwnershipAllocation[],
) {
  return allocations
    .map((allocation) => `${ownerName(graph, allocation.ownerId)} ${allocation.percentage}%`)
    .join(' · ');
}

export function OriginPortfolioStructure({
  portfolio,
  graph,
  privateMode,
  onClose,
  onSelectPortfolio,
  onCreateChild,
  onOpenPeople,
  onOpenReview,
  onOpenWorkbench,
  onPropose,
  onToast,
}: OriginPortfolioStructureProps) {
  const initialSelected = graph.nodes.some((node) => node.id === portfolio.id)
    ? portfolio.id
    : 'personal';
  const [view, setView] = useState<StructureView>('overview');
  const [selectedId, setSelectedId] = useState(initialSelected);
  const [workflow, setWorkflow] = useState<Workflow>(null);
  const [reparentTarget, setReparentTarget] = useState('');
  const [reparentReason, setReparentReason] = useState('');
  const [ownershipDraft, setOwnershipDraft] = useState<Record<string, number>>({});
  const [ownershipReason, setOwnershipReason] = useState('');
  const [notice, setNotice] = useState('');
  const [showAllAudit, setShowAllAudit] = useState(false);
  const tabsRef = useRef<HTMLElement>(null);
  const reparentTitleId = useId();
  const ownershipTitleId = useId();
  const workspaceDialogRef = useAccessibleDialog<HTMLElement>({
    open: true,
    onClose,
    initialFocusSelector: '[data-structure-heading]',
  });
  const reparentDialogRef = useAccessibleDialog<HTMLDivElement>({
    open: workflow === 'reparent',
    onClose: () => setWorkflow(null),
    initialFocusSelector: '[data-reparent-initial]',
  });
  const ownershipDialogRef = useAccessibleDialog<HTMLDivElement>({
    open: workflow === 'ownership',
    onClose: () => setWorkflow(null),
    initialFocusSelector: '[data-ownership-initial]',
  });

  useEffect(() => {
    if (!nodeById(graph, selectedId)) setSelectedId(graph.rootId);
  }, [graph, selectedId]);

  const selected = nodeById(graph, selectedId) ?? nodeById(graph, graph.rootId)!;
  const selectedParentEdge = incomingEdges(graph, selected.id, 'contains')[0];
  const selectedParent = selectedParentEdge ? nodeById(graph, selectedParentEdge.from) : undefined;
  const selectedChildren = visibleChildren(graph, selected.id);
  const direct = useMemo(() => directAllocations(graph, selected.id), [graph, selected.id]);
  const effective = useMemo(() => effectiveAllocations(graph, selected.id), [graph, selected.id]);
  const directTotal = percentTotal(direct);
  const effectiveTotal = percentTotal(effective);
  const structuralNodes = graph.nodes.filter((node) => kindMeta[node.kind].structural);
  const ownerNodes = graph.nodes.filter((node) => node.kind === 'person' || node.kind === 'trust');
  const directStructureOwners = direct.reduce<OriginStructureNode[]>((owners, allocation) => {
    const owner = nodeById(graph, allocation.ownerId);
    if (owner && owner.kind !== 'person' && owner.kind !== 'trust') owners.push(owner);
    return owners;
  }, []);
  const ownershipCandidateNodes = [...directStructureOwners, ...ownerNodes].filter(
    (node, index, candidates) => candidates.findIndex(({ id }) => id === node.id) === index,
  );
  const rootChildren = visibleChildren(graph, graph.rootId);
  const relationshipEdges = graph.edges.filter((edge) => edge.kind === 'secures');
  const creationParent = canContainStructureNode(selected)
    ? selected
    : (selectedParent ?? nodeById(graph, graph.rootId)!);
  const pendingMutationId =
    workflow === 'reparent'
      ? makeReparentMutation(false)?.id
      : workflow === 'ownership'
        ? makeOwnershipMutation(false)?.id
        : null;

  function selectNode(id: string) {
    setSelectedId(id);
    setNotice('');
  }

  function openReparent() {
    if (!selectedParent) return;
    const firstTarget = structuralNodes.find(
      (node) =>
        node.id !== selected.id &&
        node.id !== selectedParent.id &&
        !descendantIds(graph, selected.id).has(node.id) &&
        canContainStructureNode(node),
    );
    setReparentTarget(firstTarget?.id ?? '');
    setReparentReason('');
    setWorkflow('reparent');
  }

  function openOwnership() {
    const current = Object.fromEntries(
      ownerNodes.map((owner) => [
        owner.id,
        direct.find((allocation) => allocation.ownerId === owner.id)?.percentage ?? 0,
      ]),
    );
    structuralNodes.forEach((node) => {
      const allocation = direct.find((candidate) => candidate.ownerId === node.id);
      if (allocation) current[node.id] = allocation.percentage;
    });
    setOwnershipDraft(current);
    setOwnershipReason('');
    setWorkflow('ownership');
  }

  function makeReparentMutation(generateId = true): OriginStructureReparentMutation | null {
    if (!selectedParent) return null;
    return {
      id: generateId ? makeId('structure_move') : `preview-${selected.id}-${reparentTarget}`,
      type: 'reparent',
      nodeId: selected.id,
      fromParentId: selectedParent.id,
      toParentId: reparentTarget,
      reason: reparentReason.trim(),
      requestedAt: nowIso(),
      requestedBy: 'You',
    };
  }

  function makeOwnershipMutation(generateId = true): OriginStructureOwnershipMutation {
    return {
      id: generateId ? makeId('structure_owner') : `preview-${selected.id}-ownership`,
      type: 'ownership-change',
      nodeId: selected.id,
      before: direct,
      allocations: Object.entries(ownershipDraft)
        .map(([ownerId, percentage]) => ({ ownerId, percentage: Number(percentage) || 0 }))
        .filter((allocation) => allocation.percentage > 0),
      reason: ownershipReason.trim(),
      requestedAt: nowIso(),
      requestedBy: 'You',
    };
  }

  const reparentPreview = workflow === 'reparent' ? makeReparentMutation(false) : null;
  const reparentValidation = reparentPreview
    ? validateOriginStructureMutation(graph, reparentPreview)
    : { valid: false, errors: ['This object has no structural parent.'] };
  const ownershipPreview = makeOwnershipMutation(false);
  const ownershipValidation =
    workflow === 'ownership'
      ? validateOriginStructureMutation(graph, ownershipPreview)
      : { valid: false, errors: [] };
  const ownershipTotal = percentTotal(ownershipPreview.allocations);

  function submitReparent(event: FormEvent) {
    event.preventDefault();
    const mutation = makeReparentMutation();
    if (!mutation) return;
    const validation = validateOriginStructureMutation(graph, mutation);
    if (!validation.valid) return;
    const destination = nodeById(graph, mutation.toParentId)!;
    const entry: OriginReviewEntry = {
      id: mutation.id,
      kind: 'collaboration',
      title: `Move ${selected.name} to ${destination.name}`,
      summary:
        'Reparent one portfolio object without duplicating its value or changing the underlying holdings.',
      portfolio: {
        id: portfolio.id,
        name: portfolio.name,
        path: `${portfolio.name} / Structure`,
      },
      source: {
        label: 'Portfolio structure',
        detail: `${selected.reference} · proposed by You`,
        actor: 'You',
      },
      requestedAt: mutation.requestedAt,
      requestedBy: 'You',
      status: 'pending',
      priority: 'normal',
      risk: 'medium',
      affectedCount: 1,
      tags: ['structure', 'reparent', 'portfolio-truth'],
      approveLabel: 'Apply structure move',
      rejectLabel: 'Keep current parent',
      diff: [
        {
          label: 'Structural parent',
          before: selectedParent?.name,
          after: destination.name,
          tone: 'warning',
          detail: mutation.reason,
        },
      ],
      calculations: [
        {
          label: 'Moved value',
          value: formatMoney(selected.value, selected.currency, privateMode),
          detail: 'Included once after approval',
        },
        {
          label: 'Holding and activity data',
          value: 'Unchanged',
          detail: 'Only the containment edge changes',
          tone: 'positive',
        },
      ],
      lineage: [
        {
          label: 'Current parent',
          detail: selectedParent?.name ?? 'No parent',
          state: 'verified',
        },
        {
          label: 'Destination check',
          detail: 'No cycle and no second structural parent detected',
          state: 'verified',
        },
      ],
      policies: [
        {
          title: 'Single structural parent',
          description: 'The object remains counted exactly once in controlled wealth.',
          status: 'pass',
        },
        {
          title: 'Review before portfolio truth changes',
          description: 'The move remains staged until an authorised reviewer approves it.',
          status: 'warning',
        },
      ],
    };
    onPropose(entry, mutation);
    setWorkflow(null);
    setNotice(`${selected.name} → ${destination.name} is waiting in Review.`);
    onToast('Structure move sent to Review.');
  }

  function submitOwnership(event: FormEvent) {
    event.preventDefault();
    const mutation = makeOwnershipMutation();
    const validation = validateOriginStructureMutation(graph, mutation);
    if (!validation.valid) return;
    const before = ownershipSummary(graph, direct);
    const after = ownershipSummary(graph, mutation.allocations);
    const entry: OriginReviewEntry = {
      id: mutation.id,
      kind: 'collaboration',
      title: `Change ownership of ${selected.name}`,
      summary: 'Replace direct ownership allocations while preserving the effective-owner trail.',
      portfolio: {
        id: portfolio.id,
        name: portfolio.name,
        path: `${portfolio.name} / Structure / Ownership`,
      },
      source: {
        label: 'Portfolio ownership',
        detail: `${selected.reference} · proposed by You`,
        actor: 'You',
      },
      requestedAt: mutation.requestedAt,
      requestedBy: 'You',
      status: 'pending',
      priority: 'high',
      risk: 'high',
      affectedCount: mutation.allocations.length,
      tags: ['structure', 'ownership', 'portfolio-truth'],
      approveLabel: 'Apply ownership change',
      rejectLabel: 'Keep current ownership',
      diff: [
        {
          label: 'Direct ownership',
          before,
          after,
          tone: 'warning',
          detail: mutation.reason,
        },
      ],
      calculations: [
        {
          label: 'Allocation total',
          value: '100.00%',
          detail: `${mutation.allocations.length} direct owner${
            mutation.allocations.length === 1 ? '' : 's'
          }`,
          tone: 'positive',
        },
        {
          label: 'Object value',
          value: formatMoney(selected.value, selected.currency, privateMode),
          detail: 'No valuation change',
        },
      ],
      lineage: [
        {
          label: 'Current ownership',
          detail: before || 'No verified allocation',
          state: directTotal === 100 ? 'verified' : 'warning',
        },
        {
          label: 'Proposed ownership',
          detail: after,
          state: 'derived',
        },
      ],
      policies: [
        {
          title: 'Ownership allocation equals 100%',
          description: 'The proposed direct allocations reconcile exactly.',
          status: 'pass',
        },
        {
          title: 'Consequential changes require approval',
          description: 'Effective ownership will recalculate only after Review approval.',
          status: 'warning',
        },
      ],
    };
    onPropose(entry, mutation);
    setWorkflow(null);
    setNotice(`Ownership change for ${selected.name} is waiting in Review.`);
    onToast('Ownership change sent to Review.');
  }

  function onTabsKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
    const currentIndex = buttons.findIndex((button) => button === document.activeElement);
    if (currentIndex < 0) return;
    event.preventDefault();
    let nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : event.key === 'ArrowRight'
            ? (currentIndex + 1) % buttons.length
            : (currentIndex - 1 + buttons.length) % buttons.length;
    const next = buttons[nextIndex];
    if (!next) return;
    next.focus();
    next.click();
  }

  function renderTree(parentId: string, depth = 0) {
    return visibleChildren(graph, parentId).map((node) => {
      const children = visibleChildren(graph, node.id);
      const ownership = directAllocations(graph, node.id);
      const hasIssue =
        Math.abs(percentTotal(ownership) - 100) > 0.005 || node.status === 'attention';
      return (
        <li className="ops-tree__branch" key={node.id}>
          <button
            aria-current={selected.id === node.id ? 'true' : undefined}
            className={selected.id === node.id ? 'is-selected' : ''}
            onClick={() => selectNode(node.id)}
            style={{ '--ops-depth': depth } as CSSProperties}
            type="button"
          >
            <span className={`ops-node-icon is-${node.kind}`}>
              <Icon name={kindMeta[node.kind].icon} size={14} />
            </span>
            <span className="ops-tree__copy">
              <small>{kindMeta[node.kind].label}</small>
              <strong>{node.name}</strong>
            </span>
            <span className="ops-tree__value">
              {hasIssue ? (
                <span className="ops-attention-dot" aria-label="Needs attention" />
              ) : null}
              {formatMoney(node.value, node.currency, privateMode)}
            </span>
            <Icon name="chevron-right" size={13} />
          </button>
          {children.length ? <ol>{renderTree(node.id, depth + 1)}</ol> : null}
        </li>
      );
    });
  }

  const rootNode = nodeById(graph, graph.rootId)!;
  const mortgageEdge = relationshipEdges.find((edge) => edge.label === 'Secured against');
  const mortgage = mortgageEdge ? nodeById(graph, mortgageEdge.from) : undefined;
  const securedAsset = mortgageEdge ? nodeById(graph, mortgageEdge.to) : undefined;
  const gross = securedAsset?.value ?? 0;
  const debt = Math.abs(mortgage?.value ?? 0);
  const net = gross - debt;
  const moveCandidates = structuralNodes.filter(
    (node) =>
      node.id !== selected.id &&
      node.id !== selectedParent?.id &&
      canContainStructureNode(node) &&
      !descendantIds(graph, selected.id).has(node.id),
  );

  return (
    <section
      aria-label={`${portfolio.name} portfolio structure`}
      aria-modal="true"
      className="origin-portfolio-structure"
      ref={workspaceDialogRef}
      role="dialog"
      tabIndex={-1}
    >
      <header className="ops-global-header">
        <div className="ops-brand" aria-label="BetterTrack">
          <span className="ops-brand__mark" aria-hidden="true" />
          <span>
            <strong>
              Better<span>Track</span>
            </strong>
            <small>Portfolio structure</small>
          </span>
        </div>
        <div className="ops-breadcrumb" aria-label="Current location">
          <span>Portfolios</span>
          <Icon name="chevron-right" size={12} />
          <strong>{portfolio.name}</strong>
          <Icon name="chevron-right" size={12} />
          <span>Structure</span>
        </div>
        <div className="ops-global-actions">
          <span className="ops-saved">
            <i />
            Graph reconciled
          </span>
          <button onClick={onClose} type="button" aria-label="Close portfolio structure">
            <Icon name="x" size={15} />
          </button>
        </div>
      </header>

      <main className="ops-page">
        <div className="ops-page-heading">
          <div>
            <span className="ops-kicker">Connected wealth · one source of truth</span>
            <h1 data-structure-heading tabIndex={-1}>
              Portfolio structure
            </h1>
            <p>
              See what contains what, who ultimately owns it, and which debts belong to each asset.
              A value has <strong>one structural parent</strong>, so it is never silently counted
              twice.
            </p>
          </div>
          <div className="ops-page-heading__actions">
            <span>
              Scope <strong>{rootNode.name}</strong> · updated {formatDate(graph.updatedAt)}
            </span>
            <div>
              <button className="ops-button ops-button--quiet" onClick={onOpenPeople} type="button">
                <Icon name="people" size={13} />
                People
              </button>
              <button
                className="ops-button ops-button--primary"
                onClick={() => onCreateChild(creationParent.name)}
                type="button"
              >
                <Icon name="plus" size={13} />
                Add under {creationParent.name}
              </button>
            </div>
          </div>
        </div>

        {notice ? (
          <div className="ops-notice" role="status">
            <Icon name="check" size={14} />
            <span>{notice}</span>
            <button aria-label="Dismiss message" onClick={() => setNotice('')} type="button">
              <Icon name="x" size={12} />
            </button>
          </div>
        ) : null}

        <div className="ops-metrics" aria-label="Structure summary">
          <article>
            <span>
              <small>Controlled wealth</small>
              <strong>{formatMoney(rootNode.value, rootNode.currency, privateMode)}</strong>
            </span>
            <em>Across {structuralNodes.length - 1} connected objects</em>
          </article>
          <article>
            <span>
              <small>Nested portfolios</small>
              <strong>{structuralNodes.filter((node) => node.kind === 'portfolio').length}</strong>
            </span>
            <em>
              {rootChildren.length} direct {rootChildren.length === 1 ? 'branch' : 'branches'}
            </em>
          </article>
          <article>
            <span>
              <small>Verified ownership</small>
              <strong>
                {
                  structuralNodes.filter(
                    (node) =>
                      Math.abs(percentTotal(directAllocations(graph, node.id)) - 100) <= 0.005,
                  ).length
                }
                /{structuralNodes.length}
              </strong>
            </span>
            <em>Direct allocations reconcile</em>
          </article>
          <article className="is-attention">
            <span>
              <small>Linked liabilities</small>
              <strong>{relationshipEdges.length}</strong>
            </span>
            <em>{formatMoney(-debt, rootNode.currency, privateMode)} secured debt</em>
          </article>
        </div>

        <nav
          aria-label="Portfolio structure sections"
          className="ops-tabs"
          onKeyDown={onTabsKeyDown}
          ref={tabsRef}
          role="tablist"
        >
          {views.map((item) => (
            <button
              aria-controls={`ops-panel-${item.id}`}
              aria-selected={view === item.id}
              className={view === item.id ? 'is-active' : ''}
              id={`ops-tab-${item.id}`}
              key={item.id}
              onClick={() => setView(item.id)}
              role="tab"
              tabIndex={view === item.id ? 0 : -1}
              type="button"
            >
              <Icon name={item.icon} size={13} />
              {item.label}
              {item.id === 'relationships' ? <span>{relationshipEdges.length}</span> : null}
            </button>
          ))}
        </nav>

        {view === 'overview' ? (
          <section
            aria-labelledby="ops-tab-overview"
            className="ops-panel ops-overview"
            id="ops-panel-overview"
            role="tabpanel"
          >
            <div className="ops-structure-workspace">
              <aside className="ops-tree" aria-label="Portfolio hierarchy">
                <div className="ops-tree__heading">
                  <span>
                    <small>Control graph</small>
                    <strong>One value, one parent</strong>
                  </span>
                  <span className="ops-verified">
                    <Icon name="shield" size={11} />
                    Valid
                  </span>
                </div>
                <ol className="ops-tree__root">
                  <li className="ops-tree__branch">
                    <button
                      aria-current={selected.id === rootNode.id ? 'true' : undefined}
                      className={selected.id === rootNode.id ? 'is-selected' : ''}
                      onClick={() => selectNode(rootNode.id)}
                      style={{ '--ops-depth': 0 } as CSSProperties}
                      type="button"
                    >
                      <span className="ops-node-icon is-root">
                        <Icon name="layers" size={14} />
                      </span>
                      <span className="ops-tree__copy">
                        <small>{kindMeta[rootNode.kind].label}</small>
                        <strong>{rootNode.name}</strong>
                      </span>
                      <span className="ops-tree__value">
                        {formatMoney(rootNode.value, rootNode.currency, privateMode)}
                      </span>
                      <Icon name="chevron-right" size={13} />
                    </button>
                    <ol>{renderTree(rootNode.id, 1)}</ol>
                  </li>
                </ol>
                <div className="ops-tree__legend">
                  <span>
                    <i className="is-line" /> Contains
                  </span>
                  <span>
                    <i className="is-attention" /> Needs evidence
                  </span>
                </div>
              </aside>

              <article className="ops-object-detail" aria-live="polite">
                <div className="ops-object-heading">
                  <span className={`ops-object-icon is-${selected.kind}`}>
                    <Icon name={kindMeta[selected.kind].icon} size={18} />
                  </span>
                  <div>
                    <small>{kindMeta[selected.kind].label}</small>
                    <h2>{selected.name}</h2>
                    <p>{selected.description}</p>
                  </div>
                  <span className={`ops-object-status is-${selected.status}`}>
                    <i />
                    {selected.status === 'attention' ? 'Evidence due' : selected.status}
                  </span>
                </div>

                <div className="ops-value-line">
                  <span>
                    <small>Current value</small>
                    <strong>{formatMoney(selected.value, selected.currency, privateMode)}</strong>
                  </span>
                  <span>
                    <small>Reference</small>
                    <strong>{selected.reference}</strong>
                  </span>
                  <span>
                    <small>Updated</small>
                    <strong>{formatDate(selected.updatedAt)}</strong>
                  </span>
                </div>

                <div className="ops-path">
                  <span className="ops-section-label">Structural path</span>
                  <div>
                    {selectedParent ? (
                      <>
                        <button onClick={() => selectNode(selectedParent.id)} type="button">
                          {selectedParent.name}
                        </button>
                        <Icon name="chevron-right" size={12} />
                      </>
                    ) : null}
                    <strong>{selected.name}</strong>
                  </div>
                  <p>
                    {selectedParent
                      ? `${selected.name} contributes its net value to ${selectedParent.name} exactly once.`
                      : 'This is the root control view. It aggregates every connected branch exactly once.'}
                  </p>
                </div>

                <div className="ops-object-grid">
                  <section>
                    <div className="ops-section-heading">
                      <span>
                        <strong>Direct ownership</strong>
                        <small>{directTotal.toFixed(2)}% allocated</small>
                      </span>
                      <button onClick={() => setView('ownership')} type="button">
                        Inspect
                        <Icon name="arrow-right" size={11} />
                      </button>
                    </div>
                    <div className="ops-owner-stack">
                      {direct.length ? (
                        direct.map((allocation) => (
                          <span key={allocation.ownerId}>
                            <i>{ownerName(graph, allocation.ownerId).slice(0, 1)}</i>
                            <strong>{ownerName(graph, allocation.ownerId)}</strong>
                            <em>{allocation.percentage.toFixed(2)}%</em>
                          </span>
                        ))
                      ) : (
                        <p className="ops-inline-empty">No verified owner allocation.</p>
                      )}
                    </div>
                  </section>
                  <section>
                    <div className="ops-section-heading">
                      <span>
                        <strong>Contained objects</strong>
                        <small>{selectedChildren.length} direct children</small>
                      </span>
                    </div>
                    {selectedChildren.length ? (
                      <div className="ops-child-list">
                        {selectedChildren.slice(0, 4).map((child) => (
                          <button key={child.id} onClick={() => selectNode(child.id)} type="button">
                            <Icon name={kindMeta[child.kind].icon} size={12} />
                            <span>
                              <strong>{child.name}</strong>
                              <small>{formatMoney(child.value, child.currency, privateMode)}</small>
                            </span>
                            <Icon name="chevron-right" size={11} />
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="ops-inline-empty">
                        This is a leaf object. It does not contain another portfolio.
                      </p>
                    )}
                  </section>
                </div>

                <div className="ops-object-actions">
                  {selected.kind === 'portfolio' ? (
                    <button
                      className="ops-button ops-button--quiet"
                      onClick={() => onSelectPortfolio(selected.id)}
                      type="button"
                    >
                      <Icon name="arrow-right" size={12} />
                      Open portfolio
                    </button>
                  ) : null}
                  {selectedParent ? (
                    <button
                      className="ops-button ops-button--quiet"
                      onClick={openReparent}
                      type="button"
                    >
                      <Icon name="repeat" size={12} />
                      Propose move
                    </button>
                  ) : null}
                  <button
                    className="ops-button ops-button--quiet"
                    onClick={() =>
                      onOpenWorkbench(
                        `Split ${selected.name} from ${selectedParent?.name ?? rootNode.name} and compare both structures without changing portfolio truth.`,
                      )
                    }
                    type="button"
                  >
                    <Icon name="workbench" size={12} />
                    Test a split
                  </button>
                </div>
              </article>
            </div>
          </section>
        ) : null}

        {view === 'ownership' ? (
          <section
            aria-labelledby="ops-tab-ownership"
            className="ops-panel ops-ownership"
            id="ops-panel-ownership"
            role="tabpanel"
          >
            <div className="ops-view-heading">
              <div>
                <span className="ops-kicker">Direct and effective control</span>
                <h2>Ownership ledger</h2>
                <p>
                  Direct ownership is the legal edge on an object. Effective ownership unfolds
                  nested portfolios and trusts until it reaches people.
                </p>
              </div>
              <button
                className="ops-button ops-button--primary"
                onClick={openOwnership}
                type="button"
              >
                <Icon name="people" size={13} />
                Propose ownership change
              </button>
            </div>

            <div className="ops-ownership-workspace">
              <aside aria-label="Objects with ownership records">
                <div className="ops-ownership-list__heading">
                  <span>Portfolio objects</span>
                  <small>{structuralNodes.length} verified records</small>
                </div>
                {structuralNodes.map((node) => {
                  const total = percentTotal(directAllocations(graph, node.id));
                  return (
                    <button
                      aria-pressed={selected.id === node.id}
                      className={selected.id === node.id ? 'is-selected' : ''}
                      key={node.id}
                      onClick={() => selectNode(node.id)}
                      type="button"
                    >
                      <span className={`ops-node-icon is-${node.kind}`}>
                        <Icon name={kindMeta[node.kind].icon} size={13} />
                      </span>
                      <span>
                        <strong>{node.name}</strong>
                        <small>{kindMeta[node.kind].label}</small>
                      </span>
                      <em className={Math.abs(total - 100) > 0.005 ? 'is-invalid' : ''}>
                        {total.toFixed(0)}%
                      </em>
                    </button>
                  );
                })}
              </aside>

              <article className="ops-ownership-detail">
                <div className="ops-ownership-title">
                  <span>
                    <small>{kindMeta[selected.kind].label}</small>
                    <h3>{selected.name}</h3>
                  </span>
                  <span
                    className={
                      Math.abs(directTotal - 100) <= 0.005
                        ? 'ops-validation is-valid'
                        : 'ops-validation is-invalid'
                    }
                  >
                    <Icon
                      name={Math.abs(directTotal - 100) <= 0.005 ? 'check' : 'activity'}
                      size={12}
                    />
                    {Math.abs(directTotal - 100) <= 0.005
                      ? 'Ownership reconciles'
                      : 'Allocation mismatch'}
                  </span>
                </div>

                <div className="ops-ownership-columns">
                  <section>
                    <div className="ops-section-heading">
                      <span>
                        <strong>Direct ownership</strong>
                        <small>Recorded on {selected.name}</small>
                      </span>
                      <strong>{directTotal.toFixed(2)}%</strong>
                    </div>
                    <div className="ops-allocation-table">
                      {direct.map((allocation) => (
                        <div key={allocation.ownerId}>
                          <span className="ops-avatar">
                            {ownerName(graph, allocation.ownerId).slice(0, 1)}
                          </span>
                          <span>
                            <strong>{ownerName(graph, allocation.ownerId)}</strong>
                            <small>
                              {
                                kindMeta[nodeById(graph, allocation.ownerId)?.kind ?? 'person']
                                  .label
                              }
                            </small>
                          </span>
                          <i>
                            <span style={{ width: `${allocation.percentage}%` }} />
                          </i>
                          <em>{allocation.percentage.toFixed(2)}%</em>
                        </div>
                      ))}
                    </div>
                  </section>

                  <section>
                    <div className="ops-section-heading">
                      <span>
                        <strong>Effective ownership</strong>
                        <small>Nested entities resolved to people</small>
                      </span>
                      <strong>{effectiveTotal.toFixed(2)}%</strong>
                    </div>
                    <div className="ops-allocation-table">
                      {effective.map((allocation) => (
                        <div key={allocation.ownerId}>
                          <span className="ops-avatar is-effective">
                            {ownerName(graph, allocation.ownerId).slice(0, 1)}
                          </span>
                          <span>
                            <strong>{ownerName(graph, allocation.ownerId)}</strong>
                            <small>Ultimate beneficial owner</small>
                          </span>
                          <i>
                            <span style={{ width: `${allocation.percentage}%` }} />
                          </i>
                          <em>{allocation.percentage.toFixed(2)}%</em>
                        </div>
                      ))}
                    </div>
                  </section>
                </div>

                <div className="ops-control-path">
                  <span>
                    <Icon name="link" size={14} />
                  </span>
                  <div>
                    <small>Effective-owner calculation</small>
                    <strong>
                      {direct.map((allocation) => ownerName(graph, allocation.ownerId)).join(' + ')}
                      {' → '}
                      {effective
                        .map((allocation) => ownerName(graph, allocation.ownerId))
                        .join(' + ')}
                    </strong>
                    <p>
                      BetterTrack unfolds ownership edges only; portfolio containment never changes
                      legal ownership.
                    </p>
                  </div>
                </div>
              </article>
            </div>
          </section>
        ) : null}

        {view === 'relationships' ? (
          <section
            aria-labelledby="ops-tab-relationships"
            className="ops-panel ops-relationships"
            id="ops-panel-relationships"
            role="tabpanel"
          >
            <div className="ops-view-heading">
              <div>
                <span className="ops-kicker">Assets and obligations</span>
                <h2>Financial relationships</h2>
                <p>
                  Relationships explain net worth without pretending that a liability is another
                  investment holding.
                </p>
              </div>
              <button
                className="ops-button ops-button--quiet"
                onClick={() =>
                  onOpenWorkbench(
                    'Model Riverside property at a 10% lower valuation, then compare loan-to-value and total controlled wealth.',
                  )
                }
                type="button"
              >
                <Icon name="workbench" size={13} />
                Stress-test relationship
              </button>
            </div>

            <article className="ops-relationship-map">
              <div className="ops-relationship-object is-asset">
                <span className="ops-object-icon is-property">
                  <Icon name="house" size={18} />
                </span>
                <span>
                  <small>Gross asset</small>
                  <strong>{securedAsset?.name ?? 'Riverside property'}</strong>
                  <em>{formatMoney(gross, securedAsset?.currency ?? 'EUR', privateMode)}</em>
                </span>
                <button
                  onClick={() => {
                    if (!securedAsset) return;
                    selectNode(securedAsset.id);
                    setView('overview');
                  }}
                  type="button"
                  aria-label={`Inspect ${securedAsset?.name ?? 'property'}`}
                >
                  <Icon name="arrow-right" size={12} />
                </button>
              </div>
              <div className="ops-relationship-connector">
                <span>
                  <i />
                  Secured against
                  <i />
                </span>
                <Icon name="link" size={16} />
              </div>
              <div className="ops-relationship-object is-debt">
                <span className="ops-object-icon is-liability">
                  <Icon name="bank" size={18} />
                </span>
                <span>
                  <small>Linked liability</small>
                  <strong>{mortgage?.name ?? 'Riverside mortgage'}</strong>
                  <em>{formatMoney(-debt, mortgage?.currency ?? 'EUR', privateMode)}</em>
                </span>
                <button
                  onClick={() => {
                    if (!mortgage) return;
                    selectNode(mortgage.id);
                    setView('overview');
                  }}
                  type="button"
                  aria-label={`Inspect ${mortgage?.name ?? 'mortgage'}`}
                >
                  <Icon name="arrow-right" size={12} />
                </button>
              </div>
            </article>

            <div className="ops-net-equation" aria-label="Riverside net value calculation">
              <span>
                <small>Gross property</small>
                <strong>{formatMoney(gross, 'EUR', privateMode)}</strong>
              </span>
              <b aria-hidden="true">−</b>
              <span>
                <small>Mortgage balance</small>
                <strong>{formatMoney(debt, 'EUR', privateMode)}</strong>
              </span>
              <b aria-hidden="true">=</b>
              <span className="is-net">
                <small>Net contribution</small>
                <strong>{formatMoney(net, 'EUR', privateMode)}</strong>
              </span>
              <span className="ops-ltv">
                <small>Loan to value</small>
                <strong>{gross ? ((debt / gross) * 100).toFixed(1) : '0.0'}%</strong>
                <i>
                  <span style={{ width: `${gross ? (debt / gross) * 100 : 0}%` }} />
                </i>
              </span>
            </div>

            <div className="ops-relationship-evidence">
              <div>
                <Icon name="document" size={14} />
                <span>
                  <strong>Mortgage agreement · 2020.pdf</strong>
                  <small>Verified file · linked to both objects</small>
                </span>
              </div>
              <div>
                <Icon name="refresh" size={14} />
                <span>
                  <strong>Balance reconciled yesterday</strong>
                  <small>Source: Erste mortgage · ••1842</small>
                </span>
              </div>
              <div className="is-attention">
                <Icon name="clock" size={14} />
                <span>
                  <strong>Property valuation is 148 days old</strong>
                  <small>Freshness policy: 90 days</small>
                </span>
              </div>
            </div>
          </section>
        ) : null}

        {view === 'lifecycle' ? (
          <section
            aria-labelledby="ops-tab-lifecycle"
            className="ops-panel ops-lifecycle"
            id="ops-panel-lifecycle"
            role="tabpanel"
          >
            <div className="ops-view-heading">
              <div>
                <span className="ops-kicker">Receipts, lineage, and change control</span>
                <h2>Lifecycle & audit</h2>
                <p>
                  Every approved structural change keeps the proposal, decision, reason, and
                  affected object together.
                </p>
              </div>
              <button className="ops-button ops-button--quiet" onClick={onOpenReview} type="button">
                <Icon name="inbox" size={13} />
                Open Review
              </button>
            </div>

            <div className="ops-lifecycle-layout">
              <aside>
                <span className="ops-section-label">Lifecycle policy</span>
                <ol className="ops-lifecycle-steps">
                  <li className="is-complete">
                    <i>
                      <Icon name="check" size={11} />
                    </i>
                    <span>
                      <strong>Model</strong>
                      <small>Draft a structural mutation</small>
                    </span>
                  </li>
                  <li className="is-active">
                    <i>2</i>
                    <span>
                      <strong>Review</strong>
                      <small>Show before, after, and policy checks</small>
                    </span>
                  </li>
                  <li>
                    <i>3</i>
                    <span>
                      <strong>Apply</strong>
                      <small>Write the approved edge only once</small>
                    </span>
                  </li>
                  <li>
                    <i>4</i>
                    <span>
                      <strong>Receipt</strong>
                      <small>Preserve decision and actor</small>
                    </span>
                  </li>
                </ol>
                <div className="ops-policy-note">
                  <Icon name="shield" size={14} />
                  <span>
                    <strong>Review-gated truth</strong>
                    <small>
                      Reparenting and ownership edits never apply directly from this workspace.
                    </small>
                  </span>
                </div>
              </aside>

              <article className="ops-audit">
                <div className="ops-audit__heading">
                  <span>
                    <strong>Structure history</strong>
                    <small>{graph.audit.length} immutable events</small>
                  </span>
                  <button onClick={() => setShowAllAudit((current) => !current)} type="button">
                    {showAllAudit ? 'Show recent' : 'Show all'}
                  </button>
                </div>
                <ol>
                  {(showAllAudit ? graph.audit : graph.audit.slice(0, 5)).map((entry) => {
                    const object = nodeById(graph, entry.objectId);
                    return (
                      <li className={`is-${entry.tone}`} key={entry.id}>
                        <span className="ops-audit__rail">
                          <i />
                        </span>
                        <div>
                          <span className="ops-audit__meta">
                            <em>{formatDate(entry.at)}</em>
                            <small>{entry.actor}</small>
                          </span>
                          <strong>{entry.action}</strong>
                          <p>{entry.detail}</p>
                          <span className="ops-audit__receipt">
                            <Icon name={entry.review ? 'inbox' : 'document'} size={10} />
                            {entry.review
                              ? `Review ${entry.review.reference}`
                              : (object?.reference ?? entry.id)}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </article>
            </div>
          </section>
        ) : null}
      </main>

      {workflow === 'reparent' ? (
        <div className="ops-dialog-layer" data-accessible-dialog-layer>
          <div
            aria-labelledby={reparentTitleId}
            aria-modal="true"
            className="ops-dialog"
            ref={reparentDialogRef}
            role="dialog"
            tabIndex={-1}
          >
            <header>
              <span className="ops-dialog__icon">
                <Icon name="repeat" size={17} />
              </span>
              <span>
                <small>Review-gated structure change</small>
                <h2 id={reparentTitleId}>Propose a new parent</h2>
              </span>
              <button
                aria-label="Close reparent proposal"
                onClick={() => setWorkflow(null)}
                type="button"
              >
                <Icon name="x" size={14} />
              </button>
            </header>
            <form onSubmit={submitReparent}>
              <div className="ops-dialog__intro">
                <strong>{selected.name}</strong>
                <span>
                  Moving this object changes where its value rolls up. Holdings, activities, files,
                  and ownership stay connected.
                </span>
              </div>

              <div className="ops-before-after">
                <span>
                  <small>Current parent</small>
                  <strong>{selectedParent?.name ?? 'None'}</strong>
                  <em>{formatMoney(selected.value, selected.currency, privateMode)} included</em>
                </span>
                <Icon name="arrow-right" size={15} />
                <label>
                  <span>New parent</span>
                  <select
                    data-reparent-initial
                    onChange={(event) => setReparentTarget(event.target.value)}
                    value={reparentTarget}
                  >
                    <option value="">Choose destination</option>
                    {moveCandidates.map((node) => (
                      <option key={node.id} value={node.id}>
                        {node.name} · {kindMeta[node.kind].label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="ops-guard">
                <span className={reparentValidation.valid ? 'is-valid' : 'is-pending'}>
                  <Icon name={reparentValidation.valid ? 'check' : 'shield'} size={12} />
                </span>
                <div>
                  <strong>
                    {reparentValidation.valid
                      ? 'No cycle or double count detected'
                      : 'Structure guard is waiting'}
                  </strong>
                  <p aria-live="polite">
                    {reparentValidation.valid
                      ? `${selected.name} will have exactly one parent after approval.`
                      : reparentValidation.errors[0]}
                  </p>
                </div>
              </div>

              <label className="ops-field">
                <span>Reason for change</span>
                <textarea
                  onChange={(event) => setReparentReason(event.target.value)}
                  placeholder="Explain why this object belongs under the new parent…"
                  rows={3}
                  value={reparentReason}
                />
                <small>Saved with the proposal and approval receipt.</small>
              </label>

              <div className="ops-dialog__impact">
                <span>
                  <Icon name="check" size={11} />
                  Value remains counted once
                </span>
                <span>
                  <Icon name="check" size={11} />
                  Underlying data stays connected
                </span>
                <span>
                  <Icon name="inbox" size={11} />
                  Applies only after Review
                </span>
              </div>

              <div className="ops-dialog__footer">
                <span aria-live="polite">
                  {pendingMutationId ? 'A receipt will link this proposal to its mutation.' : ''}
                </span>
                <button
                  className="ops-button ops-button--quiet"
                  onClick={() => setWorkflow(null)}
                  type="button"
                >
                  Cancel
                </button>
                <button
                  className="ops-button ops-button--primary"
                  disabled={!reparentValidation.valid}
                  type="submit"
                >
                  <Icon name="inbox" size={12} />
                  Send to Review
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {workflow === 'ownership' ? (
        <div className="ops-dialog-layer" data-accessible-dialog-layer>
          <div
            aria-labelledby={ownershipTitleId}
            aria-modal="true"
            className="ops-dialog ops-dialog--ownership"
            ref={ownershipDialogRef}
            role="dialog"
            tabIndex={-1}
          >
            <header>
              <span className="ops-dialog__icon">
                <Icon name="people" size={17} />
              </span>
              <span>
                <small>Consequential ownership change</small>
                <h2 id={ownershipTitleId}>Propose ownership allocation</h2>
              </span>
              <button
                aria-label="Close ownership proposal"
                onClick={() => setWorkflow(null)}
                type="button"
              >
                <Icon name="x" size={14} />
              </button>
            </header>
            <form onSubmit={submitOwnership}>
              <div className="ops-dialog__intro">
                <strong>{selected.name}</strong>
                <span>
                  Set direct legal ownership. Effective ownership will be recalculated through
                  nested portfolios and trusts after approval.
                </span>
              </div>

              <div className="ops-owner-editor">
                <div className="ops-owner-editor__heading">
                  <span>Direct owner</span>
                  <span>Allocation</span>
                </div>
                {ownershipCandidateNodes.map((owner, index) => {
                  const value = ownershipDraft[owner.id] ?? 0;
                  return (
                    <label className={value > 0 ? 'is-active' : ''} key={owner.id}>
                      <span className="ops-avatar">{owner.name.slice(0, 1)}</span>
                      <span>
                        <strong>{owner.name}</strong>
                        <small>{kindMeta[owner.kind].label}</small>
                      </span>
                      <span className="ops-percent-input">
                        <input
                          data-ownership-initial={index === 0 ? '' : undefined}
                          inputMode="decimal"
                          max="100"
                          min="0"
                          onChange={(event) =>
                            setOwnershipDraft((current) => ({
                              ...current,
                              [owner.id]: Math.max(
                                0,
                                Math.min(100, Number(event.target.value) || 0),
                              ),
                            }))
                          }
                          step="0.01"
                          type="number"
                          value={value}
                        />
                        <span>%</span>
                      </span>
                    </label>
                  );
                })}
              </div>

              <div className="ops-allocation-total">
                <span>
                  <small>Allocation total</small>
                  <strong className={Math.abs(ownershipTotal - 100) <= 0.005 ? 'is-valid' : ''}>
                    {ownershipTotal.toFixed(2)}%
                  </strong>
                </span>
                <progress
                  aria-label={`Ownership allocation ${ownershipTotal.toFixed(2)} percent`}
                  max="100"
                  value={Math.min(ownershipTotal, 100)}
                />
                <p aria-live="polite">
                  {Math.abs(ownershipTotal - 100) <= 0.005
                    ? 'Allocation reconciles exactly.'
                    : ownershipTotal < 100
                      ? `${(100 - ownershipTotal).toFixed(2)}% remains unallocated.`
                      : `${(ownershipTotal - 100).toFixed(2)}% is overallocated.`}
                </p>
              </div>

              <label className="ops-field">
                <span>Reason and evidence</span>
                <textarea
                  onChange={(event) => setOwnershipReason(event.target.value)}
                  placeholder="Describe the legal or beneficial ownership change…"
                  rows={3}
                  value={ownershipReason}
                />
                <small>Link supporting documents from Review before approval.</small>
              </label>

              {!ownershipValidation.valid && ownershipReason.trim() ? (
                <div className="ops-form-error" role="alert">
                  <Icon name="activity" size={12} />
                  {ownershipValidation.errors[0]}
                </div>
              ) : null}

              <div className="ops-dialog__footer">
                <span>Current: {ownershipSummary(graph, direct) || 'Unverified'}</span>
                <button
                  className="ops-button ops-button--quiet"
                  onClick={() => setWorkflow(null)}
                  type="button"
                >
                  Cancel
                </button>
                <button
                  className="ops-button ops-button--primary"
                  disabled={!ownershipValidation.valid}
                  type="submit"
                >
                  <Icon name="inbox" size={12} />
                  Send to Review
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </section>
  );
}
