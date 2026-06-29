/** Repo-name helpers shared across the pipeline. */

/** Short repo name from an `owner/repo` slug (or the bare name if unqualified). */
export function repoShortName(repo: string): string {
  return repo.includes("/") ? (repo.split("/").pop() ?? repo) : repo;
}
