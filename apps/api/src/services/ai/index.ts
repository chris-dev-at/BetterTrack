/**
 * Local-AI provider layer (PROJECTPLAN.md §13.5 V5-P12, §16 2026-07-22). Barrel
 * for the provider seam, the ONE Ollama adapter, the request-time registry, the
 * per-user daily cap, and the orchestrating service. LOCAL AI ONLY — no cloud
 * adapter, no token storage exists here.
 */
export * from './types';
export * from './errors';
export {
  createOllamaProvider,
  OLLAMA_COMPLETION_TIMEOUT_MS,
  OLLAMA_CONTROL_TIMEOUT_MS,
  type CreateOllamaProviderDeps,
} from './ollamaProvider';
export {
  createAiDailyCap,
  aiCapKey,
  utcDayKey,
  secondsUntilUtcMidnight,
  AI_CAP_KEY_PREFIX,
  AI_CAP_TTL_SECONDS,
  type AiDailyCap,
  type AiDailyCapDeps,
} from './dailyCap';
export { createAiRegistry, type AiRegistry, type AiRegistryDeps } from './registry';
export {
  createAiService,
  type AiService,
  type AiServiceActor,
  type AiServiceDeps,
} from './aiService';
