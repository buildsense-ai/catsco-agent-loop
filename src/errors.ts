export class LoopError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable = false,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LoopError";
  }
}

export class CatscoAuthError extends LoopError {
  constructor(message: string, status = 401) {
    super(message, "catsco_auth", false, status);
    this.name = "CatscoAuthError";
  }
}

export class GithubAuthError extends LoopError {
  constructor(message: string) {
    super(message, "github_auth", false);
    this.name = "GithubAuthError";
  }
}
