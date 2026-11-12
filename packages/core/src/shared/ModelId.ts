/** `provider/id`, as `SessionHost.setModel` takes it. */
function of(model: { readonly provider: string; readonly id: string }): string {
  return `${model.provider}/${model.id}`;
}

export const ModelId = { of };
