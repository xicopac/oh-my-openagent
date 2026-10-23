import { resolveLiveContextLimit } from "./shared/live-model-context-limits"

export type VisionCapableModel = {
  providerID: string
  modelID: string
}

export interface ModelCacheState {
  modelContextLimitsCache: Map<string, number>;
  visionCapableModelsCache?: Map<string, VisionCapableModel>;
  anthropicContext1MEnabled: boolean;
  /**
   * Live provider-metadata fallback for models absent from
   * `modelContextLimitsCache`. See `shared/live-model-context-limits.ts`.
   */
  resolveLiveContextLimit?: (providerID: string, modelID: string) => number | null;
}

export function createModelCacheState(): ModelCacheState {
  return {
    modelContextLimitsCache: new Map<string, number>(),
    visionCapableModelsCache: new Map<string, VisionCapableModel>(),
    anthropicContext1MEnabled: false,
    resolveLiveContextLimit,
  };
}
