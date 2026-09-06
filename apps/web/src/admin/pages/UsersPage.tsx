import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import {
  ADMIN_USER_PAGE_SIZE_DEFAULT,
  ADMIN_USER_SORTS,
  ADMIN_USER_SORT_DIRECTIONS,
  type AdminStats,
  type AdminUser,
  type AdminUserSort,
  type AdminUserSortDirection,
  type CreateUserResponse,
} from '@bettertrack/contracts';

import { useT, type TranslateFn } from '../../i18n';
import * as api from '../../lib/adminApi';
import { formatDateTime } from '../../lib/format';
import { useResource } from '../useResource';
import { pageRange, useOffsetSnapBack } from '../components/ListPagination';
import { Modal } from '../components/Modal';
import { WorkspaceTabs } from '../components/WorkspaceTabs';
import {
  Alert,
  AsyncReadState,
  Badge,
  Button,
  CopyField,
  DataTable,
  EmptyState,
  PageHeader,
  Panel,
  SelectField,
  SortableTh,
  StatTile,
  Td,
  TextField,
  Th,
  cx,
} from '../components/ui';
import {
  EDGE,
  EDGE_TOP,
  SURFACE_HEADER,
  TEXT_MICRO,
  TEXT_MUTED,
  TEXT_NUM,
} from '../components/tokens';

type Dialog =
  | { type: 'create' }
  | { type: 'created'; result: CreateUserResponse }
  | { type: 'bulkDisable'; userIds: string[] };

function errorMessage(err: unknown, t: TranslateFn): string {
  void err;
  return t('common.genericError');
}

const PAGE_SIZES = [25, 50, 100] as const;

/** A filter's "no filter" sentinel. The empty string is what a `<select>` gives us. */
const ANY = '';

function isSort(value: string | null): value is AdminUserSort {
  return value !== null && (ADMIN_USER_SORTS as readonly string[]).includes(value);
}

function isDirection(value: string | null): value is AdminUserSortDirection {
  return value !== null && (ADMIN_USER_SORT_DIRECTIONS as readonly string[]).includes(value);
}

/**
 * People → Users (#1406 W2).
 *
 * The list the operator actually works from: server-side search, filters on kind
 * / state / privacy mode, four sortable columns, a bounded page, and the one
 * bulk action that exists. Everything that shapes the query lives in the URL, so
 * a filtered view is bookmarkable, survives a reload and moves with the back
 * button — an operator who found the three disabled accounts should be able to
 * send that link to themselves tomorrow.
 *
 * `disabled` remains THE suspension (#1406): it already kills sessions, bearer
 * credentials and realtime principals. No suspended/limited/locked proliferation
 * is offered here, because none exists on the server.
 */
export function UsersPage() {
  const t = useT();
  const [params, setParams] = useSearchParams();

  // ── Query state, read from the URL ─────────────────────────────────────────
  const search = params.get('q') ?? '';
  const role = params.get('role') ?? ANY;
  const status = params.get('status') ?? ANY;
  const privacyMode = params.get('privacy') ?? ANY;
  const sortParam = params.get('sort');
  const sort: AdminUserSort = isSort(sortParam) ? sortParam : 'createdAt';
  const directionParam = params.get('dir');
  const direction: AdminUserSortDirection = isDirection(directionParam) ? directionParam : 'desc';
  const limit = Number.parseInt(params.get('limit') ?? '', 10) || ADMIN_USER_PAGE_SIZE_DEFAULT;
  const offset = Math.max(0, Number.parseInt(params.get('offset') ?? '', 10) || 0);

  const [searchInput, setSearchInput] = useState(search);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [banner, setBanner] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  /**
   * Write one or more query keys. Any change to a FILTER resets the offset:
   * staying on page 3 of a result set that just shrank to one page shows an
   * empty table and reads as "no results", which is a lie.
   */
  const patchQuery = useCallback(
    (patch: Record<string, string | number | null>, keepOffset = false) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          for (const [key, value] of Object.entries(patch)) {
            if (value === null || value === '') next.delete(key);
            else next.set(key, String(value));
          }
          if (!keepOffset) next.delete('offset');
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  // Debounce the search box so each keystroke doesn't hit the API. The URL is
  // the source of truth; the input is a local draft of it.
  useEffect(() => {
    if (searchInput === search) return;
    const id = setTimeout(() => patchQuery({ q: searchInput.trim() }), 300);
    return () => clearTimeout(id);
  }, [searchInput, search, patchQuery]);

  // A back/forward navigation changes the URL under us; re-seed the draft.
  useEffect(() => setSearchInput(search), [search]);

  const stats = useResource((signal) => api.getStats(signal), []);
  const users = useResource(
    (signal) =>
      api.listUsers(
        {
          ...(search ? { search } : {}),
          ...(role ? { role: role as 'user' | 'admin' } : {}),
          ...(status ? { status: status as 'active' | 'disabled' } : {}),
          ...(privacyMode ? { privacyMode: privacyMode as 'normal' | 'paranoid' } : {}),
          sort,
          direction,
          limit,
          offset,
        },
        signal,
      ),
    [search, role, status, privacyMode, sort, direction, limit, offset],
  );

  const rows = useMemo(() => users.data?.users ?? [], [users.data]);
  const page = users.data?.page ?? null;

  const setOffset = useCallback((next: number) => patchQuery({ offset: next }, true), [patchQuery]);
  // A page that just emptied under a bulk action is not "no results" (#1848).
  useOffsetSnapBack(page, rows.length, setOffset);

  // Keep the selection in sync with what's actually on screen: a bulk action
  // must never reach a row the operator can no longer see.
  useEffect(() => {
    setSelected((prev) => {
      const ids = new Set(rows.map((u) => u.id));
      const next = new Set<string>();
      for (const id of prev) if (ids.has(id)) next.add(id);
      return next.size === prev.size ? prev : next;
    });
  }, [rows]);

  const allSelected = rows.length > 0 && rows.every((u) => selected.has(u.id));
  const filtersActive = Boolean(search || role || status || privacyMode);

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(rows.map((u) => u.id)));
  }

  function onSort(column: AdminUserSort) {
    // Clicking the active column flips it; a new column starts descending,
    // which is "most recent / highest first" for every column we offer.
    patchQuery({ sort: column, dir: sort === column && direction === 'desc' ? 'asc' : 'desc' });
  }

  async function bulkDisable(userIds: string[]) {
    if (userIds.length === 0 || bulkBusy) return;
    setBanner(null);
    setBulkBusy(true);
    try {
      const result = await api.bulkUserAction({ action: 'disable', userIds });
      users.reload();
      stats.reload();
      setSelected(new Set());
      setDialog(null);
      const disabled = t(
        result.disabled === 1
          ? 'admin.users.bulkResult.disabledOne'
          : 'admin.users.bulkResult.disabledOther',
        { count: result.disabled },
      );
      setBanner({
        tone: 'success',
        text: `${disabled}${
          result.skipped > 0
            ? `; ${t('admin.users.bulkResult.skipped', { count: result.skipped })}.`
            : '.'
        }`,
      });
    } catch (err) {
      setBanner({ tone: 'error', text: errorMessage(err, t) });
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow={t('admin.nav.sections.people')}
        title={t('admin.users.title')}
        description={t('admin.users.subtitle')}
        actions={
          <Button onClick={() => setDialog({ type: 'create' })}>{t('admin.users.create')}</Button>
        }
      />

      <WorkspaceTabs counts={tabCounts(stats.data)} />

      {stats.loading || stats.error ? (
        <AsyncReadState
          error={stats.error}
          loading={stats.loading}
          loadingLabel={t('admin.users.loading')}
          onRetry={stats.reload}
          retryable={stats.retryable}
        />
      ) : (
        <StatsStrip data={stats.data} />
      )}

      <Filters
        search={searchInput}
        onSearch={setSearchInput}
        role={role}
        status={status}
        privacyMode={privacyMode}
        limit={limit}
        onChange={patchQuery}
        filtersActive={filtersActive}
      />

      {banner ? <Alert tone={banner.tone}>{banner.text}</Alert> : null}

      {selected.size > 0 ? (
        <div
          className={cx(
            'flex flex-wrap items-center justify-between gap-3 px-4 py-2.5',
            EDGE,
            SURFACE_HEADER,
          )}
        >
          <span className="text-[13px] text-neutral-300">
            {t(selected.size === 1 ? 'admin.users.selectedOne' : 'admin.users.selectedOther', {
              count: selected.size,
            })}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => setSelected(new Set())}>
              {t('admin.users.clear')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={bulkBusy || dialog?.type === 'bulkDisable'}
              onClick={() => {
                setBanner(null);
                setDialog({ type: 'bulkDisable', userIds: [...selected] });
              }}
            >
              {bulkBusy ? t('admin.actions.disabling') : t('admin.actions.disableSelected')}
            </Button>
          </div>
        </div>
      ) : null}

      {users.loading || users.error ? (
        <AsyncReadState
          error={users.error}
          loading={users.loading}
          loadingLabel={t('admin.users.loading')}
          onRetry={users.reload}
          retryable={users.retryable}
        />
      ) : (
        // The pager sits OUTSIDE the empty branch (#1848): bulk-disable the last
        // row of page 2 and the empty state used to render with no way back —
        // the only escape was hand-editing `?offset=` in the URL.
        <div className="flex flex-col gap-2">
          {rows.length === 0 ? (
            <EmptyState>
              {filtersActive ? t('admin.users.emptySearch') : t('admin.users.empty')}
            </EmptyState>
          ) : (
            <DataTable minWidth="56rem">
              <thead className={cx(SURFACE_HEADER, 'border-b border-neutral-800')}>
                <tr>
                  <Th className="w-8">
                    <input
                      type="checkbox"
                      aria-label={t('admin.users.selectAll')}
                      className="accent-sky-500"
                      checked={allSelected}
                      onChange={toggleAll}
                    />
                  </Th>
                  <SortableTh
                    active={sort === 'username'}
                    direction={direction}
                    onSort={() => onSort('username')}
                  >
                    {t('admin.users.columns.user')}
                  </SortableTh>
                  <Th>{t('admin.users.columns.role')}</Th>
                  <Th>{t('admin.users.columns.status')}</Th>
                  <Th>{t('admin.users.columns.privacy')}</Th>
                  <SortableTh
                    active={sort === 'lastLoginAt'}
                    direction={direction}
                    onSort={() => onSort('lastLoginAt')}
                  >
                    {t('admin.users.columns.lastLogin')}
                  </SortableTh>
                  <SortableTh
                    active={sort === 'createdAt'}
                    direction={direction}
                    onSort={() => onSort('createdAt')}
                  >
                    {t('admin.users.columns.created')}
                  </SortableTh>
                  <Th className="w-16" />
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-800">
                {rows.map((u) => (
                  <UserRow
                    key={u.id}
                    user={u}
                    selected={selected.has(u.id)}
                    onToggle={() => toggleOne(u.id)}
                  />
                ))}
              </tbody>
            </DataTable>
          )}

          <Pagination page={page} rowCount={rows.length} onOffset={setOffset} />
        </div>
      )}

      {dialog?.type === 'create' && (
        <CreateUserDialog
          onClose={() => setDialog(null)}
          onCreated={(result) => {
            users.reload();
            stats.reload();
            setDialog({ type: 'created', result });
          }}
        />
      )}

      {dialog?.type === 'created' && (
        <CreatedUserDialog result={dialog.result} onClose={() => setDialog(null)} />
      )}

      {dialog?.type === 'bulkDisable' && (
        <Modal
          title={t('admin.confirmations.bulkDisable.title')}
          onClose={() => setDialog(null)}
          dismissable={!bulkBusy}
        >
          <div className="flex flex-col gap-4">
            <p className="text-[13px] text-neutral-400">
              {t(
                dialog.userIds.length === 1
                  ? 'admin.confirmations.bulkDisable.descriptionOne'
                  : 'admin.confirmations.bulkDisable.descriptionOther',
                { count: dialog.userIds.length },
              )}
            </p>
            {banner?.tone === 'error' ? <Alert tone="error">{banner.text}</Alert> : null}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" disabled={bulkBusy} onClick={() => setDialog(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={bulkBusy}
                onClick={() => void bulkDisable(dialog.userIds)}
              >
                {bulkBusy
                  ? t('admin.confirmations.bulkDisable.pending')
                  : t(
                      dialog.userIds.length === 1
                        ? 'admin.confirmations.bulkDisable.confirmOne'
                        : 'admin.confirmations.bulkDisable.confirmOther',
                      { count: dialog.userIds.length },
                    )}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Counts for the workspace strip, from the one stats read this page already makes. */
function tabCounts(stats: AdminStats | null): Record<string, number> | undefined {
  if (!stats) return undefined;
  return {
    '/admin/users': stats.userCount,
    '/admin/registration': stats.pendingRegistrationCount,
    '/admin/invites': stats.pendingInviteCount,
  };
}

function UserRow({
  user,
  selected,
  onToggle,
}: {
  user: AdminUser;
  selected: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  return (
    <tr className={cx('transition-colors', selected ? 'bg-sky-950/30' : 'hover:bg-neutral-900/60')}>
      <Td>
        <input
          type="checkbox"
          aria-label={t('admin.users.selectUser', { username: user.username })}
          className="accent-sky-500"
          checked={selected}
          onChange={onToggle}
        />
      </Td>
      <Td>
        <Link
          to={`/admin/users/${user.id}`}
          className={cx(
            'block text-sky-400 hover:text-sky-300 hover:underline',
            'focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400',
          )}
        >
          <span className="block font-medium text-neutral-100">{user.username}</span>
          <span className="block text-[12px] text-neutral-500">{user.email}</span>
        </Link>
        {user.mustChangePassword ? (
          <span className="mt-0.5 block text-[11px] text-amber-400">
            {t('admin.users.flags.mustChangePassword')}
          </span>
        ) : null}
        {user.chatBanned ? (
          <span className="mt-0.5 block text-[11px] text-red-400">
            {t('admin.users.flags.chatBanned')}
          </span>
        ) : null}
      </Td>
      <Td>
        <Badge tone={user.role === 'admin' ? 'sky' : 'neutral'}>
          {user.role === 'admin' ? t('admin.users.roles.admin') : t('admin.users.roles.user')}
        </Badge>
      </Td>
      <Td>
        <Badge tone={user.status === 'active' ? 'green' : 'red'}>
          {user.status === 'active'
            ? t('admin.users.status.active')
            : t('admin.users.status.disabled')}
        </Badge>
      </Td>
      <Td>
        {user.privacyMode === 'paranoid' ? (
          <Badge tone="amber">{t('admin.users.privacy.paranoid')}</Badge>
        ) : (
          <span className={TEXT_MUTED}>{t('admin.users.privacy.normal')}</span>
        )}
      </Td>
      <Td className={cx('whitespace-nowrap text-neutral-400', TEXT_NUM)}>
        {user.lastLoginAt ? formatDateTime(user.lastLoginAt) : '—'}
      </Td>
      <Td className={cx('whitespace-nowrap text-neutral-400', TEXT_NUM)}>
        {formatDateTime(user.createdAt)}
      </Td>
      <Td className="text-right">
        <Link
          to={`/admin/users/${user.id}`}
          className="text-[12px] text-sky-400 hover:text-sky-300 hover:underline focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
        >
          {t('admin.users.open')}
        </Link>
      </Td>
    </tr>
  );
}

function Filters({
  search,
  onSearch,
  role,
  status,
  privacyMode,
  limit,
  onChange,
  filtersActive,
}: {
  search: string;
  onSearch: (value: string) => void;
  role: string;
  status: string;
  privacyMode: string;
  limit: number;
  onChange: (patch: Record<string, string | number | null>) => void;
  filtersActive: boolean;
}) {
  const t = useT();
  return (
    <Panel className="flex flex-wrap items-end gap-3">
      <div className="min-w-[14rem] flex-1">
        <TextField
          label={t('admin.users.searchLabel')}
          name="search"
          placeholder={t('admin.users.searchPlaceholder')}
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          className="w-full"
        />
      </div>
      <SelectField
        label={t('admin.users.columns.role')}
        name="filter-role"
        value={role}
        onChange={(e) => onChange({ role: e.target.value })}
        options={[
          { value: ANY, label: t('admin.users.filters.anyRole') },
          { value: 'user', label: t('admin.users.roles.user') },
          { value: 'admin', label: t('admin.users.roles.admin') },
        ]}
      />
      <SelectField
        label={t('admin.users.columns.status')}
        name="filter-status"
        value={status}
        onChange={(e) => onChange({ status: e.target.value })}
        options={[
          { value: ANY, label: t('admin.users.filters.anyStatus') },
          { value: 'active', label: t('admin.users.status.active') },
          { value: 'disabled', label: t('admin.users.status.disabled') },
        ]}
      />
      <SelectField
        label={t('admin.users.columns.privacy')}
        name="filter-privacy"
        value={privacyMode}
        onChange={(e) => onChange({ privacy: e.target.value })}
        options={[
          { value: ANY, label: t('admin.users.filters.anyPrivacy') },
          { value: 'normal', label: t('admin.users.privacy.normal') },
          { value: 'paranoid', label: t('admin.users.privacy.paranoid') },
        ]}
      />
      <SelectField
        label={t('admin.users.filters.pageSize')}
        name="filter-limit"
        value={String(limit)}
        onChange={(e) => onChange({ limit: e.target.value })}
        options={PAGE_SIZES.map((size) => ({ value: String(size), label: String(size) }))}
      />
      {filtersActive ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange({ q: null, role: null, status: null, privacy: null })}
        >
          {t('admin.users.filters.reset')}
        </Button>
      ) : null}
    </Panel>
  );
}

function Pagination({
  page,
  rowCount,
  onOffset,
}: {
  page: { total: number; limit: number; offset: number } | null;
  rowCount: number;
  onOffset: (offset: number) => void;
}) {
  const t = useT();
  if (!page) return null;
  // Same clamped arithmetic as every other bounded console list (#1848): the
  // range this footer states can never read backwards, and an empty window past
  // the first page reports 0–0 rather than "26–25 of 25".
  const { first, last, total, hasPrev, hasNext, prevOffset, nextOffset } = pageRange(
    page,
    rowCount,
  );

  return (
    <div className={cx('flex flex-wrap items-center justify-between gap-3 px-1 pt-1', EDGE_TOP)}>
      <span className={cx(TEXT_MICRO, TEXT_NUM)}>
        {t('admin.users.pagination.range', { first, last, total })}
      </span>
      <div className="flex gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={!hasPrev}
          onClick={() => onOffset(prevOffset)}
        >
          {t('admin.users.pagination.previous')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={!hasNext}
          onClick={() => onOffset(nextOffset)}
        >
          {t('admin.users.pagination.next')}
        </Button>
      </div>
    </div>
  );
}

function CreatedUserDialog({
  result,
  onClose,
}: {
  result: CreateUserResponse;
  onClose: () => void;
}) {
  const t = useT();
  const [acknowledged, setAcknowledged] = useState(false);

  return (
    <Modal
      title={t('admin.oneTimeCredentials.temporaryPassword.title')}
      onClose={onClose}
      dismissable={acknowledged}
    >
      <div className="flex flex-col gap-4">
        <p className="text-[13px] text-neutral-400">
          {t('admin.oneTimeCredentials.temporaryPassword.description', {
            email: result.user.email,
          })}
        </p>
        <CopyField
          label={t('admin.oneTimeCredentials.temporaryPassword.label')}
          value={result.tempPassword}
          onCopied={() => setAcknowledged(true)}
        />
        <Button
          onClick={() => {
            setAcknowledged(true);
            onClose();
          }}
        >
          {t('common.savedOneTimeSecret')}
        </Button>
      </div>
    </Modal>
  );
}

function StatsStrip({ data }: { data: AdminStats | null }) {
  const t = useT();
  if (!data) return null;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <StatTile label={t('admin.users.stats.users')} value={data.userCount} />
      <StatTile label={t('admin.users.stats.active')} value={data.activeUserCount} tone="green" />
      <StatTile
        label={t('admin.users.stats.disabled')}
        value={data.disabledUserCount}
        tone={data.disabledUserCount > 0 ? 'red' : 'neutral'}
      />
      <StatTile
        label={t('admin.users.stats.pendingInvites')}
        value={data.pendingInviteCount}
        tone={data.pendingInviteCount > 0 ? 'sky' : 'neutral'}
      />
    </div>
  );
}

function CreateUserDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (result: CreateUserResponse) => void;
}) {
  const t = useT();
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await api.createUser({
        email: email.trim(),
        username: username.trim(),
        role: 'user',
      });
      onCreated(result);
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title={t('admin.users.create')} onClose={onClose}>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {error ? <Alert tone="error">{error}</Alert> : null}
        <TextField
          label={t('admin.users.emailLabel')}
          name="email"
          type="email"
          autoComplete="off"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <TextField
          label={t('admin.users.usernameLabel')}
          name="username"
          autoComplete="off"
          hint={t('admin.users.usernameHint')}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? t('common.creating') : t('admin.users.create')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
