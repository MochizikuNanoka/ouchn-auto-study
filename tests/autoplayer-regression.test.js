const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const scriptPath = path.join(__dirname, '..', '国开学习平台-自动刷课助手.user.js');

function createHarness({ hash = '#/myCourse/study?id=3016', storage = new Map(), session = new Map() } = {}) {
  let now = 0;
  let nextTimerId = 1;
  let reloads = 0;
  const timers = new Map();
  const selectors = new Map();
  const logs = [];

  const schedule = (callback, delay, repeat = false) => {
    const id = nextTimerId++;
    timers.set(id, { callback, due: now + Number(delay || 0), delay: Number(delay || 0), repeat });
    return id;
  };

  const clearTimer = id => timers.delete(id);
  const advance = milliseconds => {
    const target = now + milliseconds;
    while (true) {
      const next = [...timers.entries()]
        .filter(([, timer]) => timer.due <= target)
        .sort(([, a], [, b]) => a.due - b.due)[0];
      if (!next) break;
      const [id, timer] = next;
      now = timer.due;
      if (timer.repeat) timer.due += timer.delay;
      else timers.delete(id);
      timer.callback();
    }
    now = target;
  };

  class FakeDate extends Date {
    constructor(...args) {
      super(args.length ? args[0] : now);
    }

    static now() {
      return now;
    }
  }

  const location = {
    hash,
    reload() {
      reloads += 1;
    },
  };
  const document = {
    readyState: 'loading',
    body: { innerText: '' },
    head: { appendChild() {} },
    addEventListener() {},
    querySelector(selector) {
      return selectors.get(selector) || null;
    },
    querySelectorAll(selector) {
      const value = selectors.get(selector);
      return Array.isArray(value) ? value : value ? [value] : [];
    },
  };
  const createStorage = store => ({
    clear() { store.clear(); },
    get length() { return store.size; },
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    key(index) { return [...store.keys()][index] || null; },
    removeItem(key) { store.delete(key); },
    setItem(key, value) { store.set(key, String(value)); },
  });
  const context = {
    Date: FakeDate,
    JSON,
    Math,
    MouseEvent: class MouseEvent {},
    Promise,
    URLSearchParams,
    clearInterval: clearTimer,
    clearTimeout: clearTimer,
    console: {
      debug(...args) { logs.push({ level: 'debug', message: String(args[0] || '') }); },
      error(...args) { logs.push({ level: 'error', message: String(args[0] || '') }); },
      log(...args) { logs.push({ level: 'log', message: String(args[0] || '') }); },
      warn(...args) { logs.push({ level: 'warn', message: String(args[0] || '') }); },
    },
    document,
    getComputedStyle: () => ({ display: 'none' }),
    history: { back() {} },
    location,
    localStorage: createStorage(storage),
    sessionStorage: createStorage(session),
    setInterval(callback, delay) { return schedule(callback, delay, true); },
    setTimeout(callback, delay) { return schedule(callback, delay, false); },
    window: { location },
  };
  context.globalThis = context;

  const source = fs.readFileSync(scriptPath, 'utf8');
  const initMarker = "  if (document.readyState === 'loading') {";
  assert.ok(source.includes(initMarker), 'test hook insertion point is missing');
  let instrumented = source.replace(
    '    new ControlPanel(ap);',
    '    globalThis.__TEST_LAST_AUTOPLAYER__ = ap;',
  );
  assert.notEqual(instrumented, source, 'ControlPanel test replacement point is missing');
  instrumented = instrumented.replace(
    initMarker,
    "  globalThis.__AUTOPLAYER_TEST_HOOKS__ = { AutoPlayer, CONFIG, CourseModel, StateManager, VideoHandler, ExamHandler, compareVersions: typeof compareVersions === 'function' ? compareVersions : undefined, init, shouldAutoResume };\n\n" + initMarker,
  );
  vm.runInNewContext(instrumented, context, { filename: scriptPath });

  return {
    advance,
    context,
    get reloads() { return reloads; },
    hooks: context.__AUTOPLAYER_TEST_HOOKS__,
    logs,
    selectors,
    session,
    storage,
  };
}

function createVideo() {
  const listeners = new Map();
  return {
    ended: false,
    paused: false,
    play() { return Promise.resolve(); },
    addEventListener(type, callback) { listeners.set(type, callback); },
    emit(type) { listeners.get(type)?.(); },
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

test('persists the first task as a resumable F5 checkpoint and keeps retry state', () => {
  const harness = createHarness();
  const { AutoPlayer, StateManager, shouldAutoResume } = harness.hooks;
  const player = new AutoPlayer();
  player.running = true;
  player.courseId = '3016';
  player.tasks = [{
    chapterIdx: 0,
    chapterName: '第一章',
    domIndex: 1,
    itemType: 'video',
    pairIdx: 0,
    title: '1.1 第一节',
  }];

  player._saveState();
  const checkpoint = StateManager.load();
  assert.equal(checkpoint.courseId, '3016');
  assert.equal(shouldAutoResume(checkpoint, '3016'), true, '第一个任务也必须可以自动恢复');

  assert.equal(player._requestReload('500 错误'), true);
  const retryCheckpoint = StateManager.load();
  assert.equal(retryCheckpoint.retryCount, 1);
  assert.equal(shouldAutoResume(retryCheckpoint, '3016'), true);

  harness.advance(2000);
  assert.equal(harness.reloads, 1, '应在首轮退避后执行一次 F5');
});

test('init automatically restarts a first-task checkpoint after a full F5', async () => {
  const storage = new Map([['ouchn_autoplay_v2', JSON.stringify({
    autoResume: true,
    chapterIdx: 0,
    courseId: '3016',
    itemType: 'video',
    pairIdx: 0,
    retryCount: 1,
    title: '1.1 第一节',
  })]]);
  const harness = createHarness({
    hash: '#/myCourseDetails/vidoStudy?courseId=3016&sectionId=99',
    storage,
  });
  let starts = 0;
  harness.hooks.AutoPlayer.prototype.start = async function startForTest() {
    starts += 1;
  };

  await harness.hooks.init();
  assert.equal(starts, 1, 'F5 后无需再次点击“开始”');
});

test('never resumes a checkpoint for a different course or a deliberately stopped task', () => {
  const harness = createHarness();
  const { shouldAutoResume } = harness.hooks;
  const checkpoint = { chapterIdx: 0, pairIdx: 0, itemType: 'video', courseId: '3016' };

  assert.equal(shouldAutoResume(checkpoint, '3017'), false);
  assert.equal(shouldAutoResume({ ...checkpoint, autoResume: false }, '3016'), false);
});

test('keeps retrying the same task beyond five refreshes', () => {
  const harness = createHarness();
  const makePlayer = () => {
    const player = new harness.hooks.AutoPlayer();
    player.running = true;
    player.courseId = '3016';
    player.tasks = [{ chapterIdx: 0, pairIdx: 0, itemType: 'video', title: '1.1 第一节' }];
    return player;
  };

  let player = makePlayer();
  player._saveState();
  for (let attempt = 1; attempt <= 8; attempt++) {
    assert.equal(player._requestReload('500 错误'), true);
    assert.equal(harness.hooks.StateManager.load().retryCount, attempt);
    player = makePlayer(); // 模拟完整 F5 后的新用户脚本实例。
  }

  const persisted = harness.hooks.StateManager.load();
  assert.equal(persisted.autoResume, true);
  assert.equal(persisted.retryCount, 8);
});

test('clears only assistant cache keys and preserves unrelated platform storage', () => {
  const storage = new Map([
    ['ouchn_autoplay_v2', 'current'],
    ['ouchn_autoplay_v1', 'legacy'],
    ['platform-preference', 'keep'],
  ]);
  const session = new Map([
    ['ouchn_autoplay_temp', 'discard'],
    ['platform-session-hint', 'keep'],
  ]);
  const harness = createHarness({ storage, session });

  assert.equal(harness.hooks.StateManager.clearCache(), 3);
  assert.equal(storage.has('ouchn_autoplay_v2'), false);
  assert.equal(storage.has('ouchn_autoplay_v1'), false);
  assert.equal(session.has('ouchn_autoplay_temp'), false);
  assert.equal(storage.get('platform-preference'), 'keep');
  assert.equal(session.get('platform-session-hint'), 'keep');
});

test('cache reset stops the task and reloads the current course overview', () => {
  const storage = new Map([
    ['ouchn_autoplay_v2', 'discard'],
    ['platform-preference', 'keep'],
  ]);
  const harness = createHarness({
    hash: '#/myCourseDetails/vidoStudy?courseId=3016&sectionId=99',
    storage,
  });
  const player = new harness.hooks.AutoPlayer();
  player.running = true;
  player.courseId = '3016';

  assert.equal(player.resetCacheAndReload(), 1);
  assert.equal(player.running, false);
  assert.equal(storage.has('ouchn_autoplay_v2'), false);
  assert.equal(storage.get('platform-preference'), 'keep');

  harness.advance(harness.hooks.CONFIG.CACHE_RESET_RELOAD_DELAY);
  const [route, query] = harness.context.location.hash.split('?');
  const params = new URLSearchParams(query);
  assert.equal(harness.reloads, 1);
  assert.equal(route, '#/myCourse/study');
  assert.equal(params.get('id'), '3016');
  assert.ok(params.get('_apScan'));
});

test('automatic F5 recovery forces a new course-overview directory scan', () => {
  const harness = createHarness({
    hash: '#/myCourseDetails/vidoStudy?courseId=3016&sectionId=99',
  });
  const player = new harness.hooks.AutoPlayer();
  player.running = true;
  player.courseId = '3016';
  player.tasks = [{
    chapterIdx: 0,
    pairIdx: 0,
    itemType: 'video',
    title: '1.1 第一节',
  }];
  player._saveState();

  assert.equal(player._requestReload('课程目录异常'), true);
  const checkpoint = harness.hooks.StateManager.load();
  assert.equal(checkpoint.forceFreshDirectory, true);
  assert.ok(checkpoint.directoryScanId);
  assert.equal(checkpoint.chapterIdx, 0);
  assert.equal(checkpoint.pairIdx, 0);

  harness.advance(2000);
  const [route, query] = harness.context.location.hash.split('?');
  const params = new URLSearchParams(query);
  assert.equal(harness.reloads, 1);
  assert.equal(route, '#/myCourse/study');
  assert.equal(params.get('id'), '3016');
  assert.equal(params.get('_apScan'), checkpoint.directoryScanId);
});

test('fresh recovery rebuilds tasks from the new directory before matching its checkpoint', async () => {
  const scanId = 'fresh-directory-a';
  const storage = new Map([['ouchn_autoplay_v2', JSON.stringify({
    autoResume: true,
    chapterIdx: 0,
    courseId: '3016',
    directoryScanId: scanId,
    forceFreshDirectory: true,
    itemType: 'video',
    pairIdx: 0,
    title: '旧目录任务',
  })]]);
  const harness = createHarness({
    hash: `#/myCourse/study?id=3016&_apScan=${scanId}`,
    storage,
  });
  const freshTask = {
    chapterIdx: 0,
    chapterName: '第一章',
    domIndex: 5,
    itemType: 'video',
    pairIdx: 0,
    title: '新目录任务',
  };
  let receivedScanId = null;
  harness.hooks.CourseModel.buildModel = async ({ scanId: received } = {}) => {
    receivedScanId = received;
    return { chapters: [] };
  };
  harness.hooks.CourseModel.getPendingTasks = () => [freshTask];
  harness.hooks.AutoPlayer.prototype._processLoop = async function noop() {};

  const player = new harness.hooks.AutoPlayer();
  player.tasks = [{ title: '内存旧目录任务' }];
  await player.start();

  assert.equal(receivedScanId, scanId);
  assert.equal(player.tasks.length, 1);
  assert.equal(player.tasks[0].title, '新目录任务');
  assert.equal(harness.hooks.StateManager.load().forceFreshDirectory, undefined);
  assert.equal(harness.hooks.StateManager.load().directoryScanId, undefined);
});

test('rejects a fresh directory scan when the route token no longer matches', async () => {
  const harness = createHarness({ hash: '#/myCourse/study?id=3016&_apScan=current-token' });

  const model = await harness.hooks.CourseModel.buildModel({ scanId: 'old-token' });
  assert.equal(model, null);
});

test('compares GitHub Release versions numerically rather than by inequality', () => {
  const harness = createHarness();
  const { compareVersions } = harness.hooks;

  assert.equal(compareVersions('v2.0.1', '2.0.2'), -1);
  assert.equal(compareVersions('v2.0.2', '2.0.2'), 0);
  assert.equal(compareVersions('v2.0.10', '2.0.3'), 1);
  assert.equal(compareVersions('invalid', '2.0.3'), null);
});

test('题干含 500 时仍等待题目状态，不按文本刷新', async () => {
  const harness = createHarness({ hash: '#/examQuestion?id=3016' });
  harness.context.document.body.innerText = '第 500 题：正常题干内容';
  harness.selectors.set('#app', { innerText: '第 500 题：正常题干内容' });
  harness.selectors.set('.examQuestion', {});

  let waitCalls = 0;
  harness.hooks.CourseModel.navigateToDomIndex = async () => true;
  harness.hooks.ExamHandler.waitForPlugin = async () => {
    waitCalls += 1;
    return false;
  };

  const player = new harness.hooks.AutoPlayer();
  player.running = true;
  player._runId = 1;
  player.courseId = '3016';

  const pending = player._navigateAndProcess({ domIndex: 0, itemType: 'exam', title: '第 500 题' }, 1);
  await flushPromises();
  harness.advance(4000);
  await flushPromises();

  assert.equal(await pending, false);
  assert.equal(waitCalls, 1, '应进入题目状态等待，而不是按页面文本中断');
  assert.equal(player._reloading, false);
  assert.equal(harness.reloads, 0);
});

test('读到题目状态后持续等待完成，不因五分钟超时刷新', async () => {
  const harness = createHarness();
  let continueWaiting = true;
  harness.selectors.set('.everyAnswer', [{
    classList: { contains: () => false },
  }]);

  let settled = false;
  const pending = harness.hooks.ExamHandler.waitForPlugin(4000, () => continueWaiting);
  pending.then(() => { settled = true; });
  await flushPromises();
  harness.advance(6000);
  await flushPromises();
  assert.equal(settled, false, '已有题目状态时应继续等待答题插件，而不是触发刷新');
  const statusLogs = harness.logs.filter(log => log.message.includes('已读取题目状态'));
  assert.equal(statusLogs.length, 1, '题目状态提示只能在首次读取时输出一次');
  assert.equal(statusLogs[0].level, 'log', '题目状态提示不应使用 WARN 级别');

  continueWaiting = false;
  harness.advance(2000);
  await flushPromises();
  assert.equal(await pending, false);
});

test('opens collapsed task ancestors from outermost to innermost', async () => {
  const harness = createHarness();
  const clicks = [];
  const makeHeader = name => ({
    getAttribute(attribute) {
      return attribute === 'aria-expanded' ? 'false' : null;
    },
    click() {
      clicks.push(name);
    },
  });
  const outerHeader = makeHeader('chapter');
  const innerHeader = makeHeader('section');
  const outerItem = {
    classList: { contains: value => value === 'el-collapse-item' },
    parentElement: null,
    querySelector: selector => selector === '.el-collapse-item__header' ? outerHeader : null,
  };
  const outerWrap = { classList: { contains: () => false }, parentElement: outerItem };
  const innerItem = {
    classList: { contains: value => value === 'el-collapse-item' },
    parentElement: outerWrap,
    querySelector: selector => selector === '.el-collapse-item__header' ? innerHeader : null,
  };
  const innerWrap = { classList: { contains: () => false }, parentElement: innerItem };
  const targetItem = { parentElement: innerWrap };

  const pending = harness.hooks.CourseModel.expandCollapsedAncestors(targetItem);
  await flushPromises();
  assert.deepEqual(clicks, ['chapter']);

  harness.advance(400);
  await flushPromises();
  assert.deepEqual(clicks, ['chapter', 'section']);

  harness.advance(400);
  assert.equal(await pending, 2);
});

test('课程页含 500 时仍按稳定 DOM 扫描目录', async () => {
  const harness = createHarness();
  harness.context.document.body.innerText = '课程内容包含 500，但目录节点正常';
  harness.selectors.set('#app', { innerText: '课程内容包含 500，但目录节点正常' });
  const chapterHeader = {
    querySelector(selector) {
      return selector === '.chapter_name' ? {} : null;
    },
  };
  harness.selectors.set('.el-collapse-item', [{}]);
  harness.selectors.set('.el-collapse-item__header', [chapterHeader]);
  harness.selectors.set('.hoverItem', [{}]);

  const pending = harness.hooks.CourseModel.waitForStableDirectory({
    requireCourseItems: true,
    stableMs: 1000,
    timeout: 2500,
  });
  let resolved = false;
  pending.then(() => { resolved = true; });
  await flushPromises();
  harness.advance(500);
  await flushPromises();
  assert.equal(resolved, false, '单次轮询中的目录节点不能立即视为课程总览已就绪');
  harness.advance(500);
  await flushPromises();

  const snapshot = await pending;
  assert.equal(snapshot.chapterCount, 1);
  assert.equal(snapshot.courseItemCount, 1);
});

test('creates a resumable bootstrap checkpoint before the course directory is parsed', () => {
  const harness = createHarness();
  const player = new harness.hooks.AutoPlayer();
  player.running = true;
  player.courseId = '3016';

  assert.equal(player._requestReload('课程目录 500'), true);
  const checkpoint = harness.hooks.StateManager.load();
  assert.equal(checkpoint.stage, 'initializing');
  assert.equal(checkpoint.courseId, '3016');
  assert.equal(harness.hooks.shouldAutoResume(checkpoint, '3016'), true);
});

test('manual start clears a checkpoint that exhausted retries', async () => {
  const storage = new Map([['ouchn_autoplay_v2', JSON.stringify({
    autoResume: false,
    chapterIdx: 0,
    courseId: '3016',
    itemType: 'video',
    pairIdx: 0,
    retryCount: 6,
    title: '1.1 第一节',
  })]]);
  const harness = createHarness({ storage });
  const task = { chapterIdx: 0, pairIdx: 0, itemType: 'video', title: '1.1 第一节', domIndex: 1 };
  harness.hooks.CourseModel.buildModel = async () => ({ chapters: [] });
  harness.hooks.CourseModel.getPendingTasks = () => [task];
  harness.hooks.AutoPlayer.prototype._processLoop = async function noop() {};

  const player = new harness.hooks.AutoPlayer();
  await player.start();
  const restarted = harness.hooks.StateManager.load();
  assert.equal(restarted.retryCount, 0);
  assert.equal(restarted.autoResume, true);
});

test('stopping during a retry delay cancels the pending browser reload', () => {
  const harness = createHarness();
  const player = new harness.hooks.AutoPlayer();
  player.running = true;
  player.courseId = '3016';
  player.tasks = [{ chapterIdx: 0, pairIdx: 0, itemType: 'video', title: '1.1 第一节' }];
  player._saveState();
  player._requestReload('500 错误');
  player.stop();

  harness.advance(30000);
  assert.equal(harness.reloads, 0);
  assert.equal(harness.hooks.StateManager.load(), null);
});

test('waits the full 10 seconds after ended before completing a video', async () => {
  const harness = createHarness();
  const video = createVideo();
  harness.selectors.set('#xgPlayer video', video);
  let settled = false;
  const completion = harness.hooks.VideoHandler.waitForCompletion(() => true).then(result => {
    settled = result;
  });
  await flushPromises();

  video.ended = true;
  video.emit('ended');
  await flushPromises();
  assert.equal(settled, false, 'ended 不能立即进入下一节');

  harness.advance(9999);
  await flushPromises();
  assert.equal(settled, false, '倒计时未满 10 秒不得完成');

  harness.advance(1);
  await completion;
  assert.equal(settled, true);
});

test('does not use a paused 99% player as a completion signal', async () => {
  const harness = createHarness();
  const video = createVideo();
  const progressBar = { style: { width: '99%' } };
  harness.selectors.set('#xgPlayer video', video);
  harness.selectors.set('.xgplayer-progress-played', progressBar);
  let settled = false;
  harness.hooks.VideoHandler.waitForCompletion(() => true).then(result => {
    settled = result;
  });
  await flushPromises();

  video.paused = true;
  harness.advance(15000);
  await flushPromises();
  assert.equal(settled, false, '暂停或缓冲时 99% 不能强制跳下一节');
});

test('does not complete a 99% player whose playback clock has stopped', async () => {
  const harness = createHarness();
  const video = createVideo();
  video.currentTime = 90;
  video.duration = 100;
  const progressBar = { style: { width: '99%' } };
  harness.selectors.set('#xgPlayer video', video);
  harness.selectors.set('.xgplayer-progress-played', progressBar);
  let settled = false;
  harness.hooks.VideoHandler.waitForCompletion(() => true).then(result => {
    settled = result;
  });
  await flushPromises();

  harness.advance(15000);
  await flushPromises();
  assert.equal(settled, false, '播放时钟停住时不能仅凭 99% 跳下一节');
});

test('abandons a video promptly when its player is removed from the page', async () => {
  const harness = createHarness();
  const video = createVideo();
  harness.selectors.set('#xgPlayer video', video);
  let settled = null;
  harness.hooks.VideoHandler.waitForCompletion(() => true).then(result => {
    settled = result;
  });
  await flushPromises();

  harness.selectors.delete('#xgPlayer video');
  harness.advance(3000);
  await flushPromises();
  assert.equal(settled, false, '播放器卸载后应交给外层刷新恢复，而不是等待两小时');
});

test('does not auto-resume a legacy checkpoint without a course ID', () => {
  const harness = createHarness();
  const legacyCheckpoint = { chapterIdx: 0, pairIdx: 0, itemType: 'video' };
  assert.equal(harness.hooks.shouldAutoResume(legacyCheckpoint, '3016'), false);
});
