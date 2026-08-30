/**
 * Hands back the same frozen snapshot until the revision moves.
 *
 * `useSyncExternalStore` compares consecutive `getSnapshot()` results with `Object.is` and treats
 * any difference as a store change, so a producer that allocates a fresh object per call is an
 * infinite render loop rather than a cheap read. Vue's `watch` on a getter has the same problem in
 * a milder form: it re-runs every effect on every check.
 *
 * The key is the revision the snapshot already carries. `#publishRuntimeChange` bumps
 * `#runtimeRevision` for every state change — transient ones included, since
 * `publishTransientChange` routes through it — so nothing can move without the key moving with it.
 */
export function revisionCache<Snapshot>(): (
  revision: number,
  build: () => Snapshot,
) => Snapshot {
  let entry: { readonly revision: number; readonly value: Snapshot } | undefined;
  return (revision, build) => {
    if (entry === undefined || entry.revision !== revision) {
      entry = { revision, value: build() };
    }
    return entry.value;
  };
}
