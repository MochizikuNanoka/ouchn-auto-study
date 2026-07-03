// ==UserScript==
// @name         国开学习平台 自动刷课助手
// @namespace    https://zydz-menhu.ouchn.edu.cn/
// @version      1.0.6
// @description  自动观看视频 + 自动提交考试（配合爱问答助手）— 基于课程总览页解析进度
// @author       Hermes
// @match        https://zydz-menhu.ouchn.edu.cn/learningPlatform/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  // ======================== 配置 ========================
  const CONFIG = {
    VIDEO_CHECK_INTERVAL: 3000,
    EXAM_CHECK_INTERVAL: 2000,
    NAVIGATION_TIMEOUT: 15000,
    RETRY_DELAY_BASE: 2000,
    RETRY_DELAY_MAX: 30000,
    MAX_RETRIES: 5,
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
    const body = document.body?.innerText || '';
    return body.includes('500') || body.includes('服务器错误') ||
           body.includes('Internal Server Error') ||
           !!document.querySelector('.el-message--error');
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

  // ======================== 课程解析器（重写版 — 基于课程总览页） ========================
  class CourseParser {

    /** 展开所有章节和节次折叠 */
    static async expandAllChapters() {
      // 展开所有 el-collapse-item__header（包括章节级和节次级）
      const headers = document.querySelectorAll('.el-collapse-item__header');
      let count = 0;
      for (const h of headers) {
        const expanded = h.getAttribute('aria-expanded') === 'true';
        if (!expanded) {
          try { h.click(); count++; await sleep(250); } catch (e) {}
        }
      }
      // 再扫一遍，确保嵌套的也展开了
      if (count > 0) {
        await sleep(800);
        const headers2 = document.querySelectorAll('.el-collapse-item__header');
        for (const h of headers2) {
          const expanded = h.getAttribute('aria-expanded') === 'true';
          if (!expanded) {
            try { h.click(); count++; await sleep(200); } catch (e) {}
          }
        }
      }
      if (count > 0) logger.debug(`展开了 ${count} 个面板`);
    }

    /** 解析所有节次（含完成状态） */
    static async parse() {
      await CourseParser.expandAllChapters();
      await sleep(500);

      const sections = [];

      // 找到所有章节 header（含 .title_vice 的）来建立分组
      const chapterHeaders = document.querySelectorAll('.el-collapse-item__header');
      let currentChapter = '';

      for (const header of chapterHeaders) {
        const titleVice = header.querySelector('.title_vice');
        const chapterName = header.querySelector('.chapter_name span');

        if (chapterName) {
          // 这是一个章节头
          currentChapter = chapterName.textContent.trim();
          logger.debug(`章节: ${currentChapter} (${titleVice?.textContent?.trim() || '?'})`);
          continue;
        }
      }

      // 直接找到所有 .hoverItem — 这些是节次条目
      const hoverItems = document.querySelectorAll('.hoverItem');
      logger.info(`找到 ${hoverItems.length} 个节次条目`);

      for (let i = 0; i < hoverItems.length; i++) {
        const item = hoverItems[i];

        // 节次标题 — 多种选择器兜底
        let title = '';
        let isExamFromDom = false;  // DOM本身就标明是考试
        // 视频：.section span:first-child
        const sectionSpan = item.querySelector('.section span:first-child');
        if (sectionSpan) title = sectionSpan.textContent.trim();
        // 考试：.testView .section（格式："测验  X.X.X"）
        if (!title) {
          const testViewSpan = item.querySelector('.testView .section');
          if (testViewSpan) {
            title = testViewSpan.textContent.trim().replace(/\s+/g, ' ');
            title = title.replace(/^测验\s*/, '');
            isExamFromDom = true;  // .testView 就是考试，不用靠标题猜
          }
        }
        if (!title) {
          // 备用：找最近的 header
          const header = item.closest('.el-collapse-item')?.querySelector('.el-collapse-item__header .title');
          if (header) title = header.textContent.trim();
        }
        // 跳过空标题（可能是占位元素）
        if (!title) {
          logger.debug(`跳过空标题项 #${i}`);
          continue;
        }

        // 时长
        const durationSpan = item.querySelector('.section span:last-child');
        const duration = durationSpan?.textContent?.trim() || '';

        // 进度 — loadingLinear 文字（多种兜底）
        let progress = 0;
        const ll = item.querySelector('.loadingLinear');
        if (ll) {
          const t = ll.textContent.trim();
          progress = parseFloat(t);
          if (isNaN(progress)) progress = 0;
        } else {
          // 考试：.content_vice 文字
          const cv = item.querySelector('.content_vice');
          if (cv) {
            const cvText = cv.textContent.trim();
            if (cvText.includes('合格')) progress = 100;
            else progress = 0;  // 未进行、未通过等一律当未完成
          }
        }

        // 判断完成
        const isComplete = progress >= 100;

        // 图标类型判断
        const iconUse = item.querySelector('.iconSvg use');
        const iconHref = iconUse?.getAttribute?.('xlink:href') || iconUse?.getAttribute?.('href') || '';

        // 判断类型：DOM有.testView就是考试，否则看标题
        let type = isExamFromDom ? 'exam' : CourseParser.detectType(title);

        // 找到父级章节
        let chapter = '';
        let parent = item.parentElement;
        while (parent) {
          const chName = parent.querySelector('.chapter_name span');
          if (chName) { chapter = chName.textContent.trim(); break; }
          parent = parent.parentElement;
        }

        sections.push({
          index: i,
          domIndex: i,  // DOM顺序索引，导航时直接用
          title,
          duration,
          progress,
          isComplete,
          type,
          chapter,
        });
      }

      // 统计
      const videos = sections.filter(s => s.type === 'video');
      const exams = sections.filter(s => s.type === 'exam');
      const completed = sections.filter(s => s.isComplete);
      const remaining = sections.filter(s => !s.isComplete);

      logger.info(`解析结果: ${sections.length} 个节次`);
      logger.info(`  视频: ${videos.length} | 考试: ${exams.length}`);
      logger.info(`  已完成: ${completed.length} | 待处理: ${remaining.length}`);

      return sections;
    }

    /** 判断节次类型 */
    static detectType(title) {
      if (/^(任务[一二三四五六七八九十]|测验)/.test(title)) return 'exam';
      return 'video';
    }

    /** 在DOM中查找节次对应的可点击按钮（el-collapse-item__header） */
    static findSectionHeader(title) {
      // 遍历所有 el-collapse-item__header，找到包含目标标题的那个
      const headers = document.querySelectorAll('.el-collapse-item__header');
      for (const header of headers) {
        // 排除章节级 header（含有 chapter_name 的）
        if (header.querySelector('.chapter_name')) continue;
        const headerText = header.textContent.trim();
        // 精确匹配或包含匹配
        if (headerText === title || headerText.includes(title.substring(0, 8))) {
          return header;
        }
      }
      return null;
    }

    /** 在DOM中查找节次的进度元素（.hoverItem 或 .testView，用于解析数据） */
    static findSectionByTitle(title, type) {
      // 按类型优先：type='exam' 先搜 .testView，避免与同名视频标题冲突
      if (type === 'exam') {
        const examItems = document.querySelectorAll('.testView .section');
        for (const item of examItems) {
          const t = item.textContent.trim().replace(/\s+/g, ' ');
          if (t === title || t.includes(title) || title.includes(t.replace(/^测验\s*/, ''))) {
            return item.closest('.hoverItem') || item.closest('[class*="content"]');
          }
        }
      }
      // 视频搜索（对所有类型都执行回退）
      const videoItems = document.querySelectorAll('.hoverItem .section span:first-child');
      for (const item of videoItems) {
        if (item.textContent.trim() === title) {
          return item.closest('.hoverItem');
        }
      }
      // 非 exam 类型的考试回退搜索
      if (type !== 'exam') {
        const examItems = document.querySelectorAll('.testView .section');
        for (const item of examItems) {
          const t = item.textContent.trim().replace(/\s+/g, ' ');
          if (t === title || t.includes(title) || title.includes(t.replace(/^测验\s*/, ''))) {
            return item.closest('.hoverItem') || item.closest('[class*="content"]');
          }
        }
      }
      return null;
    }
  }

  // ======================== 视频处理器 ========================
  class VideoHandler {
    static async waitForCompletion() {
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
        let nearCompleteTime = 0;
        
        const finish = (reason) => {
          if (resolved) return;
          resolved = true;
          logger.success(`视频播放完成 (${reason})`);
          resolve(true);
        };

        video.addEventListener('ended', () => finish('ended'), { once: true });

        const check = setInterval(() => {
          if (resolved) { clearInterval(check); return; }
          
          const bar = document.querySelector('.xgplayer-progress-played');
          const pct = bar ? parseFloat(bar.style.width) : 0;
          
          // >=99% 保底：标记时间，10秒后强制完成
          if (pct >= 99) {
            if (!nearCompleteTime) {
              nearCompleteTime = Date.now();
              logger.info(`进度>=99%，等待10秒后强制完成...`);
            } else if (Date.now() - nearCompleteTime >= 10000) {
              clearInterval(check);
              finish('progress >=99% + 10s');
            }
          }
          
          if (video.ended) { clearInterval(check); finish('ended attr'); }
        }, CONFIG.VIDEO_CHECK_INTERVAL);

        setTimeout(() => { clearInterval(check); if (!resolved) { resolved = true; logger.warn('超时(2小时)强制继续'); resolve(true); } }, 2 * 3600 * 1000);
      });
    }

    static needsRefresh() {
      const v = document.querySelector('#xgPlayer video');
      if (!v) return true;
      const err = document.querySelector('.xgplayer-error');
      if (err && getComputedStyle(err).display !== 'none') return true;
      return false;
    }

    static refreshPage() {
      logger.info('执行F5刷新...');
      window.__ouchn_reloading = true;
      location.reload();
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

    static async waitForPlugin(timeout = 5 * 60 * 1000) {
      logger.info('等待爱问答助手完成答题...');
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const s = ExamHandler.isPluginDone();
        if (s === 'all_done') return true;
        await sleep(CONFIG.EXAM_CHECK_INTERVAL);
      }
      logger.error('答题等待超时(5分钟)');
      return false;
    }

    static async submitExam() {
      logger.info('===== 交卷流程 =====');

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

      // 2. 确认弹窗
      logger.info('[2] 确认弹窗...');
      await sleep(1000);
      const dialogBtns = document.querySelectorAll('.el-message-box__btns button, .el-dialog__footer button, .el-overlay button');
      for (const b of dialogBtns) {
        if (/确认|确定|提交/.test(b.textContent)) { b.click(); logger.success(`点击: "${b.textContent.trim()}"`); break; }
      }
      await sleep(2000);

      // 3. 查看试卷
      logger.info('[3] 查看试卷...');
      await sleep(1000);
      const viewBtn = await waitForElement('.determine', 5000) || findBtnByText('查看试卷');
      if (viewBtn) { viewBtn.click(); logger.success('已点击查看试卷'); await sleep(1500); }
      else { logger.warn('未找到查看试卷按钮，直接返回'); }

      // 4. 返回 — 直接用浏览器回退
      logger.info('[4] 返回课程页...');
      await sleep(500);
      history.back();
      await sleep(2000);

      await sleep(2000);
      return true;
    }
  }

  // ======================== 状态管理 ========================
  class StateManager {
    static save(state) { localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(state)); }
    static load() { try { const r = localStorage.getItem(CONFIG.STORAGE_KEY); return r ? JSON.parse(r) : null; } catch { return null; } }
    static clear() { localStorage.removeItem(CONFIG.STORAGE_KEY); }
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
      this.pendingSections = []; // 未完成的节次
      this.stats = { videos: 0, exams: 0, errors: 0, skipped: 0 };
    }

    restoreState() {
      const s = StateManager.load();
      if (s) {
        this.currentIndex = s.currentIndex || 0;
        this.stats = s.stats || { videos: 0, exams: 0, errors: 0, skipped: 0 };
        return true;
      }
      return false;
    }

    async start() {
      this.running = true;
      this.paused = false;

      logger.info('========================================');
      logger.info('===== 自动刷课助手启动 =====');
      logger.info('========================================');

      // 如果在非课程页，先跳转回课程页
      if (!isCoursePage()) {
        logger.info('不在课程页，导航回课程总览...');
        window.location.hash = '#/myCourse/study?id=3098';
        await sleep(3000);
        if (!isCoursePage()) { logger.error('无法返回课程页'); this.stop(); return; }
      }

      // 解析课程目录
      const allSections = await CourseParser.parse();
      if (allSections.length === 0) { logger.error('未找到课程节次'); this.stop(); return; }

      // 过滤出未完成的
      this.pendingSections = allSections.filter(s => !s.isComplete);
      this.sections = allSections;

      if (this.pendingSections.length === 0) {
        logger.success('所有节次已完成');
        this.stop();
        return;
      }

      logger.info(`待处理: ${this.pendingSections.length} 个节次`);

      // 自动定位：找第一个未完成的节次
      const firstIncomplete = allSections.find(s => !s.isComplete);
      if (firstIncomplete) {
        const indexInPending = this.pendingSections.findIndex(s => s.title === firstIncomplete.title);
        this.currentIndex = indexInPending >= 0 ? indexInPending : 0;
        logger.info(`定位起始节次: "${firstIncomplete.title}" (进度 ${firstIncomplete.progress}%)`);
      }

      // 如果之前有保存的进度且更大，用保存的
      const restored = this.restoreState();
      if (restored && restored.currentIndex > this.currentIndex) {
        logger.info(`恢复进度: 第 ${restored.currentIndex + 1} 个`);
        this.currentIndex = restored.currentIndex;
      }

      this._saveState();
      if (!this._loopRunning) {
        await this._processLoop();
      } else {
        logger.warn('start() 调用时 _processLoop 已在运行');
      }
    }

    pause() { this.paused = true; logger.info('已暂停'); }
    resume() { this.paused = false; logger.info('已继续'); if (!this._loopRunning) this._processLoop(); else logger.warn('resume() 时循环已在运行'); }

    stop() {
      this.running = false;
      this.paused = false;
      this._loopRunning = false;
      StateManager.clear();
      logger.info('已停止，进度已清除');
    }

    skip() {
      logger.info(`跳过: ${this._currentTitle()}`);
      this.currentIndex++;
      this._saveState();
    }

    async _processLoop() {
      // 防止双进程：如果已有循环在运行则直接返回
      if (this._loopRunning) {
        logger.warn('_processLoop 已在运行中，跳过重复调用');
        return;
      }
      this._loopRunning = true;
      this._startWatchdog();
      while (this.running && this.currentIndex < this.pendingSections.length) {
        if (this.paused) { await sleep(1000); continue; }
        if (this._reloading) { await sleep(2000); continue; }

        const section = this.pendingSections[this.currentIndex];
        if (!section) {
          logger.error(`索引${this.currentIndex}越界(pending共${this.pendingSections.length}个)，重置扫描`);
          this.currentIndex = 0;
          await sleep(1000);
          continue;
        }
        logger.info(`\n--- [${this.currentIndex + 1}/${this.pendingSections.length}] ${section.title} ---`);
        logger.info(`Type: ${section.type} | Progress: ${section.progress}% | Chapter: ${section.chapter}`);

        // 二次确认：当前节次是否真的未完成
        if (isCoursePage()) {
          const recheckItem = CourseParser.findSectionByTitle(section.title, section.type);
          if (recheckItem) {
            const ll = recheckItem.querySelector('.loadingLinear');
            if (ll && parseFloat(ll.textContent) >= 100) {
              logger.warn(`二次确认: ${section.title} 已完成(>=100%)，跳过`);
              this.currentIndex++;
              this._saveState();
              continue;
            }
          }
        }

        let success = false;
        try {
          success = await this._navigateAndProcess(section);
          this._longOperation = false;
          this._lastProgressTime = Date.now();
          if (success) {
            if (section.type === 'video') this.stats.videos++;
            else this.stats.exams++;
          } else {
            this.stats.errors++;
          }
        } catch (e) {
          this._longOperation = false;
          logger.error(`异常: ${e.message}`, e.stack);
          this.stats.errors++;
        }

        if (!this._reloading) {
          this.currentIndex++;
          this._saveState();
        } else {
          logger.info('等待页面刷新恢复...');
        }
        await sleep(2000);
      }

      this.running = false;
      this._loopRunning = false;
      StateManager.clear();
      logger.info('\n========================================');
      logger.success('全部完成!');
      logger.info(`视频: ${this.stats.videos} | 考试: ${this.stats.exams} | 错误: ${this.stats.errors}`);
    }

    async _navigateAndProcess(section) {
      // 视频页/未知页 → 回退到课程页再导航
      // 考试页 → 不退回，直接处理（submitExam里会回退）
      if (!isCoursePage() && !isExamPage()) {
        logger.info('回退到课程页...');
        history.back();
        await sleep(3000);
        if (!isCoursePage()) {
          history.back();
          await sleep(3000);
        }
      }

      // 检测页面是否挂了（AxiosError timeout）
      const bodyText = document.body?.innerText || '';
      const isDead = bodyText.includes('AxiosError') && bodyText.includes('timeout');
      if (isDead) {
        logger.warn('检测到 AxiosError timeout，F5刷新...');
        this._markReload();
        location.reload();
        return false;
      }

      // ===== 导航核心：优先标题匹配，domIndex作最后回退 =====
      // 确保目标章节展开
      if (section.chapter) {
        const chapterHeaders = document.querySelectorAll('.el-collapse-item__header');
        for (const ch of chapterHeaders) {
          const cn = ch.querySelector('.chapter_name span');
          if (cn && cn.textContent.trim() === section.chapter) {
            if (ch.getAttribute('aria-expanded') !== 'true') {
              ch.click();
              await sleep(600);
            }
            break;
          }
        }
      }

      // 方法1: 标题匹配（不受DOM折叠影响）
      let hoverItem = CourseParser.findSectionByTitle(section.title, section.type);
      let matchMethod = 'title';

      // 方法2: 找不到就全展开后再按标题搜索
      if (!hoverItem || hoverItem.offsetParent === null) {
        await CourseParser.expandAllChapters();
        await sleep(500);
        const allItems = document.querySelectorAll('.hoverItem');
        for (const item of allItems) {
          const secSpan = item.querySelector('.section span:first-child');
          const testSpan = item.querySelector('.testView .section');
          const itemTitle = (secSpan?.textContent?.trim() || testSpan?.textContent?.trim() || '').replace(/\s+/g, ' ');
          if (itemTitle === section.title || itemTitle.includes(section.title.substring(0, 8))) {
            hoverItem = item;
            matchMethod = 'title-fullexpand';
            break;
          }
        }
        // 方法3: domIndex终极回退
        if (!hoverItem) {
          hoverItem = allItems[section.domIndex];
          matchMethod = 'domIndex';
        }
      }

      if (!hoverItem) {
        logger.warn(`未找到节次: ${section.title}，跳过`);
        return false;
      }
      logger.debug(`导航定位: ${matchMethod} -> "${section.title}"`);

      // 确保父级可见
      if (hoverItem.offsetParent === null) {
        const wrap = hoverItem.closest('.el-collapse-item__wrap');
        const header = wrap?.closest('.el-collapse-item')?.querySelector('.el-collapse-item__header');
        if (header && header.getAttribute('aria-expanded') !== 'true') {
          header.click();
          await sleep(800);
        }
      }

      // 滚动到可见
      hoverItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(500);

      // 点击目标：统一用 .section（导航触发点），.testView 只是容器不会触发导航
      const clickTarget = hoverItem.querySelector('.section') || hoverItem.querySelector('.content_main') || hoverItem;
      clickTarget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      logger.debug(`已触发点击: ${section.title}`);

      await sleep(1000);
      await sleep(3000);

      // 500 重试
      for (let retry = 0; retry < CONFIG.MAX_RETRIES; retry++) {
        if (this.paused) return false;

        if (is500Error()) {
          logger.warn(`500错误，第${retry + 1}次重试...`);
          await sleep(CONFIG.RETRY_DELAY_BASE * (retry + 1));
          this._markReload();
          location.reload();
          await sleep(3000);
          continue;
        }

        if (isVideoPage()) {
          this._longOperation = true;
          logger.success('进入视频页面');
          // F5 刷新如果需要
          if (VideoHandler.needsRefresh()) {
            logger.info('视频未加载，执行F5刷新...');
            this._markReload();
            VideoHandler.refreshPage();
            return false;
          }
          return await VideoHandler.waitForCompletion();
        }

        if (isExamPage()) {
          this._longOperation = true;
          logger.success('进入考试页面');
          if (is500Error()) {
            this._markReload();
            location.reload();
            return false;
          }
          const done = await ExamHandler.waitForPlugin();
          if (!done) return false;
          await sleep(2000);
          return await ExamHandler.submitExam();
        }

        if (isCoursePage()) {
          logger.debug('仍在课程页，等待跳转...');
          // 可能是点击没生效，重试点击
          if (retry === 2) {
            clickTarget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            logger.debug('重新触发点击...');
          }
          await sleep(2000);
          continue;
        }

        await sleep(1000);
      }

      logger.error('页面跳转超时，F5刷新重试...');
      this._markReload();
      location.reload();
      return false;
    }


    // 看门狗：超过120秒无进展则强制F5恢复
    _startWatchdog() {
      if (this._watchdogTimer) clearInterval(this._watchdogTimer);
      this._lastProgressTime = Date.now();
      this._watchdogTimer = setInterval(() => {
        if (!this.running || this.paused || this._reloading) return;
        if (this._longOperation) return;  // 视频播放/考试等待中，豁免
        const elapsed = Date.now() - this._lastProgressTime;
        if (elapsed > 120000) {
          logger.warn(`[看门狗] ${Math.floor(elapsed / 1000)}秒无进展，强制F5恢复...`);
          this._markReload();
          location.reload();
        }
      }, 30000);
    }

    _currentTitle() {
      if (this.currentIndex < this.pendingSections.length) return this.pendingSections[this.currentIndex].title;
      return '未知';
    }

    _saveState() {
      const section = this.pendingSections[this.currentIndex];
      StateManager.save({
        currentIndex: this.currentIndex,
        currentTitle: section?.title || '',
        stats: this.stats,
        timestamp: Date.now(),
      });
    }

    _markReload() {
      if (this._reloading) return;
      this._reloading = true;
      this._saveState();
      window.__ouchn_reloading = true;
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
      const total = ap.pendingSections.length || 0;
      sb.innerHTML = `<span>video <b class="ok">${ap.stats.videos}</b></span>
        <span>exam <b class="ok">${ap.stats.exams}</b></span>
        <span>err <b class="er">${ap.stats.errors}</b></span>
        <span>${ap.currentIndex}/${total}</span>`;
    }

    async _checkUpdate() {
      logger.info('检查更新中...');
      try {
        const resp = await fetch('https://raw.githubusercontent.com/MochizikuNanoka/ouchn-auto-study/master/%E5%9B%BD%E5%BC%80%E5%AD%A6%E4%B9%A0%E5%B9%B3%E5%8F%B0-%E8%87%AA%E5%8A%A8%E5%88%B7%E8%AF%BE%E5%8A%A9%E6%89%8B.user.js?t=' + Date.now());
        if (!resp.ok) { logger.warn('无法获取远端版本'); return; }
        const text = await resp.text();
        const m = text.match(/@version\s+([\d.]+)/);
        if (!m) { logger.warn('未找到远端版本号'); return; }
        const remoteVer = m[1];
        const localVer = '1.0.6';
        if (remoteVer !== localVer) {
          logger.success(`发现新版本 v${remoteVer}（当前 v${localVer}），正在打开下载页...`);
          window.open('https://github.com/MochizikuNanoka/ouchn-auto-study/releases', '_blank');
        } else {
          logger.info(`已是最新 v${localVer}`);
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

    const wasReloading = !!window.__ouchn_reloading;
    if (wasReloading) {
      logger.info('检测到刷新恢复标记');
      window.__ouchn_reloading = false;
    }

    const ap = new AutoPlayer();
    new ControlPanel(ap);

    // F5 恢复
    if (wasReloading) {
      const saved = StateManager.load();
      if (saved && saved.currentIndex > 0) {
        ap.currentIndex = saved.currentIndex || 0;
        ap.stats = saved.stats || { videos: 0, exams: 0, errors: 0, skipped: 0 };
        ap._lastProgressTime = Date.now();

        if (isVideoPage()) {
          logger.info(`恢复视频处理: "${saved.currentTitle || '?'}"`);
          ap.running = true;
          ap._longOperation = true;
          ap._startWatchdog();
          VideoHandler.waitForCompletion().then(async () => {
            ap._lastProgressTime = Date.now();
            ap.currentIndex++;
            ap.stats.videos++;
            ap._saveState();
            history.back();
            await sleep(3000);
            ap._reloading = true;
            await ap.start();
          });
        } else if (isExamPage()) {
          logger.info(`恢复考试处理: "${saved.currentTitle || '?'}"`);
          ap.running = true;
          ap._longOperation = true;
          ap._startWatchdog();
          ExamHandler.waitForPlugin().then(async done => {
            if (done) {
              await ExamHandler.submitExam();
              ap._lastProgressTime = Date.now();
              ap.currentIndex++;
              ap.stats.exams++;
              ap._saveState();
              await sleep(2000);
              if (!isCoursePage()) history.back();
              await sleep(3000);
            }
            ap._reloading = true;
            await ap.start();
          });
        } else if (isCoursePage()) {
          logger.info('课程页已恢复，重新解析并继续...');
          ap._reloading = true;
          await sleep(1500);
          const allSections = await CourseParser.parse();
          ap.pendingSections = allSections.filter(s => !s.isComplete);
          ap.sections = allSections;
          if (ap.pendingSections.length === 0) {
            logger.success('所有节次已完成');
            StateManager.clear();
            return;
          }
          logger.info(`待处理: ${ap.pendingSections.length} 个节次`);
          ap.running = true;
          ap._startWatchdog();
          await ap.start();
        }
      }
    }

    logger.success('初始化完成');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 2000));
  } else {
    setTimeout(init, 2000);
  }
})();