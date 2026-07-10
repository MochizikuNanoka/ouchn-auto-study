// ==UserScript==
// @name         国开学习平台 自动刷课助手
// @namespace    https://zydz-menhu.ouchn.edu.cn/
// @version      2.0.4
// @description  国开学习平台(电大中专)自动刷课助手 — 自动播放视频 + 配合爱问答助手自动交卷，支持可靠断点续传，v2 domIndex 稳定定位消除漂移
// @author       Hermes
// @match        https://zydz-menhu.ouchn.edu.cn/learningPlatform/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  // ======================== 配置 ========================
  const CONFIG = {
    VERSION: '2.0.4',
    VIDEO_CHECK_INTERVAL: 3000,
    EXAM_CHECK_INTERVAL: 2000,
    NAVIGATION_TIMEOUT: 15000,
    COURSE_DIRECTORY_TIMEOUT: 30000,
    COURSE_DIRECTORY_STABLE_MS: 1500,
    COURSE_DIRECTORY_POLL_INTERVAL: 500,
    RETRY_DELAY_BASE: 2000,
    RETRY_DELAY_MAX: 30000,
    NAVIGATION_ATTEMPTS: 5,
    RELEASE_API_URL: 'https://api.github.com/repos/MochizikuNanoka/ouchn-auto-study/releases/latest',
    VIDEO_POST_COMPLETE_DELAY: 10000,
    STORAGE_KEY: 'ouchn_autoplay_v2',
  };

  // ======================== 日志系统 ========================
  const LogLevel = { INFO: 'INFO', WARN: 'WARN', ERROR: 'ERROR', SUCCESS: 'SUCCESS', DEBUG: 'DEBUG' };

  class Logger {
    constructor() {
      this.logs = [];
      this.maxLogs = 300;
      this.onLogCallbacks = [];
    }
    _format(level, msg, data) {
      const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      const line = `[${ts}] [${level}] ${msg}`;
      const entry = { ts, level, msg, data: data || '', line };
      this.logs.push(entry);
      if (this.logs.length > this.maxLogs) this.logs.shift();
      const consoleMsg = `[AutoStudy] ${line}`;
      (level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log)(consoleMsg, data || '');
      this.onLogCallbacks.forEach(cb => cb(entry));
    }
    info(msg, data) { this._format(LogLevel.INFO, msg, data); }
    warn(msg, data) { this._format(LogLevel.WARN, msg, data); }
    error(msg, data) { this._format(LogLevel.ERROR, msg, data); }
    success(msg, data) { this._format(LogLevel.SUCCESS, msg, data); }
    debug(msg, data) { this._format(LogLevel.DEBUG, msg, data); }
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

  function is500Error() {
    const serverError = /(?:\b500\b|服务器错误|Internal Server Error)/i;
    const platformRoot = document.querySelector('#app');
    const platformText = platformRoot?.innerText || '';
    if (serverError.test(platformText)) return true;

    if (!platformRoot) {
      const body = document.body?.innerText || '';
      const panelText = document.querySelector('#ouchn-ap-v2')?.innerText || '';
      const bodyWithoutPanel = panelText ? body.replace(panelText, '') : body;
      if (serverError.test(bodyWithoutPanel)) return true;
    }

    return [...document.querySelectorAll('.el-message--error')].some(el => {
      if (el.offsetParent === null) return false;
      return serverError.test(el.textContent || '');
    });
  }

  function getCourseIdFromHash(hash = window.location.hash) {
    const queryIndex = hash.indexOf('?');
    if (queryIndex < 0) return '';
    const params = new URLSearchParams(hash.slice(queryIndex + 1));
    return params.get('courseId') || params.get('id') || '';
  }

  function courseOverviewHash(courseId) {
    return courseId ? `#/myCourse/study?id=${encodeURIComponent(courseId)}` : '#/myCourse/study';
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
    // 可能的弹窗选择器：el-message-box, el-dialog, el-notification, el-alert
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

  // ======================== 课程解析器（重写版 — 基于课程总览页） ========================
    // =========  // =============== 课程模型（v2：基于 bodyText + domIndex 稳定定位） ========================
  class CourseModel {

    static getDirectorySnapshot() {
      const allItems = document.querySelectorAll('.el-collapse-item');
      const headers = document.querySelectorAll('.el-collapse-item__header');
      const chapterCount = [...headers].filter(header => !!header.querySelector('.chapter_name')).length;
      return {
        route: window.location.hash.split('?')[0],
        courseId: getCourseIdFromHash(),
        allItemCount: allItems.length,
        chapterCount,
        courseItemCount: document.querySelectorAll('.hoverItem').length,
        loadingCount: document.querySelectorAll('.el-loading-mask, .el-skeleton').length,
        serverError: is500Error(),
      };
    }

    static logDirectorySnapshot(stage, snapshot, level = 'debug') {
      const summary = `route=${snapshot.route || '/'} course=${snapshot.courseId || '?'} ` +
        `items=${snapshot.allItemCount} chapters=${snapshot.chapterCount} ` +
        `courseItems=${snapshot.courseItemCount} loading=${snapshot.loadingCount} 500=${snapshot.serverError}`;
      logger[level](`[CourseDirectory] ${stage}: ${summary}`, snapshot);
    }

    static isDirectorySnapshotReady(snapshot, requireCourseItems) {
      if (!isCoursePage() || snapshot.serverError) return false;
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
          snapshot.courseItemCount, snapshot.loadingCount, snapshot.serverError].join('|');

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

    static async buildModel() {
      const initialSnapshot = await CourseModel.waitForStableDirectory();
      if (!initialSnapshot) return null;
      await CourseModel.expandAllChapters();
      const populatedSnapshot = await CourseModel.waitForStableDirectory({ requireCourseItems: true });
      if (!populatedSnapshot) return null;
      const allItems = document.querySelectorAll('.el-collapse-item');
      if (allItems.length === 0) {
        CourseModel.logDirectorySnapshot('empty-after-stable-ready', CourseModel.getDirectorySnapshot(), 'warn');
        return null;
      }
      logger.info('DOM中共 ' + allItems.length + ' 个 el-collapse-item');
      const chapters = [];
      var currentChapter = null;
      for (var i = 0; i < allItems.length; i++) {
        var item = allItems[i];
        var header = item.querySelector('.el-collapse-item__header');
        if (!header) continue;
        var chNameEl = header.querySelector('.chapter_name span');
        if (chNameEl) {
          currentChapter = { name: chNameEl.textContent.trim(), chapterIdx: chapters.length, pairs: [] };
          chapters.push(currentChapter);
          continue;
        }
        var body = item.querySelector('.el-collapse-item__wrap');
        var btxt = body ? body.textContent.trim() : '';
        var durMatch = btxt.match(/（(\d{2}:\d{2}:\d{2})）/);
        var progMatch = btxt.match(/(\d{1,3})%/);
        var isVideo = !!durMatch;
        var isExam = /^测验/.test(btxt);
        if (isVideo && currentChapter) {
          var progress = progMatch ? parseInt(progMatch[1]) : 0;
          var vte = header.querySelector('.title span');
          var vtitle = vte ? vte.textContent.trim() : header.textContent.trim().replace(/[\(（].*?[\)）]/g, '').trim();
          var ve = { domIndex: i, title: vtitle, duration: durMatch ? durMatch[1] : '', progress: progress, isComplete: progress >= 100 };
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
          var ete = header.querySelector('.title span');
          var etitle = ete ? ete.textContent.trim() : header.textContent.trim().replace(/[\(（].*?[\)）]/g, '').trim();
          var ee = { domIndex: i, title: etitle, status: status, isComplete: status === '合格' };
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
      logger.info('课程模型: ' + chapters.length + ' 个章节, ' + tv + ' 视频, ' + te + ' 考试 (' + dv + '/' + de + ' 完成)');
      return { chapters: chapters };
    }

    static getPendingTasks(chapters) {
      var tasks = [];
      for (var ci = 0; ci < chapters.length; ci++) {
        var ch = chapters[ci];
        for (var pj = 0; pj < ch.pairs.length; pj++) {
          var pair = ch.pairs[pj];
          if (pair.video && !pair.video.isComplete) {
            tasks.push({ chapterIdx: ch.chapterIdx, chapterName: ch.name, pairIdx: pj, itemType: 'video', title: pair.video.title, domIndex: pair.video.domIndex, progress: pair.video.progress });
          }
          if (pair.exam && !pair.exam.isComplete) {
            tasks.push({ chapterIdx: ch.chapterIdx, chapterName: ch.name, pairIdx: pj, itemType: 'exam', title: pair.exam.title, domIndex: pair.exam.domIndex, status: pair.exam.status });
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

    static async navigateToDomIndex(domIndex, taskTitle, taskType) {
      // 从考试页/视频页回退后 Vue 可能还没渲染完 DOM，等待重试
      var allItems;
      for (let retry = 0; retry < 5; retry++) {
        allItems = document.querySelectorAll('.el-collapse-item');
        if (allItems.length > 0 && domIndex < allItems.length) break;
        await sleep(1500);
      }
      if (!allItems || domIndex >= allItems.length) {
        logger.error('domIndex ' + domIndex + ' 越界(共' + allItems.length + '个)，Vue可能未渲染完成');
        return false;
      }
      var targetItem = allItems[domIndex];
      var titleEl = targetItem.querySelector('.title span');
      var actualTitle = titleEl ? titleEl.textContent.trim() : '';
      if (taskTitle && actualTitle && actualTitle !== taskTitle) {
        logger.warn('domIndex ' + domIndex + ' 标题不匹配，拒绝误点: "' + actualTitle + '"');
        return false;
      }
      const openedAncestors = await CourseModel.expandCollapsedAncestors(targetItem);
      if (openedAncestors > 0) logger.debug('按需展开父级目录: ' + openedAncestors);
      targetItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(400);
      var ct = targetItem.querySelector('.section') || targetItem.querySelector('.content_main') || targetItem.querySelector('.el-collapse-item__header');
      if (!ct) { logger.error('domIndex ' + domIndex + ': 找不到可点击元素'); return false; }
      ct.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      logger.info('导航: [' + domIndex + '][' + taskType + '] ' + taskTitle);
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
          if (completed) logger.success(`视频播放完成 (${reason})`);
          else logger.warn(`视频未完成 (${reason})`);
          resolve(completed);
        };

        const startEndingCountdown = (reason) => {
          if (resolved || endingCountdownStarted) return;
          endingCountdownStarted = true;
          let remaining = Math.ceil(CONFIG.VIDEO_POST_COMPLETE_DELAY / 1000);
          logger.info(`视频已结束 (${reason})，${remaining} 秒倒计时后继续...`);
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
            else finish(true, `${reason} + ${CONFIG.VIDEO_POST_COMPLETE_DELAY / 1000}s`);
          }, CONFIG.VIDEO_POST_COMPLETE_DELAY);
        };

        video.addEventListener('ended', () => startEndingCountdown('ended'), { once: true });
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
            startEndingCountdown('ended attr');
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
          // 个别播放器不会触发 ended。仅在真正接近时长末尾，或播放时钟仍在推进时兜底；
          // waiting/stalled 或时钟停滞的 99% 不会被误判为完成。
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
                finish(true, `progress >=99% + ${CONFIG.VIDEO_POST_COMPLETE_DELAY / 1000}s`);
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
      if (cards.length === 0) return 'no_cards';
      const done = [...cards].filter(c => c.classList.contains('AnswerEnd')).length;
      const total = cards.length;
      if (done === total) { logger.success(`答题完成 (${done}/${total})`); return 'all_done'; }
      logger.debug(`答题进度: ${done}/${total}`);
      return 'in_progress';
    }

    static async waitForPlugin(timeout = 5 * 60 * 1000, shouldContinue = () => true) {
      logger.info('等待爱问答助手完成答题...');
      const start = Date.now();
      while (Date.now() - start < timeout) {
        if (!shouldContinue()) return false;
        const s = ExamHandler.isPluginDone();
        if (s === 'all_done') return true;
        await sleep(CONFIG.EXAM_CHECK_INTERVAL);
      }
      logger.error('答题等待超时(5分钟)');
      return false;
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
      return state.chapterIdx === task.chapterIdx && state.pairIdx === task.pairIdx && state.itemType === task.itemType;
    }
  }

  function shouldAutoResume(state, currentCourseId = getCourseIdFromHash()) {
    if (!StateManager.isResumable(state)) return false;
    if (!state.courseId) return false;
    return !currentCourseId || String(state.courseId) === String(currentCourseId);
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
      this.tasks = []; // v2待处理任务
      this.stats = { videos: 0, exams: 0, errors: 0, skipped: 0 };
      this.courseId = '';
      this._runId = 0;
      this._reloadTimer = null;
      this._loopRunId = 0;
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
      const isLegacyCheckpoint = StateManager.hasTaskPointer(savedState) && !savedState.courseId;
      const manuallyRestartingStoppedTask = StateManager.hasResumeState(savedState) &&
        savedState.autoResume === false &&
        (!savedState.courseId || !currentCourseId || String(savedState.courseId) === String(currentCourseId));
      if (isLegacyCheckpoint || manuallyRestartingStoppedTask) {
        StateManager.clear();
        logger.info(isLegacyCheckpoint
          ? '检测到旧版无课程 ID 的断点，已清除以避免串课；本次将重新建立断点'
          : '手动重新开始，已清除上一次达到上限的重试状态');
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
      const runId = ++this._runId;

      logger.info('========================================');
      logger.info('=== 自动刷课助手 v2 (domIndex定位) ===');
      logger.info('========================================');

      // 如果在非课程页，先跳转回课程页
      if (!isCoursePage()) {
        logger.info('不在课程页，导航回课程总览...');
        const targetCourseId = this.courseId || (savedMatchesCurrentCourse ? savedState.courseId : '');
        if (!targetCourseId) {
          logger.error('无法确定课程 ID，请回到课程总览页后点击开始');
          this.running = false;
          return;
        }
        window.location.hash = courseOverviewHash(targetCourseId);
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

      // 构建课程模型
      let model;
      try {
        model = await CourseModel.buildModel();
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

      logger.info("待处理: " + this.tasks.length + " 个任务");

      // 按稳定的章节/节次/类型三元组恢复；不依赖旧版已废弃的 currentIndex。
      const savedIndex = savedMatchesCurrentCourse
        ? this.tasks.findIndex(task => StateManager.isSameTask(savedState, task, this.courseId))
        : -1;
      if (savedIndex >= 0) {
        this.currentIndex = savedIndex;
        logger.info("恢复进度: #" + (this.currentIndex + 1) + " " + this.tasks[this.currentIndex].title);
      } else {
        this.currentIndex = 0;
        if (savedMatchesCurrentCourse) logger.info('保存的节次已完成或课程目录已变化，从最早待办继续');
        logger.info("定位起始: " + this.tasks[0].title);
      }

      // 同一节的失败次数必须跨“总览页可加载、视频页仍 500”的场景保留；
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

    skip() {
      logger.info(`跳过: ${this._currentTitle()}`);
      this.currentIndex++;
      this._saveState();
    }

    async _processLoop(runId) {
      // 防止双进程：如果已有循环在运行则直接返回
      if (this._loopRunning && this._loopRunId === runId) {
        logger.warn('_processLoop 已在运行中，跳过重复调用');
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
          logger.error(`索引${this.currentIndex}越界(pending共${this.tasks.length}个)，刷新后重新解析`);
          this._requestReload('任务索引异常');
          break;
        }
        logger.info(`\n--- [${this.currentIndex + 1}/${this.tasks.length}] ${task.title} ---`);
        logger.info(`Type: ${task.itemType} | Chapter: ${task.chapterName}`);

        // 二次确认：当前节次是否真的未完成
        if (isCoursePage()) {
          var recheckItem = document.querySelectorAll('.el-collapse-item')[task.domIndex];
          if (recheckItem) {
            const ll = recheckItem.querySelector('.loadingLinear');
            if (ll && parseFloat(ll.textContent) >= 100) {
              logger.warn(`二次确认: ${task.title} 已完成(>=100%)，跳过`);
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
          logger.warn(`任务未完成，保留当前节次并刷新重试: ${task.title}`);
          this._requestReload('任务处理失败');
        }
        if (this._reloading) {
          logger.info('等待页面刷新恢复...');
          break;
        }
        await sleep(2000);
      }

      // 旧循环在 stop() 后可能晚于新循环结束；不能清掉新循环的互斥标记。
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
      // 视频页/未知页 → 回退到课程页再导航；考试页则在当前页继续处理。
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
      // 仅在课程页检测 AxiosError，避免视频页残留请求超时误判。
      if (isCoursePage()) {
        const bodyText = document.body?.innerText || '';
        if (bodyText.includes('AxiosError') && bodyText.includes('timeout')) {
          logger.warn('检测到 AxiosError timeout，准备刷新恢复...');
          this._requestReload('AxiosError timeout');
          return false;
        }
      }

      const navOk = await CourseModel.navigateToDomIndex(task.domIndex, task.title, task.itemType);
      if (!navOk) {
        logger.warn('导航失败: [' + task.itemType + '] ' + task.title);
        return false;
      }
      logger.debug(`已触发点击: ${task.title}`);

      await sleep(4000);
      for (let attempt = 0; attempt < CONFIG.NAVIGATION_ATTEMPTS; attempt++) {
        if (!this._isActiveRun(runId) || this.paused) return false;

        if (is500Error()) {
          logger.warn('检测到 500 服务器错误，准备刷新恢复...');
          this._requestReload('500 服务器错误');
          return false;
        }

        if (isVideoPage()) {
          this._longOperation = true;
          logger.success('进入视频页面');
          const videoEl = await waitForElement('#xgPlayer video', 8000);
          if (!videoEl) {
            logger.warn('视频播放器未加载');
            return false;
          }
          return VideoHandler.waitForCompletion(() =>
            this._isActiveRun(runId) && !this.paused && videoEl.isConnected !== false && !is500Error()
          );
        }

        if (isExamPage()) {
          this._longOperation = true;
          logger.success('进入考试页面');
          const done = await ExamHandler.waitForPlugin(5 * 60 * 1000, () =>
            this._isActiveRun(runId) && !this.paused && !!document.querySelector('.examQuestion') && !is500Error()
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
            logger.warn(`平台提示应先完成: "${hint}"`);
            const matchIndex = this.tasks.findIndex(t => hint.includes(t.title) || t.title.includes(hint));
            if (matchIndex >= 0 && matchIndex !== this.currentIndex) {
              this.currentIndex = matchIndex;
              this._saveState({ retryCount: 0, retryAt: null, lastReloadReason: '' });
              logger.info(`纠错: 下一个处理 "${this.tasks[matchIndex].title}"`);
              return 'redirected';
            }
            if (matchIndex < 0) logger.warn(`提示节次 "${hint}" 未在待处理列表中匹配到`);
          }
          if (attempt === 2) {
            await CourseModel.navigateToDomIndex(task.domIndex, task.title, task.itemType);
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

    // 看门狗：超过120秒无进展则持久化断点后再刷新。
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
        // 首次解析课程目录前也要有可恢复状态，否则此时遇到 500 会无断点可用。
        return {
          version: 3,
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
        version: 3,
        courseId,
        chapterIdx: task.chapterIdx,
        pairIdx: task.pairIdx,
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
      StateManager.save({
        ...state,
        retryCount,
        retryAt: Date.now() + delay,
        lastReloadReason: reason,
        autoResume: true,
        timestamp: Date.now(),
      });
      this._reloading = true;
      this._longOperation = false;
      this._clearWatchdog();
      logger.warn(`${reason}，${Math.ceil(delay / 1000)} 秒后刷新（连续第 ${retryCount} 次）...`);
      this._reloadTimer = setTimeout(() => {
        if (this._reloading) location.reload();
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
      logger.success('全部完成!');
      logger.info(`视频: ${this.stats.videos} | 考试: ${this.stats.exams} | 错误: ${this.stats.errors}`);
    }
  }

  // ======================== UI 控制面板 ========================
  class ControlPanel {
    constructor(autoPlayer) {
      this.ap = autoPlayer;
      this.panel = null;
      this.expanded = false; // 默认折叠
      this._build();
      logger.onLog(e => this._addLog(e));
    }

    _build() {
      const css = `
      #ouchn-ap-v2{position:fixed;top:72px;right:16px;z-index:99999;width:420px;background:#0D0D12;border:1px solid rgba(255,255,255,.06);border-radius:10px;box-shadow:0 2px 16px rgba(0,0,0,.4);font:14px/1.5 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif;color:#C8C6C2;user-select:none;text-wrap:pretty;min-width:320px;max-width:800px;resize:both;overflow:hidden}
      #ouchn-ap-v2 .hdr{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.06);cursor:move;font-weight:600;font-size:14px;color:#E8E6E3;letter-spacing:.02em}
      #ouchn-ap-v2 .hdr .acts button{background:none;border:none;color:#666;width:24px;height:24px;border-radius:5px;cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center;transition:all .15s}
      #ouchn-ap-v2 .hdr .acts button:hover{background:rgba(255,255,255,.06);color:#aaa}
      #ouchn-ap-v2 .body{padding:10px 14px}
      #ouchn-ap-v2 .live{display:flex;align-items:center;gap:6px;margin-bottom:8px;padding:5px 10px;background:rgba(255,255,255,.03);border-radius:6px;font-size:12px;color:#777}
      #ouchn-ap-v2 .live .dot{width:6px;height:6px;border-radius:50%;background:#D4893B;flex-shrink:0;transition:background .3s}
      #ouchn-ap-v2 .live .dot.on{animation:pulse2 1.5s ease-in-out infinite}
      #ouchn-ap-v2 .live .dot.off{background:#444}
      @keyframes pulse2{0%,100%{opacity:1}50%{opacity:.2}}
      #ouchn-ap-v2 .ctrls{display:flex;gap:5px;margin-bottom:8px;flex-wrap:wrap}
      #ouchn-ap-v2 .ctrls button{flex:1;min-width:50px;padding:6px 3px;border:1px solid rgba(255,255,255,.08);border-radius:6px;cursor:pointer;font-size:11px;font-weight:600;color:#999;background:transparent;transition:all .15s}
      #ouchn-ap-v2 .ctrls button:hover:not(:disabled){border-color:#D4893B;color:#D4893B}
      #ouchn-ap-v2 .ctrls button:disabled{opacity:.3;cursor:not-allowed}
      #ouchn-ap-v2 .ctrls .pri{border-color:#D4893B;color:#D4893B}
      #ouchn-ap-v2 .ctrls .pri:hover:not(:disabled){background:#D4893B;color:#fff}
      #ouchn-ap-v2 .ctrls .dng{border-color:#C44;color:#C44}
      #ouchn-ap-v2 .ctrls .dng:hover:not(:disabled){background:#C44;color:#fff}
      #ouchn-ap-v2 .st{display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:4px;margin-bottom:8px;font-size:10px;color:#666}
      #ouchn-ap-v2 .st span{text-align:center;padding:2px 4px;border-radius:3px;background:rgba(255,255,255,.02)}
      #ouchn-ap-v2 .st b{font-weight:600}
      #ouchn-ap-v2 .st .ok{color:#5A9E6F}
      #ouchn-ap-v2 .st .er{color:#C44}
      #ouchn-ap-v2 .log{background:rgba(255,255,255,.02);border-radius:6px;max-height:300px;overflow-y:auto;padding:6px 8px;font:10px/1.55 'Cascadia Code','SF Mono','Consolas',monospace}
      #ouchn-ap-v2 .log .le{padding:1px 0;border-bottom:1px solid rgba(255,255,255,.02);word-break:break-all;color:#777}
      #ouchn-ap-v2 .log .le[data-l="ERROR"]{color:#E05555}
      #ouchn-ap-v2 .log .le[data-l="WARN"]{color:#D4893B}
      #ouchn-ap-v2 .log .le[data-l="SUCCESS"]{color:#5A9E6F}
      #ouchn-ap-v2 .log .le[data-l="DEBUG"]{color:#555}
      #ouchn-ap-v2 .dbg-row{display:none;gap:5px;margin-bottom:8px}
      #ouchn-ap-v2 .dbg-row.show{display:flex}
      #ouchn-ap-v2 .dbg-row input{flex:1;padding:4px 6px;border:1px solid rgba(255,255,255,.08);border-radius:4px;background:rgba(255,255,255,.03);color:#C8C6C2;font-size:10.5px;outline:none;width:40px}
      #ouchn-ap-v2 .dbg-row button{flex:1;padding:4px 3px;border:1px solid rgba(255,255,255,.08);border-radius:4px;cursor:pointer;font-size:10px;font-weight:600;color:#888;background:transparent;transition:all .15s}
      #ouchn-ap-v2 .dbg-row button:hover{border-color:#D4893B;color:#D4893B}
      #ouchn-ap-v2 .resize-handle{position:absolute;bottom:0;right:0;width:14px;height:14px;cursor:nwse-resize;background:linear-gradient(135deg,transparent 50%,rgba(255,255,255,.15) 50%);border-radius:0 0 9px 0}
      #ouchn-ap-v2 .resize-handle:hover{background:linear-gradient(135deg,transparent 50%,#D4893B 50%)}
      #ouchn-ap-v2.mini .body{display:none}
      #ouchn-ap-v2.mini{width:auto;resize:none}
      `;
      const style = document.createElement('style');
      style.textContent = css;
      document.head.appendChild(style);

      this.panel = document.createElement('div');
      this.panel.id = 'ouchn-ap-v2';
      this.panel.innerHTML = `
        <div class="hdr"><span>自动刷课助手</span><div class="acts"><button class="btn-tog">-</button></div></div>
        <div class="body">
          <div class="live"><span class="dot off" id="adot"></span><span id="astatus">idle</span></div>
          <div class="dbg-row" id="dbgrow">
            <input id="dbgidx" value="0" title="section index">
            <button id="dbgreset">重置</button>
            <button id="dbgupdate">检查更新</button>
          </div>
          <div class="ctrls">
            <button class="pri" id="bs">开始</button>
            <button id="bp" disabled>暂停</button>
            <button class="dng" id="bx" disabled>停止</button>
            <button id="bdbg" style="min-width:24px;flex:0 0 auto;padding:5px 5px">D</button>
          </div>
          <div class="st" id="sb">
            <span>video <b class="ok">0</b></span>
            <span>exam <b class="ok">0</b></span>
            <span>err <b class="er">0</b></span>
            <span>0/0</span>
          </div>
          <div class="log" id="la"><div class="le" data-l="INFO">[INFO] 在课程总览页点击「开始」</div></div>
          <div class="resize-handle"></div>
        </div>`;
      document.body.appendChild(this.panel);

      this.panel.querySelector('#bs').addEventListener('click', () => { this.ap.start(); this._ui(); });
      this.panel.querySelector('#bp').addEventListener('click', () => { this.ap.paused ? this.ap.resume() : this.ap.pause(); this._ui(); });
      this.panel.querySelector('#bx').addEventListener('click', () => { if (confirm('停止?')) { this.ap.stop(); this._ui(); } });
      this.panel.querySelector('#bdbg').addEventListener('click', () => {
        const row = this.panel.querySelector('#dbgrow');
        row.classList.toggle('show');
      });
      this.panel.querySelector('#dbgreset').addEventListener('click', () => { StateManager.clear(); this.ap.stop(); this._ui(); logger.info('状态已重置'); });
      this.panel.querySelector('#dbgupdate').addEventListener('click', () => this._checkUpdate());
      this.panel.querySelector('.btn-tog').addEventListener('click', () => { this.expanded = !this.expanded; this.panel.classList.toggle('mini', !this.expanded); this.panel.querySelector('.btn-tog').textContent = this.expanded ? '-' : '+'; });

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

      const dot = this.panel.querySelector('#adot');
      const st = this.panel.querySelector('#astatus');
      dot.className = 'dot ' + (running ? 'on' : paused ? 'on' : 'off');
      st.textContent = running ? '运行中' : paused ? '已暂停' : '待命';

      const sb = this.panel.querySelector('#sb');
      const total = ap.tasks.length || 0;
      sb.innerHTML = `<span>video <b class="ok">${ap.stats.videos}</b></span>
        <span>exam <b class="ok">${ap.stats.exams}</b></span>
        <span>err <b class="er">${ap.stats.errors}</b></span>
        <span>${ap.currentIndex}/${total}</span>`;
    }

    async _checkUpdate() {
      logger.info('检查更新中...');
      try {
        const resp = await fetch(CONFIG.RELEASE_API_URL, {
          cache: 'no-store',
          headers: { Accept: 'application/vnd.github+json' },
        });
        if (!resp.ok) { logger.warn(`无法获取最新 Release（HTTP ${resp.status}）`); return; }
        const release = await resp.json();
        const remoteTag = release.tag_name || release.name;
        const comparison = compareVersions(remoteTag, CONFIG.VERSION);
        if (comparison === null) {
          logger.warn(`最新 Release 标签无法识别: "${remoteTag || '?'}"`);
          return;
        }
        if (comparison > 0) {
          logger.success(`发现新 Release ${remoteTag}（当前 v${CONFIG.VERSION}），正在打开发布页...`);
          window.open(release.html_url || 'https://github.com/MochizikuNanoka/ouchn-auto-study/releases/latest', '_blank');
        } else if (comparison === 0) {
          logger.info(`已是最新已发布版本 v${CONFIG.VERSION}`);
        } else {
          logger.info(`当前开发版本 v${CONFIG.VERSION} 高于最新 Release ${remoteTag}`);
        }
      } catch (e) {
        logger.warn(`检查更新失败: ${e.message}`);
      }
    }

    _makeDraggable() {
      const hdr = this.panel.querySelector('.hdr');
      let d = false, sx, sy, ix, iy;
      hdr.addEventListener('mousedown', e => {
        if (e.target.tagName === 'BUTTON') return;
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

    // 断点保存在 localStorage，F5 会重建 window，不能再依赖页面内存标记。
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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 2000));
  } else {
    setTimeout(init, 2000);
  }
})();
