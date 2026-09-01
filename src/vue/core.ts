/**
 * A Vue ref, recognised by shape rather than by importing Vue's own type. Keeps this file usable
 * from tests and from the plain-object path without pulling Vue in.
 *
 * Only `value` is required. Vue's own `Ref<T>` brands itself with a *symbol* and carries
 * `__v_isRef` at runtime but not in a way a structural type can demand — so requiring it here made
 * a real `ref()` fail to typecheck against every `MaybeVueSource` parameter, which is to say the
 * documented Vue API did not accept the thing its own examples pass. The runtime probe in
 * {@link resolveVueSource} still checks `__v_isRef`, so only a genuine ref is ever unwrapped.
 */
export interface VueRefLike<Value> {
  readonly __v_isRef?: boolean;
  readonly value: Value;
}

/** Vue callers pass options as a plain value, a ref, or a getter. All three are accepted. */
export type MaybeVueSource<Value> = Value | VueRefLike<Value> | (() => Value);

/** Unwraps whichever of those three a caller passed, so the rest of the binding sees a value. */
export function resolveVueSource<Value>(source: MaybeVueSource<Value>): Value {
  if (typeof source === 'function') return (source as () => Value)();
  if (
    typeof source === 'object' &&
    source !== null &&
    (source as { readonly __v_isRef?: unknown }).__v_isRef === true &&
    'value' in source
  ) {
    return (source as VueRefLike<Value>).value;
  }
  return source as Value;
}
