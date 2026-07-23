# v2.0.14 发布说明

## Server酱³完成通知

- 可在主操作区保存 SendKey，并发送测试消息确认配置。
- 全部学习任务正常完成后，向手机发送课程 ID、视频、考试和异常统计。
- SendKey 仅保存在 Tampermonkey 私有存储中，不写入页面缓存或日志。

## 控制面板

- 消息通知移入常用操作区，清缓存重置收进“调试与更新”。
- 增加爱问答助手、GitHub 项目和 Bilibili 作者主页入口。
- GitHub 与 Bilibili 使用圆形纯图标，运行记录支持框选复制。
- 增大操作按钮高度，并移除多余的初始化提示。

## 兼容性修复

- 修复启用 GM 权限进入 Tampermonkey 沙箱后，课程点击事件因跨上下文 `MouseEvent.view` 报错的问题。
- Server酱³请求使用 `push.ft07.com` 父域权限，兼容不同 UID 子域名。

## 验证

- JavaScript 语法检查、Node 回归测试和 diff 空白检查全部通过。
- 使用本机 Edge 引擎检查常规和窄屏控制面板布局。
