# v2.0.10 技术规格

## Directory Diagnostics

- Add a structured `CourseModel` diagnostic result for each failed readiness condition: no collapse items, no chapter headers, or no parseable task entries.
- Emit the result through the existing `Logger`, including route, DOM counts, and retry state. Do not record credentials or full page text.
- Keep the existing bootstrap recovery state when parsing fails.

## 状态等待与目录展开

- Do not inspect arbitrary page text or error toasts for `500`, `服务器错误`, or `AxiosError` to decide whether to refresh.
- Treat a missing stable course directory, video player, or exam card status after its existing timeout as the only recovery trigger. Once exam card status exists, keep waiting for completion instead of refreshing.
- When `AnswerEnd` cards account for at least 80% of the answer cards and their count has not increased for 40 seconds, continue into the existing submit flow. Reset the 40-second timer whenever the completed-card count grows.
- Expand only chapter-level collapse items during model construction; opening every task row would add avoidable delay.
- When navigating to a target task, expand each collapsed ancestor collapse item from outermost to innermost before dispatching the task click.
- `domIndex` 只能用于诊断，不能作为点击身份。任务必须以章节名、`.title` 的完整文本、视频/考试类型和章节内课程项序号重新解析；旧索引变化时记录重定位结果，找不到唯一目标时拒绝点击并走恢复流程。

## Cache Reset and Fresh Directory Scans

- Add a control-panel reset action that removes only assistant keys with the `ouchn_autoplay_` prefix from local and session storage. It must never call `localStorage.clear()` or clear platform authentication state.
- The reset action stops the current controller, clears its in-memory task model, then reloads the course-overview route with a unique scan token.
- `_requestReload()` must persist only the current task pointer, statistics, retry metadata, and a fresh directory-scan token. It must route to `#/myCourse/study` with that token before reloading.
- 任务断点额外保存 `chapterItemIndex`；恢复时优先比较章节、类型、完整标题和章节内序号。旧断点没有该字段时，标题不一致不得按旧 `pairIdx` 误续跑。
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

- Request `https://github.com/MochizikuNanoka/ouchn-auto-study/releases/latest` with `GM_xmlhttpRequest`; do not consume the unauthenticated GitHub REST API quota.
- Read the published release tag from Tampermonkey's redirect-aware `finalUrl`.
- Compare the redirected tag with the local metadata version using a small numeric semantic-version comparator that accepts an optional leading `v`.
- Open the release URL only when the remote version is strictly greater.

## Verification

```powershell
node --check .\国开学习平台-自动刷课助手.user.js
node --test .\tests\autoplayer-regression.test.js
git diff --check
```

Live Edge verification focuses on: normal directory expansion in the presence of diagnostic logs, slow/failed directory recovery, F5 continuation, and update-panel behavior against the actual latest Release.

## Server酱³完成通知

- Add `GM_getValue`, `GM_setValue`, and `GM_xmlhttpRequest` grants plus the Tampermonkey-compatible `push.ft07.com` connection permission; the parent domain permission covers UID subdomains.
- Because GM grants move the userscript into Tampermonkey's sandbox, dispatched page `MouseEvent` objects must not include the sandbox `window` as `view`; `bubbles` and `cancelable` are sufficient for Vue navigation.
- Store the SendKey only in Tampermonkey private storage under `serverchan3_sendkey`.
- Accept Server酱³ keys matching `^sctp(\d+)t`; extract the UID and POST URL-encoded `title` and `desp` fields to `https://<uid>.push.ft07.com/send/<sendkey>.send`.
- Trigger notification only from `_finishNormally()`. Guard it per run so repeated completion calls cannot duplicate the message.
- Reuse the same request path for a user-triggered test message; save the current input before sending.
- A missing/invalid key or network error must not block normal task cleanup and must never expose the SendKey in logs.
