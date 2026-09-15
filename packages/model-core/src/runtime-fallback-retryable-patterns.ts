export const RUNTIME_FALLBACK_RETRYABLE_ERROR_PATTERNS = [
  /rate.?limit/i,
  /too.?many.?requests/i,
  /quota\s+will\s+reset\s+after/i,
  /quota.?exceeded/i,
  /exceeded.*quota/i,
  /usage\s*quota/i,
  /free.?usage/i,
  /usage.?exceeded/i,
  /exhausted\s+your\s+capacity/i,
  /limit\s+exhausted/i,
  /all\s+credentials\s+for\s+model/i,
  /cool(?:ing)?\s+down/i,
  /model.{0,20}?not.{0,10}?supported/i,
  /model_not_supported/i,
  // Fireworks: "Floating point NaN (not-a-number) is detected in generation."
  // This is a model-side decode-time logits overflow, NOT a request-validation
  // error — a byte-identical replay succeeds (transient). Deliberately narrow:
  // requires both the NaN wording AND "detected in generation" so it cannot
  // swallow a genuine parameter-validation 400.
  /floating[ _-]?point[ _-]?nan.{0,60}detected[ _-]?in[ _-]?generation/i,
  /service.?unavailable/i,
  /overloaded/i,
  /temporarily.?unavailable/i,
  /try.?again/i,
  /(?:^|\s)429(?:\s|$)/,
  /(?:^|\s)503(?:\s|$)/,
  /(?:^|\s)529(?:\s|$)/,
  /使用上限/,
  /频率限制/,
  /请求过于频繁/,
  /暂时不可用/,
  /服务不可用/,
  /请稍后重试/,
] as const
