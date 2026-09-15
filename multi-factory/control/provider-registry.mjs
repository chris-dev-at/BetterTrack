// Provider metadata and route validation shared by the control server and UI.
// This module is deliberately pure: importing it must never inspect credentials,
// start a CLI, or contact a provider.

export const DIFFICULTIES = Object.freeze(['easy', 'normal', 'intermediate', 'hard', 'max']);

// v2 per-role routing: each difficulty may carry three slot objects in addition
// to the flat legacy provider/model/effort keys (which mirror `completion` for
// stale readers). Order matches MF_SLOT_ORDER in mflib.sh.
export const SLOTS = Object.freeze(['writer', 'reviewer1', 'completion']);

// Roles whose `roles.<role>` entry may be a direct {provider, model, effort}
// pin instead of a difficulty string. Mirrors the roles mflib.sh scans in
// mf_uses_claude / role_pin_cfg. reviewFloor is deliberately absent — it is a
// floor, always a difficulty name, never a model.
export const PINNABLE_ROLES = Object.freeze([
  'composer',
  'checker',
  'writer',
  'reviewer',
  'fixer',
  'ci-fix',
]);

const CLAUDE_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const CODEX_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

// Owner hard rule (2026-07): no Opus 5 route may ever run above xhigh.
// Matches claude-opus-5 and suffixed variants (claude-opus-5-20260514, …) but
// not claude-opus-4-8. Enforced by filtering the effort list every validator
// and effort picker consults, so it binds flat entries and all three slots.
const OPUS5_MODEL = /^claude-opus-5(?:$|[.:@_-])/i;
const EFFORTS_ABOVE_XHIGH = Object.freeze(['max', 'ultra']);
export function isOpusFiveModel(model) {
  return OPUS5_MODEL.test(typeof model === 'string' ? model.trim() : '');
}

const MODEL_CATALOGS = Object.freeze({
  claude: Object.freeze([
    'claude-fable-5',
    'claude-opus-5',
    'claude-opus-4-8',
    'claude-sonnet-5',
    'claude-haiku-4-5',
  ]),
  openai: Object.freeze([
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.3-codex-spark',
    'codex-auto-review',
    'gpt-5-codex',
  ]),
  // opencode addresses models as "<opencode-provider>/<model>", and the model
  // half may itself contain a slash (stealth/ox-alpha).
  opencode: Object.freeze(['openrouter/stealth/ox-alpha']),
});

// Mirrors the selector guard in mflib.sh's cc_opencode. Slashes are legal here
// (they are the provider separator) but nothing that could break out of a shell
// argument or the ledger's pipe-delimited route string is.
const OPENCODE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

const registry = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    providerFamily: 'anthropic',
    harness: 'claude-code',
    billing: 'subscription',
    experimental: false,
    modelSuggestions: MODEL_CATALOGS.claude,
    efforts: CLAUDE_EFFORTS,
    defaultModel: 'claude-opus-4-8',
    defaultEffort: 'high',
    capabilities: {
      freeTextModel: true,
      effort: true,
      containerTest: false,
      apiEquivalentEstimate: false,
      dynamicModelCatalog: false,
    },
    modelEfforts: {
      'claude-opus-5': Object.freeze(['low', 'medium', 'high', 'xhigh']),
    },
  },
  claudex: {
    id: 'claudex',
    label: 'ClaudeX (Claude Code + Codex OAuth)',
    providerFamily: 'openai',
    harness: 'claude-code',
    billing: 'subscription',
    experimental: true,
    modelSuggestions: MODEL_CATALOGS.openai,
    efforts: CLAUDE_EFFORTS,
    defaultModel: 'gpt-5.6-terra',
    defaultEffort: 'high',
    capabilities: {
      freeTextModel: true,
      effort: true,
      containerTest: true,
      apiEquivalentEstimate: true,
      dynamicModelCatalog: true,
      oauthBridge: true,
    },
  },
  codex: {
    id: 'codex',
    label: 'Codex (OpenAI)',
    providerFamily: 'openai',
    harness: 'codex-cli',
    billing: 'subscription',
    experimental: false,
    modelSuggestions: MODEL_CATALOGS.openai,
    efforts: CODEX_EFFORTS,
    defaultModel: 'gpt-5.6-terra',
    defaultEffort: 'medium',
    capabilities: {
      freeTextModel: true,
      effort: true,
      containerTest: false,
      apiEquivalentEstimate: true,
      dynamicModelCatalog: true,
    },
    modelEfforts: {
      'gpt-5.6-sol': CODEX_EFFORTS,
      'gpt-5.6-terra': CODEX_EFFORTS,
      'gpt-5.6-luna': Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
    },
  },
  // The only API-KEY route in the factory: OpenRouter bills per token, and the
  // intended model is free only for the duration of its preview. `billing` says
  // free-preview rather than subscription so neither this registry nor the ledger
  // implies the $0 is structural the way it is for the other three.
  opencode: {
    id: 'opencode',
    label: 'opencode (OpenRouter)',
    providerFamily: 'openrouter',
    harness: 'opencode-cli',
    billing: 'free-preview',
    experimental: true,
    modelSuggestions: MODEL_CATALOGS.opencode,
    // opencode calls reasoning effort a "variant" and its legal values are
    // provider- and model-specific. None are verified for Ox Alpha, so advertise
    // none: an unverified effort would be silently ignored by the CLI while
    // looking authoritative in the dashboard.
    efforts: Object.freeze([]),
    defaultModel: 'openrouter/stealth/ox-alpha',
    defaultEffort: null,
    capabilities: {
      freeTextModel: true,
      effort: false,
      containerTest: false,
      apiEquivalentEstimate: false,
      dynamicModelCatalog: false,
      // Prompts and completions are RETAINED by the anonymous preview provider.
      retainsPrompts: true,
    },
  },
};

for (const provider of Object.values(registry)) {
  Object.freeze(provider.capabilities);
  if (provider.modelEfforts) Object.freeze(provider.modelEfforts);
  Object.freeze(provider);
}

export const PROVIDER_REGISTRY = Object.freeze(registry);
export const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDER_REGISTRY));

export function providerDefinition(id) {
  return Object.hasOwn(PROVIDER_REGISTRY, id) ? PROVIDER_REGISTRY[id] : null;
}

export function providerEfforts(provider, model = '') {
  const definition = providerDefinition(provider);
  if (!definition) return [];
  const efforts = definition.modelEfforts?.[model] || definition.efforts;
  if (isOpusFiveModel(model))
    return efforts.filter((effort) => !EFFORTS_ABOVE_XHIGH.includes(effort));
  return efforts;
}

export function normalizeProviderModel(provider, value) {
  let model = typeof value === 'string' ? value.trim() : '';
  if (provider === 'claudex' && model.startsWith('codex-api/'))
    model = model.slice('codex-api/'.length);
  return model;
}

export function expectedModelSelector(provider, model) {
  const normalized = normalizeProviderModel(provider, model);
  return provider === 'claudex' ? `codex-api/${normalized}` : normalized;
}

export function validateRouteEntry(entry) {
  const definition = providerDefinition(entry?.provider);
  if (!definition) return false;
  const model = normalizeProviderModel(entry.provider, entry.model);
  const hasControlCharacter = [...model].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (!model || model.length > 120 || hasControlCharacter) return false;
  if (entry.provider === 'claudex' && !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(model)) return false;
  // Keep the dashboard from saving a route mflib.sh's cc_opencode would reject.
  if (entry.provider === 'opencode' && !OPENCODE_MODEL.test(model)) return false;
  if (entry.effort == null || entry.effort === '') return true;
  return providerEfforts(entry.provider, model).includes(entry.effort);
}

export function normalizeRouteEntry(entry) {
  if (!validateRouteEntry(entry)) return null;
  const model = normalizeProviderModel(entry.provider, entry.model);
  const explicitEmptyEffort = Object.hasOwn(entry, 'effort') && entry.effort === '';
  return {
    provider: entry.provider,
    model,
    ...(entry.effort ? { effort: entry.effort } : explicitEmptyEffort ? { effort: '' } : {}),
  };
}

// Composer planning is a top-tier role. Keep this policy independent from the
// owner-selected difficulty slot so changing a slot cannot silently downgrade
// composition to a smaller model.
export function composerRouteAllowed(entry) {
  const normalized = normalizeRouteEntry(entry);
  if (!normalized) return false;
  if (normalized.provider === 'claude')
    return /^claude-(?:fable|opus)-[A-Za-z0-9._:-]+$/.test(normalized.model);
  return (
    (normalized.provider === 'claudex' || normalized.provider === 'codex') &&
    normalized.model === 'gpt-5.6-sol'
  );
}

export function defaultRouteForProvider(provider) {
  const definition = providerDefinition(provider);
  if (!definition) return null;
  return {
    provider,
    model: definition.defaultModel,
    ...(definition.defaultEffort ? { effort: definition.defaultEffort } : {}),
  };
}

// Extract the valid slot routes of one difficulty entry (v2 schema). Invalid
// or absent slots are omitted — mflib.sh fails closed on them at run time, and
// the editor re-seeds a missing slot from the flat route before saving.
export function normalizeSlotRoutes(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return {};
  const slots = {};
  for (const slot of SLOTS) {
    const normalized = normalizeRouteEntry(entry[slot]);
    if (normalized) slots[slot] = normalized;
  }
  return slots;
}

// Every route an entry can dispatch: the flat legacy route plus any slots.
export function entryRoutes(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
  return [entry, ...SLOTS.map((slot) => entry[slot]).filter((r) => r && typeof r === 'object')];
}

// roles.<role> accepts EITHER a difficulty string (legacy meaning: resolve
// through that tier) OR a {provider, model, effort} object pinning the role to
// that exact route. Returns the normalized pin, or null when the entry is not
// a valid pin (strings, absent entries and malformed objects all yield null —
// mflib.sh falls back to difficulty routing on those). validateRouteEntry
// enforces the Opus-5 ≤ xhigh cap, so an over-effort Opus 5 pin is never valid.
export function normalizeRolePin(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  return normalizeRouteEntry(entry);
}

export function normalizeModelRouting(raw, defaults) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const fallback =
    defaults && typeof defaults === 'object' && !Array.isArray(defaults) ? defaults : {};
  const out = {
    version: 1,
    difficulties: {},
    roles: { ...(fallback.roles || {}) },
  };
  let hasSlots = false;
  for (const difficulty of DIFFICULTIES) {
    const entry = source.difficulties?.[difficulty];
    const flat = normalizeRouteEntry(entry) || {
      ...(fallback.difficulties?.[difficulty] || {}),
    };
    const slots = normalizeSlotRoutes(entry);
    if (Object.keys(slots).length) hasSlots = true;
    out.difficulties[difficulty] = { ...flat, ...slots };
  }
  let hasPins = false;
  for (const role of new Set([...PINNABLE_ROLES, 'reviewFloor'])) {
    const value = source.roles?.[role];
    if (typeof value === 'string' && DIFFICULTIES.includes(value)) {
      // Difficulty strings keep their legacy meaning everywhere; under worker
      // role names they are inert for mflib but preserved so a save round-trip
      // cannot drop them.
      out.roles[role] = value;
      continue;
    }
    if (role === 'reviewFloor') continue; // the floor is never a pin
    const pin = normalizeRolePin(value);
    if (pin) {
      out.roles[role] = pin;
      hasPins = true;
    }
    // Malformed pins are dropped: mflib ignores them at run time, and
    // persisting them would only preserve a route nothing can dispatch.
  }
  if (hasSlots || hasPins) out.version = 2;
  return out;
}

// Return fresh JSON-compatible objects so API consumers cannot mutate the
// process-wide validation registry.
export function publicProviderRegistry() {
  return PROVIDER_IDS.map((id) => {
    const definition = PROVIDER_REGISTRY[id];
    return {
      id: definition.id,
      label: definition.label,
      providerFamily: definition.providerFamily,
      harness: definition.harness,
      billing: definition.billing,
      experimental: definition.experimental,
      modelSuggestions: [...definition.modelSuggestions],
      efforts: [...definition.efforts],
      defaultModel: definition.defaultModel,
      defaultEffort: definition.defaultEffort,
      capabilities: { ...definition.capabilities },
      ...(definition.modelEfforts
        ? {
            modelEfforts: Object.fromEntries(
              Object.entries(definition.modelEfforts).map(([model, efforts]) => [
                model,
                [...efforts],
              ]),
            ),
          }
        : {}),
    };
  });
}
