// semver.ts — the one three-field comparator every version-drift check in this package shares
// (the tenant-minimum bundle check, and CTC-2160's published-release checks).
/** True when `a` is a semver-older release than `b`. Prerelease/build metadata is ignored; a segment
 *  that does not parse counts as 0. A tiny compare on purpose — no dependency for three fields. */
export function semverOlder(a: string, b: string): boolean {
  const parse = (v: string): [number, number, number] => {
    const core = v.split("-")[0]!.split("+")[0]!;
    const p = core.split(".");
    return [Number(p[0]) || 0, Number(p[1]) || 0, Number(p[2]) || 0];
  };
  const [a0, a1, a2] = parse(a);
  const [b0, b1, b2] = parse(b);
  if (a0 !== b0) return a0 < b0;
  if (a1 !== b1) return a1 < b1;
  return a2 < b2;
}
