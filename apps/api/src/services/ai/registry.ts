import type { Logger } from '../../logger';
import type { AppSettingsService } from '../appSettings/appSettingsService';
import { createOllamaProvider } from './ollamaProvider';
import type { AiProvider } from './types';

/**
 * The provider registry (PROJECTPLAN.md §13.5 V5-P12). It resolves the ACTIVE
 * provider from the admin config AT REQUEST TIME — every `resolve()` reads the
 * current app-settings config and constructs a fresh adapter — so an endpoint or
 * model switch takes effect on the very next request with no redeploy. Today the
 * only adapter is local Ollama; the registry is the seam a future adapter slots
 * into (choosing by a stored `provider` kind), but no cloud adapter exists.
 */

export interface AiRegistryDeps {
  appSettings: Pick<AppSettingsService, 'getAiSettings'>;
  /** Injectable fetch handed to the constructed adapter (tests). */
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

export interface AiRegistry {
  /** Build the active provider from the current config, or null when unconfigured. */
  resolve(): Promise<AiProvider | null>;
  /** Build a provider for an explicit endpoint/model (admin test-connection). */
  resolveFor(endpoint: string, model: string): AiProvider;
}

export function createAiRegistry(deps: AiRegistryDeps): AiRegistry {
  function build(endpoint: string, model: string): AiProvider {
    return createOllamaProvider({
      endpoint,
      model,
      fetchImpl: deps.fetchImpl,
      logger: deps.logger,
    });
  }

  async function resolve(): Promise<AiProvider | null> {
    const settings = await deps.appSettings.getAiSettings();
    if (!settings.configured || !settings.endpoint || !settings.model) return null;
    return build(settings.endpoint, settings.model);
  }

  return { resolve, resolveFor: build };
}
