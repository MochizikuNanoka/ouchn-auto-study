# v2.0.3 Reliability and Release PRD

## Goal

Make course-directory recovery observable and reliable, keep retrying recoverable platform failures without an arbitrary attempt limit, and publish a correct GitHub Release-based update signal.

## User Value

- A temporary platform outage or slow course directory no longer leaves the user at a stopped script after five attempts.
- Diagnostic records explain why the directory was not recognized, so a platform DOM change can be diagnosed from evidence rather than guesswork.
- The update panel only announces versions that are newer than the installed version and have actually been published as GitHub Releases.

## Acceptance Criteria

1. A missing, partial, or unparsable course directory records a structured diagnostic entry in the browser log and does not clear the recovery state.
2. Retry state survives F5 and continues past five attempts, using bounded exponential delay between refreshes.
3. Update checking reads the repository's latest published Release and treats `v2.0.1` as older than local `2.0.2`/`2.0.3`.
4. Unit tests cover the changed recovery, version-comparison, and diagnostic paths.
5. The v2.0.3 userscript is committed, pushed to GitHub, tagged, and published as a GitHub Release after verification.

## Constraints and Risks

- The userscript runs with `@grant none`; it cannot safely append to a local `log.txt` at runtime. `log.txt` is a diagnostic artifact for development; runtime evidence remains in the injected panel and browser console.
- Live browser testing may require an existing authenticated Edge session. Login, CAPTCHA, and credentials stay user-operated.
- Removing the retry cap can cause long-lived recovery loops during an outage; the delay remains exponentially backed off and capped per attempt.
