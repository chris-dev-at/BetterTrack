import {
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';

import { Icon, type IconName } from './Icons';
import { useAccessibleDialog } from './useAccessibleDialog';
import './origin-documents.css';

type DocumentType = 'Statement' | 'Contract' | 'Valuation' | 'Tax' | 'Receipt';
type DocumentSource = 'Drive' | 'Upload' | 'BetterTrack' | 'Import';
type DocumentStatus = 'current' | 'needs-review' | 'archived';
type DocumentIssue = 'missing-basis' | 'stale-valuation' | 'duplicate';
type DocumentsView = 'compact' | 'detailed' | 'grid';
type DetailTab = 'overview' | 'links' | 'access' | 'versions';
type UploadStep = 'choose' | 'scan' | 'classify' | 'link' | 'metadata' | 'review' | 'receipt';
type DriveRole = 'watched' | 'backup' | 'data-home';

type DocumentVersion = {
  id: string;
  version: number;
  date: string;
  actor: string;
  size: string;
  checksum: string;
  note: string;
};

type DocumentEvent = {
  id: string;
  at: string;
  actor: string;
  action: string;
  detail: string;
};

export type OriginDocumentRecord = {
  id: string;
  name: string;
  type: DocumentType;
  source: DocumentSource;
  status: DocumentStatus;
  issue?: DocumentIssue;
  issueDetail?: string;
  date: string;
  size: string;
  checksum: string;
  version: number;
  mime: string;
  folder: string;
  provenance: string;
  linkedAssets: string[];
  linkedActivities: string[];
  access: string[];
  tags: string[];
  annotation: string;
  versions: DocumentVersion[];
  events: DocumentEvent[];
};

type DriveConfiguration = {
  role: DriveRole;
  folder: string;
  watch: boolean;
  lastSync: string;
};

type UploadReceipt = {
  id: string;
  documentId: string;
  documentName: string;
  at: string;
  checksum: string;
  links: number;
};

type StoredDocumentsState = {
  documents: OriginDocumentRecord[];
  drive: DriveConfiguration;
  receipts: UploadReceipt[];
};

type PendingUpload = {
  name: string;
  size: string;
  mime: string;
  type: DocumentType;
  source: DocumentSource;
  folder: string;
  linkedAssets: string[];
  linkedActivities: string[];
  tags: string[];
  annotation: string;
};

type Confirmation =
  | { kind: 'archive'; documentId: string }
  | { kind: 'replace'; documentId: string; fileName: string; fileSize: string }
  | null;

export type OriginDocumentsProps = {
  portfolio: string;
  driveConnected: boolean;
  onConnections: () => void;
  onImport: () => void;
  onToast?: (message: string) => void;
};

const documentTypes: DocumentType[] = ['Statement', 'Contract', 'Valuation', 'Tax', 'Receipt'];
const documentSources: DocumentSource[] = ['Drive', 'Upload', 'BetterTrack', 'Import'];

const typeIcons: Record<DocumentType, IconName> = {
  Statement: 'list',
  Contract: 'document',
  Valuation: 'house',
  Tax: 'cash',
  Receipt: 'inbox',
};

const typeDescriptions: Record<DocumentType, string> = {
  Statement: 'Broker, bank, or custody statement',
  Contract: 'Agreement, deed, or policy',
  Valuation: 'Asset valuation or appraisal',
  Tax: 'Tax report, evidence, or filing',
  Receipt: 'Transaction or expense evidence',
};

const issueLabels: Record<DocumentIssue, string> = {
  'missing-basis': 'Missing cost basis',
  'stale-valuation': 'Valuation is stale',
  duplicate: 'Possible duplicate',
};

const issueDescriptions: Record<DocumentIssue, string> = {
  'missing-basis': 'The linked activity has no verified acquisition cost.',
  'stale-valuation': 'This valuation is older than the portfolio review policy allows.',
  duplicate: 'The checksum or statement period overlaps another document.',
};

const seededAssets = ['Vanguard FTSE All-World', 'Apple', 'Riverside property', 'Cash reserve'];
const seededActivities = [
  'Buy · VWCE · 12 Jun 2026',
  'Property valuation · 30 Jun 2026',
  'Dividend · Apple · 16 May 2026',
  'Expense · Property insurance · 02 Jul 2026',
];

function makeChecksum(seed: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  const short = (hash >>> 0).toString(16).padStart(8, '0');
  return `sha256:${short}${short}${short}${short}`;
}

function makeId(prefix: string, seed: string) {
  return `${prefix}_${makeChecksum(seed).slice(7, 15)}_${Date.now().toString(36)}`;
}

function nowLabel() {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date());
}

function storageKey(portfolio: string) {
  const safe = portfolio
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `bt-origin-documents-v1-${safe || 'portfolio'}`;
}

function seedDocuments(portfolio: string): OriginDocumentRecord[] {
  const events = (action: string, detail: string): DocumentEvent[] => [
    {
      id: makeId('event', `${portfolio}-${action}`),
      at: '18 Jul 2026 · 09:42',
      actor: 'BetterTrack',
      action,
      detail,
    },
  ];

  return [
    {
      id: 'doc_flx_q2',
      name: 'Flatex statement · Q2 2026.pdf',
      type: 'Statement',
      source: 'Drive',
      status: 'current',
      date: '01 Jul 2026',
      size: '842 KB',
      checksum: makeChecksum('flatex-q2-2026'),
      version: 2,
      mime: 'application/pdf',
      folder: '/BetterTrack/Statements/Flatex',
      provenance: 'Watched Google Drive folder · imported 01 Jul 2026',
      linkedAssets: ['Vanguard FTSE All-World', 'Apple'],
      linkedActivities: ['Buy · VWCE · 12 Jun 2026', 'Dividend · Apple · 16 May 2026'],
      access: ['You · owner', 'Elena Fischer · advisor'],
      tags: ['broker', 'quarterly', '2026'],
      annotation: 'Reconciled against the Q2 activity ledger.',
      versions: [
        {
          id: 'version_flx_2',
          version: 2,
          date: '01 Jul 2026 · 08:14',
          actor: 'Google Drive sync',
          size: '842 KB',
          checksum: makeChecksum('flatex-q2-2026'),
          note: 'Final broker-issued statement.',
        },
        {
          id: 'version_flx_1',
          version: 1,
          date: '30 Jun 2026 · 22:06',
          actor: 'You',
          size: '816 KB',
          checksum: makeChecksum('flatex-q2-draft'),
          note: 'Provisional export; superseded.',
        },
      ],
      events: events('Reconciled', 'Matched 18 of 18 statement activities.'),
    },
    {
      id: 'doc_property_value',
      name: 'Riverside property valuation 2026.pdf',
      type: 'Valuation',
      source: 'Upload',
      status: 'needs-review',
      issue: 'stale-valuation',
      issueDetail: 'Portfolio policy requires a valuation within the last 12 months.',
      date: '16 May 2025',
      size: '3.8 MB',
      checksum: makeChecksum('riverside-property-value-2025'),
      version: 1,
      mime: 'application/pdf',
      folder: '/BetterTrack/Property',
      provenance: 'Uploaded by you · device scan passed',
      linkedAssets: ['Riverside property'],
      linkedActivities: ['Property valuation · 30 Jun 2026'],
      access: ['You · owner', 'Mara Lind · can review'],
      tags: ['property', 'appraisal'],
      annotation: 'Replacement appraisal requested from the surveyor.',
      versions: [
        {
          id: 'version_property_1',
          version: 1,
          date: '16 May 2025 · 11:30',
          actor: 'You',
          size: '3.8 MB',
          checksum: makeChecksum('riverside-property-value-2025'),
          note: 'Original appraisal.',
        },
      ],
      events: events('Review opened', 'Valuation freshness policy exceeded.'),
    },
    {
      id: 'doc_purchase_note',
      name: 'VWCE purchase confirmation · Jun 12.pdf',
      type: 'Receipt',
      source: 'Import',
      status: 'needs-review',
      issue: 'missing-basis',
      issueDetail: 'The purchase activity is missing €2.40 in external fees.',
      date: '12 Jun 2026',
      size: '186 KB',
      checksum: makeChecksum('vwce-purchase-confirmation-12-jun'),
      version: 1,
      mime: 'application/pdf',
      folder: '/BetterTrack/Receipts/2026',
      provenance: 'Flatex import · Import batch IMP-1042',
      linkedAssets: ['Vanguard FTSE All-World'],
      linkedActivities: ['Buy · VWCE · 12 Jun 2026'],
      access: ['You · owner'],
      tags: ['trade', 'cost-basis'],
      annotation: '',
      versions: [
        {
          id: 'version_purchase_1',
          version: 1,
          date: '12 Jun 2026 · 18:02',
          actor: 'Flatex import',
          size: '186 KB',
          checksum: makeChecksum('vwce-purchase-confirmation-12-jun'),
          note: 'Source artifact from import.',
        },
      ],
      events: events('Linked automatically', 'Confidence 98% · matched by ISIN, units, and time.'),
    },
    {
      id: 'doc_tax_2025',
      name: 'Austrian tax report · 2025.pdf',
      type: 'Tax',
      source: 'BetterTrack',
      status: 'current',
      date: '31 Jan 2026',
      size: '1.2 MB',
      checksum: makeChecksum('austrian-tax-report-2025'),
      version: 1,
      mime: 'application/pdf',
      folder: '/BetterTrack/Tax/2025',
      provenance: 'Generated from verified portfolio activity',
      linkedAssets: ['Vanguard FTSE All-World', 'Apple'],
      linkedActivities: ['Dividend · Apple · 16 May 2026'],
      access: ['You · owner', 'Daniel Kern · tax advisor'],
      tags: ['tax', 'austria', '2025'],
      annotation: 'Final archive copy shared with tax advisor.',
      versions: [
        {
          id: 'version_tax_1',
          version: 1,
          date: '31 Jan 2026 · 10:12',
          actor: 'BetterTrack report studio',
          size: '1.2 MB',
          checksum: makeChecksum('austrian-tax-report-2025'),
          note: 'Final generated report.',
        },
      ],
      events: events('Generated', 'Based on 126 verified activities.'),
    },
    {
      id: 'doc_deed',
      name: 'Riverside purchase agreement.pdf',
      type: 'Contract',
      source: 'Drive',
      status: 'current',
      date: '08 Mar 2022',
      size: '6.4 MB',
      checksum: makeChecksum('riverside-purchase-agreement'),
      version: 1,
      mime: 'application/pdf',
      folder: '/BetterTrack/Property/Legal',
      provenance: 'Google Drive backup · original retained in Drive',
      linkedAssets: ['Riverside property'],
      linkedActivities: [],
      access: ['You · owner', 'Mara Lind · can view'],
      tags: ['property', 'contract', 'original'],
      annotation: 'Signed copy. Original paper document in home archive.',
      versions: [
        {
          id: 'version_deed_1',
          version: 1,
          date: '08 Mar 2022 · 15:20',
          actor: 'Google Drive sync',
          size: '6.4 MB',
          checksum: makeChecksum('riverside-purchase-agreement'),
          note: 'Signed original.',
        },
      ],
      events: events(
        'Access verified',
        'Only portfolio collaborators with file permission can view.',
      ),
    },
    {
      id: 'doc_duplicate',
      name: 'Flatex statement · Q2 2026 (copy).pdf',
      type: 'Statement',
      source: 'Upload',
      status: 'needs-review',
      issue: 'duplicate',
      issueDetail: 'Its statement period and 18 activities match another document.',
      date: '02 Jul 2026',
      size: '842 KB',
      checksum: makeChecksum('flatex-q2-2026'),
      version: 1,
      mime: 'application/pdf',
      folder: '/BetterTrack/Inbox',
      provenance: 'Uploaded by you · exact checksum match detected',
      linkedAssets: ['Vanguard FTSE All-World', 'Apple'],
      linkedActivities: ['Buy · VWCE · 12 Jun 2026'],
      access: ['You · owner'],
      tags: ['broker', 'duplicate'],
      annotation: '',
      versions: [
        {
          id: 'version_duplicate_1',
          version: 1,
          date: '02 Jul 2026 · 07:55',
          actor: 'You',
          size: '842 KB',
          checksum: makeChecksum('flatex-q2-2026'),
          note: 'Upload retained until duplicate review is resolved.',
        },
      ],
      events: events(
        'Duplicate flagged',
        'Exact checksum match with Flatex statement · Q2 2026.pdf.',
      ),
    },
  ];
}

function loadState(portfolio: string): StoredDocumentsState {
  const fallback: StoredDocumentsState = {
    documents: seedDocuments(portfolio),
    drive: {
      role: 'watched',
      folder: `/BetterTrack/${portfolio}`,
      watch: true,
      lastSync: '2 minutes ago',
    },
    receipts: [],
  };

  try {
    const stored = localStorage.getItem(storageKey(portfolio));
    if (!stored) return fallback;
    const parsed = JSON.parse(stored) as Partial<StoredDocumentsState>;
    return {
      documents: Array.isArray(parsed.documents) ? parsed.documents : fallback.documents,
      drive: parsed.drive ?? fallback.drive,
      receipts: Array.isArray(parsed.receipts) ? parsed.receipts : [],
    };
  } catch {
    return fallback;
  }
}

function Button({
  children,
  icon,
  tone = 'secondary',
  type = 'button',
  disabled,
  onClick,
}: {
  children: ReactNode;
  icon?: IconName;
  tone?: 'primary' | 'secondary' | 'quiet' | 'danger';
  type?: 'button' | 'submit';
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      className={`od-button od-button--${tone}`}
      disabled={disabled}
      onClick={onClick}
      type={type}
    >
      {icon ? <Icon name={icon} size={14} /> : null}
      <span>{children}</span>
    </button>
  );
}

function StatusPill({ document }: { document: OriginDocumentRecord }) {
  if (document.status === 'needs-review') {
    return (
      <span className="od-status od-status--review">
        <i />
        Review
      </span>
    );
  }
  if (document.status === 'archived') {
    return (
      <span className="od-status od-status--archived">
        <i />
        Archived
      </span>
    );
  }
  return (
    <span className="od-status od-status--current">
      <i />
      Current
    </span>
  );
}

function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: IconName;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="od-empty">
      <span>
        <Icon name={icon} size={18} />
      </span>
      <strong>{title}</strong>
      <p>{description}</p>
      {action}
    </div>
  );
}

function Modal({
  title,
  eyebrow,
  children,
  onClose,
  width = 'medium',
  stepAnnouncement,
}: {
  title: string;
  eyebrow: string;
  children: ReactNode;
  onClose: () => void;
  width?: 'small' | 'medium' | 'large';
  stepAnnouncement?: string;
}) {
  const titleId = useId();
  const stepStatusId = useId();
  const dialogRef = useAccessibleDialog<HTMLDivElement>({
    open: true,
    onClose,
  });

  return (
    <div className="od-modal-layer" data-accessible-dialog-layer role="presentation">
      <div
        aria-describedby={stepAnnouncement ? stepStatusId : undefined}
        aria-labelledby={titleId}
        aria-modal="true"
        className={`od-modal od-modal--${width}`}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="od-modal__header">
          <div>
            <span>{eyebrow}</span>
            <h2 id={titleId}>{title}</h2>
          </div>
          <button aria-label="Close" className="od-icon-button" onClick={onClose} type="button">
            <Icon name="x" size={16} />
          </button>
        </header>
        {stepAnnouncement ? (
          <span aria-live="polite" className="od-visually-hidden" id={stepStatusId} role="status">
            {stepAnnouncement}
          </span>
        ) : null}
        {children}
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="od-field">
      <span>
        <strong>{label}</strong>
        {hint ? <small>{hint}</small> : null}
      </span>
      {children}
    </label>
  );
}

export function OriginDocuments({
  portfolio,
  driveConnected,
  onConnections,
  onImport,
  onToast,
}: OriginDocumentsProps) {
  const [state, setState] = useState<StoredDocumentsState>(() => loadState(portfolio));
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | DocumentType>('all');
  const [sourceFilter, setSourceFilter] = useState<'all' | DocumentSource>('all');
  const [statusFilter, setStatusFilter] = useState<'active' | 'review' | 'archived' | 'all'>(
    'active',
  );
  const [view, setView] = useState<DocumentsView>('detailed');
  const [selectedId, setSelectedId] = useState<string | null>(
    () => loadState(portfolio).documents[0]?.id ?? null,
  );
  const [detailTab, setDetailTab] = useState<DetailTab>('overview');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadStep, setUploadStep] = useState<UploadStep>('choose');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [pendingUpload, setPendingUpload] = useState<PendingUpload | null>(null);
  const [driveOpen, setDriveOpen] = useState(false);
  const [driveDraft, setDriveDraft] = useState<DriveConfiguration>(state.drive);
  const [resolveId, setResolveId] = useState<string | null>(null);
  const [resolveAction, setResolveAction] = useState('Keep document and mark verified');
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [localNotice, setLocalNotice] = useState<string | null>(null);
  const [annotationDraft, setAnnotationDraft] = useState('');
  const [tagDraft, setTagDraft] = useState('');
  const replacementInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const next = loadState(portfolio);
    setState(next);
    setDriveDraft(next.drive);
    setSelectedId(next.documents[0]?.id ?? null);
  }, [portfolio]);

  useEffect(() => {
    localStorage.setItem(storageKey(portfolio), JSON.stringify(state));
  }, [portfolio, state]);

  useEffect(() => {
    if (!localNotice) return undefined;
    const timer = window.setTimeout(() => setLocalNotice(null), 3600);
    return () => window.clearTimeout(timer);
  }, [localNotice]);

  useEffect(() => {
    if (!uploadOpen || uploadStep !== 'scan') return undefined;
    setUploadProgress(8);
    const interval = window.setInterval(() => {
      setUploadProgress((current) => {
        const next = Math.min(current + 13, 100);
        if (next === 100) {
          window.clearInterval(interval);
          window.setTimeout(() => setUploadStep('classify'), 280);
        }
        return next;
      });
    }, 110);
    return () => window.clearInterval(interval);
  }, [uploadOpen, uploadStep]);

  const notify = (message: string) => {
    setLocalNotice(message);
    onToast?.(message);
  };

  const documents = state.documents;
  const selected = documents.find((document) => document.id === selectedId) ?? null;
  const reviewDocuments = documents.filter((document) => document.status === 'needs-review');

  useEffect(() => {
    setAnnotationDraft(selected?.annotation ?? '');
    setTagDraft('');
    setDetailTab('overview');
  }, [selected?.id]);

  const filteredDocuments = useMemo(() => {
    const term = search.trim().toLowerCase();
    return documents.filter((document) => {
      if (
        term &&
        ![
          document.name,
          document.type,
          document.source,
          document.folder,
          document.tags.join(' '),
          document.linkedAssets.join(' '),
        ]
          .join(' ')
          .toLowerCase()
          .includes(term)
      ) {
        return false;
      }
      if (typeFilter !== 'all' && document.type !== typeFilter) return false;
      if (sourceFilter !== 'all' && document.source !== sourceFilter) return false;
      if (statusFilter === 'active' && document.status === 'archived') return false;
      if (statusFilter === 'review' && document.status !== 'needs-review') return false;
      if (statusFilter === 'archived' && document.status !== 'archived') return false;
      return true;
    });
  }, [documents, search, sourceFilter, statusFilter, typeFilter]);

  const updateDocument = (
    documentId: string,
    updater: (document: OriginDocumentRecord) => OriginDocumentRecord,
  ) => {
    setState((current) => ({
      ...current,
      documents: current.documents.map((document) =>
        document.id === documentId ? updater(document) : document,
      ),
    }));
  };

  const appendEvent = (
    document: OriginDocumentRecord,
    action: string,
    detail: string,
  ): OriginDocumentRecord => ({
    ...document,
    events: [
      {
        id: makeId('event', `${document.id}-${action}-${document.events.length}`),
        at: nowLabel(),
        actor: 'You',
        action,
        detail,
      },
      ...document.events,
    ],
  });

  const beginUpload = () => {
    setPendingUpload(null);
    setUploadProgress(0);
    setUploadStep('choose');
    setUploadOpen(true);
  };

  const chooseDemoFile = () => {
    setPendingUpload({
      name: 'Interactive Brokers statement · July 2026.pdf',
      size: '934 KB',
      mime: 'application/pdf',
      type: 'Statement',
      source: 'Upload',
      folder: '/BetterTrack/Inbox',
      linkedAssets: [],
      linkedActivities: [],
      tags: ['broker', '2026'],
      annotation: '',
    });
    setUploadStep('scan');
  };

  const chooseFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const size =
      file.size > 1024 * 1024
        ? `${(file.size / (1024 * 1024)).toFixed(1)} MB`
        : `${Math.max(1, Math.round(file.size / 1024))} KB`;
    setPendingUpload({
      name: file.name,
      size,
      mime: file.type || 'application/octet-stream',
      type: file.name.toLowerCase().includes('tax') ? 'Tax' : 'Statement',
      source: 'Upload',
      folder: '/BetterTrack/Inbox',
      linkedAssets: [],
      linkedActivities: [],
      tags: [],
      annotation: '',
    });
    event.target.value = '';
    setUploadStep('scan');
  };

  const uploadSteps: Array<{ id: UploadStep; label: string }> = [
    { id: 'choose', label: 'Choose' },
    { id: 'scan', label: 'Scan' },
    { id: 'classify', label: 'Classify' },
    { id: 'link', label: 'Link' },
    { id: 'metadata', label: 'Describe' },
    { id: 'review', label: 'Review' },
  ];
  const currentUploadIndex = uploadSteps.findIndex((step) => step.id === uploadStep);

  const completeUpload = () => {
    if (!pendingUpload) return;
    const timestamp = nowLabel();
    const id = makeId('doc', pendingUpload.name);
    const checksum = makeChecksum(`${pendingUpload.name}-${pendingUpload.size}-${timestamp}`);
    const document: OriginDocumentRecord = {
      id,
      name: pendingUpload.name,
      type: pendingUpload.type,
      source: pendingUpload.source,
      status: 'current',
      date: timestamp.split(' · ')[0] ?? timestamp,
      size: pendingUpload.size,
      checksum,
      version: 1,
      mime: pendingUpload.mime,
      folder: pendingUpload.folder,
      provenance: 'Uploaded by you · local safety scan passed',
      linkedAssets: pendingUpload.linkedAssets,
      linkedActivities: pendingUpload.linkedActivities,
      access: ['You · owner'],
      tags: pendingUpload.tags,
      annotation: pendingUpload.annotation,
      versions: [
        {
          id: makeId('version', pendingUpload.name),
          version: 1,
          date: timestamp,
          actor: 'You',
          size: pendingUpload.size,
          checksum,
          note: 'Original upload.',
        },
      ],
      events: [
        {
          id: makeId('event', pendingUpload.name),
          at: timestamp,
          actor: 'You',
          action: 'Uploaded',
          detail: `Scan passed · ${pendingUpload.linkedAssets.length + pendingUpload.linkedActivities.length} portfolio links`,
        },
      ],
    };
    const receipt: UploadReceipt = {
      id: `DOC-${Date.now().toString(36).toUpperCase()}`,
      documentId: id,
      documentName: document.name,
      at: timestamp,
      checksum,
      links: document.linkedAssets.length + document.linkedActivities.length,
    };
    setState((current) => ({
      ...current,
      documents: [document, ...current.documents],
      receipts: [receipt, ...current.receipts].slice(0, 20),
    }));
    setSelectedId(id);
    setUploadStep('receipt');
    notify(`${document.name} is now part of ${portfolio}.`);
  };

  const resolveDocument = (event: FormEvent) => {
    event.preventDefault();
    if (!resolveId) return;
    updateDocument(resolveId, (document) => {
      if (document.issue === 'duplicate' && resolveAction === 'Archive duplicate') {
        return appendEvent(
          { ...document, status: 'archived', issue: undefined, issueDetail: undefined },
          'Duplicate resolved',
          'Archived after comparison with the retained original.',
        );
      }
      return appendEvent(
        { ...document, status: 'current', issue: undefined, issueDetail: undefined },
        'Review resolved',
        resolveAction,
      );
    });
    setResolveId(null);
    notify('Document review resolved. The decision was added to its audit trail.');
  };

  const executeConfirmation = () => {
    if (!confirmation) return;
    if (confirmation.kind === 'archive') {
      updateDocument(confirmation.documentId, (document) =>
        appendEvent(
          { ...document, status: 'archived' },
          'Archived',
          'Removed from the active portfolio document set. Versions were retained.',
        ),
      );
      notify('Document archived. Its versions and audit history were retained.');
    } else {
      updateDocument(confirmation.documentId, (document) => {
        const nextVersion = document.version + 1;
        const timestamp = nowLabel();
        const checksum = makeChecksum(
          `${confirmation.fileName}-${confirmation.fileSize}-${timestamp}-${nextVersion}`,
        );
        return appendEvent(
          {
            ...document,
            name: confirmation.fileName,
            size: confirmation.fileSize,
            checksum,
            version: nextVersion,
            date: timestamp.split(' · ')[0] ?? timestamp,
            status: document.status === 'archived' ? 'archived' : 'current',
            issue: undefined,
            issueDetail: undefined,
            versions: [
              {
                id: makeId('version', `${document.id}-${nextVersion}`),
                version: nextVersion,
                date: timestamp,
                actor: 'You',
                size: confirmation.fileSize,
                checksum,
                note: 'Replacement uploaded after local safety scan.',
              },
              ...document.versions,
            ],
          },
          'Version replaced',
          `Version ${nextVersion} became current. Earlier versions remain available.`,
        );
      });
      notify('Replacement verified and stored as a new version.');
    }
    setConfirmation(null);
  };

  const selectReplacement = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !selected) return;
    const size =
      file.size > 1024 * 1024
        ? `${(file.size / (1024 * 1024)).toFixed(1)} MB`
        : `${Math.max(1, Math.round(file.size / 1024))} KB`;
    setConfirmation({
      kind: 'replace',
      documentId: selected.id,
      fileName: file.name,
      fileSize: size,
    });
    event.target.value = '';
  };

  const downloadManifest = (document: OriginDocumentRecord) => {
    const content = [
      `BetterTrack document preview`,
      `Portfolio: ${portfolio}`,
      `Document: ${document.name}`,
      `Version: ${document.version}`,
      `Checksum: ${document.checksum}`,
      `Provenance: ${document.provenance}`,
      '',
      'This demo downloads a metadata manifest. No original file is stored by the demo.',
    ].join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const href = URL.createObjectURL(blob);
    const anchor = window.document.createElement('a');
    anchor.href = href;
    anchor.download = `${document.name.replace(/\.[^.]+$/, '')}-manifest.txt`;
    anchor.click();
    URL.revokeObjectURL(href);
    notify('Demo manifest downloaded. Original file content is not stored.');
  };

  const saveAnnotation = () => {
    if (!selected) return;
    updateDocument(selected.id, (document) =>
      appendEvent(
        { ...document, annotation: annotationDraft.trim() },
        'Annotation updated',
        annotationDraft.trim() || 'Annotation cleared.',
      ),
    );
    notify('Private portfolio annotation saved.');
  };

  const addTag = (event: FormEvent) => {
    event.preventDefault();
    if (!selected || !tagDraft.trim()) return;
    const nextTag = tagDraft.trim().toLowerCase();
    updateDocument(selected.id, (document) => ({
      ...document,
      tags: Array.from(new Set([...document.tags, nextTag])),
    }));
    setTagDraft('');
  };

  const removeTag = (tag: string) => {
    if (!selected) return;
    updateDocument(selected.id, (document) => ({
      ...document,
      tags: document.tags.filter((candidate) => candidate !== tag),
    }));
  };

  const restoreDocument = (documentId: string) => {
    updateDocument(documentId, (document) =>
      appendEvent(
        { ...document, status: 'current' },
        'Restored',
        'Returned to the active portfolio document set.',
      ),
    );
    notify('Document restored.');
  };

  const saveDrive = (event: FormEvent) => {
    event.preventDefault();
    setState((current) => ({ ...current, drive: { ...driveDraft, lastSync: 'Just now' } }));
    setDriveOpen(false);
    notify('Google Drive document role updated.');
  };

  return (
    <section className="origin-documents">
      {localNotice ? (
        <div aria-live="polite" className="od-toast">
          <Icon name="check" size={14} />
          <span>{localNotice}</span>
        </div>
      ) : null}

      <header className="od-page-header">
        <h1>Documents</h1>
        <div className="od-page-header__actions">
          <Button icon="download" onClick={onImport}>
            Import
          </Button>
          <Button icon="upload" onClick={beginUpload} tone="primary">
            Add document
          </Button>
        </div>
      </header>

      {reviewDocuments.length ? (
        <div className="od-review-queue">
          <div className="od-metrics">
            <div>
              <small>Needs review</small>
              <strong>{reviewDocuments.length}</strong>
            </div>
          </div>
          <button
            className="od-review-action"
            onClick={() => {
              const nextDocument = reviewDocuments[0]!;
              setStatusFilter('review');
              setSelectedId(nextDocument.id);
              setResolveId(nextDocument.id);
            }}
            type="button"
          >
            <span className="od-review-action__icon">
              <Icon name="activity" size={15} />
            </span>
            <span>
              <strong>
                {reviewDocuments[0]!.issue
                  ? issueLabels[reviewDocuments[0]!.issue!]
                  : 'Document needs review'}
              </strong>
              <small>{reviewDocuments[0]!.name}</small>
            </span>
            <span className="od-review-action__cta">
              Resolve
              <Icon name="arrow-right" size={13} />
            </span>
          </button>
        </div>
      ) : null}

      <section className="od-library">
        <header className="od-toolbar">
          <label className="od-search">
            <Icon name="search" size={14} />
            <input
              aria-label="Search documents"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search name, tag, asset, or folder…"
              type="search"
              value={search}
            />
            {search ? (
              <button aria-label="Clear search" onClick={() => setSearch('')} type="button">
                <Icon name="x" size={12} />
              </button>
            ) : null}
          </label>
          <label className="od-select">
            <span>Type</span>
            <select
              aria-label="Filter by document type"
              onChange={(event) => setTypeFilter(event.target.value as 'all' | DocumentType)}
              value={typeFilter}
            >
              <option value="all">All types</option>
              {documentTypes.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <label className="od-select">
            <span>Source</span>
            <select
              aria-label="Filter by source"
              onChange={(event) => setSourceFilter(event.target.value as 'all' | DocumentSource)}
              value={sourceFilter}
            >
              <option value="all">All sources</option>
              {documentSources.map((source) => (
                <option key={source} value={source}>
                  {source}
                </option>
              ))}
            </select>
          </label>
          <label className="od-select">
            <span>Status</span>
            <select
              aria-label="Filter by status"
              onChange={(event) =>
                setStatusFilter(event.target.value as 'active' | 'review' | 'archived' | 'all')
              }
              value={statusFilter}
            >
              <option value="active">Active</option>
              <option value="review">Needs review</option>
              <option value="archived">Archived</option>
              <option value="all">All statuses</option>
            </select>
          </label>
          <div aria-label="Document view" className="od-view-toggle" role="group">
            {(
              [
                ['compact', 'list'],
                ['detailed', 'layers'],
                ['grid', 'grid'],
              ] as Array<[DocumentsView, IconName]>
            ).map(([id, icon]) => (
              <button
                aria-label={`${id} view`}
                aria-pressed={view === id}
                className={view === id ? 'is-active' : undefined}
                key={id}
                onClick={() => setView(id)}
                type="button"
              >
                <Icon name={icon} size={13} />
              </button>
            ))}
          </div>
        </header>

        <div className="od-library__summary">
          <span>
            {filteredDocuments.length} of {documents.length} documents
          </span>
          <span>Checksums shown as shortened previews</span>
        </div>

        <div className={`od-library__body od-library__body--${view}`}>
          {filteredDocuments.length ? (
            <div className={`od-document-list od-document-list--${view}`}>
              {filteredDocuments.map((document) => (
                <button
                  className={`od-document-row ${selectedId === document.id ? 'is-selected' : ''}`}
                  key={document.id}
                  onClick={() => setSelectedId(document.id)}
                  type="button"
                >
                  <span className={`od-file-icon od-file-icon--${document.type.toLowerCase()}`}>
                    <Icon name={typeIcons[document.type]} size={16} />
                    <small>{document.name.split('.').at(-1)?.slice(0, 3).toUpperCase()}</small>
                  </span>
                  <span className="od-document-row__identity">
                    <strong>{document.name}</strong>
                    <small>
                      {document.type} · {document.source}
                    </small>
                    {view === 'grid' ? (
                      <span className="od-grid-tags">
                        {document.tags.slice(0, 2).map((tag) => (
                          <i key={tag}>{tag}</i>
                        ))}
                      </span>
                    ) : null}
                  </span>
                  {view !== 'compact' ? (
                    <>
                      <span className="od-document-row__links">
                        <strong>
                          {document.linkedAssets.length + document.linkedActivities.length}
                        </strong>
                        <small>portfolio links</small>
                      </span>
                      <span className="od-document-row__date">
                        <strong>{document.date}</strong>
                        <small>
                          v{document.version} · {document.size}
                        </small>
                      </span>
                    </>
                  ) : null}
                  <StatusPill document={document} />
                  <Icon className="od-row-chevron" name="chevron-right" size={13} />
                </button>
              ))}
            </div>
          ) : (
            <EmptyState
              action={
                <Button
                  onClick={() => {
                    setSearch('');
                    setTypeFilter('all');
                    setSourceFilter('all');
                    setStatusFilter('all');
                  }}
                  tone="quiet"
                >
                  Clear filters
                </Button>
              }
              description="Try a different name, source, type, or status."
              icon="search"
              title="No matching documents"
            />
          )}

          {selected ? (
            <aside className="od-detail">
              <header className="od-detail__header">
                <span className={`od-file-icon od-file-icon--${selected.type.toLowerCase()}`}>
                  <Icon name={typeIcons[selected.type]} size={17} />
                  <small>{selected.name.split('.').at(-1)?.slice(0, 3).toUpperCase()}</small>
                </span>
                <div>
                  <span>{selected.type}</span>
                  <h2>{selected.name}</h2>
                  <StatusPill document={selected} />
                </div>
                <button
                  aria-label="Close detail"
                  className="od-detail__close"
                  onClick={() => setSelectedId(null)}
                  type="button"
                >
                  <Icon name="x" size={14} />
                </button>
              </header>

              <nav aria-label="Document detail">
                {(
                  [
                    ['overview', 'Overview'],
                    ['links', 'Portfolio links'],
                    ['access', 'Access'],
                    ['versions', `Versions (${selected.versions.length})`],
                  ] as Array<[DetailTab, string]>
                ).map(([id, label]) => (
                  <button
                    aria-current={detailTab === id ? 'page' : undefined}
                    key={id}
                    onClick={() => setDetailTab(id)}
                    type="button"
                  >
                    {label}
                  </button>
                ))}
              </nav>

              <div className="od-detail__content">
                {selected.issue ? (
                  <section className="od-detail-issue">
                    <span>
                      <Icon name="activity" size={14} />
                    </span>
                    <div>
                      <strong>{issueLabels[selected.issue]}</strong>
                      <p>{selected.issueDetail ?? issueDescriptions[selected.issue]}</p>
                    </div>
                    <Button onClick={() => setResolveId(selected.id)} tone="quiet">
                      Resolve
                    </Button>
                  </section>
                ) : null}

                {detailTab === 'overview' ? (
                  <>
                    <dl className="od-facts">
                      <div>
                        <dt>Source</dt>
                        <dd>{selected.source}</dd>
                      </div>
                      <div>
                        <dt>Document date</dt>
                        <dd>{selected.date}</dd>
                      </div>
                      <div>
                        <dt>Location</dt>
                        <dd>{selected.folder}</dd>
                      </div>
                      <div>
                        <dt>File</dt>
                        <dd>
                          {selected.size} · {selected.mime.replace('application/', '')}
                        </dd>
                      </div>
                    </dl>
                    <section className="od-provenance">
                      <header>
                        <span>Provenance</span>
                        <strong>Verified source trail</strong>
                      </header>
                      <div>
                        <Icon name="shield" size={15} />
                        <span>
                          <strong>{selected.provenance}</strong>
                          <small title={selected.checksum}>
                            {selected.checksum.slice(0, 22)}…{selected.checksum.slice(-8)}
                          </small>
                        </span>
                      </div>
                    </section>
                    <section className="od-annotation">
                      <header>
                        <strong>Portfolio annotation</strong>
                        <small>Visible to collaborators with file access</small>
                      </header>
                      <textarea
                        onChange={(event) => setAnnotationDraft(event.target.value)}
                        placeholder="Add useful context for this evidence…"
                        rows={3}
                        value={annotationDraft}
                      />
                      <Button
                        disabled={annotationDraft === selected.annotation}
                        onClick={saveAnnotation}
                        tone="quiet"
                      >
                        Save annotation
                      </Button>
                    </section>
                    <section className="od-tags">
                      <header>
                        <strong>Tags</strong>
                        <small>Searchable within this portfolio</small>
                      </header>
                      <div>
                        {selected.tags.map((tag) => (
                          <button key={tag} onClick={() => removeTag(tag)} type="button">
                            {tag}
                            <Icon name="x" size={10} />
                          </button>
                        ))}
                        {!selected.tags.length ? <span>No tags yet</span> : null}
                      </div>
                      <form onSubmit={addTag}>
                        <input
                          aria-label="New tag"
                          onChange={(event) => setTagDraft(event.target.value)}
                          placeholder="Add tag"
                          value={tagDraft}
                        />
                        <Button disabled={!tagDraft.trim()} type="submit" tone="quiet">
                          Add
                        </Button>
                      </form>
                    </section>
                  </>
                ) : null}

                {detailTab === 'links' ? (
                  <>
                    <section className="od-link-section">
                      <header>
                        <span>
                          <Icon name="assets" size={14} />
                        </span>
                        <div>
                          <strong>Linked assets</strong>
                          <small>Evidence travels with these positions</small>
                        </div>
                      </header>
                      {selected.linkedAssets.length ? (
                        selected.linkedAssets.map((asset) => (
                          <div className="od-linked-row" key={asset}>
                            <span className="od-linked-row__avatar">{asset.slice(0, 2)}</span>
                            <span>
                              <strong>{asset}</strong>
                              <small>{portfolio}</small>
                            </span>
                            <Icon name="link" size={13} />
                          </div>
                        ))
                      ) : (
                        <p className="od-muted-copy">No asset links.</p>
                      )}
                    </section>
                    <section className="od-link-section">
                      <header>
                        <span>
                          <Icon name="activity" size={14} />
                        </span>
                        <div>
                          <strong>Linked activities</strong>
                          <small>Transactions, valuations, and cash flow</small>
                        </div>
                      </header>
                      {selected.linkedActivities.length ? (
                        selected.linkedActivities.map((activity) => (
                          <div className="od-linked-row" key={activity}>
                            <span className="od-linked-row__event">
                              <Icon name="activity" size={13} />
                            </span>
                            <span>
                              <strong>{activity}</strong>
                              <small>Verified portfolio activity</small>
                            </span>
                            <Icon name="link" size={13} />
                          </div>
                        ))
                      ) : (
                        <p className="od-muted-copy">No activity links.</p>
                      )}
                    </section>
                    <Button
                      icon="plus"
                      onClick={() => {
                        const exampleActivity =
                          seededActivities[3] ?? 'Expense · Property insurance · 02 Jul 2026';
                        updateDocument(selected.id, (document) =>
                          appendEvent(
                            {
                              ...document,
                              linkedActivities: Array.from(
                                new Set([...document.linkedActivities, exampleActivity]),
                              ),
                            },
                            'Activity linked',
                            exampleActivity,
                          ),
                        );
                        notify('Example activity linked to this document.');
                      }}
                      tone="quiet"
                    >
                      Link an activity
                    </Button>
                  </>
                ) : null}

                {detailTab === 'access' ? (
                  <>
                    <section className="od-access-summary">
                      <Icon name="lock" size={16} />
                      <div>
                        <strong>Portfolio permissions apply</strong>
                        <p>
                          A collaborator needs both portfolio access and the Files permission to
                          open this document.
                        </p>
                      </div>
                    </section>
                    <section className="od-access-list">
                      {selected.access.map((person) => {
                        const [rawName, rawRole] = person.split(' · ');
                        const name = rawName ?? person;
                        const role = rawRole ?? 'can view';
                        return (
                          <div key={person}>
                            <span>{name.slice(0, 2).toUpperCase()}</span>
                            <span>
                              <strong>{name}</strong>
                              <small>{role}</small>
                            </span>
                            {role === 'owner' ? (
                              <Icon name="shield" size={13} />
                            ) : (
                              <button
                                onClick={() => {
                                  updateDocument(selected.id, (document) => ({
                                    ...document,
                                    access: document.access.filter((entry) => entry !== person),
                                  }));
                                  notify(`${name} no longer has access to this document.`);
                                }}
                                type="button"
                              >
                                Remove
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </section>
                    <Button
                      icon="user-plus"
                      onClick={() => {
                        updateDocument(selected.id, (document) => ({
                          ...document,
                          access: Array.from(
                            new Set([...document.access, 'Jonas Weber · can view']),
                          ),
                        }));
                        notify('Jonas Weber was granted demo view access.');
                      }}
                      tone="quiet"
                    >
                      Add portfolio collaborator
                    </Button>
                  </>
                ) : null}

                {detailTab === 'versions' ? (
                  <>
                    <section className="od-versions">
                      {selected.versions.map((version, index) => (
                        <article key={version.id}>
                          <span>{version.version}</span>
                          <div>
                            <strong>
                              Version {version.version}
                              {index === 0 ? <i>Current</i> : null}
                            </strong>
                            <small>
                              {version.date} · {version.actor}
                            </small>
                            <p>{version.note}</p>
                            <code title={version.checksum}>{version.checksum.slice(0, 27)}…</code>
                          </div>
                          <small>{version.size}</small>
                        </article>
                      ))}
                    </section>
                    <Button
                      icon="repeat"
                      onClick={() => replacementInputRef.current?.click()}
                      tone="quiet"
                    >
                      Upload replacement
                    </Button>
                    <input
                      accept=".pdf,.csv,.xlsx,.png,.jpg,.jpeg,.txt"
                      className="od-visually-hidden"
                      onChange={selectReplacement}
                      ref={replacementInputRef}
                      type="file"
                    />
                  </>
                ) : null}

                <section className="od-audit">
                  <header>
                    <strong>Recent document activity</strong>
                    <small>Append-only portfolio evidence log</small>
                  </header>
                  {selected.events.slice(0, 4).map((event) => (
                    <div key={event.id}>
                      <i />
                      <span>
                        <strong>{event.action}</strong>
                        <small>
                          {event.at} · {event.actor}
                        </small>
                        <p>{event.detail}</p>
                      </span>
                    </div>
                  ))}
                </section>
              </div>

              <footer className="od-detail__footer">
                <Button icon="download" onClick={() => downloadManifest(selected)} tone="quiet">
                  Download
                </Button>
                {selected.status === 'archived' ? (
                  <Button icon="refresh" onClick={() => restoreDocument(selected.id)}>
                    Restore
                  </Button>
                ) : (
                  <Button
                    icon="trash"
                    onClick={() => setConfirmation({ kind: 'archive', documentId: selected.id })}
                    tone="danger"
                  >
                    Archive
                  </Button>
                )}
              </footer>
            </aside>
          ) : null}
        </div>
      </section>

      <section className={`od-drive-bar ${driveConnected ? 'is-connected' : 'is-disconnected'}`}>
        <span className="od-drive-bar__icon">
          <Icon name="database" size={16} />
        </span>
        <div>
          <strong>Google Drive document source</strong>
          <p>
            {driveConnected
              ? `${state.drive.folder} · ${
                  state.drive.watch ? 'Watching for changes' : 'Manual sync'
                }`
              : 'Not connected'}
          </p>
        </div>
        <span className="od-drive-bar__health">
          <i />
          {driveConnected ? `Synced ${state.drive.lastSync}` : 'Offline'}
        </span>
        <Button
          icon={driveConnected ? 'settings' : 'link'}
          onClick={() => {
            if (!driveConnected) onConnections();
            else {
              setDriveDraft(state.drive);
              setDriveOpen(true);
            }
          }}
          tone="quiet"
        >
          {driveConnected ? 'Manage source' : 'Connect'}
        </Button>
      </section>

      {uploadOpen ? (
        <Modal
          eyebrow="Add to portfolio"
          onClose={() => setUploadOpen(false)}
          stepAnnouncement={
            uploadStep === 'receipt'
              ? 'Upload complete. Persistent document receipt ready.'
              : `Step ${Math.max(1, currentUploadIndex + 1)} of ${uploadSteps.length}: ${
                  uploadSteps[Math.max(0, currentUploadIndex)]?.label ?? 'Choose'
                }`
          }
          title={uploadStep === 'receipt' ? 'Document added' : 'Add document'}
          width="large"
        >
          {uploadStep !== 'receipt' ? (
            <div aria-label="Upload steps" className="od-upload-steps" role="list">
              {uploadSteps.map((step, index) => (
                <span
                  aria-current={index === currentUploadIndex ? 'step' : undefined}
                  className={
                    index === currentUploadIndex
                      ? 'is-current'
                      : index < currentUploadIndex
                        ? 'is-complete'
                        : ''
                  }
                  key={step.id}
                  role="listitem"
                >
                  <i>{index < currentUploadIndex ? <Icon name="check" size={10} /> : index + 1}</i>
                  <small>{step.label}</small>
                </span>
              ))}
            </div>
          ) : null}

          <div className="od-modal__body">
            {uploadStep === 'choose' ? (
              <div className="od-upload-choose">
                <label>
                  <span>
                    <Icon name="upload" size={21} />
                  </span>
                  <strong>Choose a file from this device</strong>
                  <p>PDF, CSV, XLSX, PNG, JPG, or TXT · up to 25 MB in the final app</p>
                  <input
                    accept=".pdf,.csv,.xlsx,.png,.jpg,.jpeg,.txt"
                    onChange={chooseFiles}
                    type="file"
                  />
                </label>
                <div>
                  <span>or use another source</span>
                  <button onClick={chooseDemoFile} type="button">
                    <Icon name="document" size={15} />
                    <span>
                      <strong>Use a demo statement</strong>
                      <small>Walk through the complete lifecycle</small>
                    </span>
                    <Icon name="arrow-right" size={13} />
                  </button>
                  <button
                    onClick={() => {
                      setUploadOpen(false);
                      onConnections();
                    }}
                    type="button"
                  >
                    <Icon name="database" size={15} />
                    <span>
                      <strong>Add from a connection</strong>
                      <small>Drive, broker, bank, or integration</small>
                    </span>
                    <Icon name="arrow-right" size={13} />
                  </button>
                  <button
                    onClick={() => {
                      setUploadOpen(false);
                      onImport();
                    }}
                    type="button"
                  >
                    <Icon name="download" size={15} />
                    <span>
                      <strong>Open Import Hub</strong>
                      <small>Reconcile a portfolio data export</small>
                    </span>
                    <Icon name="arrow-right" size={13} />
                  </button>
                </div>
              </div>
            ) : null}

            {uploadStep === 'scan' && pendingUpload ? (
              <div className="od-upload-scan">
                <span className="od-file-icon od-file-icon--statement">
                  <Icon name="document" size={19} />
                  <small>{pendingUpload.name.split('.').at(-1)?.toUpperCase()}</small>
                </span>
                <div>
                  <strong>{pendingUpload.name}</strong>
                  <small>{pendingUpload.size} · processed locally for this demo</small>
                </div>
                <div className="od-scan-progress">
                  <span
                    aria-label="Document safety scan"
                    aria-valuemax={100}
                    aria-valuemin={0}
                    aria-valuenow={uploadProgress}
                    aria-valuetext={
                      uploadProgress < 100
                        ? `Safety scan ${uploadProgress} percent`
                        : 'Safety scan passed'
                    }
                    role="progressbar"
                  >
                    <i style={{ width: `${uploadProgress}%` }} />
                  </span>
                  <small>
                    {uploadProgress < 100 ? `Safety scan · ${uploadProgress}%` : 'Scan passed'}
                  </small>
                </div>
                <ul>
                  <li className={uploadProgress > 20 ? 'is-complete' : ''}>
                    <Icon name="check" size={12} /> File signature
                  </li>
                  <li className={uploadProgress > 55 ? 'is-complete' : ''}>
                    <Icon name="check" size={12} /> Duplicate check
                  </li>
                  <li className={uploadProgress > 88 ? 'is-complete' : ''}>
                    <Icon name="check" size={12} /> Metadata extraction
                  </li>
                </ul>
              </div>
            ) : null}

            {uploadStep === 'classify' && pendingUpload ? (
              <div className="od-upload-form">
                <div className="od-upload-form__intro">
                  <span>Classification</span>
                  <h3>What kind of evidence is this?</h3>
                  <p>This controls review rules and where the document appears in reports.</p>
                </div>
                <div className="od-type-grid">
                  {documentTypes.map((type) => (
                    <button
                      aria-pressed={pendingUpload.type === type}
                      className={pendingUpload.type === type ? 'is-selected' : undefined}
                      key={type}
                      onClick={() =>
                        setPendingUpload((current) => (current ? { ...current, type } : current))
                      }
                      type="button"
                    >
                      <span>
                        <Icon name={typeIcons[type]} size={16} />
                      </span>
                      <strong>{type}</strong>
                      <small>{typeDescriptions[type]}</small>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {uploadStep === 'link' && pendingUpload ? (
              <div className="od-upload-form">
                <div className="od-upload-form__intro">
                  <span>Portfolio context</span>
                  <h3>Connect it to the underlying data</h3>
                  <p>Links make evidence available wherever this portfolio data is used.</p>
                </div>
                <div className="od-link-picker">
                  <section>
                    <header>
                      <Icon name="assets" size={14} />
                      <strong>Assets</strong>
                    </header>
                    {seededAssets.map((asset) => (
                      <label key={asset}>
                        <input
                          checked={pendingUpload.linkedAssets.includes(asset)}
                          onChange={() =>
                            setPendingUpload((current) =>
                              current
                                ? {
                                    ...current,
                                    linkedAssets: current.linkedAssets.includes(asset)
                                      ? current.linkedAssets.filter((item) => item !== asset)
                                      : [...current.linkedAssets, asset],
                                  }
                                : current,
                            )
                          }
                          type="checkbox"
                        />
                        <span>
                          <strong>{asset}</strong>
                          <small>{portfolio}</small>
                        </span>
                      </label>
                    ))}
                  </section>
                  <section>
                    <header>
                      <Icon name="activity" size={14} />
                      <strong>Activities</strong>
                    </header>
                    {seededActivities.map((activity) => (
                      <label key={activity}>
                        <input
                          checked={pendingUpload.linkedActivities.includes(activity)}
                          onChange={() =>
                            setPendingUpload((current) =>
                              current
                                ? {
                                    ...current,
                                    linkedActivities: current.linkedActivities.includes(activity)
                                      ? current.linkedActivities.filter((item) => item !== activity)
                                      : [...current.linkedActivities, activity],
                                  }
                                : current,
                            )
                          }
                          type="checkbox"
                        />
                        <span>
                          <strong>{activity}</strong>
                          <small>Verified activity</small>
                        </span>
                      </label>
                    ))}
                  </section>
                </div>
              </div>
            ) : null}

            {uploadStep === 'metadata' && pendingUpload ? (
              <div className="od-upload-form">
                <div className="od-upload-form__intro">
                  <span>Description</span>
                  <h3>Make it easy to find later</h3>
                  <p>The original file stays unchanged. This metadata belongs to BetterTrack.</p>
                </div>
                <Field label="Display name">
                  <input
                    onChange={(event) =>
                      setPendingUpload((current) =>
                        current ? { ...current, name: event.target.value } : current,
                      )
                    }
                    value={pendingUpload.name}
                  />
                </Field>
                <Field
                  label="Portfolio folder"
                  hint="A logical location; it does not move the source file."
                >
                  <input
                    onChange={(event) =>
                      setPendingUpload((current) =>
                        current ? { ...current, folder: event.target.value } : current,
                      )
                    }
                    value={pendingUpload.folder}
                  />
                </Field>
                <Field label="Tags" hint="Comma-separated">
                  <input
                    onChange={(event) =>
                      setPendingUpload((current) =>
                        current
                          ? {
                              ...current,
                              tags: event.target.value
                                .split(',')
                                .map((tag) => tag.trim())
                                .filter(Boolean),
                            }
                          : current,
                      )
                    }
                    placeholder="broker, statement, 2026"
                    value={pendingUpload.tags.join(', ')}
                  />
                </Field>
                <Field
                  label="Annotation"
                  hint="Optional context for collaborators with file access."
                >
                  <textarea
                    onChange={(event) =>
                      setPendingUpload((current) =>
                        current ? { ...current, annotation: event.target.value } : current,
                      )
                    }
                    placeholder="Why this document matters…"
                    rows={3}
                    value={pendingUpload.annotation}
                  />
                </Field>
              </div>
            ) : null}

            {uploadStep === 'review' && pendingUpload ? (
              <div className="od-upload-review">
                <div className="od-upload-review__identity">
                  <span
                    className={`od-file-icon od-file-icon--${pendingUpload.type.toLowerCase()}`}
                  >
                    <Icon name={typeIcons[pendingUpload.type]} size={18} />
                    <small>{pendingUpload.name.split('.').at(-1)?.slice(0, 3).toUpperCase()}</small>
                  </span>
                  <div>
                    <strong>{pendingUpload.name}</strong>
                    <small>
                      {pendingUpload.type} · {pendingUpload.size}
                    </small>
                  </div>
                  <span className="od-status od-status--current">
                    <i />
                    Scan passed
                  </span>
                </div>
                <dl>
                  <div>
                    <dt>Portfolio</dt>
                    <dd>{portfolio}</dd>
                  </div>
                  <div>
                    <dt>Folder</dt>
                    <dd>{pendingUpload.folder}</dd>
                  </div>
                  <div>
                    <dt>Asset links</dt>
                    <dd>{pendingUpload.linkedAssets.length || 'None'}</dd>
                  </div>
                  <div>
                    <dt>Activity links</dt>
                    <dd>{pendingUpload.linkedActivities.length || 'None'}</dd>
                  </div>
                  <div>
                    <dt>Access</dt>
                    <dd>Portfolio owner only</dd>
                  </div>
                  <div>
                    <dt>Retention</dt>
                    <dd>Until manually archived</dd>
                  </div>
                </dl>
                <div className="od-upload-review__notice">
                  <Icon name="shield" size={15} />
                  <p>
                    The demo stores metadata and state in this browser only. It never stores or
                    transmits the selected file contents.
                  </p>
                </div>
              </div>
            ) : null}

            {uploadStep === 'receipt' && pendingUpload ? (
              <div className="od-upload-receipt">
                <span>
                  <Icon name="check" size={24} />
                </span>
                <div>
                  <small>Persistent demo receipt</small>
                  <h3>{pendingUpload.name}</h3>
                  <p>
                    The document is now connected to {portfolio}. Search, links, access, versions,
                    and its audit trail will persist after a reload.
                  </p>
                </div>
                <dl>
                  <div>
                    <dt>Receipt</dt>
                    <dd>{state.receipts[0]?.id}</dd>
                  </div>
                  <div>
                    <dt>Source</dt>
                    <dd>Device upload</dd>
                  </div>
                  <div>
                    <dt>Portfolio links</dt>
                    <dd>{state.receipts[0]?.links}</dd>
                  </div>
                  <div>
                    <dt>Recorded</dt>
                    <dd>{state.receipts[0]?.at}</dd>
                  </div>
                  <div className="od-upload-receipt__checksum">
                    <dt>Checksum</dt>
                    <dd>{state.receipts[0]?.checksum}</dd>
                  </div>
                </dl>
              </div>
            ) : null}
          </div>

          {uploadStep !== 'choose' && uploadStep !== 'scan' ? (
            <footer className="od-modal__footer">
              {uploadStep === 'receipt' ? (
                <>
                  <Button
                    onClick={() => {
                      setUploadOpen(false);
                      setUploadStep('choose');
                    }}
                    tone="primary"
                  >
                    View document
                  </Button>
                  <Button
                    onClick={() => {
                      setUploadStep('choose');
                      setPendingUpload(null);
                    }}
                    tone="quiet"
                  >
                    Add another
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    onClick={() => {
                      if (uploadStep === 'classify') {
                        setUploadStep('choose');
                        setPendingUpload(null);
                        return;
                      }
                      const previous = uploadSteps[Math.max(0, currentUploadIndex - 1)];
                      if (previous) setUploadStep(previous.id);
                    }}
                    tone="quiet"
                  >
                    Back
                  </Button>
                  <Button
                    disabled={uploadStep === 'metadata' && !pendingUpload?.name.trim()}
                    onClick={() => {
                      if (uploadStep === 'review') {
                        completeUpload();
                        return;
                      }
                      const next = uploadSteps[currentUploadIndex + 1];
                      if (next) setUploadStep(next.id);
                    }}
                    tone="primary"
                  >
                    {uploadStep === 'review' ? 'Add to portfolio' : 'Continue'}
                  </Button>
                </>
              )}
            </footer>
          ) : null}
        </Modal>
      ) : null}

      {driveOpen ? (
        <Modal eyebrow="Google Drive" onClose={() => setDriveOpen(false)} title="Document source">
          <form onSubmit={saveDrive}>
            <div className="od-modal__body od-drive-form">
              <div className="od-drive-form__status">
                <span>
                  <Icon name="database" size={16} />
                </span>
                <div>
                  <strong>Connected as alex@example.com</strong>
                  <small>Last sync {state.drive.lastSync} · permission healthy</small>
                </div>
                <span className="od-status od-status--current">
                  <i />
                  Healthy
                </span>
              </div>
              <Field label="Drive role" hint="One role can be active for this portfolio.">
                <select
                  onChange={(event) =>
                    setDriveDraft((current) => ({
                      ...current,
                      role: event.target.value as DriveRole,
                    }))
                  }
                  value={driveDraft.role}
                >
                  <option value="watched">Watched source folder</option>
                  <option value="backup">Backup destination</option>
                  <option value="data-home">Portfolio data home</option>
                </select>
              </Field>
              <div className="od-role-explainer">
                <Icon
                  name={
                    driveDraft.role === 'backup'
                      ? 'refresh'
                      : driveDraft.role === 'data-home'
                        ? 'database'
                        : 'eye'
                  }
                  size={15}
                />
                <p>
                  {driveDraft.role === 'watched'
                    ? 'BetterTrack watches this folder for new and changed documents. Originals stay in Drive.'
                    : driveDraft.role === 'backup'
                      ? 'BetterTrack writes a secondary copy after a document is verified. Drive is not read for changes.'
                      : 'Drive owns portfolio files and portable data. BetterTrack reads and writes the selected folder.'}
                </p>
              </div>
              <Field label="Portfolio folder">
                <input
                  onChange={(event) =>
                    setDriveDraft((current) => ({ ...current, folder: event.target.value }))
                  }
                  value={driveDraft.folder}
                />
              </Field>
              <label className="od-switch-row">
                <span>
                  <strong>Watch for changes</strong>
                  <small>Surface new versions and duplicates in the review queue.</small>
                </span>
                <input
                  checked={driveDraft.watch}
                  onChange={(event) =>
                    setDriveDraft((current) => ({ ...current, watch: event.target.checked }))
                  }
                  type="checkbox"
                />
              </label>
            </div>
            <footer className="od-modal__footer">
              <Button onClick={() => setDriveOpen(false)} tone="quiet">
                Cancel
              </Button>
              <Button type="submit" tone="primary">
                Save role
              </Button>
            </footer>
          </form>
        </Modal>
      ) : null}

      {resolveId ? (
        <Modal
          eyebrow="Data quality"
          onClose={() => setResolveId(null)}
          title={`Resolve ${
            documents.find((document) => document.id === resolveId)?.issue
              ? issueLabels[documents.find((document) => document.id === resolveId)!.issue!]
              : 'document review'
          }`}
        >
          <form onSubmit={resolveDocument}>
            <div className="od-modal__body od-resolve">
              <div className="od-resolve__context">
                <Icon name="activity" size={16} />
                <div>
                  <strong>{documents.find((document) => document.id === resolveId)?.name}</strong>
                  <p>
                    {documents.find((document) => document.id === resolveId)?.issueDetail ??
                      'Review the evidence and record a decision.'}
                  </p>
                </div>
              </div>
              <Field label="Resolution">
                <select
                  onChange={(event) => setResolveAction(event.target.value)}
                  value={resolveAction}
                >
                  <option>Keep document and mark verified</option>
                  <option>Add missing basis from this evidence</option>
                  <option>Keep current valuation with an exception</option>
                  <option>Archive duplicate</option>
                  <option>Request collaborator review</option>
                </select>
              </Field>
              <div className="od-resolution-impact">
                <span>What happens next</span>
                <ul>
                  <li>
                    <Icon name="check" size={12} />
                    The review flag is cleared from this portfolio.
                  </li>
                  <li>
                    <Icon name="check" size={12} />
                    The decision is written to the document audit trail.
                  </li>
                  <li>
                    <Icon name="check" size={12} />
                    Original evidence and versions stay unchanged.
                  </li>
                </ul>
              </div>
            </div>
            <footer className="od-modal__footer">
              <Button onClick={() => setResolveId(null)} tone="quiet">
                Cancel
              </Button>
              <Button type="submit" tone="primary">
                Confirm resolution
              </Button>
            </footer>
          </form>
        </Modal>
      ) : null}

      {confirmation ? (
        <Modal
          eyebrow={confirmation.kind === 'archive' ? 'Retain history' : 'Version control'}
          onClose={() => setConfirmation(null)}
          title={
            confirmation.kind === 'archive' ? 'Archive this document?' : 'Replace current version?'
          }
          width="small"
        >
          <div className="od-modal__body od-confirm">
            <span>
              <Icon name={confirmation.kind === 'archive' ? 'trash' : 'repeat'} size={18} />
            </span>
            <p>
              {confirmation.kind === 'archive'
                ? 'The document leaves active views, but its versions, links, checksum, and audit history remain recoverable.'
                : `${confirmation.fileName} becomes the current version after a simulated safety scan. The existing version stays in history.`}
            </p>
          </div>
          <footer className="od-modal__footer">
            <Button onClick={() => setConfirmation(null)} tone="quiet">
              Cancel
            </Button>
            <Button
              onClick={executeConfirmation}
              tone={confirmation.kind === 'archive' ? 'danger' : 'primary'}
            >
              {confirmation.kind === 'archive' ? 'Archive document' : 'Replace version'}
            </Button>
          </footer>
        </Modal>
      ) : null}
    </section>
  );
}
