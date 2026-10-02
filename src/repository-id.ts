/** Repository row IDs are opaque cloud identifiers, including tenant-prefixed legacy names.
 * Syntax validation never establishes tenant ownership; callers must join fresh ACL and contract reads. */
export function isRepositoryId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
}
