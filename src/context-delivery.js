// Qualification is explicit per provider/model/variant. Missing identity,
// options or host capability always retains the original system projection.
export function usesRequestData(event, { contextDelivery, contextDataModels } = {}) {
  const model = event.model;
  return contextDelivery === 'request-data-v1' && Array.isArray(event.contextData)
    && typeof model?.providerID === 'string' && typeof model?.id === 'string'
    && typeof model?.variant === 'string' && model.variant.length > 0
    && Array.isArray(contextDataModels) && contextDataModels.some(ref =>
      ref?.providerID === model.providerID && ref?.id === model.id && ref?.variant === model.variant);
}
