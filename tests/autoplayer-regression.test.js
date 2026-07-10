const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const scriptPath = path.join(__dirname, '..', '国开学习平台-自动刷课助手.user.js');

function createHarness({ hash = '#/myCourse/study?id=3016', storage = new Map() } = {}) {
  let now = 0;
  let nextTimerId = 1;
  let reloads = 0;
  const timers = new Map();
  const selectors = new Map();

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
  const context = {
    Date: FakeDate,
    JSON,
    Math,
    MouseEvent: class MouseEvent {},
    Promise,
    URLSearchParams,
    clearInterval: clearTimer,
    clearTimeout: clearTimer,
    console: { debug() {}, error() {}, log() {}, warn() {} },
    document,
    getComputedStyle: () => ({ display: 'none' }),
    history: { back() {} },
    location,
    localStorage: {
      clear() { storage.clear(); },
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      removeItem(key) { storage.delete(key); },
      setItem(key, value) { storage.set(key, String(value)); },
    },
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
    "  globalThis.__AUTOPLAYER_TEST_HOOKS__ = { AutoPlayer, CONFIG, CourseModel, StateManager, VideoHandler, compareVersions: typeof compareVersions === 'function' ? compareVersions : undefined, init, shouldAutoResume };\n\n" + initMarker,
  );
  vm.runInNewContext(instrumented, context, { filename: scriptPath });

  return {
    advance,
    context,
    get reloads() { return reloads; },
    hooks: context.__AUTOPLAYER_TEST_HOOKS__,
    selectors,
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

test('compares GitHub Release versions numerically rather than by inequality', () => {
  const harness = createHarness();
  const { compareVersions } = harness.hooks;

  assert.equal(compareVersions('v2.0.1', '2.0.2'), -1);
  assert.equal(compareVersions('v2.0.2', '2.0.2'), 0);
  assert.equal(compareVersions('v2.0.10', '2.0.3'), 1);
  assert.equal(compareVersions('invalid', '2.0.3'), null);
});

test('waits for a stable course directory rather than one transient DOM node', async () => {
  const harness = createHarness();
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
