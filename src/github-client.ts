import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GithubAuthError, LoopError } from "./errors.js";
import type { CiSummary, PullRequestState, ReviewEvidence } from "./types.js";

const execFileAsync = promisify(execFile);

export interface IGithubClient {
  validate(repo: string): Promise<{ login: string }>;
  findPullRequest(repo: string, branch: string, base: string): Promise<PullRequestState | undefined>;
  getCi(repo: string, sha: string, previous?: CiSummary): Promise<CiSummary>;
  getReviewEvidence(repo: string, pr: number): Promise<ReviewEvidence[]>;
}

interface GhPull {
  number: number;
  url: string;
  state: string;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  author?: { login?: string };
  headRepository?: { name?: string; nameWithOwner?: string };
  headRepositoryOwner?: { login?: string };
}

export class GithubClient implements IGithubClient {
  constructor(
    private readonly noChecksGraceMs: number,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async validate(repo: string): Promise<{ login: string }> {
    try {
      const auth = await this.gh(["api", "user"]); 
      const user = JSON.parse(auth) as { login?: string };
      if (!user.login) throw new Error("GitHub user login missing");
      await this.gh(["repo", "view", repo, "--json", "nameWithOwner"]);
      return { login: user.login };
    } catch (error) {
      throw new GithubAuthError(`GitHub startup check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async findPullRequest(repo: string, branch: string, base: string): Promise<PullRequestState | undefined> {
    const output = await this.gh([
      "pr", "list", "--repo", repo, "--state", "open", "--head", branch,
      "--json", "number,url,state,baseRefName,headRefName,headRefOid,author,headRepository,headRepositoryOwner",
    ]);
    const pulls = JSON.parse(output) as GhPull[];
    const pull = pulls.find((candidate) => candidate.baseRefName === base && candidate.headRefName === branch);
    if (!pull) return undefined;
    return {
      number: pull.number,
      url: pull.url,
      state: pull.state,
      base_ref: pull.baseRefName,
      head_ref: pull.headRefName,
      head_sha: pull.headRefOid,
      author_login: pull.author?.login ?? "",
      head_repository: pull.headRepository?.nameWithOwner
        ?? (pull.headRepositoryOwner?.login && pull.headRepository?.name ? `${pull.headRepositoryOwner.login}/${pull.headRepository.name}` : ""),
      head_repository_owner: pull.headRepositoryOwner?.login ?? "",
      first_seen_at: new Date().toISOString(),
    };
  }

  async getCi(repo: string, sha: string, previous?: CiSummary): Promise<CiSummary> {
    const now = new Date().toISOString();
    const [checkRunsRaw, statusesRaw] = await Promise.all([
      this.gh(["api", `repos/${repo}/commits/${sha}/check-runs`, "-H", "Accept: application/vnd.github+json"]),
      this.gh(["api", `repos/${repo}/commits/${sha}/status`, "-H", "Accept: application/vnd.github+json"]),
    ]);
    const checkRuns = JSON.parse(checkRunsRaw) as {
      check_runs?: Array<{ name: string; status: string; conclusion?: string | null; html_url?: string }>;
    };
    const statuses = JSON.parse(statusesRaw) as {
      statuses?: Array<{ context: string; state: string; target_url?: string }>;
    };
    const checks = [
      ...(checkRuns.check_runs ?? []).map((check) => ({
        name: check.name,
        state: check.status,
        ...(check.conclusion ? { conclusion: check.conclusion } : {}),
        ...(check.html_url ? { url: check.html_url } : {}),
      })),
      ...(statuses.statuses ?? []).map((status) => ({
        name: status.context,
        state: status.state === "pending" ? "in_progress" : "completed",
        conclusion: status.state,
        ...(status.target_url ? { url: status.target_url } : {}),
      })),
    ];

    if (!checks.length) {
      const firstEmpty = previous?.sha === sha && previous.first_empty_at ? previous.first_empty_at : now;
      const elapsed = Date.now() - Date.parse(firstEmpty);
      return {
        sha,
        state: elapsed >= this.noChecksGraceMs ? "none" : "pending",
        checks: [],
        observed_at: now,
        first_empty_at: firstEmpty,
      };
    }

    const failing = new Set(["failure", "cancelled", "timed_out", "action_required", "stale", "error"]);
    const pending = checks.some((check) => check.state !== "completed" && check.state !== "success");
    const failed = checks.some((check) => check.conclusion && failing.has(check.conclusion.toLowerCase()));
    return { sha, state: failed ? "failure" : pending ? "pending" : "success", checks, observed_at: now };
  }

  async getReviewEvidence(repo: string, pr: number): Promise<ReviewEvidence[]> {
    const [reviewsRaw, issueCommentsRaw, reviewCommentsRaw] = await Promise.all([
      this.gh(["api", `repos/${repo}/pulls/${pr}/reviews`, "--paginate"]),
      this.gh(["api", `repos/${repo}/issues/${pr}/comments`, "--paginate"]),
      this.gh(["api", `repos/${repo}/pulls/${pr}/comments`, "--paginate"]),
    ]);
    const reviews = JSON.parse(reviewsRaw) as Array<{
      id: number; user?: { login?: string }; state?: string; commit_id?: string; submitted_at?: string; html_url?: string;
    }>;
    const issueComments = JSON.parse(issueCommentsRaw) as Array<{
      id: number; user?: { login?: string }; created_at?: string; html_url?: string;
    }>;
    const reviewComments = JSON.parse(reviewCommentsRaw) as Array<{
      id: number; user?: { login?: string }; created_at?: string; html_url?: string; commit_id?: string;
    }>;
    return [
      ...reviews.map((item) => ({
        id: `review:${item.id}`, kind: "review" as const, author: item.user?.login ?? "",
        ...(item.state ? { state: item.state } : {}), ...(item.commit_id ? { commit_id: item.commit_id } : {}),
        created_at: item.submitted_at ?? "", ...(item.html_url ? { url: item.html_url } : {}),
      })),
      ...issueComments.map((item) => ({
        id: `issue:${item.id}`, kind: "issue_comment" as const, author: item.user?.login ?? "",
        created_at: item.created_at ?? "", ...(item.html_url ? { url: item.html_url } : {}),
      })),
      ...reviewComments.map((item) => ({
        id: `comment:${item.id}`, kind: "review_comment" as const, author: item.user?.login ?? "",
        ...(item.commit_id ? { commit_id: item.commit_id } : {}), created_at: item.created_at ?? "",
        ...(item.html_url ? { url: item.html_url } : {}),
      })),
    ];
  }

  private async gh(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync("gh", args, {
        env: this.env,
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      });
      return stdout;
    } catch (error) {
      const candidate = error as Error & { stderr?: string; code?: number | string };
      const detail = candidate.stderr?.trim() || candidate.message;
      const auth = /auth|authentication|HTTP 401|HTTP 403|not logged/i.test(detail);
      if (auth) throw new GithubAuthError(detail);
      throw new LoopError(`gh failed: ${detail}`, "github_command", true);
    }
  }
}
