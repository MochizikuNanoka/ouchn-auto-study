# v2.0.7 技术规格

## Directory Diagnostics

- Add a structured `CourseModel` diagnostic result for each failed readiness condition: no collapse items, no chapter headers, or no parseable task entries.
- Emit the result through the existing `Logger`, including route, DOM counts, and retry state. Do not record credentials or full page text.
- Keep the existing bootstrap recovery state when parsing fails.

## 状态等待与目录展开

- Do not inspect arbitrary page text or error toasts for `500`, `服务器错误`, or `AxiosError` to decide whether to refresh.
- Treat a missing stable course directory, video player, or exam card status after its existing timeout as the only recovery trigger. Once exam card status exists, keep waiting for completion instead of refreshing.
- Expand only chapter-level collapse items during model construction; opening every task row would add avoidable delay.
- When navigating to a target task, expand each collapsed ancestor collapse item from outermost to innermost before dispatching the task click.

## Cache Reset and Fresh Directory Scans

- Add a control-panel reset action that removes only assistant keys with the `ouchn_autoplay_` prefix from local and session storage. It must never call `localStorage.clear()` or clear platform authentication state.
- The reset action stops the current controller, clears its in-memory task model, then reloads the course-overview route with a unique scan token.
- `_requestReload()` must persist only the current task pointer, statistics, retry metadata, and a fresh directory-scan token. It must route to `#/myCourse/study` with that token before reloading.
- On recovery, discard all in-memory task arrays, require the matching scan token in the route, wait for stable DOM, then build a new model before matching the saved task pointer.
- Keep the scan token out of the next ordinary checkpoint after a successful model rebuild so normal task progression remains compact.

## 中文用户界面文案

- Use Chinese for comments, README prose, panel labels, and log messages.
- Keep standard log-level tags (`[INFO]`, `[WARN]`, `[ERROR]`, `[SUCCESS]`, `[DEBUG]`) and code/selector identifiers unchanged where they are machine-facing.

## Retry Policy

- Keep `retryCount` for observability and exponential-delay calculation.
- Delete the branch that turns `autoResume` off once `retryCount` exceeds `MAX_RETRIES`.
- Retain the capped delay (`RETRY_DELAY_MAX`) to prevent request storms.

## Update Check

- Fetch `https://api.github.com/repos/MochizikuNanoka/ouchn-auto-study/releases/latest`.
- Ignore draft/prerelease data by relying on the latest published endpoint.
- Compare `tag_name` with the local metadata version using a small numeric semantic-version comparator that accepts an optional leading `v`.
- Open the release URL only when the remote version is strictly greater.

## Verification

```powershell
node --check .\国开学习平台-自动刷课助手.user.js
node --test .\tests\autoplayer-regression.test.js
git diff --check
```

Live Edge verification focuses on: normal directory expansion in the presence of diagnostic logs, slow/failed directory recovery, F5 continuation, and update-panel behavior against the actual latest Release.
