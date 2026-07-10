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
- The injected control panel is outside the platform Vue root (`#app`); never scan the whole document for a bare `500`, because diagnostic lines such as `500=false` would self-trigger the recovery path. Scope platform error text to `#app` and retain visible platform error-toast checks.
- Task navigation must open collapsed ancestor course items from outermost to innermost before dispatching its task click. Do not expand every task row during model construction.
- Cache reset must only remove assistant-owned `ouchn_autoplay_*` keys from local/session storage. Never call storage-wide clear methods because they may remove platform login or unrelated preferences.
- Automatic F5 recovery persists a task pointer plus a unique directory-scan ID, reloads `#/myCourse/study` with that ID, and rebuilds the task list from stable DOM before matching the saved pointer. The full directory model is never persisted.
- Recovery attempts are intentionally unlimited; exponential delay remains capped to avoid repeatedly hammering the platform.
- Update checking is based on the latest published GitHub Release tag and numeric version comparison, never branch-file inequality.

## Verification Baseline

- Use the Node built-in regression harness in `tests/autoplayer-regression.test.js` plus JavaScript syntax and whitespace checks.
- Live platform validation requires a logged-in browser session and may be blocked by CAPTCHA or expired authentication; never record credentials here.
- On 2026-07-10, the Codex Edge browser connection inspected an authenticated course page: `#app` excluded the injected panel, and a chapter button changed from `aria-expanded=false` to `true` on click. Browser security policy blocks visiting `edge://extensions`, so Tampermonkey script installation remains user-operated; local regression tests verify the release artifact.
