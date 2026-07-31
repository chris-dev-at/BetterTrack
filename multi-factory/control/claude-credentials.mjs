import { randomUUID as nodeRandomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, rm, unlink } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export const CLAUDE_FACTORY_ENV_PROFILE = 'factory-env';
export const CLAUDE_CREDENTIAL_SERVICES = Object.freeze([
  'master',
  'worker-1',
  'worker-2',
  'worker-3',
  'worker-4',
]);
export const CLAUDE_CREDENTIAL_TARGETS = Object.freeze(['default', ...CLAUDE_CREDENTIAL_SERVICES]);

const STORE_VERSION = 1;
const VAULT_DIRECTORY = '.claude-credentials';
const PROFILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SETUP_TOKEN_PATTERN = /sk-ant-oat01-[A-Za-z0-9_-]+/g;
const MAX_PROFILE_NAME_LENGTH = 80;

export class ClaudeCredentialStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ClaudeCredentialStoreError';
    this.code = code;
  }
}

function storeError(code, message) {
  return new ClaudeCredentialStoreError(code, message);
}

function setupTokensIn(value) {
  if (typeof value !== 'string') return [];
  return [...new Set(value.match(SETUP_TOKEN_PATTERN) || [])];
}

export function extractClaudeSetupToken(value) {
  const tokens = setupTokensIn(value);
  if (tokens.length === 0)
    throw storeError('INVALID_SETUP_TOKEN', 'No valid Claude setup token was found.');
  if (tokens.length !== 1)
    throw storeError('AMBIGUOUS_SETUP_TOKEN', 'More than one Claude setup token was found.');
  return tokens[0];
}

export function redactClaudeSetupToken(value, replacement = '[REDACTED]') {
  if (typeof value !== 'string') return '';
  return value.replace(SETUP_TOKEN_PATTERN, replacement);
}

function normalizeProfileName(value) {
  if (typeof value !== 'string')
    throw storeError('INVALID_PROFILE_NAME', 'A profile name is required.');
  const name = value.trim();
  const hasControlCharacter = [...name].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (
    !name ||
    [...name].length > MAX_PROFILE_NAME_LENGTH ||
    hasControlCharacter ||
    setupTokensIn(name).length > 0
  )
    throw storeError('INVALID_PROFILE_NAME', 'The profile name is invalid.');
  return name;
}

function assertProfileId(value) {
  if (typeof value !== 'string' || !PROFILE_ID_PATTERN.test(value))
    throw storeError('INVALID_PROFILE', 'The Claude credential profile is invalid.');
  return value.toLowerCase();
}

function assertService(value) {
  if (!CLAUDE_CREDENTIAL_SERVICES.includes(value))
    throw storeError('INVALID_SERVICE', 'The factory service is invalid.');
  return value;
}

function assertTarget(value) {
  if (!CLAUDE_CREDENTIAL_TARGETS.includes(value))
    throw storeError('INVALID_TARGET', 'The credential assignment target is invalid.');
  return value;
}

function privateChild(root, ...segments) {
  const candidate = resolve(root, ...segments);
  const rel = relative(root, candidate);
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel))
    throw storeError('INVALID_PATH', 'The credential storage path is invalid.');
  return candidate;
}

async function ensurePrivateDirectory(path) {
  try {
    const existing = await lstat(path);
    if (!existing.isDirectory() || existing.isSymbolicLink())
      throw storeError('UNSAFE_STORAGE', 'The credential storage directory is unsafe.');
  } catch (error) {
    if (error instanceof ClaudeCredentialStoreError) throw error;
    if (error?.code !== 'ENOENT') throw error;
    await mkdir(path, { recursive: true, mode: 0o700 });
    const created = await lstat(path);
    if (!created.isDirectory() || created.isSymbolicLink())
      throw storeError('UNSAFE_STORAGE', 'The credential storage directory is unsafe.');
  }
  await chmod(path, 0o700);
}

async function atomicWriteFile(path, contents, mode = 0o600) {
  const tempPath = `${path}.${process.pid}.${nodeRandomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(tempPath, 'wx', mode);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(tempPath, mode);
    await rename(tempPath, path);
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // The original failure is the useful one.
      }
    }
    try {
      await unlink(tempPath);
    } catch {
      // The temporary file may not have been created or may already be renamed.
    }
    throw error;
  }
}

async function unlinkIfPresent(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function bestEffortUnlink(path) {
  try {
    await unlinkIfPresent(path);
  } catch {
    // Cleanup must not replace the sanitized operation error.
  }
}

function defaultState() {
  return {
    version: STORE_VERSION,
    profiles: [],
    assignments: {
      default: CLAUDE_FACTORY_ENV_PROFILE,
      master: null,
      'worker-1': null,
      'worker-2': null,
      'worker-3': null,
      'worker-4': null,
    },
  };
}

function validTimestamp(value) {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function normalizeStoredState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw storeError('CORRUPT_STORE', 'The Claude credential store is invalid.');
  if (value.version !== STORE_VERSION || !Array.isArray(value.profiles))
    throw storeError('CORRUPT_STORE', 'The Claude credential store is invalid.');

  const profiles = [];
  const ids = new Set();
  const names = new Set();
  for (const raw of value.profiles) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw storeError('CORRUPT_STORE', 'The Claude credential store is invalid.');
    const id = assertProfileId(raw.id);
    const name = normalizeProfileName(raw.name);
    if (
      id !== raw.id ||
      name !== raw.name ||
      !validTimestamp(raw.createdAt) ||
      !validTimestamp(raw.updatedAt) ||
      ids.has(id) ||
      names.has(name.toLocaleLowerCase('en-US'))
    )
      throw storeError('CORRUPT_STORE', 'The Claude credential store is invalid.');
    ids.add(id);
    names.add(name.toLocaleLowerCase('en-US'));
    profiles.push({
      id,
      name,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    });
  }

  const rawAssignments = value.assignments;
  if (!rawAssignments || typeof rawAssignments !== 'object' || Array.isArray(rawAssignments))
    throw storeError('CORRUPT_STORE', 'The Claude credential store is invalid.');

  const assignments = {};
  for (const target of CLAUDE_CREDENTIAL_TARGETS) {
    const selection = rawAssignments[target];
    if (target !== 'default' && selection === null) {
      assignments[target] = null;
      continue;
    }
    if (selection === CLAUDE_FACTORY_ENV_PROFILE) {
      assignments[target] = selection;
      continue;
    }
    const profileId = assertProfileId(selection);
    if (!ids.has(profileId))
      throw storeError('CORRUPT_STORE', 'The Claude credential store is invalid.');
    assignments[target] = profileId;
  }

  return { version: STORE_VERSION, profiles, assignments };
}

function publicState(state) {
  return {
    version: state.version,
    profiles: state.profiles.map((profile) => ({ ...profile })),
    assignments: { ...state.assignments },
  };
}

function cloneState(state) {
  return {
    version: state.version,
    profiles: state.profiles.map((profile) => ({ ...profile })),
    assignments: { ...state.assignments },
  };
}

function resolvedSelection(state, service) {
  return state.assignments[service] ?? state.assignments.default;
}

function profileMarker(profile) {
  return {
    version: STORE_VERSION,
    source: 'profile',
    profileId: profile.id,
    name: profile.name,
  };
}

function activatingProfileMarker(profile) {
  return {
    ...profileMarker(profile),
    status: 'activating',
  };
}

function unavailableMarker() {
  return {
    version: STORE_VERSION,
    source: 'unavailable',
    profileId: null,
    name: 'Claude credential unavailable',
    status: 'unavailable',
  };
}

function factoryEnvMarker() {
  return {
    version: STORE_VERSION,
    source: CLAUDE_FACTORY_ENV_PROFILE,
    profileId: null,
    name: 'Factory .env',
  };
}

function activatingFactoryEnvMarker() {
  return {
    ...factoryEnvMarker(),
    status: 'activating',
  };
}

function safeInstant(now) {
  try {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error('invalid time');
    return date.toISOString();
  } catch {
    throw storeError('STORE_UNAVAILABLE', 'The Claude credential store is unavailable.');
  }
}

export function createClaudeCredentialStore(options = {}) {
  const normalizedOptions = typeof options === 'string' ? { authRoot: options } : options;
  const {
    authRoot,
    now = () => new Date(),
    idFactory = nodeRandomUUID,
    lockWaitMs = 10000,
    lockLeaseMs = 30000,
    lockRecoveryGraceMs = 2000,
  } = normalizedOptions || {};
  if (typeof authRoot !== 'string' || !authRoot.trim() || authRoot.includes('\0'))
    throw storeError('INVALID_AUTH_ROOT', 'A credential auth root is required.');
  if (
    typeof now !== 'function' ||
    typeof idFactory !== 'function' ||
    !Number.isSafeInteger(lockWaitMs) ||
    lockWaitMs < 1 ||
    !Number.isSafeInteger(lockLeaseMs) ||
    lockLeaseMs < 1 ||
    !Number.isSafeInteger(lockRecoveryGraceMs) ||
    lockRecoveryGraceMs < 0
  )
    throw storeError('INVALID_OPTIONS', 'The credential store options are invalid.');

  const root = resolve(authRoot);
  const vaultRoot = privateChild(root, VAULT_DIRECTORY);
  const profilesRoot = privateChild(vaultRoot, 'profiles');
  const statePath = privateChild(vaultRoot, 'state.json');
  const lockRoot = privateChild(vaultRoot, '.store-lock');
  const recoveryLockRoot = privateChild(vaultRoot, '.store-lock-recovery');
  const lockOwnerPath = privateChild(lockRoot, 'owner.json');
  let queue = Promise.resolve();

  const pause = (milliseconds) =>
    new Promise((resolvePause) => setTimeout(resolvePause, milliseconds));

  async function readLockOwner() {
    try {
      const value = JSON.parse(await readFile(lockOwnerPath, 'utf8'));
      return value &&
        typeof value.id === 'string' &&
        Number.isSafeInteger(value.pid) &&
        value.pid > 0
        ? value
        : null;
    } catch {
      return null;
    }
  }

  function processIsAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code !== 'ESRCH';
    }
  }

  async function recoverAbandonedLock() {
    try {
      await mkdir(recoveryLockRoot, { mode: 0o700 });
    } catch (error) {
      if (error?.code === 'EEXIST') return;
      throw error;
    }
    try {
      let lockInfo;
      try {
        lockInfo = await lstat(lockRoot);
      } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
      }
      const owner = await readLockOwner();
      const ownerCreatedAt = Date.parse(owner?.createdAt || '');
      const leaseExpired =
        !Number.isFinite(ownerCreatedAt) || Date.now() - ownerCreatedAt > lockLeaseMs;
      const oldEnough = Date.now() - lockInfo.mtimeMs > lockRecoveryGraceMs;
      if (oldEnough && (!owner || !processIsAlive(owner.pid) || leaseExpired)) {
        await rm(lockRoot, { recursive: true, force: true });
      }
    } finally {
      await rm(recoveryLockRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function acquireProcessLock() {
    await initialize();
    const deadline = Date.now() + lockWaitMs;
    while (Date.now() <= deadline) {
      const id = nodeRandomUUID();
      try {
        await mkdir(lockRoot, { mode: 0o700 });
        try {
          await atomicWriteFile(
            lockOwnerPath,
            `${JSON.stringify({ id, pid: process.pid, createdAt: new Date().toISOString() })}\n`,
          );
          return id;
        } catch (error) {
          await rm(lockRoot, { recursive: true, force: true }).catch(() => {});
          throw error;
        }
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
      await recoverAbandonedLock();
      await pause(25);
    }
    throw storeError('STORE_BUSY', 'The Claude credential store is busy. Try again.');
  }

  async function releaseProcessLock(id) {
    const owner = await readLockOwner();
    if (owner?.id === id) await rm(lockRoot, { recursive: true, force: true });
  }

  function startProcessLockHeartbeat(id) {
    const intervalMs = Math.max(5, Math.floor(lockLeaseMs / 3));
    let stopped = false;
    let timer = null;
    let pending = Promise.resolve();
    const schedule = () => {
      if (stopped) return;
      timer = setTimeout(() => {
        pending = (async () => {
          const owner = await readLockOwner();
          if (owner?.id !== id) return;
          await atomicWriteFile(
            lockOwnerPath,
            `${JSON.stringify({
              id,
              pid: process.pid,
              createdAt: new Date().toISOString(),
            })}\n`,
          );
        })()
          .catch(() => {})
          .finally(schedule);
      }, intervalMs);
      timer.unref?.();
    };
    schedule();
    return async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await pending.catch(() => {});
    };
  }

  function exclusive(operation) {
    const lockedOperation = async () => {
      let lockId;
      try {
        lockId = await acquireProcessLock();
      } catch (error) {
        throw sanitizeFailure(error);
      }
      const stopHeartbeat = startProcessLockHeartbeat(lockId);
      try {
        return await operation();
      } finally {
        await stopHeartbeat();
        await releaseProcessLock(lockId).catch(() => {});
      }
    };
    const result = queue.then(lockedOperation, lockedOperation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function initialize() {
    await ensurePrivateDirectory(root);
    await ensurePrivateDirectory(vaultRoot);
    await ensurePrivateDirectory(profilesRoot);
  }

  async function writeState(state) {
    const normalized = normalizeStoredState(state);
    await atomicWriteFile(statePath, `${JSON.stringify(normalized, null, 2)}\n`);
    return normalized;
  }

  async function readState() {
    await initialize();
    let serialized;
    try {
      serialized = await readFile(statePath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const initial = defaultState();
      await writeState(initial);
      return initial;
    }
    if (setupTokensIn(serialized).length > 0)
      throw storeError('CORRUPT_STORE', 'The Claude credential store is invalid.');
    try {
      return normalizeStoredState(JSON.parse(serialized));
    } catch (error) {
      if (error instanceof ClaudeCredentialStoreError) throw error;
      throw storeError('CORRUPT_STORE', 'The Claude credential store is invalid.');
    }
  }

  function profileDirectory(profileId) {
    return privateChild(profilesRoot, assertProfileId(profileId));
  }

  function storedTokenPath(profileId) {
    return privateChild(profileDirectory(profileId), 'oauth-token');
  }

  function materializedPaths(service) {
    const validService = assertService(service);
    const serviceRoot = privateChild(root, validService);
    const claudeRoot = privateChild(serviceRoot, 'claude');
    return {
      serviceRoot,
      claudeRoot,
      token: privateChild(claudeRoot, 'oauth-token'),
      marker: privateChild(claudeRoot, 'profile.json'),
    };
  }

  async function readExactToken(path) {
    let value;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('unsafe credential file');
      value = await readFile(path, 'utf8');
      const token = extractClaudeSetupToken(value);
      if (value.trim() !== token) throw new Error('unexpected credential contents');
      return token;
    } catch {
      throw storeError('TOKEN_UNAVAILABLE', 'The Claude credential is unavailable.');
    }
  }

  async function readStoredToken(profileId) {
    return readExactToken(storedTokenPath(profileId));
  }

  async function readMaterializedMarker(service) {
    try {
      const paths = materializedPaths(service);
      const info = await lstat(paths.marker);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('unsafe marker file');
      const serialized = await readFile(paths.marker, 'utf8');
      if (setupTokensIn(serialized).length > 0) throw new Error('secret in marker');
      const marker = JSON.parse(serialized);
      if (!marker || typeof marker !== 'object' || Array.isArray(marker))
        throw new Error('invalid marker');
      return marker;
    } catch {
      throw storeError(
        'MATERIALIZATION_UNAVAILABLE',
        'The Claude credential selection is unavailable.',
      );
    }
  }

  async function markMaterializedUnavailable(service, marker = unavailableMarker()) {
    const paths = materializedPaths(service);
    await ensurePrivateDirectory(paths.serviceRoot);
    await ensurePrivateDirectory(paths.claudeRoot);
    await bestEffortUnlink(paths.token);
    await atomicWriteFile(paths.marker, `${JSON.stringify(marker, null, 2)}\n`);
  }

  async function materializeFromState(state, service) {
    const paths = materializedPaths(service);
    await ensurePrivateDirectory(paths.serviceRoot);
    await ensurePrivateDirectory(paths.claudeRoot);
    const selection = resolvedSelection(state, service);

    if (selection === CLAUDE_FACTORY_ENV_PROFILE) {
      const marker = factoryEnvMarker();
      try {
        await atomicWriteFile(
          paths.marker,
          `${JSON.stringify(activatingFactoryEnvMarker(), null, 2)}\n`,
        );
        await unlinkIfPresent(paths.token);
        await atomicWriteFile(paths.marker, `${JSON.stringify(marker, null, 2)}\n`);
      } catch (error) {
        try {
          await atomicWriteFile(
            paths.marker,
            `${JSON.stringify({ ...marker, status: 'unavailable' }, null, 2)}\n`,
          );
        } catch {
          // The activating marker remains fail-closed when the final marker
          // cannot be written.
        }
        throw error;
      }
      return marker;
    }

    const profile = state.profiles.find((candidate) => candidate.id === selection);
    if (!profile) {
      await markMaterializedUnavailable(service);
      throw storeError('PROFILE_NOT_FOUND', 'The Claude credential profile was not found.');
    }

    let token;
    try {
      // Publish a fail-closed marker before replacing the token. A role that
      // starts during activation either sees the completed selection or stops;
      // it never falls through to the legacy Factory .env credential.
      await atomicWriteFile(
        paths.marker,
        `${JSON.stringify(activatingProfileMarker(profile), null, 2)}\n`,
      );
      token = await readStoredToken(profile.id);
      await atomicWriteFile(paths.token, `${token}\n`);
      const marker = profileMarker(profile);
      await atomicWriteFile(paths.marker, `${JSON.stringify(marker, null, 2)}\n`);
      return marker;
    } catch (error) {
      token = undefined;
      await bestEffortUnlink(paths.token);
      try {
        await atomicWriteFile(
          paths.marker,
          `${JSON.stringify({ ...profileMarker(profile), status: 'unavailable' }, null, 2)}\n`,
        );
      } catch {
        // The activating marker is already fail-closed if the final marker
        // cannot be written.
      }
      throw error;
    }
  }

  async function materializeServices(state, services) {
    const results = await Promise.allSettled(
      services.map((service) => materializeFromState(state, service)),
    );
    if (results.some((result) => result.status === 'rejected'))
      throw storeError(
        'MATERIALIZE_FAILED',
        'The Claude credential selection could not be activated.',
      );
  }

  async function failClosedServices(services) {
    await Promise.allSettled(services.map((service) => markMaterializedUnavailable(service)));
  }

  function sanitizeFailure(error, code = 'STORE_UNAVAILABLE') {
    if (error instanceof ClaudeCredentialStoreError) return error;
    return storeError(code, 'The Claude credential store is unavailable.');
  }

  function list() {
    return exclusive(async () => {
      try {
        return publicState(await readState());
      } catch (error) {
        throw sanitizeFailure(error);
      }
    });
  }

  function save({ name: rawName, setupToken } = {}) {
    const name = normalizeProfileName(rawName);
    const token = extractClaudeSetupToken(setupToken);
    return exclusive(async () => {
      let newProfileDirectory;
      try {
        const state = await readState();
        if (
          state.profiles.some(
            (profile) =>
              profile.name.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US'),
          )
        )
          throw storeError(
            'DUPLICATE_PROFILE_NAME',
            'A Claude credential profile with that name already exists.',
          );

        let id;
        for (let attempt = 0; attempt < 10; attempt += 1) {
          id = assertProfileId(idFactory());
          if (!state.profiles.some((profile) => profile.id === id)) break;
          id = undefined;
        }
        if (!id)
          throw storeError(
            'PROFILE_ID_UNAVAILABLE',
            'A Claude credential profile could not be created.',
          );

        const timestamp = safeInstant(now);
        const profile = { id, name, createdAt: timestamp, updatedAt: timestamp };
        newProfileDirectory = profileDirectory(id);
        await ensurePrivateDirectory(newProfileDirectory);
        await atomicWriteFile(storedTokenPath(id), `${token}\n`);
        state.profiles.push(profile);
        await writeState(state);
        return { ...profile };
      } catch (error) {
        if (newProfileDirectory) {
          try {
            await rm(newProfileDirectory, { recursive: true, force: true });
          } catch {
            // A later retry can clean an orphan; never expose a filesystem error.
          }
        }
        throw sanitizeFailure(error);
      }
    });
  }

  function remove(profileId) {
    const id = assertProfileId(profileId);
    return exclusive(async () => {
      try {
        const state = await readState();
        const previousState = cloneState(state);
        const profileIndex = state.profiles.findIndex((profile) => profile.id === id);
        if (profileIndex === -1)
          throw storeError('PROFILE_NOT_FOUND', 'The Claude credential profile was not found.');

        const affectedServices = CLAUDE_CREDENTIAL_SERVICES.filter(
          (service) => resolvedSelection(state, service) === id,
        );
        state.profiles.splice(profileIndex, 1);
        if (state.assignments.default === id)
          state.assignments.default = CLAUDE_FACTORY_ENV_PROFILE;
        for (const service of CLAUDE_CREDENTIAL_SERVICES) {
          if (state.assignments[service] === id) state.assignments[service] = null;
        }
        await writeState(state);

        try {
          await materializeServices(state, affectedServices);
        } catch (error) {
          try {
            await writeState(previousState);
            await materializeServices(previousState, affectedServices);
          } catch {
            await failClosedServices(affectedServices);
          }
          throw error;
        }
        await rm(profileDirectory(id), { recursive: true, force: true });
        return publicState(state);
      } catch (error) {
        throw sanitizeFailure(error);
      }
    });
  }

  function renameProfile({ profileId, name: rawName } = {}) {
    const id = assertProfileId(profileId);
    const name = normalizeProfileName(rawName);
    return exclusive(async () => {
      try {
        const state = await readState();
        const previousState = cloneState(state);
        const profile = state.profiles.find((candidate) => candidate.id === id);
        if (!profile)
          throw storeError('PROFILE_NOT_FOUND', 'The Claude credential profile was not found.');
        if (
          state.profiles.some(
            (candidate) =>
              candidate.id !== id &&
              candidate.name.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US'),
          )
        )
          throw storeError(
            'DUPLICATE_PROFILE_NAME',
            'A Claude credential profile with that name already exists.',
          );

        const affectedServices = CLAUDE_CREDENTIAL_SERVICES.filter(
          (service) => resolvedSelection(state, service) === id,
        );
        profile.name = name;
        profile.updatedAt = safeInstant(now);
        await writeState(state);
        try {
          await materializeServices(state, affectedServices);
        } catch (error) {
          try {
            await writeState(previousState);
            await materializeServices(previousState, affectedServices);
          } catch {
            await failClosedServices(affectedServices);
          }
          throw error;
        }
        return publicState(state);
      } catch (error) {
        throw sanitizeFailure(error);
      }
    });
  }

  function assign({ target: rawTarget, profileId } = {}) {
    const target = assertTarget(rawTarget);
    let selection = profileId;
    if (selection === null && target === 'default')
      throw storeError(
        'INVALID_ASSIGNMENT',
        'The default Claude credential assignment cannot inherit.',
      );
    if (selection !== null && selection !== CLAUDE_FACTORY_ENV_PROFILE)
      selection = assertProfileId(selection);

    return exclusive(async () => {
      try {
        const state = await readState();
        const previousState = cloneState(state);
        if (
          selection !== null &&
          selection !== CLAUDE_FACTORY_ENV_PROFILE &&
          !state.profiles.some((profile) => profile.id === selection)
        )
          throw storeError('PROFILE_NOT_FOUND', 'The Claude credential profile was not found.');
        state.assignments[target] = selection;
        await writeState(state);
        const affectedServices =
          target === 'default'
            ? CLAUDE_CREDENTIAL_SERVICES.filter((service) => state.assignments[service] === null)
            : [target];
        try {
          await materializeServices(state, affectedServices);
        } catch (error) {
          try {
            await writeState(previousState);
            await materializeServices(previousState, affectedServices);
          } catch {
            await failClosedServices(affectedServices);
          }
          throw error;
        }
        return publicState(state);
      } catch (error) {
        throw sanitizeFailure(error);
      }
    });
  }

  function materialize(service) {
    const validService = assertService(service);
    return exclusive(async () => {
      try {
        const state = await readState();
        return { ...(await materializeFromState(state, validService)) };
      } catch (error) {
        try {
          await markMaterializedUnavailable(validService);
        } catch {
          // Preserve the sanitized store error when even the marker is
          // unavailable; autorun will abort rather than launch the service.
        }
        throw sanitizeFailure(error, 'MATERIALIZE_FAILED');
      }
    });
  }

  function materializeAll() {
    return exclusive(async () => {
      try {
        const state = await readState();
        await materializeServices(state, CLAUDE_CREDENTIAL_SERVICES);
        return publicState(state);
      } catch (error) {
        throw sanitizeFailure(error, 'MATERIALIZE_FAILED');
      }
    });
  }

  function tokenForProfile(profileId) {
    const id = assertProfileId(profileId);
    return exclusive(async () => {
      try {
        const state = await readState();
        if (!state.profiles.some((profile) => profile.id === id))
          throw storeError('PROFILE_NOT_FOUND', 'The Claude credential profile was not found.');
        return await readStoredToken(id);
      } catch (error) {
        throw sanitizeFailure(error);
      }
    });
  }

  function tokenForService(service) {
    const validService = assertService(service);
    return exclusive(async () => {
      try {
        const state = await readState();
        const selection = resolvedSelection(state, validService);
        const marker = await readMaterializedMarker(validService);
        if (selection === CLAUDE_FACTORY_ENV_PROFILE) {
          if (
            marker.source !== CLAUDE_FACTORY_ENV_PROFILE ||
            (marker.status != null && marker.status !== 'ready')
          )
            throw storeError(
              'MATERIALIZATION_UNAVAILABLE',
              'The Claude credential selection is unavailable.',
            );
          return null;
        }
        const profile = state.profiles.find((candidate) => candidate.id === selection);
        if (
          !profile ||
          marker.source !== 'profile' ||
          marker.profileId !== profile.id ||
          marker.name !== profile.name ||
          (marker.status != null && marker.status !== 'ready')
        )
          throw storeError(
            'MATERIALIZATION_UNAVAILABLE',
            'The Claude credential selection is unavailable.',
          );
        return await readExactToken(materializedPaths(validService).token);
      } catch (error) {
        throw sanitizeFailure(error);
      }
    });
  }

  return Object.freeze({
    list,
    save,
    remove,
    renameProfile,
    assign,
    materialize,
    materializeAll,
    tokenForProfile,
    tokenForService,
  });
}
