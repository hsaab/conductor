/**
 * Minimal GitHub access for the merge stage: read whether a build's pull request
 * has actually merged, so the dashboard's review/merge stages advance on the real
 * merge rather than waiting on the downstream Vercel deploy.
 *
 * Target repos are typically private, so this needs a token (`GH_TOKEN`).
 * Every helper degrades safely: with no token or on any API error it reports
 * `"unknown"`, and callers treat anything other than a definite merge as
 * not-yet-merged — so an outage never falsely advances a stage.
 */
import { githubToken } from "../config.js";

/** Owner / repo / PR number parsed from a GitHub pull-request URL. */
export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
}

/** Merge state of a single PR. `unknown` means "could not determine" (no token / error). */
export type MergeState = "merged" | "open" | "unknown";

const PR_URL_RE = /github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i;

/** Extracts owner/repo/number from a GitHub PR URL, or `null` if it is not one. */
export function parsePullRequestUrl(url: string): PullRequestRef | null {
  const match = url.match(PR_URL_RE);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

/**
 * Resolves whether a single pull request has merged via the GitHub REST API.
 * Returns `"unknown"` when no token is configured or the request fails, so a
 * transient error is never mistaken for a merge.
 */
export async function fetchPullRequestMergeState(
  url: string,
  token: string = githubToken(),
): Promise<MergeState> {
  const ref = parsePullRequestUrl(url);
  if (!ref || !token) return "unknown";
  try {
    const res = await fetch(
      `https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "conductor",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!res.ok) return "unknown";
    const pr = (await res.json()) as { merged?: boolean; merged_at?: string | null };
    return pr.merged || pr.merged_at ? "merged" : "open";
  } catch {
    return "unknown";
  }
}

/**
 * True only when every given PR URL is definitively merged (and there is at least
 * one). A missing token, an unparseable URL, or any still-open/unknown PR yields
 * `false`, so the merge stage advances strictly on confirmed merges.
 */
export async function allPullRequestsMerged(
  urls: string[],
  token: string = githubToken(),
): Promise<boolean> {
  if (urls.length === 0 || !token) return false;
  const states = await Promise.all(urls.map((url) => fetchPullRequestMergeState(url, token)));
  return states.every((state) => state === "merged");
}
