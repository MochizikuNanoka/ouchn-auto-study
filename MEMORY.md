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
- 不以页面中的 `500`、服务器错误、`AxiosError` 或错误提示文本触发恢复；题干和平台正常文案可能含这些字样。只在课程目录、视频播放器或题目状态等待超时未就绪时，保存断点并 F5 恢复。
- 答题卡状态一旦出现，即使答题插件尚未完成也持续等待，不按五分钟完成超时刷新；只有整个等待窗口始终未读取到答题卡状态时才恢复刷新。
- 题目状态首次出现时只记录一次 `[INFO]`，不得在轮询中重复输出 WARN。
- 控制面板采用「暖石墨控制台」方向：墨黑底、暖白文字、陶土橙仅用于主操作和运行状态；状态、操作、统计和日志保持分区，避免霓虹渐变和装饰性图标。
- DEBUG 日志默认关闭，只在“调试与更新”中显式开启；关闭时同时过滤助手面板和本脚本控制台输出。外部答题插件的控制台日志不受本脚本控制。
- 项目规格文档放在 `docs/`，发布封面放在 `assets/`；根目录的 `log.txt` 是本地诊断样本，保持忽略且不发布。
- Task navigation must open collapsed ancestor course items from outermost to innermost before dispatching its task click. Do not expand every task row during model construction.
- Cache reset must only remove assistant-owned `ouchn_autoplay_*` keys from local/session storage. Never call storage-wide clear methods because they may remove platform login or unrelated preferences.
- Automatic F5 recovery persists a task pointer plus a unique directory-scan ID, reloads `#/myCourse/study` with that ID, and rebuilds the task list from stable DOM before matching the saved pointer. The full directory model is never persisted.
- Recovery attempts are intentionally unlimited; exponential delay remains capped to avoid repeatedly hammering the platform.
- Update checking is based on the latest published GitHub Release tag and numeric version comparison, never branch-file inequality.

## Verification Baseline

- Use the Node built-in regression harness in `tests/autoplayer-regression.test.js` plus JavaScript syntax and whitespace checks.
- Live platform validation requires a logged-in browser session and may be blocked by CAPTCHA or expired authentication; never record credentials here.
- On 2026-07-10, the Codex Edge browser connection inspected an authenticated course page: `#app` excluded the injected panel, and a chapter button changed from `aria-expanded=false` to `true` on click. Browser security policy blocks visiting `edge://extensions`, so Tampermonkey script installation remains user-operated; local regression tests verify the release artifact.
