# v2.0.4 Technical Specification

## Directory Diagnostics

- Add a structured `CourseModel` diagnostic result for each failed readiness condition: no collapse items, no chapter headers, no parseable task entries, and detected server error.
- Emit the result through the existing `Logger`, including route, DOM counts, visible error text summary, and retry state. Do not record credentials or full page text.
- Keep the existing bootstrap recovery state when parsing fails.

## Server Error Boundary and Expansion

- Detect error text from the platform Vue root (`#app`) rather than the entire document, because the injected control panel contains diagnostic strings such as `500=false`.
- Preserve visible `.el-message--error` checks for platform error toasts.
- Expand only chapter-level collapse items during model construction; opening every task row would add avoidable delay.
- When navigating to a target task, expand each collapsed ancestor collapse item from outermost to innermost before dispatching the task click.

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
