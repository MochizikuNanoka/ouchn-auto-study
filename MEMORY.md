# Project Memory

## Product and Runtime

- Product: a Tampermonkey assistant for the Chinese OUCN learning platform.
- Runtime: a single browser userscript; no package manager or build step.
- Supported browser context: Edge or Chrome with Tampermonkey.

## Reliability Decisions

- Task recovery uses browser `localStorage` and identifies a task by course ID, chapter index, pair index, and task type.
- Course-directory parsing must distinguish a genuinely complete course from a page that is still loading or has failed.
- Video completion requires a post-completion delay so platform-side study progress can persist before navigation.
- Browser errors should preserve enough state for recovery but must not silently skip a task.
- Course-directory readiness is a stable-DOM condition: wait for chapter headers, then for expanded course items, and log compact `[CourseDirectory]` snapshots when either condition is absent.
- Recovery attempts are intentionally unlimited; exponential delay remains capped to avoid repeatedly hammering the platform.
- Update checking is based on the latest published GitHub Release tag and numeric version comparison, never branch-file inequality.

## Verification Baseline

- Use the Node built-in regression harness in `tests/autoplayer-regression.test.js` plus JavaScript syntax and whitespace checks.
- Live platform validation requires a logged-in browser session and may be blocked by CAPTCHA or expired authentication; never record credentials here.
- On 2026-07-10, the Windows browser-control helper could not verify the current Edge URL and stopped before live inspection. Local regression tests are the verification fallback for v2.0.3.
