# v2.0.9 控制面板与日志整理 PRD

## Goal

移除页面文本中的 500/错误判定。只有课程目录、视频播放器或答题状态在规定等待时间内没有就绪时，才执行可恢复的 F5；刷新后仍从新的课程总览目录重建任务。

## User Value

- A temporary platform outage or slow course directory no longer leaves the user at a stopped script after five attempts.
- Diagnostic records explain why the directory was not recognized, so a platform DOM change can be diagnosed from evidence rather than guesswork.
- The update panel only announces versions that are newer than the installed version and have actually been published as GitHub Releases.
- 题干、答题提示或平台正文中出现“500”不会中断答题；读到答题卡状态后持续等待插件完成。
- A user can reset only assistant-owned cache without clearing login state or other platform data.
- Automatic recovery keeps the current task pointer but discards the prior directory model and rescans the directory.

## Acceptance Criteria

1. A missing, partial, or unparsable course directory records a structured diagnostic entry in the browser log and does not clear the recovery state.
2. Retry state survives F5 and continues past five attempts, using bounded exponential delay between refreshes.
3. Update checking reads the repository's latest published Release and treats `v2.0.1` as older than local `2.0.2`/`2.0.3`.
4. 课程目录或答题页出现任意 500/服务器错误/AxiosError 文本时，脚本不以该文本触发刷新；仅在目录或题目状态等待超时时恢复。
5. A visible cache-reset button clears only `ouchn_autoplay_*` storage entries, stops the running task, and reloads the course overview without logging the user out.
6. An automatic F5 recovery writes a unique directory-scan token, reloads the course overview with that token, and rebuilds pending tasks from the newly parsed directory.
7. User-visible comments, README prose, and runtime logs are Chinese, except unavoidable product names, protocol names, selectors, and code identifiers.
8. Unit tests cover cache clearing, fresh-scan recovery, version comparison, and existing recovery paths.
9. The v2.0.9 userscript is committed, pushed to GitHub, tagged, and published as a GitHub Release after verification.

## Constraints and Risks

- The userscript runs with `@grant none`; it cannot safely append to a local `log.txt` at runtime. `log.txt` is a diagnostic artifact for development; runtime evidence remains in the injected panel and browser console.
- Live browser testing may require an existing authenticated Edge session. Login, CAPTCHA, and credentials stay user-operated.
- Removing the retry cap can cause long-lived recovery loops during an outage; the delay remains exponentially backed off and capped per attempt.
