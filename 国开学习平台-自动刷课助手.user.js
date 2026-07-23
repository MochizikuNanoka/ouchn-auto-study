// ==UserScript==
// @name         国开学习平台 自动刷课助手
// @namespace    https://zydz-menhu.ouchn.edu.cn/
// @version      2.0.14
// @description  国开学习平台（电大中专）自动刷课助手：自动播放视频、配合爱问答助手自动交卷，支持可靠断点续传与课程目录重新扫描
// @author       Hermes
// @match        https://zydz-menhu.ouchn.edu.cn/learningPlatform/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      push.ft07.com
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  // ======================== 配置 ========================
  const CONFIG = {
    VERSION: '2.0.14',
    VIDEO_CHECK_INTERVAL: 3000,
    EXAM_CHECK_INTERVAL: 2000,
    EXAM_STALLED_COMPLETE_RATIO: 0.8,
    EXAM_STALLED_COMPLETE_MS: 40000,
    NAVIGATION_TIMEOUT: 15000,
    COURSE_DIRECTORY_TIMEOUT: 30000,
    COURSE_DIRECTORY_STABLE_MS: 1500,
    COURSE_DIRECTORY_POLL_INTERVAL: 500,
    RETRY_DELAY_BASE: 2000,
    RETRY_DELAY_MAX: 30000,
    NAVIGATION_ATTEMPTS: 5,
    RELEASE_API_URL: 'https://api.github.com/repos/MochizikuNanoka/ouchn-auto-study/releases/latest',
    GITHUB_REPO_URL: 'https://github.com/MochizikuNanoka/ouchn-auto-study',
    BILIBILI_PROFILE_URL: 'https://space.bilibili.com/523746311',
    AIASK_URL: 'https://www.aiask.site/',
    SERVERCHAN_DOC_URL: 'https://doc.sc3.ft07.com/zh/serverchan3',
    SERVERCHAN_SENDKEY_STORAGE_KEY: 'serverchan3_sendkey',
    VIDEO_POST_COMPLETE_DELAY: 10000,
    DIRECTORY_SCAN_QUERY: '_apScan',
    CACHE_RESET_RELOAD_DELAY: 300,
    STORAGE_KEY: 'ouchn_autoplay_v2',
  };

  // ======================== 日志系统 ========================
  const LogLevel = { INFO: 'INFO', WARN: 'WARN', ERROR: 'ERROR', SUCCESS: 'SUCCESS', DEBUG: 'DEBUG' };

  class Logger {
    constructor() {
      this.logs = [];
      this.maxLogs = 300;
      this.onLogCallbacks = [];
      this.debugEnabled = false;
    }
    _format(level, msg, data) {
      if (level === LogLevel.DEBUG && !this.debugEnabled) return;
      const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      const line = `[${ts}] [${level}] ${msg}`;
      const entry = { ts, level, msg, data: data || '', line };
      this.logs.push(entry);
      if (this.logs.length > this.maxLogs) this.logs.shift();
      const consoleMsg = `[自动刷课助手] ${line}`;
      (level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log)(consoleMsg, data || '');
      this.onLogCallbacks.forEach(cb => cb(entry));
    }
    info(msg, data) { this._format(LogLevel.INFO, msg, data); }
    warn(msg, data) { this._format(LogLevel.WARN, msg, data); }
    error(msg, data) { this._format(LogLevel.ERROR, msg, data); }
    success(msg, data) { this._format(LogLevel.SUCCESS, msg, data); }
    debug(msg, data) { this._format(LogLevel.DEBUG, msg, data); }
    setDebugEnabled(enabled) { this.debugEnabled = Boolean(enabled); }
    onLog(cb) { this.onLogCallbacks.push(cb); }
    getRecent(n) { return this.logs.slice(-n); }
  }

  const logger = new Logger();

  // ======================== 工具函数 ========================
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function waitForElement(selector, timeout = CONFIG.NAVIGATION_TIMEOUT) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = document.querySelector(selector);
      if (el) return el;
      await sleep(500);
    }
    return null;
  }

  async function waitForElements(selector, minCount = 1, timeout = CONFIG.NAVIGATION_TIMEOUT) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const els = document.querySelectorAll(selector);
      if (els.length >= minCount) return [...els];
      await sleep(500);
    }
    return [];
  }

  function getHashParams(hash = window.location.hash) {
    const queryIndex = hash.indexOf('?');
    return new URLSearchParams(queryIndex < 0 ? '' : hash.slice(queryIndex + 1));
  }

  function getCourseIdFromHash(hash = window.location.hash) {
    const params = getHashParams(hash);
    return params.get('courseId') || params.get('id') || '';
  }

  function getDirectoryScanId(hash = window.location.hash) {
    return getHashParams(hash).get(CONFIG.DIRECTORY_SCAN_QUERY) || '';
  }

  function createDirectoryScanId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function courseOverviewHash(courseId, scanId = '') {
    const params = new URLSearchParams();
    if (courseId) params.set('id', courseId);
    if (scanId) params.set(CONFIG.DIRECTORY_SCAN_QUERY, scanId);
    const query = params.toString();
    return `#/myCourse/study${query ? `?${query}` : ''}`;
  }

  function compareVersions(left, right) {
    const parse = value => {
      const match = String(value || '').trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/i);
      return match ? [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)] : null;
    };
    const leftParts = parse(left);
    const rightParts = parse(right);
    if (!leftParts || !rightParts) return null;
    for (let index = 0; index < leftParts.length; index++) {
      if (leftParts[index] > rightParts[index]) return 1;
      if (leftParts[index] < rightParts[index]) return -1;
    }
    return 0;
  }

  // ======================== 完成通知 ========================
  class ServerChanNotifier {
    static getSendKey() {
      return String(GM_getValue(CONFIG.SERVERCHAN_SENDKEY_STORAGE_KEY, '') || '').trim();
    }

    static setSendKey(sendKey) {
      GM_setValue(CONFIG.SERVERCHAN_SENDKEY_STORAGE_KEY, String(sendKey || '').trim());
    }

    static getEndpoint(sendKey) {
      const key = String(sendKey || '').trim();
      const match = key.match(/^sctp(\d+)t/i);
      if (!match || /\s/.test(key)) return null;
      return `https://${match[1]}.push.ft07.com/send/${encodeURIComponent(key)}.send`;
    }

    static async send(title, desp, successMessage) {
      const sendKey = ServerChanNotifier.getSendKey();
      if (!sendKey) return false;

      const endpoint = ServerChanNotifier.getEndpoint(sendKey);
      if (!endpoint) {
        logger.warn('Server酱³ SendKey 格式无效，未发送消息');
        return false;
      }

      const body = new URLSearchParams({
        title,
        desp,
      }).toString();

      try {
        await new Promise((resolve, reject) => {
          GM_xmlhttpRequest({
            method: 'POST',
            url: endpoint,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
            data: body,
            timeout: 15000,
            onload: response => {
              if (response.status >= 200 && response.status < 300) resolve();
              else reject(new Error(`HTTP ${response.status}`));
            },
            onerror: () => reject(new Error('网络请求失败或被脚本管理器拦截')),
            ontimeout: () => reject(new Error('请求超时')),
          });
        });
        logger.success(successMessage);
        return true;
      } catch (error) {
        logger.warn(`Server酱³ 消息发送失败：${error.message}`);
        return false;
      }
    }

    static sendTaskCompleted(stats, courseId) {
      return ServerChanNotifier.send(
        '国开学习任务已完成',
        [
          `课程 ID：${courseId || '未知'}`,
          `视频完成：${stats.videos || 0}`,
          `考试完成：${stats.exams || 0}`,
          `异常次数：${stats.errors || 0}`,
        ].join('\n'),
        'Server酱³ 完成通知已发送',
      );
    }

    static sendTest() {
      return ServerChanNotifier.send(
        '国开学习助手测试消息',
        'Server酱³消息通知配置正常。',
        'Server酱³ 测试消息已发送',
      );
    }
  }

  function isCoursePage() {
    return window.location.hash.includes('/myCourse/study');
  }

  function isVideoPage() {
    return !!document.querySelector('#xgPlayer') || window.location.hash.includes('vidoStudy');
  }

  function isExamPage() {
    return !!document.querySelector('.examQuestion') || window.location.hash.includes('examQuestion');
  }

  // 检测平台弹窗提示"请先完成X.X"，提取应先完成的节次标题
  function detectOrderHint() {
    // 可能的弹窗选择器：.el-message-box、.el-dialog、.el-notification、.el-alert。
    const dialogEls = document.querySelectorAll('.el-message-box, .el-dialog, .el-notification, .el-alert, .el-message');
    for (const el of dialogEls) {
      const text = el.textContent || '';
      // 匹配 "请先完成"、"请先学习"、"先完成" 等模式
      const m = text.match(/(?:请先(?:完成|学习|通过)|先(?:完成|学习)|应先(?:完成|学习))[：:]*\s*(.+?)(?:[，。!！\s]|$)/);
      if (m) {
        let target = m[1].trim();
        // 规范化：去掉"的课程""章节""节次"等后缀
        target = target.replace(/(?:的课程|章节|节次|部分)\s*$/, '');
        return target;
      }
      // 直接匹配 "请先完成" 后面的内容（更宽松的模式）
      const m2 = text.match(/请先完成[：:]*\s*(.+?)(?:[，。!！\s]|$)/);
      if (m2) {
        let target = m2[1].trim();
        target = target.replace(/(?:的课程|章节|节次|部分)\s*$/, '');
        return target;
      }
    }
    return null;
  }

  // ======================== 课程目录解析器（基于课程总览页） ========================
  // ======================== 课程模型（基于页面文本与 DOM 索引稳定定位） ========================
  class CourseModel {

    static getDirectorySnapshot() {
      const allItems = document.querySelectorAll('.el-collapse-item');
      const headers = document.querySelectorAll('.el-collapse-item__header');
      const chapterCount = [...headers].filter(header => !!header.querySelector('.chapter_name')).length;
      return {
        route: window.location.hash,
        courseId: getCourseIdFromHash(),
        allItemCount: allItems.length,
        chapterCount,
        courseItemCount: document.querySelectorAll('.hoverItem').length,
        loadingCount: document.querySelectorAll('.el-loading-mask, .el-skeleton').length,
      };
    }

    static logDirectorySnapshot(stage, snapshot, level = 'debug') {
      const stageNames = {
        'wait-start': '开始等待目录',
        'wait-populated-start': '开始等待课程项',
        'waiting-for-chapters': '等待章节加载',
        'waiting-for-course-items': '等待课程项加载',
        'candidate-found': '发现候选目录',
        'stable-ready': '目录稳定可用',
        'wait-timeout': '等待目录超时',
        'wait-populated-timeout': '等待课程项超时',
        'empty-after-stable-ready': '稳定后目录为空',
        'no-chapters-after-parse': '解析后未找到章节',
      };
      const summary = `路由=${snapshot.route || '/'} 课程=${snapshot.courseId || '?'} ` +
        `折叠项=${snapshot.allItemCount} 章节=${snapshot.chapterCount} ` +
        `课程项=${snapshot.courseItemCount} 加载层=${snapshot.loadingCount}`;
      logger[level](`[课程目录] ${stageNames[stage] || '目录状态'}：${summary}`, snapshot);
    }

    static isDirectorySnapshotReady(snapshot, requireCourseItems) {
      if (!isCoursePage()) return false;
      if (snapshot.allItemCount === 0 || snapshot.chapterCount === 0) return false;
      return !requireCourseItems || snapshot.courseItemCount > 0;
    }

    static async waitForStableDirectory({
      requireCourseItems = false,
      timeout = CONFIG.COURSE_DIRECTORY_TIMEOUT,
      stableMs = CONFIG.COURSE_DIRECTORY_STABLE_MS,
    } = {}) {
      const startedAt = Date.now();
      let stableSince = 0;
      let stableSignature = '';
      let lastDiagnostic = '';
      CourseModel.logDirectorySnapshot(requireCourseItems ? 'wait-populated-start' : 'wait-start', CourseModel.getDirectorySnapshot());

      while (Date.now() - startedAt < timeout) {
        const snapshot = CourseModel.getDirectorySnapshot();
        const ready = CourseModel.isDirectorySnapshotReady(snapshot, requireCourseItems);
        const signature = [snapshot.route, snapshot.allItemCount, snapshot.chapterCount,
          snapshot.courseItemCount, snapshot.loadingCount].join('|');

        if (!ready) {
          if (signature !== lastDiagnostic) {
            CourseModel.logDirectorySnapshot(requireCourseItems ? 'waiting-for-course-items' : 'waiting-for-chapters', snapshot);
            lastDiagnostic = signature;
          }
          stableSince = 0;
          stableSignature = '';
        } else if (signature !== stableSignature) {
          stableSignature = signature;
          stableSince = Date.now();
          CourseModel.logDirectorySnapshot('candidate-found', snapshot);
        } else if (Date.now() - stableSince >= stableMs) {
          CourseModel.logDirectorySnapshot('stable-ready', snapshot, 'success');
          return snapshot;
        }

        await sleep(CONFIG.COURSE_DIRECTORY_POLL_INTERVAL);
      }

      const timeoutSnapshot = CourseModel.getDirectorySnapshot();
      CourseModel.logDirectorySnapshot(requireCourseItems ? 'wait-populated-timeout' : 'wait-timeout', timeoutSnapshot, 'warn');
      return null;
    }

    static async expandAllChapters() {
      const allItems = document.querySelectorAll('.el-collapse-item');
      let count = 0;
      for (const item of allItems) {
        const header = item.querySelector('.el-collapse-item__header');
        if (!header) continue;
        if (!header.querySelector('.chapter_name')) continue;
        if (header.getAttribute('aria-expanded') !== 'true') {
          try { header.click(); count++; await sleep(400); } catch (e) {}
        }
      }
      if (count > 0) { await sleep(1000); }
      logger.debug('展开章节: ' + count);
    }

    static getCourseItemInfo(item) {
      const header = item?.querySelector('.el-collapse-item__header');
      const body = item?.querySelector('.el-collapse-item__wrap');
      const bodyText = body ? body.textContent.trim() : '';
      const durationMatch = bodyText.match(/（(\d{2}:\d{2}:\d{2})）/);
      const itemType = durationMatch ? 'video' : /^测验/.test(bodyText) ? 'exam' : '';
      const titleElement = header?.querySelector('.title');
      const title = titleElement ? titleElement.textContent.trim() : header ? header.textContent.trim() : '';
      return { header, body, bodyText, durationMatch, itemType, title };
    }

    static getDirectoryTaskDescriptors(allItems = document.querySelectorAll('.el-collapse-item')) {
      const descriptors = [];
      let currentChapterName = '';
      let chapterItemIndex = 0;

      for (let index = 0; index < allItems.length; index++) {
        const item = allItems[index];
        const info = CourseModel.getCourseItemInfo(item);
        if (!info.header) continue;
        const chapterNameElement = info.header.querySelector('.chapter_name span');
        if (chapterNameElement) {
          currentChapterName = chapterNameElement.textContent.trim();
          chapterItemIndex = 0;
          continue;
        }
        if (!info.itemType || !info.title) continue;
        descriptors.push({
          item,
          domIndex: index,
          chapterName: currentChapterName,
          chapterItemIndex: chapterItemIndex++,
          itemType: info.itemType,
          title: info.title,
        });
      }
      return descriptors;
    }

    static resolveTaskItem(task, allItems = document.querySelectorAll('.el-collapse-item'), { logMove = false } = {}) {
      if (!task?.title || !task?.itemType) return null;
      const candidates = CourseModel.getDirectoryTaskDescriptors(allItems).filter(descriptor =>
        descriptor.itemType === task.itemType &&
        descriptor.title === task.title &&
        (!task.chapterName || descriptor.chapterName === task.chapterName)
      );
      let target = Number.isInteger(task.chapterItemIndex)
        ? candidates.find(descriptor => descriptor.chapterItemIndex === task.chapterItemIndex)
        : null;
      if (!target && candidates.length === 1) target = candidates[0];
      if (!target) {
        logger.warn(`无法唯一定位任务：${task.title}（候选 ${candidates.length} 项）`);
        return null;
      }
      if (logMove && Number.isInteger(task.domIndex) && target.domIndex !== task.domIndex) {
        logger.info(`目录索引已变化，按任务锚点重新定位：${task.domIndex} → ${target.domIndex}`);
      }
      return target;
    }

    static async buildModel({ scanId = '' } = {}) {
      if (scanId && getDirectoryScanId() !== scanId) {
        logger.warn('目录扫描标识不匹配，拒绝使用当前页面目录');
        return null;
      }
      if (scanId) logger.info('正在重新扫描课程目录');
      const initialSnapshot = await CourseModel.waitForStableDirectory();
      if (!initialSnapshot) return null;
      if (scanId && getDirectoryScanId() !== scanId) {
        logger.warn('目录扫描期间页面已变化，放弃当前目录');
        return null;
      }
      await CourseModel.expandAllChapters();
      const populatedSnapshot = await CourseModel.waitForStableDirectory({ requireCourseItems: true });
      if (!populatedSnapshot) return null;
      if (scanId && getDirectoryScanId() !== scanId) {
        logger.warn('目录扫描期间页面已变化，放弃当前目录');
        return null;
      }
      const allItems = document.querySelectorAll('.el-collapse-item');
      if (allItems.length === 0) {
        CourseModel.logDirectorySnapshot('empty-after-stable-ready', CourseModel.getDirectorySnapshot(), 'warn');
        return null;
      }
      logger.info('课程目录中共有 ' + allItems.length + ' 个折叠项');
      const chapters = [];
      var currentChapter = null;
      for (var i = 0; i < allItems.length; i++) {
        var item = allItems[i];
        var itemInfo = CourseModel.getCourseItemInfo(item);
        var header = itemInfo.header;
        if (!header) continue;
        var chNameEl = header.querySelector('.chapter_name span');
        if (chNameEl) {
          currentChapter = { name: chNameEl.textContent.trim(), chapterIdx: chapters.length, pairs: [], nextCourseItemIndex: 0 };
          chapters.push(currentChapter);
          continue;
        }
        var btxt = itemInfo.bodyText;
        var durMatch = itemInfo.durationMatch;
        var progMatch = btxt.match(/(\d{1,3})%/);
        var isVideo = itemInfo.itemType === 'video';
        var isExam = itemInfo.itemType === 'exam';
        if (isVideo && currentChapter) {
          var progress = progMatch ? parseInt(progMatch[1]) : 0;
          var vtitle = itemInfo.title;
          var ve = { domIndex: i, chapterItemIndex: currentChapter.nextCourseItemIndex++, title: vtitle, duration: durMatch ? durMatch[1] : '', progress: progress, isComplete: progress >= 100 };
          var existPair = null;
          for (var pi = 0; pi < currentChapter.pairs.length; pi++) {
            if (currentChapter.pairs[pi].video === null && currentChapter.pairs[pi].exam && currentChapter.pairs[pi].exam.title === vtitle) {
              existPair = currentChapter.pairs[pi]; break;
            }
          }
          if (existPair) { existPair.video = ve; }
          else { currentChapter.pairs.push({ video: ve, exam: null }); }
        } else if (isExam && currentChapter) {
          var stMatch = btxt.match(/章节测试[：:]\s*(.+)/);
          var status = stMatch ? stMatch[1].trim() : '未知';
          var etitle = itemInfo.title;
          var ee = { domIndex: i, chapterItemIndex: currentChapter.nextCourseItemIndex++, title: etitle, status: status, isComplete: status === '合格' };
          var mpair = null;
          for (var mpi = 0; mpi < currentChapter.pairs.length; mpi++) {
            if (!currentChapter.pairs[mpi].exam && currentChapter.pairs[mpi].video && currentChapter.pairs[mpi].video.title === etitle) {
              mpair = currentChapter.pairs[mpi]; break;
            }
          }
          if (mpair) { mpair.exam = ee; }
          else {
            var hv = false;
            for (var cpi = 0; cpi < currentChapter.pairs.length; cpi++) {
              if (currentChapter.pairs[cpi].video && currentChapter.pairs[cpi].video.title === etitle) { hv = true; break; }
            }
            if (!hv) { currentChapter.pairs.push({ video: null, exam: ee }); }
          }
        }
      }
      if (chapters.length === 0) {
        CourseModel.logDirectorySnapshot('no-chapters-after-parse', CourseModel.getDirectorySnapshot(), 'warn');
        return null;
      }

      var tv = 0, te = 0, dv = 0, de = 0;
      for (var ci = 0; ci < chapters.length; ci++) {
        for (var pj = 0; pj < chapters[ci].pairs.length; pj++) {
          if (chapters[ci].pairs[pj].video) { tv++; if (chapters[ci].pairs[pj].video.isComplete) dv++; }
          if (chapters[ci].pairs[pj].exam) { te++; if (chapters[ci].pairs[pj].exam.isComplete) de++; }
        }
      }
      logger.info('课程模型：' + chapters.length + ' 个章节，' + tv + ' 个视频，' + te + ' 个考试（' + dv + '/' + de + ' 已完成）');
      return { chapters: chapters };
    }

    static getPendingTasks(chapters) {
      var tasks = [];
      for (var ci = 0; ci < chapters.length; ci++) {
        var ch = chapters[ci];
        for (var pj = 0; pj < ch.pairs.length; pj++) {
          var pair = ch.pairs[pj];
          if (pair.video && !pair.video.isComplete) {
            tasks.push({ chapterIdx: ch.chapterIdx, chapterName: ch.name, pairIdx: pj, itemType: 'video', title: pair.video.title, domIndex: pair.video.domIndex, chapterItemIndex: pair.video.chapterItemIndex, progress: pair.video.progress });
          }
          if (pair.exam && !pair.exam.isComplete) {
            tasks.push({ chapterIdx: ch.chapterIdx, chapterName: ch.name, pairIdx: pj, itemType: 'exam', title: pair.exam.title, domIndex: pair.exam.domIndex, chapterItemIndex: pair.exam.chapterItemIndex, status: pair.exam.status });
          }
        }
      }
      return tasks;
    }

    static async expandCollapsedAncestors(targetItem) {
      const ancestors = [];
      let node = targetItem.parentElement;
      while (node) {
        if (node.classList?.contains('el-collapse-item')) ancestors.unshift(node);
        node = node.parentElement;
      }

      let count = 0;
      for (const item of ancestors) {
        const header = item.querySelector('.el-collapse-item__header');
        if (header?.getAttribute('aria-expanded') !== 'false') continue;
        header.click();
        count++;
        await sleep(400);
      }
      return count;
    }

    static async navigateToDomIndex(domIndex, taskTitle, taskType, chapterName = '', chapterItemIndex = -1) {
      // 从考试页或视频页回退后，Vue 可能尚未完成渲染，需要等待后重试。
      var allItems;
      for (let retry = 0; retry < 5; retry++) {
        allItems = document.querySelectorAll('.el-collapse-item');
        if (allItems.length > 0) break;
        await sleep(1500);
      }
      if (!allItems || allItems.length === 0) {
        logger.error('课程目录为空，页面可能尚未渲染完成');
        return false;
      }
      const task = { domIndex, title: taskTitle, itemType: taskType, chapterName, chapterItemIndex };
      const target = CourseModel.resolveTaskItem(task, allItems, { logMove: true });
      if (!target) return false;
      var targetItem = target.item;
      const openedAncestors = await CourseModel.expandCollapsedAncestors(targetItem);
      if (openedAncestors > 0) logger.debug('按需展开父级目录：' + openedAncestors);
      targetItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(400);
      var ct = targetItem.querySelector('.section') || targetItem.querySelector('.content_main') || targetItem.querySelector('.el-collapse-item__header');
      if (!ct) { logger.error('课程项 ' + target.domIndex + '：找不到可点击元素'); return false; }
      ct.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      logger.info('导航：[' + target.domIndex + '][' + getTaskTypeLabel(taskType) + '] ' + taskTitle);
      return true;
    }
  }
  // ======================== 视频处理器 ========================
  class VideoHandler {
    static async waitForCompletion(isActive = () => true) {
      logger.info('等待视频播放完成...');

      const video = await waitForElement('#xgPlayer video', 10000);
      if (!video) {
        logger.warn('未检测到视频播放器');
        return false;
      }

      // 播放（不改变倍速——平台会检测）
      if (video.paused) {
        video.play().catch(() => {
          const btn = document.querySelector('.xgplayer-play, .xgplayer-start');
          if (btn) btn.click();
        });
      }

      return new Promise((resolve) => {
        let resolved = false;
        let endingCountdownStarted = false;
        let nearCompleteTime = 0;
        let lastNearCompleteSeconds = null;
        let checkTimer = null;
        let countdownTimer = null;
        let countdownFinishTimer = null;
        let timeoutTimer = null;
        let playerStalled = false;
        let lastPlaybackTime = Number(video.currentTime);
        let lastPlaybackAdvanceTime = Date.now();

        const cleanup = () => {
          if (checkTimer) clearInterval(checkTimer);
          if (countdownTimer) clearInterval(countdownTimer);
          if (countdownFinishTimer) clearTimeout(countdownFinishTimer);
          if (timeoutTimer) clearTimeout(timeoutTimer);
        };

        const finish = (completed, reason) => {
          if (resolved) return;
          resolved = true;
          cleanup();
          if (completed) logger.success(`视频播放完成（${reason}）`);
          else logger.warn(`视频未完成（${reason}）`);
          resolve(completed);
        };

        const startEndingCountdown = (reason) => {
          if (resolved || endingCountdownStarted) return;
          endingCountdownStarted = true;
          let remaining = Math.ceil(CONFIG.VIDEO_POST_COMPLETE_DELAY / 1000);
          logger.info(`视频已结束（${reason}），${remaining} 秒倒计时后继续...`);
          countdownTimer = setInterval(() => {
            if (!isActive()) {
              finish(false, '任务已停止');
              return;
            }
            remaining--;
            if (remaining > 0) logger.info(`视频完成确认倒计时：${remaining} 秒`);
          }, 1000);
          countdownFinishTimer = setTimeout(() => {
            if (!isActive()) finish(false, '任务已停止');
            else finish(true, `${reason}后等待 ${CONFIG.VIDEO_POST_COMPLETE_DELAY / 1000} 秒`);
          }, CONFIG.VIDEO_POST_COMPLETE_DELAY);
        };

        video.addEventListener('ended', () => startEndingCountdown('收到视频结束事件'), { once: true });
        video.addEventListener('waiting', () => { playerStalled = true; });
        video.addEventListener('stalled', () => { playerStalled = true; });
        video.addEventListener('playing', () => { playerStalled = false; });
        video.addEventListener('timeupdate', () => {
          const currentTime = Number(video.currentTime);
          if (Number.isFinite(currentTime)) {
            lastPlaybackTime = currentTime;
            lastPlaybackAdvanceTime = Date.now();
            playerStalled = false;
          }
        });

        checkTimer = setInterval(() => {
          if (resolved) return;
          if (!isActive()) {
            finish(false, '任务已停止');
            return;
          }
          if (VideoHandler.needsRefresh()) {
            finish(false, '播放器已卸载或报错');
            return;
          }
          if (video.ended) {
            startEndingCountdown('检测到视频已结束');
            return;
          }
          if (endingCountdownStarted) return;

          const bar = document.querySelector('.xgplayer-progress-played');
          const pct = bar ? parseFloat(bar.style.width) : 0;
          const now = Date.now();
          const currentTime = Number(video.currentTime);
          const duration = Number(video.duration);
          if (Number.isFinite(currentTime) && (!Number.isFinite(lastPlaybackTime) || currentTime > lastPlaybackTime + 0.05)) {
            lastPlaybackTime = currentTime;
            lastPlaybackAdvanceTime = now;
            playerStalled = false;
          }
          const atNativeEnd = Number.isFinite(currentTime) && Number.isFinite(duration) && currentTime >= Math.max(0, duration - 1);
          const playbackRecentlyAdvanced = Number.isFinite(currentTime) &&
            now - lastPlaybackAdvanceTime <= CONFIG.VIDEO_CHECK_INTERVAL * 2;
          // 个别播放器不会触发“播放结束”事件（ended）。仅在真正接近时长末尾，或播放时钟仍在推进时兜底。
          // 处于等待、卡顿或播放时钟停滞的 99% 不会被误判为完成。
          const canUse99Fallback = atNativeEnd || (!video.paused && !playerStalled && playbackRecentlyAdvanced);
          if (pct >= 99 && canUse99Fallback) {
            if (!nearCompleteTime) {
              nearCompleteTime = Date.now();
              lastNearCompleteSeconds = Math.ceil(CONFIG.VIDEO_POST_COMPLETE_DELAY / 1000);
              logger.info(`进度>=99%，${lastNearCompleteSeconds} 秒倒计时后兜底完成...`);
            } else {
              const elapsed = Date.now() - nearCompleteTime;
              const secondsLeft = Math.max(0, Math.ceil((CONFIG.VIDEO_POST_COMPLETE_DELAY - elapsed) / 1000));
              if (secondsLeft !== lastNearCompleteSeconds && secondsLeft > 0) {
                lastNearCompleteSeconds = secondsLeft;
                logger.info(`视频末尾确认倒计时：${secondsLeft} 秒`);
              }
              if (elapsed >= CONFIG.VIDEO_POST_COMPLETE_DELAY) {
                finish(true, `进度达到 99% 并等待 ${CONFIG.VIDEO_POST_COMPLETE_DELAY / 1000} 秒`);
              }
            }
          } else if (nearCompleteTime) {
            nearCompleteTime = 0;
            lastNearCompleteSeconds = null;
            logger.info('99% 进度确认已重置（视频暂停、缓冲、播放时钟停滞或进度回落）');
          }
        }, CONFIG.VIDEO_CHECK_INTERVAL);

        timeoutTimer = setTimeout(() => finish(false, '等待超时(2小时)'), 2 * 3600 * 1000);
      });
    }

    static needsRefresh() {
      const v = document.querySelector('#xgPlayer video');
      if (!v) return true;
      const err = document.querySelector('.xgplayer-error');
      if (err && getComputedStyle(err).display !== 'none') return true;
      return false;
    }

  }

  // ======================== 考试处理器 ========================
  class ExamHandler {
    static isPluginDone() {
      const cards = document.querySelectorAll('.everyAnswer');
      if (cards.length === 0) return { state: 'no_cards', done: 0, total: 0 };
      const done = [...cards].filter(c => c.classList.contains('AnswerEnd')).length;
      const total = cards.length;
      if (done === total) { logger.success(`答题完成 (${done}/${total})`); return { state: 'all_done', done, total }; }
      logger.debug(`答题进度: ${done}/${total}`);
      return { state: 'in_progress', done, total };
    }

    static async waitForPlugin(timeout = 5 * 60 * 1000, shouldContinue = () => true) {
      logger.info('等待爱问答助手完成答题...');
      const start = Date.now();
      let hasQuestionStatus = false;
      let lastDoneCount = -1;
      let lastProgressAt = 0;
      while (true) {
        if (!shouldContinue()) return false;
        const progress = ExamHandler.isPluginDone();
        if (progress.state === 'all_done') return true;
        if (progress.state !== 'no_cards') {
          if (!hasQuestionStatus) logger.info('已读取题目状态，继续等待答题插件完成');
          hasQuestionStatus = true;
          if (progress.done !== lastDoneCount) {
            lastDoneCount = progress.done;
            lastProgressAt = Date.now();
          } else if (
            progress.done > 0 &&
            progress.done / progress.total >= CONFIG.EXAM_STALLED_COMPLETE_RATIO &&
            Date.now() - lastProgressAt >= CONFIG.EXAM_STALLED_COMPLETE_MS
          ) {
            logger.warn(`答题进度停滞 ${Math.round(CONFIG.EXAM_STALLED_COMPLETE_MS / 1000)} 秒，已完成 ${progress.done}/${progress.total}，疑似存在空白题，继续交卷`);
            return true;
          }
        } else if (!hasQuestionStatus && Date.now() - start >= timeout) {
          logger.error('等待题目状态超时（5分钟，未读取到题目状态）');
          return false;
        }
        await sleep(CONFIG.EXAM_CHECK_INTERVAL);
      }
    }

    static async submitExam(shouldContinue = () => true) {
      logger.info('===== 交卷流程 =====');
      const canContinue = () => {
        if (shouldContinue()) return true;
        logger.warn('交卷流程已停止');
        return false;
      };
      if (!canContinue()) return false;

      // 辅助：按文本找按钮
      const findBtnByText = (text) => {
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          if (b.textContent.includes(text)) return b;
        }
        return null;
      };

      // 1. 点击交卷
      logger.info('[1] 点击交卷...');
      const btn = await waitForElement('.paperBtn', 5000) || findBtnByText('交卷');
      if (btn) { btn.click(); logger.success('已点击交卷'); await sleep(1500); }
      else { logger.error('未找到交卷按钮'); return false; }
      if (!canContinue()) return false;

      // 2. 确认弹窗
      logger.info('[2] 确认弹窗...');
      await sleep(1000);
      if (!canContinue()) return false;
      const dialogBtns = document.querySelectorAll('.el-message-box__btns button, .el-dialog__footer button, .el-overlay button');
      let confirmed = false;
      for (const b of dialogBtns) {
        if (/确认|确定|提交/.test(b.textContent)) {
          b.click();
          confirmed = true;
          logger.success(`点击: "${b.textContent.trim()}"`);
          break;
        }
      }
      if (!confirmed) { logger.error('未找到交卷确认按钮'); return false; }
      await sleep(2000);
      if (!canContinue()) return false;

      // 3. 查看试卷
      logger.info('[3] 查看试卷...');
      await sleep(1000);
      if (!canContinue()) return false;
      const viewBtn = await waitForElement('.determine', 5000) || findBtnByText('查看试卷');
      if (viewBtn) { viewBtn.click(); logger.success('已点击查看试卷'); await sleep(1500); }
      else { logger.warn('未找到查看试卷按钮，直接返回'); }
      if (!canContinue()) return false;

      // 4. 返回 — 直接用浏览器回退
      logger.info('[4] 返回课程页...');
      await sleep(500);
      history.back();
      await sleep(2000);

      await sleep(3000);
      return true;
    }
  }

  // ======================== 状态管理 ========================
  class StateManager {
    static save(state) {
      try {
        localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(state));
        return true;
      } catch (e) {
        logger.error(`保存断点失败: ${e.message}`);
        return false;
      }
    }
    static load() { try { const r = localStorage.getItem(CONFIG.STORAGE_KEY); return r ? JSON.parse(r) : null; } catch { return null; } }
    static clear() { localStorage.removeItem(CONFIG.STORAGE_KEY); }
    static clearCache() {
      const clearStorage = storage => {
        if (!storage) return 0;
        const keys = new Set([CONFIG.STORAGE_KEY]);
        const length = Number(storage.length) || 0;
        for (let index = 0; index < length; index++) {
          const key = storage.key?.(index);
          if (key === CONFIG.STORAGE_KEY || key?.startsWith('ouchn_autoplay_')) keys.add(key);
        }

        let cleared = 0;
        for (const key of keys) {
          if (storage.getItem(key) === null) continue;
          storage.removeItem(key);
          cleared++;
        }
        return cleared;
      };

      let cleared = clearStorage(localStorage);
      if (typeof sessionStorage !== 'undefined') cleared += clearStorage(sessionStorage);
      return cleared;
    }
    static hasTaskPointer(state) {
      return !!state && Number.isInteger(state.chapterIdx) && Number.isInteger(state.pairIdx) &&
        (state.itemType === 'video' || state.itemType === 'exam');
    }
    static hasResumeState(state) {
      return StateManager.hasTaskPointer(state) ||
        (!!state && state.stage === 'initializing' && !!state.courseId);
    }
    static isResumable(state) {
      return StateManager.hasResumeState(state) && state.autoResume !== false;
    }
    static isSameTask(state, task, courseId) {
      if (!StateManager.hasTaskPointer(state) || !task) return false;
      if (!state.courseId || !courseId || String(state.courseId) !== String(courseId)) return false;
      if (state.chapterIdx !== task.chapterIdx || state.itemType !== task.itemType) return false;
      if (state.title && task.title && state.title !== task.title) return false;
      if (Number.isInteger(state.chapterItemIndex) && Number.isInteger(task.chapterItemIndex)) {
        return state.chapterItemIndex === task.chapterItemIndex;
      }
      return state.pairIdx === task.pairIdx;
    }
  }

  function shouldAutoResume(state, currentCourseId = getCourseIdFromHash()) {
    if (!StateManager.isResumable(state)) return false;
    if (!state.courseId) return false;
    return !currentCourseId || String(state.courseId) === String(currentCourseId);
  }

  function getTaskTypeLabel(type) {
    if (type === 'video') return '视频';
    if (type === 'exam') return '考试';
    return '未知类型';
  }

  // ======================== 主控制器 ========================
  class AutoPlayer {
    constructor() {
      this.running = false;
      this.paused = false;
      this._reloading = false;
      this._loopRunning = false;
      this.currentIndex = 0;
      this.sections = [];
      this.tasks = []; // 待处理任务列表
      this.stats = { videos: 0, exams: 0, errors: 0, skipped: 0 };
      this.courseId = '';
      this._runId = 0;
      this._reloadTimer = null;
      this._loopRunId = 0;
      this._completionNotificationSent = false;
    }

    restoreState() {
      const s = StateManager.load();
      if (StateManager.isResumable(s)) {
        this.stats = s.stats || { videos: 0, exams: 0, errors: 0, skipped: 0 };
        this.courseId = s.courseId || this.courseId;
        return true;
      }
      return false;
    }

    async start() {
      if (this.running) {
        logger.warn('任务已在运行中');
        return;
      }

      const savedState = StateManager.load();
      const currentCourseId = getCourseIdFromHash();
      const savedMatchesCurrentCourse = shouldAutoResume(savedState, currentCourseId);
      const forceFreshDirectory = savedMatchesCurrentCourse && savedState.forceFreshDirectory === true && !!savedState.directoryScanId;
      const isLegacyCheckpoint = StateManager.hasTaskPointer(savedState) && !savedState.courseId;
      const manuallyRestartingStoppedTask = StateManager.hasResumeState(savedState) &&
        savedState.autoResume === false &&
        (!savedState.courseId || !currentCourseId || String(savedState.courseId) === String(currentCourseId));
      if (isLegacyCheckpoint || manuallyRestartingStoppedTask) {
        StateManager.clear();
        logger.info(isLegacyCheckpoint
          ? '检测到旧版无课程 ID 的断点，已清除以避免串课；本次将重新建立断点'
          : '手动重新开始，已清除上一次停止任务的状态');
      }
      if (savedMatchesCurrentCourse) {
        this.stats = savedState.stats || this.stats;
        this.courseId = savedState.courseId || currentCourseId || this.courseId;
      } else {
        this.courseId = currentCourseId || this.courseId;
        if (StateManager.isResumable(savedState) && isCoursePage()) {
          logger.warn(`已保存的是课程 ${savedState.courseId}，当前为 ${currentCourseId}，不会串课恢复`);
        }
      }

      this.running = true;
      this.paused = false;
      this._reloading = false;
      this._completionNotificationSent = false;
      const runId = ++this._runId;

      if (forceFreshDirectory) {
        this.tasks = [];
        this.sections = [];
        this.currentIndex = 0;
        logger.info('自动刷新恢复：已丢弃旧目录，等待重新扫描');
      }

      logger.info('========================================');
      logger.info('=== 自动刷课助手 v2（DOM 索引定位）===');
      logger.info('========================================');

      // 不在课程页或目录扫描标识不匹配时，先跳转到全新的课程总览页。
      const needsCourseOverview = !isCoursePage() || (forceFreshDirectory && getDirectoryScanId() !== savedState.directoryScanId);
      if (needsCourseOverview) {
        logger.info(forceFreshDirectory ? '进入新的课程总览页，准备重新扫描目录...' : '不在课程页，导航回课程总览...');
        const targetCourseId = this.courseId || (savedMatchesCurrentCourse ? savedState.courseId : '');
        if (!targetCourseId) {
          logger.error('无法确定课程 ID，请回到课程总览页后点击开始');
          this.running = false;
          return;
        }
        window.location.hash = courseOverviewHash(targetCourseId, forceFreshDirectory ? savedState.directoryScanId : '');
        const startTime = Date.now();
        while (!isCoursePage() && Date.now() - startTime < CONFIG.NAVIGATION_TIMEOUT && this._isActiveRun(runId)) {
          await sleep(500);
        }
        if (!isCoursePage()) {
          logger.error('无法返回课程页，准备刷新恢复');
          this._requestReload('无法返回课程总览');
          return;
        }
      }

      // 根据当前页面重新构建课程模型，不复用刷新前的目录。
      let model;
      try {
        model = await CourseModel.buildModel({ scanId: forceFreshDirectory ? savedState.directoryScanId : '' });
      } catch (e) {
        logger.error(`课程目录解析异常: ${e.message}`, e.stack);
      }
      if (!this._isActiveRun(runId)) return;
      if (!model) {
        this.stats.errors++;
        logger.warn('课程目录未就绪，保留断点并刷新重试');
        this._requestReload('课程目录未加载');
        return;
      }

      // 过滤出未完成的
      this.tasks = CourseModel.getPendingTasks(model.chapters);

      if (this.tasks.length === 0) {
        logger.success('所有节次已完成');
        this._finishNormally();
        return;
      }

      logger.info('待处理任务：' + this.tasks.length + ' 个');

      // 按稳定的章节/节次/类型三元组恢复；不依赖旧版已废弃的 currentIndex。
      const savedIndex = savedMatchesCurrentCourse
        ? this.tasks.findIndex(task => StateManager.isSameTask(savedState, task, this.courseId))
        : -1;
      if (savedIndex >= 0) {
        this.currentIndex = savedIndex;
        logger.info('恢复进度：#' + (this.currentIndex + 1) + ' ' + this.tasks[this.currentIndex].title);
      } else {
        this.currentIndex = 0;
        if (savedMatchesCurrentCourse) logger.info('保存的节次已完成或课程目录已变化，从最早待办继续');
        logger.info('起始任务：' + this.tasks[0].title);
      }

      // 同一节的失败次数需要跨“总览页可加载、视频页尚未就绪”的场景保留。
      // 真正完成并切换到下一节时，_saveState() 会因任务指针变化自动归零。
      this._saveState();
      await this._processLoop(runId);
    }

    pause() { this.paused = true; logger.info('已暂停'); }
    resume() {
      this.paused = false;
      this._lastProgressTime = Date.now();
      logger.info('已继续');
      if (this.running && (!this._loopRunning || this._loopRunId !== this._runId)) this._processLoop(this._runId);
    }

    stop() {
      this._runId++;
      this.running = false;
      this.paused = false;
      this._reloading = false;
      this._longOperation = false;
      this._clearWatchdog();
      if (this._reloadTimer) clearTimeout(this._reloadTimer);
      this._reloadTimer = null;
      StateManager.clear();
      logger.info('已停止，进度已清除');
    }

    resetCacheAndReload() {
      const savedState = StateManager.load();
      const courseId = getCourseIdFromHash() || this.courseId || savedState?.courseId || '';
      const cleared = StateManager.clearCache();
      this.stop();
      this.tasks = [];
      this.sections = [];
      this.currentIndex = 0;
      this.stats = { videos: 0, exams: 0, errors: 0, skipped: 0 };

      if (!courseId) {
        logger.warn('已清除助手缓存；未识别当前课程，请回到课程总览页后点击开始');
        return cleared;
      }

      const scanId = createDirectoryScanId();
      logger.success(`已清除 ${cleared} 项助手缓存，正在重新加载课程目录`);
      this._reloadTimer = setTimeout(() => {
        window.location.hash = courseOverviewHash(courseId, scanId);
        location.reload();
      }, CONFIG.CACHE_RESET_RELOAD_DELAY);
      return cleared;
    }

    skip() {
      logger.info(`跳过：${this._currentTitle()}`);
      this.currentIndex++;
      this._saveState();
    }

    async _processLoop(runId) {
      // 防止重复处理：已有循环运行时直接返回。
      if (this._loopRunning && this._loopRunId === runId) {
        logger.warn('任务处理循环已在运行中，跳过重复调用');
        return;
      }
      this._loopRunning = true;
      this._loopRunId = runId;
      this._startWatchdog();
      while (this._isActiveRun(runId) && this.currentIndex < this.tasks.length) {
        if (this.paused) { await sleep(1000); continue; }
        if (this._reloading) break;

        const task = this.tasks[this.currentIndex];
        if (!task) {
          logger.error(`任务索引 ${this.currentIndex} 越界（待处理共 ${this.tasks.length} 个），刷新后重新解析`);
          this._requestReload('任务索引异常');
          break;
        }
        logger.info(`\n--- [${this.currentIndex + 1}/${this.tasks.length}] ${task.title} ---`);
        logger.info(`类型：${getTaskTypeLabel(task.itemType)} | 章节：${task.chapterName}`);

        // 二次确认：当前节次是否真的未完成
        if (isCoursePage()) {
          var recheckItem = CourseModel.resolveTaskItem(task)?.item;
          if (recheckItem) {
            const ll = recheckItem.querySelector('.loadingLinear');
            if (ll && parseFloat(ll.textContent) >= 100) {
              logger.warn(`二次确认：${task.title} 已完成（进度不少于 100%），跳过`);
              this.currentIndex++;
              this._saveState();
              continue;
            }
          }
        }

        let outcome = false;
        try {
          outcome = await this._navigateAndProcess(task, runId);
          if (!this._isActiveRun(runId)) break;
          this._longOperation = false;
          this._lastProgressTime = Date.now();
          if (outcome === true) {
            if (task.itemType === 'video') this.stats.videos++;
            else this.stats.exams++;
          }
        } catch (e) {
          this._longOperation = false;
          logger.error(`异常: ${e.message}`, e.stack);
          outcome = false;
        }

        if (outcome === 'redirected') {
          await sleep(500);
          continue;
        }
        if (outcome === true) {
          this.currentIndex++;
          this._saveState();
        } else if (!this._reloading && !this.paused) {
          this.stats.errors++;
          logger.warn(`任务未完成，保留当前节次并刷新重试：${task.title}`);
          this._requestReload('任务处理失败');
        }
        if (this._reloading) {
          logger.info('等待页面刷新恢复...');
          break;
        }
        await sleep(2000);
      }

      // 旧循环在停止后可能晚于新循环结束，不能清掉新循环的互斥标记。
      if (this._loopRunId !== runId) return;
      this._loopRunning = false;
      this._loopRunId = 0;
      this._longOperation = false;
      if (this._reloading) {
        this.running = false;
        this._clearWatchdog();
        return;
      }
      if (!this._isActiveRun(runId)) return;
      if (this.currentIndex < this.tasks.length) return;

      this._finishNormally();
    }

    async _navigateAndProcess(task, runId) {
      // 视频页或未知页先回退到课程页再导航；考试页则在当前页继续处理。
      if (!isCoursePage() && !isExamPage()) {
        logger.info('回退到课程页...');
        history.back();
        await sleep(3000);
        if (!isCoursePage()) {
          history.back();
          await sleep(3000);
        }
        if (!isCoursePage()) return false;
      }

      if (!this._isActiveRun(runId)) return false;
      const navOk = await CourseModel.navigateToDomIndex(task.domIndex, task.title, task.itemType, task.chapterName, task.chapterItemIndex);
      if (!navOk) {
        logger.warn('导航失败：[' + getTaskTypeLabel(task.itemType) + '] ' + task.title);
        return false;
      }
      logger.debug(`已触发点击: ${task.title}`);

      await sleep(4000);
      for (let attempt = 0; attempt < CONFIG.NAVIGATION_ATTEMPTS; attempt++) {
        if (!this._isActiveRun(runId) || this.paused) return false;

        if (isVideoPage()) {
          this._longOperation = true;
          logger.success('进入视频页面');
          const videoEl = await waitForElement('#xgPlayer video', 8000);
          if (!videoEl) {
            logger.warn('视频播放器未加载');
            return false;
          }
          return VideoHandler.waitForCompletion(() =>
            this._isActiveRun(runId) && !this.paused && videoEl.isConnected !== false
          );
        }

        if (isExamPage()) {
          this._longOperation = true;
          logger.success('进入考试页面');
          const done = await ExamHandler.waitForPlugin(5 * 60 * 1000, () =>
            this._isActiveRun(runId) && !this.paused && !!document.querySelector('.examQuestion')
          );
          if (!done) {
            logger.warn('答题插件未完成或已暂停');
            return false;
          }
          await sleep(2000);
          if (!this._isActiveRun(runId) || this.paused) return false;
          return ExamHandler.submitExam(() => this._isActiveRun(runId) && !this.paused);
        }

        if (isCoursePage()) {
          const hint = detectOrderHint();
          if (hint) {
            logger.warn(`平台提示应先完成：“${hint}”`);
            const matchIndex = this.tasks.findIndex(t => hint.includes(t.title) || t.title.includes(hint));
            if (matchIndex >= 0 && matchIndex !== this.currentIndex) {
              this.currentIndex = matchIndex;
              this._saveState({ retryCount: 0, retryAt: null, lastReloadReason: '' });
              logger.info(`纠错：下一个处理“${this.tasks[matchIndex].title}”`);
              return 'redirected';
            }
            if (matchIndex < 0) logger.warn(`提示节次 "${hint}" 未在待处理列表中匹配到`);
          }
          if (attempt === 2) {
            await CourseModel.navigateToDomIndex(task.domIndex, task.title, task.itemType, task.chapterName, task.chapterItemIndex);
            logger.debug('重新触发点击...');
          }
          await sleep(2000);
          continue;
        }

        await sleep(1000);
      }

      logger.error('页面跳转超时');
      return false;
    }

    // 看门狗：超过 120 秒无进展时，持久化断点后再刷新。
    _startWatchdog() {
      this._clearWatchdog();
      this._lastProgressTime = Date.now();
      this._watchdogTimer = setInterval(() => {
        if (!this.running || this.paused || this._reloading || this._longOperation) return;
        const elapsed = Date.now() - this._lastProgressTime;
        if (elapsed > 120000) {
          logger.warn(`[看门狗] ${Math.floor(elapsed / 1000)}秒无进展，准备刷新恢复...`);
          this._requestReload('看门狗无进展');
        }
      }, 30000);
    }

    _clearWatchdog() {
      if (this._watchdogTimer) clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }

    _isActiveRun(runId) {
      return this.running && this._runId === runId;
    }

    _currentTitle() {
      if (this.currentIndex < this.tasks.length) return this.tasks[this.currentIndex].title;
      return '未知';
    }

    _buildState(overrides = {}) {
      const previous = StateManager.load();
      const task = this.tasks[this.currentIndex];
      if (!task) {
        if (StateManager.hasResumeState(previous)) {
          return {
            ...previous,
            stats: { ...this.stats },
            timestamp: Date.now(),
            ...overrides,
          };
        }
        const courseId = this.courseId || getCourseIdFromHash();
        if (!courseId) return null;
        // 首次解析课程目录前也要有可恢复状态，否则目录等待超时会无断点可用。
        return {
          version: 4,
          stage: 'initializing',
          courseId,
          stats: { ...this.stats },
          retryCount: 0,
          retryAt: null,
          lastReloadReason: '',
          autoResume: true,
          timestamp: Date.now(),
          ...overrides,
        };
      }

      const courseId = this.courseId || getCourseIdFromHash() || previous?.courseId || '';
      const sameTask = StateManager.isSameTask(previous, task, courseId);
      const retryCount = Object.prototype.hasOwnProperty.call(overrides, 'retryCount')
        ? overrides.retryCount
        : sameTask ? Number(previous.retryCount) || 0 : 0;
      const retryAt = Object.prototype.hasOwnProperty.call(overrides, 'retryAt')
        ? overrides.retryAt
        : sameTask ? previous.retryAt || null : null;
      const lastReloadReason = Object.prototype.hasOwnProperty.call(overrides, 'lastReloadReason')
        ? overrides.lastReloadReason
        : sameTask ? previous.lastReloadReason || '' : '';

      return {
        version: 4,
        courseId,
        chapterIdx: task.chapterIdx,
        pairIdx: task.pairIdx,
        chapterItemIndex: task.chapterItemIndex,
        itemType: task.itemType,
        title: task.title,
        totalTasks: this.tasks.length,
        stats: { ...this.stats },
        retryCount,
        retryAt,
        lastReloadReason,
        autoResume: Object.prototype.hasOwnProperty.call(overrides, 'autoResume') ? overrides.autoResume : true,
        timestamp: Date.now(),
        ...overrides,
      };
    }

    _saveState(overrides = {}) {
      const state = this._buildState(overrides);
      if (state) StateManager.save(state);
      return state;
    }

    _requestReload(reason) {
      if (this._reloading) return true;
      const state = this._buildState();
      if (!StateManager.hasResumeState(state)) {
        logger.error('无法确定课程或断点，已停止以避免盲目刷新');
        this.running = false;
        return false;
      }

      const retryCount = (Number(state.retryCount) || 0) + 1;
      const delay = Math.min(
        CONFIG.RETRY_DELAY_BASE * Math.pow(2, Math.min(retryCount - 1, 10)),
        CONFIG.RETRY_DELAY_MAX,
      );
      const directoryScanId = createDirectoryScanId();
      const recoveryState = {
        ...state,
        retryCount,
        retryAt: Date.now() + delay,
        lastReloadReason: reason,
        autoResume: true,
        forceFreshDirectory: true,
        directoryScanId,
        timestamp: Date.now(),
      };
      StateManager.save(recoveryState);
      this._reloading = true;
      this._longOperation = false;
      this._clearWatchdog();
      logger.warn(`${reason}，${Math.ceil(delay / 1000)} 秒后刷新并重新扫描目录（连续第 ${retryCount} 次）...`);
      this._reloadTimer = setTimeout(() => {
        if (!this._reloading) return;
        window.location.hash = courseOverviewHash(recoveryState.courseId, directoryScanId);
        location.reload();
      }, delay);
      return true;
    }

    _finishNormally() {
      this.running = false;
      this.paused = false;
      this._loopRunning = false;
      this._loopRunId = 0;
      this._longOperation = false;
      this._clearWatchdog();
      StateManager.clear();
      logger.info('\n========================================');
      logger.success('全部完成！');
      logger.info(`视频：${this.stats.videos} | 考试：${this.stats.exams} | 错误：${this.stats.errors}`);
      if (!this._completionNotificationSent) {
        this._completionNotificationSent = true;
        void ServerChanNotifier.sendTaskCompleted(this.stats, this.courseId);
      }
    }
  }

  // ======================== 控制面板 ========================
  class ControlPanel {
    constructor(autoPlayer) {
      this.ap = autoPlayer;
      this.panel = null;
      this.expanded = true; // 面板初始显示完整内容
      this._build();
      logger.onLog(e => this._addLog(e));
    }

    _build() {
      const css = `
      #ouchn-ap-v2{position:fixed;top:72px;right:16px;z-index:99999;width:440px;min-width:320px;max-width:800px;resize:both;overflow:hidden;color-scheme:dark;background:rgba(28,28,30,.82);border:1px solid rgba(255,255,255,.14);border-radius:16px;box-shadow:0 24px 56px rgba(0,0,0,.32),0 1px 0 rgba(255,255,255,.12) inset;backdrop-filter:blur(24px) saturate(150%);-webkit-backdrop-filter:blur(24px) saturate(150%);font:13px/1.5 -apple-system,BlinkMacSystemFont,'SF Pro Display','PingFang SC','Microsoft YaHei',sans-serif;color:#f5f5f7;user-select:none;text-wrap:pretty}
      #ouchn-ap-v2 .hdr{display:flex;align-items:center;gap:10px;min-height:54px;padding:12px 15px;background:rgba(44,44,46,.52);border-bottom:1px solid rgba(255,255,255,.1);cursor:move}
      #ouchn-ap-v2 .brand{display:grid;flex:none;gap:2px}
      #ouchn-ap-v2 .eyebrow{font-size:10px;font-weight:700;letter-spacing:.08em;color:#98989d}
      #ouchn-ap-v2 .panel-title{font:600 17px/1.15 -apple-system,BlinkMacSystemFont,'SF Pro Display','PingFang SC','Microsoft YaHei',sans-serif;letter-spacing:-.01em;color:#fff}
      #ouchn-ap-v2 .aiask-button{display:inline-flex;align-items:center;justify-content:center;min-height:30px;margin-right:auto;padding:0 11px;border:1px solid rgba(100,168,255,.35);border-radius:9px;background:rgba(10,132,255,.12);font:600 10px/1 -apple-system,BlinkMacSystemFont,'SF Pro Text','PingFang SC','Microsoft YaHei',sans-serif;color:#64a8ff;text-decoration:none;white-space:nowrap;cursor:pointer;transition:background .2s ease,border-color .2s ease,color .2s ease,transform .2s cubic-bezier(.2,.8,.2,1)}
      #ouchn-ap-v2 .aiask-button:hover{background:rgba(10,132,255,.2);border-color:rgba(100,168,255,.55);color:#9ac7ff;transform:translateY(-1px)}
      #ouchn-ap-v2 .aiask-button:active{transform:scale(.97);transition-duration:.1s}
      #ouchn-ap-v2 .acts{display:flex;align-items:center;gap:9px}
      #ouchn-ap-v2 .version{font:10px/1 'SF Mono','Cascadia Code','Consolas',monospace;color:#98989d}
      #ouchn-ap-v2 .hdr .acts button{width:30px;height:30px;border:1px solid rgba(255,255,255,.12);border-radius:50%;background:rgba(255,255,255,.08);color:#d1d1d6;cursor:pointer;font-size:17px;line-height:1;transition:background .2s ease,color .2s ease,transform .2s cubic-bezier(.2,.8,.2,1)}
      #ouchn-ap-v2 .hdr .acts button:hover{background:rgba(255,255,255,.16);color:#fff}
      #ouchn-ap-v2 .hdr .acts button:active{transform:scale(.94);transition-duration:.1s}
      #ouchn-ap-v2 .body{padding:12px 14px 14px}
      #ouchn-ap-v2 .live{display:grid;grid-template-columns:8px 1fr auto;align-items:center;gap:10px;margin-bottom:10px;padding:10px 11px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1);border-radius:11px}
      #ouchn-ap-v2 .live .dot{width:8px;height:8px;border-radius:50%;background:#8e8e93;transition:background .24s ease,box-shadow .24s ease}
      #ouchn-ap-v2 .live .dot.on{background:#30d158;box-shadow:0 0 0 4px rgba(48,209,88,.16);animation:ap-status-pulse 1.8s ease-in-out infinite}
      #ouchn-ap-v2 .live .dot.off{background:#8e8e93}
      #ouchn-ap-v2 .live-label{display:block;margin-bottom:2px;font-size:10px;letter-spacing:.04em;color:#98989d}
      #ouchn-ap-v2 .live strong{font:600 14px/1.2 -apple-system,BlinkMacSystemFont,'SF Pro Text','PingFang SC','Microsoft YaHei',sans-serif;color:#fff}
      #ouchn-ap-v2 .live-note{font-size:10px;color:#98989d}
      @keyframes ap-status-pulse{0%,100%{opacity:1}50%{opacity:.58}}
      #ouchn-ap-v2 .ctrls{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-bottom:10px}
      #ouchn-ap-v2 .ctrls button{min-height:38px;padding:9px 10px;border:1px solid rgba(255,255,255,.1);border-radius:9px;cursor:pointer;font:600 11px/1.2 -apple-system,BlinkMacSystemFont,'SF Pro Text','PingFang SC','Microsoft YaHei',sans-serif;letter-spacing:.01em;color:#f5f5f7;background:rgba(255,255,255,.1);transition:background .2s ease,border-color .2s ease,color .2s ease,transform .2s cubic-bezier(.2,.8,.2,1)}
      #ouchn-ap-v2 .ctrls button:hover:not(:disabled){background:rgba(255,255,255,.18);border-color:rgba(255,255,255,.18);transform:translateY(-1px)}
      #ouchn-ap-v2 .ctrls button:active:not(:disabled){transform:scale(.97);transition-duration:.1s}
      #ouchn-ap-v2 .ctrls button:disabled{opacity:.38;cursor:not-allowed}
      #ouchn-ap-v2 .ctrls .pri{grid-column:span 2;border-color:#0a84ff;background:#0a84ff;color:#fff;font-size:12px}
      #ouchn-ap-v2 .ctrls .pri:hover:not(:disabled){background:#409cff;border-color:#409cff;color:#fff}
      #ouchn-ap-v2 .ctrls .dng{color:#ff6961}
      #ouchn-ap-v2 .ctrls .dng:hover:not(:disabled){background:rgba(255,105,97,.15);border-color:rgba(255,105,97,.45);color:#ffb4ad}
      #ouchn-ap-v2 .muted{color:#d1d1d6}
      #ouchn-ap-v2 .ctrls .notify-button{color:#64a8ff}
      #ouchn-ap-v2 .ctrls .debug-button{font-size:10px;color:#aeaeb2}
      #ouchn-ap-v2 .ctrls button:focus-visible,#ouchn-ap-v2 .hdr .acts button:focus-visible,#ouchn-ap-v2 .aiask-button:focus-visible,#ouchn-ap-v2 .dbg-row button:focus-visible,#ouchn-ap-v2 .serverchan-row input:focus-visible,#ouchn-ap-v2 .serverchan-row a:focus-visible,#ouchn-ap-v2 .serverchan-row button:focus-visible,#ouchn-ap-v2 .footer-links a:focus-visible{outline:2px solid #0a84ff;outline-offset:2px}
      #ouchn-ap-v2 .st{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-bottom:10px}
      #ouchn-ap-v2 .st span{display:flex;align-items:baseline;justify-content:space-between;gap:8px;min-height:32px;padding:7px 9px;border:1px solid rgba(255,255,255,.08);border-radius:9px;background:rgba(0,0,0,.16);color:#aeaeb2}
      #ouchn-ap-v2 .st small{font-size:10px;letter-spacing:.02em}
      #ouchn-ap-v2 .st b{font:600 13px/1 'SF Mono','Cascadia Code','Consolas',monospace;color:#f5f5f7}
      #ouchn-ap-v2 .st .ok{color:#30d158}
      #ouchn-ap-v2 .st .er{color:#ff6961}
      #ouchn-ap-v2 .log-wrap{border:1px solid rgba(255,255,255,.1);border-radius:11px;overflow:hidden;background:rgba(0,0,0,.22)}
      #ouchn-ap-v2 .log-head{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-bottom:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.06);font-size:10px;font-weight:600;letter-spacing:.04em;color:#d1d1d6}
      #ouchn-ap-v2 .log-head span{font:9px/1 'SF Mono','Cascadia Code','Consolas',monospace;color:#8e8e93}
      #ouchn-ap-v2 .log{max-height:260px;overflow-y:auto;padding:7px 10px;font:10px/1.65 'SF Mono','Cascadia Code','Consolas',monospace;user-select:text}
      #ouchn-ap-v2 .log .le{padding:2px 0;border-bottom:1px solid rgba(255,255,255,.05);word-break:break-all;color:#d1d1d6}
      #ouchn-ap-v2 .log .le[data-l="ERROR"]{color:#ff6961}
      #ouchn-ap-v2 .log .le[data-l="WARN"]{color:#ffd60a}
      #ouchn-ap-v2 .log .le[data-l="SUCCESS"]{color:#30d158}
      #ouchn-ap-v2 .log .le[data-l="DEBUG"]{color:#8e8e93}
      #ouchn-ap-v2 .panel-footer{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:10px}
      #ouchn-ap-v2 .footer-links{display:flex;align-items:center;gap:7px}
      #ouchn-ap-v2 .footer-links a{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;padding:0;border:1px solid rgba(255,255,255,.1);border-radius:50%;background:rgba(255,255,255,.08);color:#d1d1d6;text-decoration:none;transition:background .2s ease,border-color .2s ease,color .2s ease,transform .2s cubic-bezier(.2,.8,.2,1)}
      #ouchn-ap-v2 .footer-links svg{width:16px;height:16px;fill:currentColor}
      #ouchn-ap-v2 .footer-links a:hover{background:rgba(255,255,255,.16);border-color:rgba(255,255,255,.18);color:#fff;transform:translateY(-1px)}
      #ouchn-ap-v2 .footer-links a:active{transform:scale(.97);transition-duration:.1s}
      #ouchn-ap-v2 .signature{font-size:10px;color:#8e8e93;white-space:nowrap}
      #ouchn-ap-v2 .dbg-row{display:none;gap:7px;margin-bottom:10px}
      #ouchn-ap-v2 .dbg-row.show{display:flex}
      #ouchn-ap-v2 .dbg-row button{flex:1;min-height:36px;padding:9px 9px;border:1px solid rgba(255,255,255,.1);border-radius:9px;cursor:pointer;font:600 10px/1.2 -apple-system,BlinkMacSystemFont,'SF Pro Text','PingFang SC','Microsoft YaHei',sans-serif;color:#d1d1d6;background:rgba(255,255,255,.08);transition:background .2s ease,border-color .2s ease,color .2s ease,transform .2s cubic-bezier(.2,.8,.2,1)}
      #ouchn-ap-v2 .dbg-row button:hover{background:rgba(255,255,255,.16);border-color:rgba(255,255,255,.18);color:#fff}
      #ouchn-ap-v2 .dbg-row button:active{transform:scale(.97);transition-duration:.1s}
      #ouchn-ap-v2 .serverchan-row{display:none;grid-template-columns:1fr auto;align-items:center;gap:7px;margin:-3px 0 10px;padding:9px;border:1px solid rgba(255,255,255,.1);border-radius:10px;background:rgba(0,0,0,.16)}
      #ouchn-ap-v2 .serverchan-row.show{display:grid}
      #ouchn-ap-v2 .serverchan-row label{grid-column:1/-1;font-size:10px;font-weight:600;letter-spacing:.03em;color:#d1d1d6}
      #ouchn-ap-v2 .serverchan-row input{min-width:0;height:32px;padding:0 9px;border:1px solid rgba(255,255,255,.12);border-radius:8px;background:rgba(255,255,255,.08);font:11px/1 'SF Mono','Cascadia Code','Consolas',monospace;color:#f5f5f7;user-select:text}
      #ouchn-ap-v2 .serverchan-row input::placeholder{color:#636366}
      #ouchn-ap-v2 .serverchan-row a{font-size:10px;color:#64a8ff;text-decoration:none;white-space:nowrap}
      #ouchn-ap-v2 .serverchan-row a:hover{text-decoration:underline}
      #ouchn-ap-v2 .serverchan-row button{grid-column:1/-1;min-height:36px;padding:9px;border:1px solid rgba(100,168,255,.35);border-radius:9px;cursor:pointer;font:600 10px/1.2 -apple-system,BlinkMacSystemFont,'SF Pro Text','PingFang SC','Microsoft YaHei',sans-serif;color:#64a8ff;background:rgba(10,132,255,.12);transition:background .2s ease,border-color .2s ease,transform .2s cubic-bezier(.2,.8,.2,1)}
      #ouchn-ap-v2 .serverchan-row button:hover:not(:disabled){background:rgba(10,132,255,.2);border-color:rgba(100,168,255,.55)}
      #ouchn-ap-v2 .serverchan-row button:active:not(:disabled){transform:scale(.98);transition-duration:.1s}
      #ouchn-ap-v2 .serverchan-row button:disabled{opacity:.5;cursor:wait}
      #ouchn-ap-v2 .resize-handle{position:absolute;bottom:5px;right:5px;width:10px;height:10px;cursor:nwse-resize;border-right:2px solid #8e8e93;border-bottom:2px solid #8e8e93}
      #ouchn-ap-v2 .resize-handle:hover{border-color:#0a84ff}
      #ouchn-ap-v2.mini .body{display:none}
      #ouchn-ap-v2.mini{width:218px;min-width:218px;resize:none}
      @media (max-width:460px){#ouchn-ap-v2{right:8px;top:56px;width:calc(100vw - 16px);min-width:0}#ouchn-ap-v2 .hdr{gap:8px;padding-right:11px;padding-left:11px}#ouchn-ap-v2 .body{padding:10px}#ouchn-ap-v2 .panel-title{font-size:17px}#ouchn-ap-v2 .aiask-button{padding:0 8px;font-size:9px}}
      @media (max-width:360px){#ouchn-ap-v2 .version{display:none}}
      @media (prefers-reduced-motion:reduce){#ouchn-ap-v2 *,#ouchn-ap-v2 *::before,#ouchn-ap-v2 *::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important}}
      @media (prefers-reduced-transparency:reduce){#ouchn-ap-v2{background:#1c1c1e;backdrop-filter:none;-webkit-backdrop-filter:none}#ouchn-ap-v2 .hdr{background:#2c2c2e}}
      @media (prefers-contrast:more){#ouchn-ap-v2{background:#1c1c1e;border-color:#fff}#ouchn-ap-v2 .live,#ouchn-ap-v2 .st span,#ouchn-ap-v2 .log-wrap{border-color:rgba(255,255,255,.38)}}
      `;
      const style = document.createElement('style');
      style.textContent = css;
      document.head.appendChild(style);

      this.panel = document.createElement('div');
      this.panel.id = 'ouchn-ap-v2';
      this.panel.innerHTML = `
        <div class="hdr">
          <div class="brand">
            <span class="eyebrow">学习自动化</span>
            <span class="panel-title">自动刷课助手</span>
          </div>
          <a class="aiask-button" href="${CONFIG.AIASK_URL}" target="_blank" rel="noopener noreferrer">爱问答助手</a>
          <div class="acts"><span class="version">v${CONFIG.VERSION}</span><button class="btn-tog" aria-label="折叠面板" aria-expanded="true">-</button></div>
        </div>
        <div class="body">
          <div class="live"><span class="dot off" id="adot"></span><div><span class="live-label">当前状态</span><strong id="astatus">待命</strong></div><span class="live-note">可拖动</span></div>
          <div class="ctrls">
            <button class="pri" id="bs">开始学习</button>
            <button id="bp" disabled>暂停</button>
            <button class="dng" id="bx" disabled>停止</button>
            <button class="notify-button" id="bserverchan" aria-controls="serverchanrow" aria-expanded="false">Server酱³消息通知</button>
            <button class="debug-button" id="bdbg" aria-controls="dbgrow" aria-expanded="false">调试与更新</button>
          </div>
          <div class="serverchan-row" id="serverchanrow" role="region" aria-label="Server酱³消息通知设置">
            <label for="serverchankey">SendKey（留空则不发送）</label>
            <input id="serverchankey" type="password" autocomplete="off" spellcheck="false" placeholder="sctp...">
            <a href="${CONFIG.SERVERCHAN_DOC_URL}" target="_blank" rel="noopener noreferrer">使用文档</a>
            <button id="serverchantest">发送测试消息</button>
          </div>
          <div class="dbg-row" id="dbgrow" role="region" aria-label="调试与更新选项">
            <button id="dbgupdate">检查最新发布版本</button>
            <button id="dbglog" aria-pressed="false">DEBUG：关闭</button>
            <button class="muted" id="bcache">清缓存重置</button>
          </div>
          <div class="st" id="sb">
            <span><small>视频完成</small><b class="ok">0</b></span>
            <span><small>考试完成</small><b class="ok">0</b></span>
            <span><small>异常次数</small><b class="er">0</b></span>
            <span><small>当前进度</small><b>0/0</b></span>
          </div>
          <div class="log-wrap"><div class="log-head">运行记录 <span>实时</span></div><div class="log" id="la"></div></div>
          <div class="panel-footer">
            <div class="footer-links">
              <a href="${CONFIG.GITHUB_REPO_URL}" target="_blank" rel="noopener noreferrer" aria-label="GitHub 项目主页" title="GitHub 项目主页"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.87c-2.78.61-3.37-1.18-3.37-1.18-.45-1.17-1.11-1.48-1.11-1.48-.91-.63.07-.62.07-.62 1 .08 1.53 1.05 1.53 1.05.9 1.55 2.35 1.1 2.92.84.09-.66.35-1.1.64-1.36-2.22-.26-4.56-1.13-4.56-5A3.94 3.94 0 0 1 6.69 8.6a3.7 3.7 0 0 1 .1-2.75s.84-.27 2.75 1.05a9.37 9.37 0 0 1 5 0c1.91-1.32 2.75-1.05 2.75-1.05a3.7 3.7 0 0 1 .1 2.75 3.94 3.94 0 0 1 1.05 2.74c0 3.89-2.34 4.74-4.57 5 .36.32.68.94.68 1.9V21c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"/></svg></a>
              <a href="${CONFIG.BILIBILI_PROFILE_URL}" target="_blank" rel="noopener noreferrer" aria-label="Bilibili 作者主页" title="Bilibili 作者主页"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.7 2.8a1 1 0 0 0-1.4 1.4L9.1 6H6a3 3 0 0 0-3 3v9a3 3 0 0 0 3 3h12a3 3 0 0 0 3-3V9a3 3 0 0 0-3-3h-3.1l1.8-1.8a1 1 0 0 0-1.4-1.4L12 6.1 8.7 2.8ZM6 8h12a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Zm2.5 3a1 1 0 0 0-1 1v2a1 1 0 1 0 2 0v-2a1 1 0 0 0-1-1Zm7 0a1 1 0 0 0-1 1v2a1 1 0 1 0 2 0v-2a1 1 0 0 0-1-1Z"/></svg></a>
            </div>
            <span class="signature">@镜桦izumik</span>
          </div>
          <div class="resize-handle"></div>
        </div>`;
      document.body.appendChild(this.panel);

      this.panel.querySelector('#bs').addEventListener('click', () => { this.ap.start(); this._ui(); });
      this.panel.querySelector('#bp').addEventListener('click', () => { this.ap.paused ? this.ap.resume() : this.ap.pause(); this._ui(); });
      this.panel.querySelector('#bx').addEventListener('click', () => { if (confirm('确定停止当前任务吗？')) { this.ap.stop(); this._ui(); } });
      this.panel.querySelector('#bcache').addEventListener('click', () => {
        if (!confirm('将停止任务、清除助手缓存并重新加载课程目录；不会退出登录。是否继续？')) return;
        this.ap.resetCacheAndReload();
        this._ui();
      });
      this.panel.querySelector('#bdbg').addEventListener('click', () => {
        const row = this.panel.querySelector('#dbgrow');
        row.classList.toggle('show');
        const isOpen = row.classList.contains('show');
        this.panel.querySelector('#bdbg').setAttribute('aria-expanded', String(isOpen));
      });
      this.panel.querySelector('#dbgupdate').addEventListener('click', () => this._checkUpdate());
      this.panel.querySelector('#dbglog').addEventListener('click', () => {
        logger.setDebugEnabled(!logger.debugEnabled);
        logger.info(logger.debugEnabled ? 'DEBUG 日志已开启' : 'DEBUG 日志已关闭');
        this._ui();
      });
      const sendKeyInput = this.panel.querySelector('#serverchankey');
      sendKeyInput.value = ServerChanNotifier.getSendKey();
      sendKeyInput.addEventListener('change', () => {
        ServerChanNotifier.setSendKey(sendKeyInput.value);
        logger.info(sendKeyInput.value.trim() ? 'Server酱³ SendKey 已保存' : 'Server酱³ 完成通知已关闭');
      });
      this.panel.querySelector('#bserverchan').addEventListener('click', () => {
        const row = this.panel.querySelector('#serverchanrow');
        row.classList.toggle('show');
        this.panel.querySelector('#bserverchan').setAttribute('aria-expanded', String(row.classList.contains('show')));
        if (row.classList.contains('show')) sendKeyInput.focus();
      });
      this.panel.querySelector('#serverchantest').addEventListener('click', async event => {
        ServerChanNotifier.setSendKey(sendKeyInput.value);
        if (!sendKeyInput.value.trim()) {
          logger.warn('请先填写 Server酱³ SendKey');
          return;
        }
        const button = event.currentTarget;
        button.disabled = true;
        await ServerChanNotifier.sendTest();
        button.disabled = false;
      });
      this.panel.querySelector('.btn-tog').addEventListener('click', () => {
        this.expanded = !this.expanded;
        this.panel.classList.toggle('mini', !this.expanded);
        const toggle = this.panel.querySelector('.btn-tog');
        toggle.textContent = this.expanded ? '-' : '+';
        toggle.setAttribute('aria-label', this.expanded ? '折叠面板' : '展开面板');
        toggle.setAttribute('aria-expanded', String(this.expanded));
      });

      this._makeDraggable();
      setInterval(() => this._ui(), 2000);
    }

    _addLog(e) {
      const la = this.panel?.querySelector('#la');
      if (!la) return;
      const d = document.createElement('div');
      d.className = 'le';
      d.setAttribute('data-l', e.level);
      d.textContent = e.line;
      la.appendChild(d);
      la.scrollTop = la.scrollHeight;
      while (la.children.length > 200) la.firstChild.remove();
    }

    _ui() {
      const ap = this.ap;
      const running = ap.running && !ap.paused;
      const paused = ap.paused;

      this.panel.querySelector('#bs').disabled = ap.running;
      this.panel.querySelector('#bp').disabled = !ap.running;
      this.panel.querySelector('#bx').disabled = !ap.running;
      this.panel.querySelector('#bp').textContent = paused ? '继续' : '暂停';
      this.panel.querySelector('#dbglog').textContent = logger.debugEnabled ? 'DEBUG：开启' : 'DEBUG：关闭';
      this.panel.querySelector('#dbglog').setAttribute('aria-pressed', String(logger.debugEnabled));

      const dot = this.panel.querySelector('#adot');
      const st = this.panel.querySelector('#astatus');
      dot.className = 'dot ' + (running ? 'on' : paused ? 'on' : 'off');
      st.textContent = running ? '运行中' : paused ? '已暂停' : '待命';

      const sb = this.panel.querySelector('#sb');
      const total = ap.tasks.length || 0;
      sb.innerHTML = `<span><small>视频完成</small><b class="ok">${ap.stats.videos}</b></span>
        <span><small>考试完成</small><b class="ok">${ap.stats.exams}</b></span>
        <span><small>异常次数</small><b class="er">${ap.stats.errors}</b></span>
        <span><small>当前进度</small><b>${ap.currentIndex}/${total}</b></span>`;
    }

    async _checkUpdate() {
      logger.info('正在检查最新发布版本...');
      try {
        const resp = await fetch(CONFIG.RELEASE_API_URL, {
          cache: 'no-store',
          headers: { Accept: 'application/vnd.github+json' },
        });
        if (!resp.ok) { logger.warn(`无法获取最新发布版本（HTTP ${resp.status}）`); return; }
        const release = await resp.json();
        const remoteTag = release.tag_name || release.name;
        const comparison = compareVersions(remoteTag, CONFIG.VERSION);
        if (comparison === null) {
          logger.warn(`最新发布版本标签无法识别："${remoteTag || '?'}"`);
          return;
        }
        if (comparison > 0) {
          logger.success(`发现新发布版本 ${remoteTag}（当前 v${CONFIG.VERSION}），正在打开发布页...`);
          window.open(release.html_url || 'https://github.com/MochizikuNanoka/ouchn-auto-study/releases/latest', '_blank');
        } else if (comparison === 0) {
          logger.info(`当前已是最新发布版本 v${CONFIG.VERSION}`);
        } else {
          logger.info(`当前开发版本 v${CONFIG.VERSION} 高于最新发布版本 ${remoteTag}`);
        }
      } catch (e) {
        logger.warn(`检查更新失败: ${e.message}`);
      }
    }

    _makeDraggable() {
      const hdr = this.panel.querySelector('.hdr');
      let d = false, sx, sy, ix, iy;
      hdr.addEventListener('mousedown', e => {
        if (e.target.closest('button, a')) return;
        d = true; sx = e.clientX; sy = e.clientY;
        const r = this.panel.getBoundingClientRect();
        ix = r.left; iy = r.top;
        this.panel.style.transition = 'none';
        e.preventDefault();
      });
      document.addEventListener('mousemove', e => {
        if (!d) return;
        this.panel.style.left = (ix + e.clientX - sx) + 'px';
        this.panel.style.top = (iy + e.clientY - sy) + 'px';
        this.panel.style.right = 'auto';
      });
      document.addEventListener('mouseup', () => { if (d) { d = false; this.panel.style.transition = ''; } });
    }
  }

  // ======================== 初始化 ========================
  async function init() {
    logger.info('自动刷课助手 v2 初始化');
    logger.info(`页面: ${window.location.hash || '/'}`);

    const ap = new AutoPlayer();
    new ControlPanel(ap);

    // 断点保存在浏览器本地存储（localStorage）中，F5 会重建页面，不能依赖页面内存标记。
    const saved = StateManager.load();
    const currentCourseId = getCourseIdFromHash();
    if (shouldAutoResume(saved, currentCourseId)) {
      const retryAt = Number(saved.retryAt);
      const waitMs = Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : 0;
      logger.info(`检测到断点，自动恢复: "${saved.title || '?'}"`);
      if (waitMs > 0) {
        logger.info(`按重试退避等待 ${Math.ceil(waitMs / 1000)} 秒...`);
        await sleep(waitMs);
      }
      // 等待期间用户可能已点击停止或切换课程，重新确认断点仍适用。
      if (shouldAutoResume(StateManager.load(), getCourseIdFromHash())) await ap.start();
    } else if (StateManager.isResumable(saved) && isCoursePage()) {
      logger.warn(`发现其他课程的断点（${saved.courseId}），当前课程不会自动续跑`);
    }

    logger.success('初始化完成');
    logger.info('请确认安装爱问答助手');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 2000));
  } else {
    setTimeout(init, 2000);
  }
})();
