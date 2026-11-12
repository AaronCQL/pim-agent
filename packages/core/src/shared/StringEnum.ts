import { type TUnsafe, Type } from "typebox";

export function StringEnum<const T extends readonly string[]>(
  values: T,
  options?: { readonly description?: string; readonly default?: T[number] }
): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({ type: "string", enum: values, ...options });
}
