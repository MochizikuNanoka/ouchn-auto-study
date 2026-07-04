<p align="center">
  <img src="https://img.shields.io/badge/version-2.0.1-%23D4893B" alt="version">
  <img src="https://img.shields.io/badge/platform-Tampermonkey-%23000" alt="platform">
  <img src="https://img.shields.io/badge/browser-Edge%20%7C%20Chrome-blue" alt="browser">
</p>

# 国开学习平台 自动刷课助手

> 国家开放大学（电大中专）学习平台自动刷课脚本 — 自动播放视频 + 配合爱问答助手自动交卷，断点续传，500 容错

## 适用平台

| 平台 | 网址 | 状态 |
|------|------|------|
| 电大中专 | `zydz-menhu.ouchn.edu.cn` | 已测试 |

## 功能

| 功能 | 说明 |
|------|------|
| 自动看视频 | 解析课程总览页进度，跳过已完成，自动播放未完成视频，99% 保底后 10s 强制完成 |
| 自动交卷 | 检测爱问答助手答题完成 → 自动交卷 → 确认 → 查看试卷 → 返回课程页 |
| 500 容错 | 页面出错自动 F5 刷新，指数退避最多 5 次 |
| 断点续传 | 进度存 localStorage（key `ouchn_autoplay_v2`），页面刷新/崩溃后自动恢复 |
| 看门狗 | 超过 120 秒无进展自动 F5 恢复 |
| 顺序纠错 | 平台弹"请先完成 X.X"时自动匹配并导航到正确节次 |
| 调试面板 | 可手动指定节次索引、重置进度、检查更新 |

## 安装

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展
2. 打开 Tampermonkey 管理面板 → **添加新脚本**
3. 将 [国开学习平台-自动刷课助手.user.js](./国开学习平台-自动刷课助手.user.js) 全部内容粘贴进去
4. `Ctrl+S` 保存

## 使用

1. 登录学习平台，进入课程总览页
2. 右上角出现控制面板，点击 **开始**
3. 脚本自动展开章节 → 扫描节次 → 逐个处理

> 考试答题依赖**爱问答助手**插件。检测逻辑基于答题卡 `.everyAnswer.AnswerEnd` 类名。

## 控制面板

| 按钮 | 功能 |
|------|------|
| 开始 | 启动自动刷课 |
| 暂停 / 继续 | 暂停或恢复当前循环 |
| 停止 | 停止并清除 localStorage 进度 |
| D | 展开调试面板（手动索引、重置状态、检查更新） |

## 技术架构 (v2)

### 核心改进：domIndex 稳定定位

v1 通过标题文本匹配定位节次，但课程页面存在大量同名节次（视频和考试标题相同、跨章节重名），导致"漂移"。

v2 改为基于 DOM 索引（`domIndex`）的稳定定位：

```
CourseModel.buildModel()
  -> expandAllChapters()       展开所有章节级面板
  -> 遍历 el-collapse-item     按 bodyText 区分视频（含时长+百分比）和考试（以"测验"开头）
  -> 构建层级模型              章节 -> 节次对（pair）-> {video, exam}
  -> getPendingTasks()         展平为任务列表，每项带 domIndex
  -> navigateToDomIndex()      按全局索引直接定位，不依赖文本
```

### 关键 DOM 结构

```html
<div class="el-collapse-item">          <!-- 章节级 -->
  <div class="el-collapse-item__header">
    <div class="chapter_name"><span>项目一: ...</span></div>
    <div class="title_vice">完成/未完成</div>
  </div>
</div>
<div class="el-collapse-item">          <!-- 节次级（视频或考试） -->
  <div class="el-collapse-item__header">
    <div class="title"><span>1.1 Linux操作系统概述</span></div>
  </div>
  <div class="el-collapse-item__wrap">
    <!-- 视频: bodyText 含 (00:14:28) + 百分比 -->
    <!-- 考试: bodyText 以"测验"开头 + "章节测试：合格/未进行" -->
  </div>
</div>
```

### 状态存储

```json
{
  "chapterIdx": 0,
  "pairIdx": 2,
  "itemType": "exam",
  "title": "1.3 文件权限管理",
  "totalTasks": 49,
  "stats": { "videos": 15, "exams": 10, "errors": 0, "skipped": 0 },
  "timestamp": 1751689200000
}
```

## 版本历史

| 版本 | 日期 | 说明 |
|------|------|------|
| 2.0.1 | 2026-07-05 | 修复 task-is-not-defined、_reloading 死循环、waitForPlugin 超时恢复、Promise 异常处理 |
| 2.0.0 | 2026-07 | 重构为 domIndex 稳定定位，消除节次漂移 |
| 1.0.7 | 2026-06 | 平台提示纠错、F5 刷新优化 |
| 1.0.6 | 2026-06 | 修复考试点击目标、stop() 清理看门狗 |

## License

MIT
