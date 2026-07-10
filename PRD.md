# v2.0.5 Cache Reset and Fresh Directory Scan PRD

## Goal

Give users a safe way to discard stale assistant cache, and ensure every automatic F5 recovery rebuilds the course directory from a new course-overview route instead of relying on the previous SPA directory state.

## User Value

- A temporary platform outage or slow course directory no longer leaves the user at a stopped script after five attempts.
- Diagnostic records explain why the directory was not recognized, so a platform DOM change can be diagnosed from evidence rather than guesswork.
- The update panel only announces versions that are newer than the installed version and have actually been published as GitHub Releases.
- The script's own diagnostic text can never block course-directory expansion.
- A user can reset only assistant-owned cache without clearing login state or other platform data.
- Automatic recovery keeps the current task pointer but discards the prior directory model and rescans the directory.

## Acceptance Criteria

1. A missing, partial, or unparsable course directory records a structured diagnostic entry in the browser log and does not clear the recovery state.
2. Retry state survives F5 and continues past five attempts, using bounded exponential delay between refreshes.
3. Update checking reads the repository's latest published Release and treats `v2.0.1` as older than local `2.0.2`/`2.0.3`.
4. A normal platform page containing the control-panel diagnostic text `500=false` is not treated as a server failure.
5. A visible cache-reset button clears only `ouchn_autoplay_*` storage entries, stops the running task, and reloads the course overview without logging the user out.
6. An automatic F5 recovery writes a unique directory-scan token, reloads the course overview with that token, and rebuilds pending tasks from the newly parsed directory.
7. User-visible comments, README prose, and runtime logs are Chinese, except unavoidable product names, protocol names, selectors, and code identifiers.
8. Unit tests cover cache clearing, fresh-scan recovery, version comparison, and existing recovery paths.
9. The v2.0.5 userscript is committed, pushed to GitHub, tagged, and published as a GitHub Release after verification.

## Constraints and Risks

- The userscript runs with `@grant none`; it cannot safely append to a local `log.txt` at runtime. `log.txt` is a diagnostic artifact for development; runtime evidence remains in the injected panel and browser console.
- Live browser testing may require an existing authenticated Edge session. Login, CAPTCHA, and credentials stay user-operated.
- Removing the retry cap can cause long-lived recovery loops during an outage; the delay remains exponentially backed off and capped per attempt.
