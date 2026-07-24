// Provider metadata and route validation shared by the control server and UI.
// This module is deliberately pure: importing it must never inspect credentials,
// start a CLI, or contact a provider.

export const DIFFICULTIES = Object.freeze(['easy', 'normal', 'intermediate', 'hard', 'max']);

const CLAUDE_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const CODEX_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

const MODEL_CATALOGS = Object.freeze({
  claude: Object.freeze([
    'claude-fable-5',
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
  gemini: Object.freeze([
    'Gemini 3.1 Pro (High)',
    'Gemini 3.1 Pro (Low)',
    'Gemini 3.5 Flash (High)',
    'Gemini 3.5 Flash (Medium)',
    'Gemini 3.5 Flash (Low)',
  ]),
});

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
  gemini: {
    id: 'gemini',
    label: 'Antigravity (Google)',
    providerFamily: 'google',
    harness: 'antigravity',
    billing: 'subscription',
    experimental: false,
    modelSuggestions: MODEL_CATALOGS.gemini,
    efforts: Object.freeze([]),
    defaultModel: 'Gemini 3.1 Pro (High)',
    defaultEffort: null,
    capabilities: {
      freeTextModel: true,
      effort: false,
      containerTest: false,
      apiEquivalentEstimate: false,
      dynamicModelCatalog: true,
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
  return definition.modelEfforts?.[model] || definition.efforts;
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

export function defaultRouteForProvider(provider) {
  const definition = providerDefinition(provider);
  if (!definition) return null;
  return {
    provider,
    model: definition.defaultModel,
    ...(definition.defaultEffort ? { effort: definition.defaultEffort } : {}),
  };
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
  for (const difficulty of DIFFICULTIES) {
    const entry = source.difficulties?.[difficulty];
    out.difficulties[difficulty] = normalizeRouteEntry(entry) || {
      ...(fallback.difficulties?.[difficulty] || {}),
    };
  }
  for (const role of ['composer', 'checker', 'reviewFloor'])
    if (DIFFICULTIES.includes(source.roles?.[role])) out.roles[role] = source.roles[role];
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
