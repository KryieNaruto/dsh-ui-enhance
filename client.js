window.__ModuleLoader__.load({
  id: '@local/ui-enhance',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    let ReactDOM = null;
    try {
      ReactDOM = require('react-dom');
    } catch (error) {
      ReactDOM = null;
    }

    const NS = 'ui-enhance';
    /** Release marker: also the revision the desktop boot plan addresses for this bundle. */
    const CLIENT_BUILD = '0.9.63';
    const QUOTA_URL = '/plugin/ui-enhance/quota';
    const W = 1000000;
    const QUOTA_REFRESH_MS = 60000;
    /** Ring geometry of the shipped ContextMeter (14px viewBox, r 5.5). */
    const RING_RADIUS = 5.5;
    const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
    const WARN_PERCENT = 85;
    /** Auto-compaction armed only for sessions with an explicit budget. */
    const AUTO_COMPACT_PERCENT = 90;
    const AUTO_COMPACT_COOLDOWN_MS = 60000;
    const autoCompactAt = new Map();
    /** The floating panel matches the composer card's height, capped so a tall editor stays sane. */
    const HUD_MAX_HEIGHT = 132;
    /**
     * Right-pane default. The shipped right Sidebar keeps its state per Session in
     * this key; a Session without one has never shown the column, so that is where we
     * open the workspace file tree. Collapsing the column afterwards drops the tree
     * back to the shipped guide page ("开始"), whose first card opens it again.
     */
    const RIGHT_PANE_STORAGE = 'dsh.sidebar-right.v1';
    /** Sessions this plugin already gave its default pane, so a reload respects the collapse. */
    const RIGHT_PANE_MARKER = 'ui-enhance.right-pane-default';
    const RIGHT_PANE_FILES = 'files';
    const RIGHT_PANE_GUIDE = 'guide';
    const RIGHT_PANE_SEED_INTERVAL_MS = 150;
    const RIGHT_PANE_SEED_ATTEMPTS = 80;

    /**
     * Identifier for this document instance in the diagnostic channel: a reload produces a
     * new id, so a probe log can tell which page emitted an entry. It is diagnostics-only
     * and never leaves the loopback probe route.
     */
    const PAGE_ID =
      'page-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

    /** Fire-and-forget diagnostics; the Host keeps a small in-memory ring for this page. */
    const probe = (event, data) => {
      try {
        fetch('/plugin/ui-enhance/probe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ event, data: data === undefined ? null : data, at: Date.now() }),
        }).catch(() => {});
      } catch (error) {
        /* diagnostics only */
      }
    };

    /**
     * Remove the force-reload marker from the address bar. The marker exists only to make the
     * reloaded document a different URL, so the browser cannot answer it from cache; keeping it
     * would make every later refresh look like a new page.
     */
    function consumeRefreshMarker() {
      try {
        const url = new URL(window.location.href);
        if (!url.searchParams.has(REFRESH_PARAM)) return;
        url.searchParams.delete(REFRESH_PARAM);
        const search = url.searchParams.toString();
        window.history.replaceState(
          window.history.state,
          '',
          url.pathname + (search === '' ? '' : '?' + search) + url.hash,
        );
      } catch (error) {
        /* the marker is cosmetic */
      }
    }

    /**
     * The Client resources a fresh document would load, read from the injection rows
     * the desktop process hands to every boot: the entry bundles, the composed batch
     * bundles and the inline bootstrap script. A bootstrap batch that fails to load
     * takes the whole boot down, which is exactly what the check exists to catch.
     * @param rows - injection rows (`kind` global/script/script-src/style/html).
     */
    function bootResources(rows) {
      const scripts = [];
      const inline = [];
      const seen = new Set();
      const addScript = (id, url) => {
        if (typeof url !== 'string' || url.length === 0) return;
        // Rows use document-relative references; the Host route is absolute.
        const path = url.charAt(0) === '/' ? url : '/' + url;
        if (seen.has(path)) return;
        seen.add(path);
        scripts.push({ id: typeof id === 'string' && id.length > 0 ? id : path, url: path });
      };
      const addGraph = (graph) => {
        if (!graph || typeof graph !== 'object') return;
        const entries = Array.isArray(graph.entries) ? graph.entries : [];
        for (const entry of entries) if (entry && typeof entry === 'object') addScript(entry.id, entry.url);
        const batches = Array.isArray(graph.batches) ? graph.batches : [];
        for (const batch of batches) {
          if (batch && typeof batch === 'object') addScript('batch:' + String(batch.phase), batch.url);
        }
      };
      for (const row of Array.isArray(rows) ? rows : []) {
        if (!row || typeof row !== 'object') continue;
        if (row.kind === 'global') {
          if (row.name === '__DSH_BOOT__') addGraph(row.value);
        } else if (row.kind === 'script-src') {
          addScript(undefined, row.src);
        } else if (row.kind === 'script' && typeof row.text === 'string' && row.text.length > 0) {
          inline.push({ id: 'inline-bootstrap', text: row.text });
        }
      }
      return { scripts, inline };
    }

    /**
     * The resource plan for the *next* document: `dshDesktopBoot.ready()` returns the
     * rows the desktop process will inject into it, so its revisions are the ones the
     * reload will actually request. Outside the desktop shell the current graph is the
     * only available source.
     */
    async function bootResourcesForNextDocument() {
      const bridge = globalThis.dshDesktopBoot;
      if (bridge && typeof bridge.ready === 'function') {
        try {
          const ready = await bridge.ready();
          const plan = bootResources(ready && ready.injections);
          if (plan.scripts.length > 0 || plan.inline.length > 0) {
            plan.source = 'desktop-boot';
            return plan;
          }
        } catch (error) {
          /* fall back to the running document's graph */
        }
      }
      const plan = bootResources([{ kind: 'global', name: '__DSH_BOOT__', value: globalThis.__DSH_BOOT__ }]);
      plan.source = 'current-graph';
      return plan;
    }

    /** Compile one classic script without running it; undefined when it compiles. */
    function compileProblem(text) {
      try {
        // eslint-disable-next-line no-new-func -- compiling is the whole point; nothing runs.
        new Function(text);
        return undefined;
      } catch (error) {
        return String((error && error.message) || error);
      }
    }

    /** Whether compiling was refused by the page policy rather than by the script. */
    function compileRefused(message) {
      return /unsafe-eval|Content Security Policy|Refused to evaluate|is not allowed/i.test(String(message || ''));
    }

    /**
     * Page-side half of the check, used when the Host cannot serve the bundles itself
     * (a Host from before this feature, or a service that is unavailable): fetch each
     * resource and compile it here. A resource that does not answer 200 or does not
     * register a Client module fails the same audit the next boot runs.
     */
    async function inspectBootResourcesLocally(plan) {
      const problems = [];
      let checked = 0;
      let compiled = 0;
      for (const script of plan.scripts.slice(0, PREFLIGHT_MAX_SCRIPTS)) {
        checked += 1;
        let text;
        try {
          const response = await fetch(script.url, { cache: 'no-store', credentials: 'same-origin' });
          if (!response || !response.ok) {
            problems.push({ id: script.id, url: script.url, error: 'http-' + String(response && response.status) });
            continue;
          }
          text = await response.text();
        } catch (error) {
          problems.push({ id: script.id, url: script.url, error: 'fetch: ' + String((error && error.message) || error) });
          continue;
        }
        if (text.indexOf('__ModuleLoader__') === -1) {
          problems.push({ id: script.id, url: script.url, error: 'bundle does not register a Client module' });
          continue;
        }
        const failure = compileProblem(text);
        if (failure === undefined) compiled += 1;
        else if (!compileRefused(failure)) problems.push({ id: script.id, url: script.url, error: failure });
      }
      for (const block of plan.inline.slice(0, PREFLIGHT_MAX_INLINE)) {
        checked += 1;
        const failure = compileProblem(block.text);
        if (failure === undefined) compiled += 1;
        else if (!compileRefused(failure)) problems.push({ id: block.id, error: failure });
      }
      return { ok: problems.length === 0, checked, compiled, served: false, source: plan.source, problems };
    }

    /**
     * Decide whether a reload is safe. The Host route is preferred because it can read
     * the exact bundle bytes it would serve; the page-side path is the fallback. A
     * verdict with `ok: false` means the desktop would show its startup-failure dialog.
     */
    async function preflightBoot() {
      const plan = await bootResourcesForNextDocument();
      if (plan.scripts.length === 0 && plan.inline.length === 0) {
        return { ok: true, checked: 0, served: false, source: plan.source, problems: [], noPlan: true };
      }
      let hostBody;
      try {
        const response = await fetch(PREFLIGHT_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scripts: plan.scripts, inline: plan.inline }),
          signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
        });
        if (response.ok) hostBody = await response.json();
      } catch (error) {
        hostBody = undefined;
      }
      if (hostBody && hostBody.served === true && typeof hostBody.ok === 'boolean') {
        hostBody.source = plan.source;
        return hostBody;
      }
      return inspectBootResourcesLocally(plan);
    }

    /** One transient notice for the whole page; a second notice replaces the first. */
    let noticeNode = null;
    let noticeTimer = null;

    /**
     * Show a transient, dismissible notice at the corner of the window. It is appended
     * to the document body rather than a plugin slot on purpose: the reload guard must
     * stay visible even when the slot tree that hosts this plugin is what is broken.
     * @param notice - `{ title, body, detail: string[], tone: 'warn'|'info' }`.
     */
    function showNotice(notice) {
      try {
        const doc = document;
        if (!doc || !doc.body) return;
        if (noticeNode !== null && typeof noticeNode.remove === 'function') noticeNode.remove();
        if (noticeTimer !== null) window.clearTimeout(noticeTimer);
        const warn = notice.tone !== 'info';
        const box = doc.createElement('div');
        box.setAttribute('data-ui-enhance-notice', warn ? 'warn' : 'info');
        box.title = t('noticeDismiss');
        box.style.cssText = [
          'position:fixed',
          'right:18px',
          'bottom:18px',
          'z-index:2147483000',
          'max-width:440px',
          'padding:12px 14px',
          'border-radius:10px',
          'border:1px solid ' +
            (warn ? 'var(--dsw-alias-state-warn-primary, #c9820a)' : 'var(--dsw-alias-border-l3, #555)'),
          'background:var(--dsw-alias-bg-elevated, #1f1f1f)',
          'box-shadow:0 10px 30px rgba(0, 0, 0, .38)',
          'color:var(--dsw-alias-label-primary, #eee)',
          'font:inherit',
          'font-size:12.5px',
          'line-height:1.55',
          'cursor:pointer',
          'white-space:pre-wrap',
        ].join(';');
        const title = doc.createElement('div');
        title.textContent = notice.title;
        title.style.cssText =
          'font-weight:600;margin-bottom:4px;color:' +
          (warn ? 'var(--dsw-alias-state-warn-primary, #e0a020)' : 'var(--dsw-alias-label-primary, #eee)');
        box.appendChild(title);
        if (notice.body) {
          const body = doc.createElement('div');
          body.textContent = notice.body;
          body.style.opacity = '0.85';
          box.appendChild(body);
        }
        const detail = Array.isArray(notice.detail) ? notice.detail : [];
        if (detail.length > 0) {
          const list = doc.createElement('div');
          list.textContent = detail.join('\n');
          list.style.cssText =
            'margin-top:6px;font-family:ui-monospace, SFMono-Regular, Menlo, monospace;font-size:11.5px;opacity:0.75';
          box.appendChild(list);
        }
        box.addEventListener('click', () => {
          if (typeof box.remove === 'function') box.remove();
          if (noticeNode === box) noticeNode = null;
        });
        doc.body.appendChild(box);
        noticeNode = box;
        noticeTimer = window.setTimeout(() => {
          noticeTimer = null;
          if (typeof box.remove === 'function') box.remove();
          if (noticeNode === box) noticeNode = null;
        }, 15000);
      } catch (error) {
        /* a notice must never be the thing that breaks the page */
      }
    }

    /** Report a blocked reload: which resources fail and what the user should do instead. */
    function showReloadBlocked(report) {
      const problems = Array.isArray(report.problems) ? report.problems : [];
      const detail = problems.slice(0, 3).map((problem) => {
        const id = typeof problem.id === 'string' ? problem.id : 'resource';
        const reason = typeof problem.error === 'string' ? problem.error : 'unknown error';
        return '· ' + id + ' — ' + reason;
      });
      if (problems.length > 3) detail.push('· ' + fill(t('refreshBlockMore'), { count: problems.length - 3 }));
      showNotice({
        title: t('refreshBlocked'),
        body: fill(t('refreshBlockedBody'), { count: String(report.checked || problems.length) }),
        detail,
        tone: 'warn',
      });
    }

    /**
     * One boot audit per document: check the resources the next reload would load
     * and record the verdict in the Host's probe ring. This is diagnostics only — it
     * never blocks or changes the page — but it turns a "startup failure" that used to
     * leave no trace into a recorded list of the resources that no longer load.
     */
    let bootAuditStarted = false;
    function auditBootOnce() {
      if (bootAuditStarted) return;
      bootAuditStarted = true;
      window.setTimeout(() => {
        void (async () => {
          try {
            const verdict = await preflightBoot();
            probe('preflight-audit', {
              ok: verdict.ok,
              checked: verdict.checked,
              served: verdict.served,
              source: verdict.source,
              noPlan: verdict.noPlan === true,
              problems: (verdict.problems || []).slice(0, 5),
            });
          } catch (error) {
            probe('preflight-audit-failed', { message: String((error && error.message) || error) });
          }
        })();
      }, 6000);
    }

    /** Look once (over a few attempts) for the report of the Host's startup session scan. */
    let autoResumeWatchStarted = false;
    function watchAutoResumeReport() {
      if (autoResumeWatchStarted) return;
      autoResumeWatchStarted = true;
      let done = false;
      const tick = async () => {
        if (done) return;
        let body;
        try {
          const response = await fetch(AUTO_RESUME_PATH, { cache: 'no-store', credentials: 'same-origin' });
          if (!response.ok) return;
          body = await response.json();
        } catch (error) {
          return;
        }
        if (!body || typeof body !== 'object') return;
        const report = body.report;
        if (body.running === true || !report) return;
        done = true;
        const prompted = typeof report.prompted === 'number' ? report.prompted : 0;
        probe('auto-resume-report', {
          mode: report.mode,
          prompted,
          interrupted: report.interrupted,
          skipped: report.skipped,
        });
        if (prompted > 0) {
          showNotice({
            title: t('autoResumeNotice'),
            body: fill(t('autoResumeBody'), { count: prompted }),
            detail: [],
            tone: 'info',
          });
        }
      };
      for (const delay of AUTO_RESUME_POLL_MS) {
        window.setTimeout(() => {
          void tick();
        }, delay);
      }
    }

    /** Drop service workers and CacheStorage entries, so no cached document survives. */
    async function flushClientCaches() {
      try {
        if (
          'serviceWorker' in navigator &&
          navigator.serviceWorker &&
          typeof navigator.serviceWorker.getRegistrations === 'function'
        ) {
          const registrations = await navigator.serviceWorker.getRegistrations();
          await Promise.all(registrations.map((registration) => registration.unregister().catch(() => false)));
        }
      } catch (error) {
        /* nothing registered is the normal case */
      }
      try {
        if (window.caches && typeof window.caches.keys === 'function') {
          const keys = await window.caches.keys();
          await Promise.all(keys.map((key) => window.caches.delete(key).catch(() => false)));
        }
      } catch (error) {
        /* cache storage is best-effort */
      }
    }

    /**
     * Manually reload the whole page through a fresh document. This is the escape hatch for the
     * states a running page cannot repair in place — a client plugin missing from a live slot
     * tree, or a module change that only takes effect on boot: caches and service workers are
     * dropped, then the page is replaced under a unique URL so the shell document itself is
     * re-fetched rather than reused.
     */
    async function forceReloadUi() {
      await flushClientCaches();
      const url = new URL(window.location.href);
      url.searchParams.set(REFRESH_PARAM, String(Date.now()));
      window.location.replace(url.toString());
    }

    /** Per-session context budget, stored in this browser only. */
    const WINDOW_TIERS = [200000, 400000, 800000, 1000000];
    const WINDOW_AUTO = 'auto';
    const STORAGE_KEY = 'ui-enhance.session-windows';
    /** Reserved entry in that map: the budget every Session inherits unless it has its own. */
    const WINDOW_DEFAULT_KEY = '__default';
    /** Host mirror of the browser-local budgets; drives compaction in the middle of a turn. */
    const BUDGETS_PATH = '/plugin/ui-enhance/budgets';
    /** Points the profile's model entry at the chosen tier, so dsh itself reports that capacity. */
    const CONTEXT_WINDOW_PATH = '/plugin/ui-enhance/context-window';
    /** Re-send the budget mirror so a Host restart cannot leave budgets unenforced. */
    const BUDGETS_RESYNC_MS = 60000;
    /**
     * Force-stop one Session. A compaction that hangs inside its summary never settles the
     * command request, and the shipped UI offers no stop button while compaction runs (the
     * agent reports idle during maintenance), so this channel is the only way out.
     */
    const ABORT_PATH = '/plugin/ui-enhance/abort';
    /** Host-side open compaction markers, so a stuck compaction is visible before any click. */
    const COMPACTIONS_PATH = '/plugin/ui-enhance/compactions';
    /** Forced compaction through the Host; the shipped `/compact` refuses while busy. */
    const COMPACT_PATH = '/plugin/ui-enhance/compact';
    const COMPACTION_POLL_MS = 5000;
    /**
     * A compaction this old is presumed stuck, not merely slow: a normal summary finishes in
     * seconds, so the stop affordance appears only once waiting longer than this.
     */
    const COMPACT_STUCK_MS = 30000;
    /** How long the local compaction lock survives a requested abort when the call never settles. */
    const ABORT_GRACE_MS = 8000;

    /**
     * A full-screen backdrop shader runs on the same thread as the list scrolling in front
     * of it. Every scroll event pushes the next paint out by this much, so the backdrop
     * holds its last frame while a heavy view moves and resumes as soon as it settles.
     */
    const SHADER_SCROLL_PAUSE_MS = 220;

    /** How long the clear-context action stays armed waiting for its confirming second click. */
    const CLEAR_ARM_MS = 4000;
    /** Safety release for the clear-context lock when switching Sessions is slower than expected. */
    const CLEAR_RESET_MS = 5000;
    /** Upper bound on waiting for the cancelled turn before opening the blank Session anyway. */
    const CLEAR_ABORT_MS = 1500;
    /** Query flag marking a document fetched by the force-reload path; stripped right after boot. */
    const REFRESH_PARAM = '__dsh_refresh';
    /**
     * Host route that compiles the Client resources a reload would load. The desktop
     * shell treats one failing entry as a fatal boot error, so a reload is only safe
     * once this route reports that every resource still loads.
     */
    const PREFLIGHT_PATH = '/plugin/ui-enhance/preflight';
    /** A check slower than this counts as unverifiable instead of holding the reload. */
    const PREFLIGHT_TIMEOUT_MS = 8000;
    /** Upper bound on the resources inspected in one pass (the boot graph is far smaller). */
    const PREFLIGHT_MAX_SCRIPTS = 256;
    const PREFLIGHT_MAX_INLINE = 64;
    /** The startup interrupted-Session scan runs a few seconds after the Host starts. */
    const AUTO_RESUME_PATH = '/plugin/ui-enhance/auto-resume';
    /** When to look for that scan's report while the page settles. */
    const AUTO_RESUME_POLL_MS = [2500, 6000, 10000, 15000];
    const EFFORT_KEYS = { off: 'effortOff', low: 'effortLow', high: 'effortHigh', max: 'effortMax' };

    const dictionaries = {
      zh: {
        quota: '额度剩余',
        pending: '额度剩余 …',
        unavailable: '额度剩余 —',
        tipWeekly: '本周额度 {quota} · 已用 {used} · 剩余 {rest}',
        tipClaude: 'Claude 桶 · 剩余 {rest} / {quota}',
        tipCodex: 'Codex 桶 · 未设额度',
        tipUpdated: '更新于 {time}',
        tipError: '额度读取失败：{error}',
        unlimited: '∞',
        newLabel: '新建会话',
        newHint: '清空当前上下文，在当前工作区新建会话并跳转',
        tipKeys: 'Alt+Enter 换行 · Enter 发送',
        compact: '压缩上下文',
        compactBusy: '压缩中…',
        compactFailed: '压缩失败：{error}',
        compactStop: '终止压缩',
        compactStopping: '正在终止压缩…',
        compactStopped: '已请求终止压缩',
        compactGone: '已终止：会话不再运行，压缩随之结束',
        refresh: '强制刷新界面',
        refreshShort: '刷新界面',
        refreshArmed: '再点一次',
        refreshConfirm: '再点一次确认刷新（未发送的输入会丢失）',
        clearShort: '清空',
        clearArm: '再点一次',
        clearLabel: '清空上下文',
        clearTitle: '清空上下文：新开一个空白会话继续聊，旧会话保留在侧栏（会先终止当前回合）',
        clearConfirm: '再点一次确认清空：新开空白会话，未发送的输入会丢失',
        clearBusy: '正在新开…',
        clearFailed: '清空失败：{error}',
        clearUnavailable: '清空失败：当前界面不支持新建会话',
        refreshHint: '清掉缓存并重新加载整个界面，让插件安装/更新立即生效',
        refreshBusy: '刷新中…',
        refreshBlocked: '刷新已阻止',
        refreshBlockedHint: '这次刷新被阻止：新的界面启动会失败，原因见右下角提示',
        refreshBlockedBody:
          '检查了 {count} 个界面资源，其中有资源当前无法加载或语法错误。直接刷新只会重演上次的“启动失败”对话框（界面卡死、只能重启），因此当前页面已保留。如果刚更新过插件，重启应用后即可恢复；如果一直如此，请先修复上面的资源。',
        refreshBlockMore: '另有 {count} 个问题',
        autoResumeNotice: '已自动续跑中断的会话',
        resumeTip: '一键恢复所有中断或运行失败的任务',
        resumeNone: '没有需要恢复的任务',
        resumeDone: '已恢复 {n} 个任务',
        resumePartial: '已恢复 {n}/{m} 个任务',
        resumeFailed: '恢复失败，请稍后重试',
        resumeBusy: '正在恢复，请稍候',
        autoResumeBody: '检测到 {count} 个会话的任务中断或运行失败，已自动继续这些任务；可在侧栏查看。',
        noticeDismiss: '点击关闭',
        compactAuto: '上下文到 {percent}% 自动压缩（任务中也会）',
        windowAuto: '自动',
        windowTitle: '本会话的上下文预算（达到后自动压缩，任务中也生效）',
        windowAria: '本会话上下文预算',
        hoverContext: '上下文 {percent}% · {used} / {total}',
        meterAria: '上下文已用 {percent}%，剩余 {left}',
        meterFull: '上下文已满，可手动压缩',
        effortOff: '关',
        effortLow: '低',
        effortHigh: '高',
        effortMax: '最高',
        modelLine: '模型 {model} · 强度 {effort}',
        modelLineOnly: '模型 {model}',
        modelSwitchTrigger: '{model} · {effort}',
        tokenPanelTotal: '累计 Token',
        tokenPanelInput: '输入',
        tokenPanelOutput: '输出',
        tokenPanelCache: '缓存命中',
        tokenPanelMeta: '{sessions} 个会话 · {live} 个进行中',
        tokenPanelTip: '本工作区 {sessions} 个会话的 Token 汇总',
        tokenPanelLoading: '统计中…',
        tokenPanelError: '统计不可用：{error}',
        scopeOnlyWorkspace: '仅本工作区',
        scopeAllWorkspaces: '全部工作区',
        scopeOnlyTip: '点击切换为全部工作区',
        scopeAllTip: '点击仅显示当前工作区的会话',
        modelSwitchLoading: '读取模型列表…',
        modelSwitchError: '模型列表不可用：{error}',
        modelEffortGroup: '思考强度',
        modelBulkTitle: '一键设置本工作区全部会话的模型',
        modelBulkHint: '选择后立即套用到本工作区所有会话（不含已归档、已删除）',
        modelBulkDone: '已更新 {count} 个会话',
        modelBulkPartial: '成功 {ok} 个，失败 {failed} 个',
        modelBulkFailed: '批量设置失败：{error}',
        windowMode: '窗口模式',
        windowOn: '已开启',
        windowOff: '已关闭',
        windowReset: '恢复默认',
        windowRadius: '圆角',
        windowGap: '间距',
        windowOpacity: '不透明度',
        hudTurn: '本轮',
        hudSession: '会话',
        hudTokens: 'tok',
        hudQuota: '剩余',
        quotaShort: '{percent}%',
        quotaShortPending: '…',
        quotaShortUnknown: '—',
        quotaShortUnlimited: '∞',
        tipPrice: '费用按目录价估算：输入 ${input} / 输出 ${output} / 缓存读 ${cacheRead} / 缓存写 ${cacheWrite}（USD / 百万 token）',
        tipPriceUnknown: '当前模型没有价格数据，费用显示 —',
        tipRateRelay: '费用按中转站配额权重折算（含时段加权），与额度余额同口径：输入 {input} / 输出 {output} / 缓存读 {cacheRead} / 缓存写 {cacheWrite}（W / token，W÷1e6 = USD）',
        tipBudget: '上下文预算 {budget}（到 {percent}% 自动压缩，任务中也生效）',
        tipBudgetAuto: '上下文预算：自动（按模型容量与内置阈值压缩）',
        gitBranch: '当前分支 {branch}',
        gitDetached: '游离 HEAD（{branch}）',
        beautify: '美化',
        beautifyTitle: '美化设置',
        beautifyOn: '启用美化',
        beautifyReset: '重置',
        beautifySolid: '纯色',
        beautifyImage: '图片',
        beautifyShader: 'ShaderToy',
        beautifyImageUrl: '图片地址（URL 或 data:）',
        beautifyPickFile: '本地图片',
        beautifyImageClear: '清除',
        beautifyImageTooBig: '图片太大：请选 2 MB 以内的图片',
        beautifyShaderId: 'ShaderToy 作品 ID 或链接',
        beautifyShaderFetch: '拉取并渲染',
        beautifyShaderForce: '强制重新拉取',
        beautifyShaderNoId: '请先填 ShaderToy ID 或作品链接',
        beautifyShaderFetching: '正在通过浏览器拉取…',
        beautifyShaderRendered: '已渲染',
        beautifyShaderRenderedTex: '已渲染 · 纹理 {count}',
        beautifyShaderHttp: '拉取失败（HTTP {status}）',
        beautifyShaderBadWork: '拉取到的作品格式无法识别',
        beautifyShaderNoLayer: '先把背景切到 ShaderToy',
        beautifyShaderCode: '代码',
        beautifyShaderApply: '编译',
        beautifyShaderCodeHint: '拉取后可直接修改',
        beautifyShaderEmpty: '（还没有代码）',
        beautifyNoGl: '浏览器不支持 WebGL',
        beautifyNeedGl2: '这个作品需要 WebGL2，当前浏览器只提供 WebGL1',
        beautifyNoPass: '这个作品没有可渲染的 Image pass',
        beautifyCompile: '着色器编译失败：{log}',
        beautifyPresets: '预设',
        beautifyPresetSave: '保存当前为预设',
        beautifyPresetName: '预设名称',
        beautifyPresetDelete: '删除预设',
        beautifyPresetNameNeeded: '先给预设起个名字',
        beautifyGlass: '磨砂玻璃',
        beautifyGlassBlur: '模糊半径',
        beautifyGlassAlpha: '不透明度',
        beautifyStorageFull: '保存失败：浏览器存储空间不足',
      },
      en: {
        quota: 'Quota left',
        pending: 'Quota left …',
        unavailable: 'Quota left —',
        tipWeekly: 'Weekly {quota} · used {used} · left {rest}',
        tipClaude: 'Claude bucket · left {rest} / {quota}',
        tipCodex: 'Codex bucket · no quota set',
        tipUpdated: 'Updated {time}',
        tipError: 'Quota read failed: {error}',
        unlimited: '∞',
        newLabel: 'New session',
        newHint: 'Clear the current context, create a new session in this workspace, and switch to it',
        tipKeys: 'Alt+Enter newline · Enter send',
        compact: 'Compact context',
        compactBusy: 'Compacting…',
        compactFailed: 'Compact failed: {error}',
        compactStop: 'Stop compaction',
        compactStopping: 'Stopping compaction…',
        compactStopped: 'Stop requested',
        compactGone: 'Stopped: the session is no longer running, so its compaction is over',
        refresh: 'Force reload UI',
        refreshShort: 'Reload UI',
        refreshArmed: 'Click again',
        refreshConfirm: 'Click again to confirm (unsent input is lost)',
        clearShort: 'Clear',
        clearArm: 'Click again',
        clearLabel: 'Clear context',
        clearTitle: 'Clear context: start a blank session and keep this one in the sidebar (stops the current turn first)',
        clearConfirm: 'Click again to confirm: opens a blank session, unsent input is lost',
        clearBusy: 'Starting…',
        clearFailed: 'Clear failed: {error}',
        clearUnavailable: 'Clear failed: this UI cannot start a new session',
        refreshHint: 'Drops caches and reloads the whole UI so a plugin install or update applies at once',
        refreshBusy: 'Reloading…',
        refreshBlocked: 'Reload blocked',
        refreshBlockedHint: 'This reload was blocked: the next boot would fail — see the notice for why',
        refreshBlockedBody:
          'Checked {count} UI resources and at least one cannot be loaded or does not compile. Reloading now would repeat the startup-failure dialog (the app becomes unusable until restarted), so this page was kept. If a plugin was just updated, restart the app to recover; if it persists, fix the resources above first.',
        refreshBlockMore: '{count} more problems',
        autoResumeNotice: 'Interrupted sessions resumed',
        resumeTip: 'Resume every task that was interrupted or failed',
        resumeNone: 'Nothing to resume',
        resumeDone: 'Resumed {n} task(s)',
        resumePartial: 'Resumed {n}/{m} task(s)',
        resumeFailed: 'Resume failed, try again',
        resumeBusy: 'Resuming, please wait',
        autoResumeBody:
          '{count} session(s) were left mid-task by the last abnormal exit; their work has been continued automatically. See the sidebar.',
        noticeDismiss: 'Click to dismiss',
        compactAuto: 'Auto-compact at {percent}% (also mid-task)',
        windowAuto: 'Auto',
        windowTitle: 'Context budget for this session (auto-compacts at the tier, mid-task too)',
        windowAria: 'Context budget for this session',
        hoverContext: 'Context {percent}% · {used} / {total}',
        meterAria: 'Context {percent}% used, {left} left',
        meterFull: 'Context is full — compact manually',
        effortOff: 'off',
        effortLow: 'low',
        effortHigh: 'high',
        effortMax: 'max',
        modelLine: 'Model {model} · effort {effort}',
        modelLineOnly: 'Model {model}',
        modelSwitchTrigger: '{model} · {effort}',
        tokenPanelTotal: 'Total tokens',
        tokenPanelInput: 'Input',
        tokenPanelOutput: 'Output',
        tokenPanelCache: 'Cache read',
        tokenPanelMeta: '{sessions} sessions · {live} running',
        tokenPanelTip: 'Token totals across {sessions} sessions in this Workspace',
        tokenPanelLoading: 'Measuring…',
        tokenPanelError: 'Unavailable: {error}',
        scopeOnlyWorkspace: 'This Workspace',
        scopeAllWorkspaces: 'All Workspaces',
        scopeOnlyTip: 'Switch to all Workspaces',
        scopeAllTip: 'Show only the current Workspace',
        modelSwitchLoading: 'Loading models…',
        modelSwitchError: 'Model list unavailable: {error}',
        modelEffortGroup: 'Reasoning effort',
        modelBulkTitle: 'Set the model for every Session in this Workspace',
        modelBulkHint: 'Applies to every Session here (archived and deleted ones excluded)',
        modelBulkDone: 'Updated {count} Sessions',
        modelBulkPartial: '{ok} succeeded, {failed} failed',
        modelBulkFailed: 'Bulk switch failed: {error}',
        windowMode: 'Window mode',
        windowOn: 'On',
        windowOff: 'Off',
        windowReset: 'Reset',
        windowRadius: 'Radius',
        windowGap: 'Gap',
        windowOpacity: 'Opacity',
        hudTurn: 'Turn',
        hudSession: 'Session',
        hudTokens: 'tok',
        hudQuota: 'Left',
        quotaShort: '{percent}%',
        quotaShortPending: '…',
        quotaShortUnknown: '—',
        quotaShortUnlimited: '∞',
        tipPrice: 'Cost estimated at list price: input ${input} / output ${output} / cache read ${cacheRead} / cache write ${cacheWrite} (USD per million tokens)',
        tipPriceUnknown: 'No price data for this model — cost shows —',
        tipRateRelay: 'Cost follows the relay quota weights (peak rules included), the same unit as the balance: input {input} / output {output} / cache read {cacheRead} / cache write {cacheWrite} (W per token; W/1e6 = USD)',
        tipBudget: 'Context budget {budget} (auto-compacts at {percent}%, mid-task too)',
        tipBudgetAuto: 'Context budget: auto (model capacity and the built-in threshold)',
        gitBranch: 'Current branch {branch}',
        gitDetached: 'Detached HEAD ({branch})',
        beautify: 'Beautify',
        beautifyTitle: 'Beautify',
        beautifyOn: 'Enable',
        beautifyReset: 'Reset',
        beautifySolid: 'Solid',
        beautifyImage: 'Image',
        beautifyShader: 'ShaderToy',
        beautifyImageUrl: 'Image URL or data:',
        beautifyPickFile: 'Local image',
        beautifyImageClear: 'Clear',
        beautifyImageTooBig: 'Image too large: pick one under 2 MB',
        beautifyShaderId: 'ShaderToy work id or link',
        beautifyShaderFetch: 'Fetch & render',
        beautifyShaderForce: 'Force refetch',
        beautifyShaderNoId: 'Enter a ShaderToy id or work link first',
        beautifyShaderFetching: 'Fetching through the browser…',
        beautifyShaderRendered: 'Rendered',
        beautifyShaderRenderedTex: 'Rendered · {count} texture(s)',
        beautifyShaderHttp: 'Fetch failed (HTTP {status})',
        beautifyShaderBadWork: 'The fetched work could not be read',
        beautifyShaderNoLayer: 'Switch the background to ShaderToy first',
        beautifyShaderCode: 'Code',
        beautifyShaderApply: 'Compile',
        beautifyShaderCodeHint: 'Editable after fetching',
        beautifyShaderEmpty: '(no code yet)',
        beautifyNoGl: 'WebGL is not available in this browser',
        beautifyNeedGl2: 'This work needs WebGL2, but this browser only offers WebGL1',
        beautifyNoPass: 'This work has no renderable Image pass',
        beautifyCompile: 'Shader compile failed: {log}',
        beautifyPresets: 'Presets',
        beautifyPresetSave: 'Save current as preset',
        beautifyPresetName: 'Preset name',
        beautifyPresetDelete: 'Delete preset',
        beautifyPresetNameNeeded: 'Give the preset a name first',
        beautifyGlass: 'Frosted glass',
        beautifyGlassBlur: 'Blur radius',
        beautifyGlassAlpha: 'Opacity',
        beautifyStorageFull: 'Save failed: browser storage is full',
      },
    };

    function pad2(value) {
      return value < 10 ? '0' + value : String(value);
    }

    function formatClock(date) {
      return pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
    }

    function formatTier(value) {
      if (value >= 1000000) {
        const millions = value / 1000000;
        return (Number.isInteger(millions) ? String(millions) : millions.toFixed(1)) + 'M';
      }
      return Math.round(value / 1000) + 'K';
    }

    function formatAmount(tokens) {
      if (typeof tokens !== 'number' || !Number.isFinite(tokens)) return '—';
      if (tokens >= 1000000) return Math.round(tokens / 100000) / 10 + 'M';
      if (tokens >= 1000) return Math.round(tokens / 100) / 10 + 'K';
      return String(Math.round(tokens));
    }

    function fill(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (whole, key) => (key in values ? String(values[key]) : whole));
    }

    function modelLabel(id) {
      const raw = typeof id === 'string' ? id : '';
      const lower = raw.toLowerCase();
      if (lower.includes('pro')) return 'Pro';
      if (lower.includes('flash')) return 'Flash';
      const tail = lower.replace(/^deepseek[-_]?/, '');
      return tail === '' ? raw : tail;
    }

    /** One browser-local map: sessionId -> budget tokens. */
    const windowStore = (() => {
      let map = null;
      const listeners = new Set();

      const load = () => {
        if (map !== null) return map;
        map = {};
        try {
          const raw = window.localStorage.getItem(STORAGE_KEY);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') map = parsed;
          }
        } catch (error) {
          /* storage unavailable: keep the in-memory map */
        }
        return map;
      };

      const persist = () => {
        try {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(load()));
        } catch (error) {
          /* best-effort persistence */
        }
      };

      return {
        get(sessionId) {
          if (!sessionId) return undefined;
          const value = load()[sessionId];
          return typeof value === 'number' && value > 0 ? value : undefined;
        },
        all() {
          return { ...load() };
        },
        default() {
          const value = load()[WINDOW_DEFAULT_KEY];
          return typeof value === 'number' && value > 0 ? value : undefined;
        },
        effective(sessionId) {
          return this.get(sessionId) ?? this.default();
        },
        setDefault(value) {
          const store = load();
          if (typeof value === 'number' && value > 0) store[WINDOW_DEFAULT_KEY] = value;
          else delete store[WINDOW_DEFAULT_KEY];
          persist();
          for (const listener of Array.from(listeners)) listener();
        },
        set(sessionId, value) {
          if (!sessionId) return;
          const store = load();
          if (typeof value === 'number' && value > 0) store[sessionId] = value;
          else delete store[sessionId];
          persist();
          for (const listener of Array.from(listeners)) listener();
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      };
    })();

    function useSessionWindow(sessionId) {
      const [, force] = React.useReducer((value) => value + 1, 0);
      React.useEffect(() => windowStore.subscribe(force), []);
      /* Undefined means "auto": the harness's own context window is the denominator.
       * A hard 200K default pinned every session to a fifth of a 1M window, so the
       * ring read 90% at 180K, auto-compaction armed in sessions the user never gave
       * a budget, and the sidebar bars (which already fall back to the live
       * contextWindow) disagreed with the HUD.
       * Otherwise this is the effective budget: the Session's own setting, else the
       * user's explicit "default for all Sessions" (which also covers sub-agents). */
      return windowStore.effective(sessionId);
    }

    /**
     * USD per million tokens, from the model catalog the harness ships
     * (`pi-ai` provider data: deepseek.json). This is only the fallback: the relay
     * reports its own per-token quota weights, and those are what it actually bills.
     */
    const MODEL_PRICES = {
      'deepseek-v4-pro': { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
      'deepseek-v4-flash': { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
      'deepseek-flash': { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
    };
    const BUCKET_KEYS = ['input', 'cacheRead', 'cacheWrite', 'output'];
    const TURN_STORAGE_KEY = 'ui-enhance.turn-usage';

    /** Catalog fallback: USD per million tokens for one billed bucket vector. */
    function priceFor(model) {
      if (typeof model !== 'string' || model === '') return null;
      const exact = MODEL_PRICES[model];
      if (exact) return exact;
      const lower = model.toLowerCase();
      if (lower.indexOf('flash') !== -1) return MODEL_PRICES['deepseek-flash'];
      if (lower.indexOf('pro') !== -1) return MODEL_PRICES['deepseek-v4-pro'];
      return null;
    }

    /**
     * The relay's own weights: quota units (W) spent per token, already including the
     * current peak-period rule, so `tokens * weight / 1e6` is the charged USD and
     * directly comparable with the remaining balance.
     */
    function relayRateFor(weights, model) {
      if (!weights || typeof weights !== 'object' || typeof model !== 'string') return null;
      const entry = weights[model];
      if (!entry || typeof entry !== 'object') return null;
      const input = typeof entry.input === 'number' ? entry.input : null;
      const output = typeof entry.output === 'number' ? entry.output : null;
      if (input === null || output === null) return null;
      return {
        input,
        output,
        cacheRead: typeof entry.cacheRead === 'number' ? entry.cacheRead : 0,
        cacheWrite: typeof entry.cacheCreation === 'number' ? entry.cacheCreation : 0,
      };
    }

    function modelOf(selection) {
      if (!selection) return null;
      const current = selection.next || selection.lastUsed || null;
      return current && typeof current.model === 'string' ? current.model : null;
    }

    /** The four billed buckets of the `tokenUsage` projection, as plain numbers. */
    function bucketsOf(usage) {
      if (!usage) return null;
      const buckets = {};
      buckets.input = typeof usage.uncachedInputTokens === 'number' ? usage.uncachedInputTokens : 0;
      buckets.cacheRead = typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0;
      buckets.cacheWrite = typeof usage.cacheWriteTokens === 'number' ? usage.cacheWriteTokens : 0;
      buckets.output = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0;
      return buckets;
    }

    function isBuckets(value) {
      if (!value || typeof value !== 'object') return false;
      return BUCKET_KEYS.every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0);
    }

    function bucketTotal(buckets) {
      if (!buckets) return null;
      return buckets.input + buckets.cacheRead + buckets.cacheWrite + buckets.output;
    }

    function bucketDelta(current, base) {
      if (!current || !base) return null;
      const delta = {};
      for (const key of BUCKET_KEYS) delta[key] = Math.max(0, current[key] - base[key]);
      return delta;
    }

    /** USD cost of one bucket set under a per-million price vector. */
    function costOf(buckets, price) {
      if (!buckets || !price) return null;
      const value =
        (buckets.input * price.input +
          buckets.cacheRead * price.cacheRead +
          buckets.cacheWrite * (price.cacheWrite || 0) +
          buckets.output * price.output) /
        1000000;
      return Number.isFinite(value) ? value : null;
    }

    function formatMoney(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
      if (value <= 0) return '$0';
      if (value < 0.0001) return '<$0.0001';
      if (value < 0.01) return '$' + value.toFixed(4);
      if (value < 1) return '$' + value.toFixed(3);
      return '$' + value.toFixed(2);
    }

    /** Remaining quota is money too: W ÷ 1e6 = USD, and it may go negative once overspent. */
    function formatQuotaMoney(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
      const abs = Math.abs(value);
      const body = abs < 0.01 ? abs.toFixed(4) : abs < 1 ? abs.toFixed(3) : abs.toFixed(2);
      return (value < 0 ? '-$' : '$') + body;
    }

    function formatPercent(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
      const rounded = Math.round(value * 10) / 10;
      return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
    }

    /**
     * Per-Turn token accounting on top of the whole-log `tokenUsage` projection:
     * take the billed-bucket totals at `turn/start` and subtract them from what
     * the projection reports now. A Turn boundary is the Session's `running`
     * flag, and the state survives a refresh in this tab's sessionStorage.
     */
    const turnStates = new Map();

    function readStoredTurnStates() {
      try {
        const raw = window.sessionStorage.getItem(TURN_STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch (error) {
        return {};
      }
    }

    function writeTurnState(sessionId, state) {
      turnStates.set(sessionId, state);
      try {
        const all = readStoredTurnStates();
        if (state === null) delete all[sessionId];
        else all[sessionId] = state;
        const ids = Object.keys(all);
        if (ids.length > 60) for (const id of ids.slice(0, ids.length - 60)) delete all[id];
        window.sessionStorage.setItem(TURN_STORAGE_KEY, JSON.stringify(all));
      } catch (error) {
        /* best-effort persistence */
      }
    }

    function turnStateOf(sessionId) {
      if (turnStates.has(sessionId)) return turnStates.get(sessionId);
      const stored = readStoredTurnStates()[sessionId];
      const state =
        stored && typeof stored === 'object' && (stored.base === null || isBuckets(stored.base)) &&
        (stored.last === null || isBuckets(stored.last))
          ? { running: stored.running === true, base: stored.base || null, last: stored.last || null }
          : null;
      turnStates.set(sessionId, state);
      return state;
    }

    function useTurnUsage(sessionId, usage, running) {
      const current = bucketsOf(usage);
      if (sessionId === undefined) return null;
      let state = turnStateOf(sessionId);

      if (state === null) {
        state = running
          ? { running: true, base: current, last: null }
          : { running: false, base: null, last: null };
        writeTurnState(sessionId, state);
      } else if (state.running !== running) {
        state = running
          ? { running: true, base: current, last: state.last }
          : {
              running: false,
              base: null,
              last: state.base !== null && current !== null ? bucketDelta(current, state.base) : state.last,
            };
        writeTurnState(sessionId, state);
      } else if (running && state.base === null && current !== null) {
        // Mounted mid-Turn before the projection delivered anything: count from the first
        // reading rather than showing nothing for the rest of the Turn.
        state = { running: true, base: current, last: state.last };
        writeTurnState(sessionId, state);
      }

      if (running) return state.base !== null && current !== null ? bucketDelta(current, state.base) : null;
      return state.last;
    }

    function useQuota() {
      const [state, setState] = React.useState({ phase: 'loading' });

      React.useEffect(() => {
        let alive = true;
        let controller = null;

        const load = async () => {
          if (controller) controller.abort();
          const current = new AbortController();
          controller = current;
          const timer = window.setTimeout(() => current.abort(), 9000);
          try {
            const response = await window.fetch(QUOTA_URL, {
              signal: current.signal,
              cache: 'no-store',
              headers: { accept: 'application/json' },
            });
            const body = await response.json();
            if (!alive || controller !== current) return;
            if (body && body.ok === true) {
              setState({ phase: 'ready', data: body.data, fetchedAt: body.fetchedAt });
            } else {
              setState((previous) =>
                previous.phase === 'ready' ? previous : { phase: 'error', error: (body && body.error) || 'unknown' },
              );
            }
          } catch (error) {
            if (!alive || controller !== current) return;
            setState((previous) => (previous.phase === 'ready' ? previous : { phase: 'error', error: 'network' }));
          } finally {
            window.clearTimeout(timer);          }
        };

        load();
        const interval = window.setInterval(load, QUOTA_REFRESH_MS);
        const onVisibility = () => {
          if (document.visibilityState === 'visible') load();
        };
        document.addEventListener('visibilitychange', onVisibility);

        return () => {
          alive = false;
          window.clearInterval(interval);
          document.removeEventListener('visibilitychange', onVisibility);
          if (controller) controller.abort();
        };
      }, []);

      return state;
    }

    /** Insert a line break into a controlled textarea without fighting React's value tracker. */
    function insertTextareaNewline(area) {
      const value = area.value;
      const start = typeof area.selectionStart === 'number' ? area.selectionStart : value.length;
      const end = typeof area.selectionEnd === 'number' ? area.selectionEnd : start;
      const next = value.slice(0, start) + '\n' + value.slice(end);
      const descriptor = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
      if (descriptor && typeof descriptor.set === 'function') descriptor.set.call(area, next);
      else area.value = next;
      try {
        area.setSelectionRange(start + 1, start + 1);
      } catch (error) {
        /* selection is best-effort */
      }
      area.dispatchEvent(new Event('input', { bubbles: true }));
    }

    /** Composer selectors: trigger styled like the harness model select, plus our own rounded menu. */
/**
 * Feature #8 (body background veil) and #9 (focused pane brightening).
 *
 * Both are pure CSS layers driven by attributes on <html>/panes, so they cost no
 * per-frame React work. The shipped layout is `frame > [sidebarCol | centerCol]`, and
 * the right dock lives inside centerCol, so the panes are marked by probing for those
 * real class names at mount and re-probed when a pane appears or disappears.
 */
const VISUAL_CSS = [
  /* #8 背景打底：底色之上叠一层极淡的斜向晕染，让大片纯色有层次但不抢内容。 */
  'html[data-ui-enhance-veil="on"] #root{position:relative;isolation:isolate}',
  'html[data-ui-enhance-veil="on"] #root::before{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;background:radial-gradient(1200px 620px at 16% -12%,rgba(122,152,255,.075),transparent 62%),radial-gradient(900px 520px at 94% 110%,rgba(92,202,190,.06),transparent 60%)}',
  /* #9 焦点面板提亮：指针所在面板轻微提亮，其余压暗半档，视线自然聚焦。 */
  'html[data-ui-enhance-focus="on"] [data-ui-enhance-pane]{transition:filter .16s ease}',
  'html[data-ui-enhance-focus="on"] [data-ui-enhance-pane][data-ui-enhance-pane-dim="true"]{filter:brightness(.97) saturate(.99)}',
  'html[data-ui-enhance-focus="on"] [data-ui-enhance-pane][data-ui-enhance-pane-lit="true"]{filter:brightness(1.03)}',
].join('\n');

/**
 * Real layout selectors, matched by the CSS-Modules suffix so they survive hash changes.
 *
 * The right sidebar is a pane like the other two. Leaving `_rightbarCol` out meant the
 * right card never received `data-ui-enhance-pane` -- so it got neither the focus
 * brightening nor, once the glass pass reused this list, its rounded corners.
 */
const PANE_SELECTORS = ['[class*="_sidebarCol"]', '[class*="_centerCol"]', '[class*="_rightbarCol"]'];

/**
 * Mark the panes and keep `lit`/`dim` in sync with the pointer. A pane is lit while the
 * pointer is inside it; when the pointer leaves the window everything clears, so a
 * screenshot never catches a half-dimmed layout.
 */
function usePaneFocus(enabled) {
  React.useEffect(() => {
    if (!enabled) return undefined;
    const root = document.documentElement;
    root.setAttribute('data-ui-enhance-focus', 'on');

    let frame = 0;
    let disposed = false;
    let paneRects = [];
    let paneObserver = null;

    const panesOf = () => {
      const found = [];
      for (const selector of PANE_SELECTORS) {
        for (const node of document.querySelectorAll(selector)) {
          if (node instanceof HTMLElement && !found.includes(node)) found.push(node);
        }
      }
      for (const node of found) {
        if (node.getAttribute('data-ui-enhance-pane') !== '') node.setAttribute('data-ui-enhance-pane', '');
      }
      return found;
    };

    // The deepest pane containing the point wins (centerCol may nest other panels).
    // Boxes are cached so the per-frame pointer path never forces layout.
    const paneAt = (x, y) => {
      let lit = null;
      for (let i = 0; i < panes.length; i += 1) {
        const box = paneRects[i];
        if (!box) continue;
        if (x < box.left || x > box.right || y < box.top || y > box.bottom) continue;
        const node = panes[i];
        if (lit === null || node.contains(lit)) lit = node;
      }
      return lit;
    };

    const paint = (lit) => {
      for (const node of panes) {
        const nextLit = node === lit ? 'true' : 'false';
        const nextDim = lit !== null && node !== lit ? 'true' : 'false';
        if (node.getAttribute('data-ui-enhance-pane-lit') !== nextLit) {
          node.setAttribute('data-ui-enhance-pane-lit', nextLit);
        }
        if (node.getAttribute('data-ui-enhance-pane-dim') !== nextDim) {
          node.setAttribute('data-ui-enhance-pane-dim', nextDim);
        }
      }
    };

    // Measuring is only done when layout may have changed, not on every frame.
    const measure = () => {
      paneRects = panes.map((node) => node.getBoundingClientRect());
    };
    const watch = (nodes) => {
      if (typeof ResizeObserver === 'undefined') return;
      if (paneObserver === null) paneObserver = new ResizeObserver(() => measure());
      paneObserver.disconnect();
      for (const node of nodes) paneObserver.observe(node);
    };
    const refreshPanes = () => {
      panes = panesOf();
      measure();
      watch(panes);
    };
    let panes = [];
    refreshPanes();

    const onMove = (event) => {
      if (disposed || frame !== 0) return;
      const x = event.clientX;
      const y = event.clientY;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        if (disposed) return;
        if (panes.length === 0) refreshPanes();
        paint(paneAt(x, y));
      });
    };
    const clear = () => {
      if (disposed) return;
      paint(null);
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('resize', measure);
    document.addEventListener('pointerleave', clear, true);
    window.addEventListener('blur', clear);

    return () => {
      disposed = true;
      if (frame !== 0) window.cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('resize', measure);
      document.removeEventListener('pointerleave', clear, true);
      window.removeEventListener('blur', clear);
      if (paneObserver !== null) {
        paneObserver.disconnect();
        paneObserver = null;
      }
      paneRects = [];
      root.removeAttribute('data-ui-enhance-focus');
      for (const node of panes) {
        node.removeAttribute('data-ui-enhance-pane');
        node.removeAttribute('data-ui-enhance-pane-lit');
        node.removeAttribute('data-ui-enhance-pane-dim');
      }
    };
  }, [enabled]);
}

    const CONTROLS_CSS = [
      '[data-ui-enhance-window]{appearance:none;-webkit-appearance:none;box-sizing:border-box;height:22px;padding:0 20px 0 8px;border:0;border-radius:var(--dsw-radius-sm);background-color:#0000;background-image:url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'12\' height=\'12\' viewBox=\'0 0 12 12\' fill=\'none\'%3E%3Cpath d=\'M3 4.5L6 7.5L9 4.5\' stroke=\'%2381858C\' stroke-width=\'1.5\' stroke-linecap=\'round\' stroke-linejoin=\'round\'/%3E%3C/svg%3E");background-position:right 4px center;background-repeat:no-repeat;background-size:12px 12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;font:inherit;font-size:12px;font-weight:500;line-height:22px;font-variant-numeric:tabular-nums;cursor:pointer;outline:none}',
      '[data-ui-enhance-window]:hover:not(:disabled),[data-ui-enhance-window][aria-expanded="true"]{background-color:var(--dsw-alias-interactive-bg-hover)}',
      '[data-ui-enhance-window]:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}',
      '[data-ui-enhance-compact]{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;outline:none}',
      '[data-ui-enhance-compact]:hover:not(:disabled){background-color:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '[data-ui-enhance-compact]:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}',
      '[data-ui-enhance-compact]:disabled{opacity:.4;cursor:default}',
      /* Header utility: force reload. Same geometry as the compact icon, with an armed state
         (second click) that warns before the page is replaced. */
      '[data-ui-enhance-refresh]{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;outline:none;flex:none}',
      '[data-ui-enhance-refresh]:hover:not(:disabled){background-color:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '[data-ui-enhance-refresh]:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}',
      '[data-ui-enhance-refresh][data-ui-enhance-refresh-armed]{background-color:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-warn-primary)}',
      /* Blocked by the boot preflight: the button stays clickable for a retry, but says why. */
      '[data-ui-enhance-refresh][data-ui-enhance-refresh-blocked]{background-color:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-warn-primary);box-shadow:inset 0 0 0 1px var(--dsw-alias-state-warn-primary)}',
      '[data-ui-enhance-refresh]:disabled{opacity:.5;cursor:default}',
      /* Sidebar-foot action (beside Settings): always mounted, labelled while the sidebar is
         wide and a square icon while it is the 56px rail. */
      '[data-ui-enhance-refresh-side]{display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:28px;white-space:nowrap;cursor:pointer;outline:none;flex:none}',
      '[data-ui-enhance-refresh-side]:not([data-ui-enhance-refresh-wide]){width:28px;padding:0}',
      '[data-ui-enhance-refresh-side]:hover:not(:disabled){background-color:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '[data-ui-enhance-refresh-side]:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}',
      '[data-ui-enhance-refresh-side][data-ui-enhance-refresh-armed]{background-color:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-warn-primary)}',
      '[data-ui-enhance-refresh-side][data-ui-enhance-refresh-blocked]{background-color:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-warn-primary);box-shadow:inset 0 0 0 1px var(--dsw-alias-state-warn-primary)}',
      '[data-ui-enhance-refresh-side]:disabled{opacity:.5;cursor:default}',
      /* Dock: clear-context, beside the compact action. Labelled on purpose — a bare icon in
         the dock row is too easy to miss — with an armed state (second click) before it starts
         a fresh Session. */
      '[data-ui-enhance-clear]{display:inline-flex;align-items:center;justify-content:center;height:22px;padding:0 6px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;font-weight:500;line-height:22px;white-space:nowrap;cursor:pointer;outline:none;flex:none}',
      '[data-ui-enhance-clear]:hover:not(:disabled){background-color:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '[data-ui-enhance-clear]:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}',
      '[data-ui-enhance-clear][data-ui-enhance-clear-armed]{background-color:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-warn-primary)}',
      '[data-ui-enhance-clear]:disabled{opacity:.5;cursor:default}',
      /* Composer dock controls: the budget select and the compact action live in the row that
         the shipped composer renders under the card, next to its context ring. */
      '[data-ui-enhance-dock]{display:inline-flex;align-items:center;gap:2px;flex:none}',
      '[data-ui-enhance-dock] [data-ui-enhance-window]{height:22px;padding:0 18px 0 6px;background-position:right 3px center;font-size:12px;line-height:22px}',
      '[data-ui-enhance-dock] [data-ui-enhance-compact]{width:22px;height:22px}',
      /* Composer HUD: a small panel that floats to the LEFT of the composer card (outside it),
         carrying the Turn/Session token and cost readings plus the remaining quota. It is
         anchored to the card's overlay helper, so its left/width are relative to the card, and
         its height/top are measured so it spans exactly the card's height (capped for a tall
         editor); the three readings then share that height as equal rows. */
      '[data-ui-enhance-hud]{--ui-enhance-hud-width:156px;position:absolute;left:calc(0px - var(--ui-enhance-hud-width) - 10px);top:0;z-index:4;box-sizing:border-box;width:var(--ui-enhance-hud-width);display:flex;flex-direction:column;gap:0;padding:6px 9px;border-radius:var(--dsw-radius-md);border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-specific-input-major);box-shadow:var(--dsw-elevation-soft);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:14px;font-variant-numeric:tabular-nums;white-space:nowrap;user-select:none}',
      '[data-ui-enhance-hud-row]{display:flex;align-items:center;gap:4px;min-width:0;min-height:0;flex:1 1 0}',
      '[data-ui-enhance-hud-label]{color:var(--dsw-alias-label-tertiary)}',
      '[data-ui-enhance-hud-value]{color:var(--dsw-alias-label-primary);font-weight:600}',
      '[data-ui-enhance-hud-unit]{color:var(--dsw-alias-label-tertiary);font-size:10px}',
      '[data-ui-enhance-hud-cost]{margin-left:auto;color:var(--dsw-alias-label-primary)}',
      '[data-ui-enhance-menu]{box-sizing:border-box;min-width:76px;padding:4px;border:0;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);font-size:12px;line-height:20px;overflow:hidden}',
      '[data-ui-enhance-menu-item]{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;padding:4px 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:20px;text-align:left;white-space:nowrap;font-variant-numeric:tabular-nums;cursor:pointer;outline:none}',
      '[data-ui-enhance-menu-item]:hover{background-color:var(--dsw-alias-interactive-bg-hover)}',
      '[data-ui-enhance-menu-item][data-active="true"]{color:var(--dsw-alias-brand-primary);font-weight:600}',
      /* Session-row context gauge: the row is shipped UI, so the driver component appends one
         absolutely positioned child and only writes the two custom properties on it. */
      '[data-row-key^="session:"]{position:relative}',
      '[data-ui-enhance-ctx-bar]{position:absolute;left:8px;right:8px;bottom:1px;height:2px;border-radius:1px;background:color-mix(in srgb, var(--dsw-alias-border-l3) 70%, transparent);pointer-events:none;overflow:hidden}',
      '[data-ui-enhance-ctx-bar]::after{content:"";position:absolute;inset:0;border-radius:inherit;background:var(--ui-enhance-ctx-color,var(--dsw-alias-brand-primary));transform:scaleX(var(--ui-enhance-ctx-scale,0));transform-origin:left center;transition:transform .18s ease,background-color .18s ease}',
      /* File-tree title bar: the workspace's checked-out git branch as a quiet green pill with
         white text. Nothing is drawn when the tree root is not inside a repository. */
      '[data-ui-enhance-git-branch]{display:inline-flex;align-items:center;gap:4px;flex:none;max-width:160px;min-width:0;padding:1px 8px 1px 6px;border-radius:999px;background:#52705c;color:#fff;font:inherit;font-size:11px;font-weight:500;line-height:16px;letter-spacing:.01em;white-space:nowrap;user-select:none}',
      '[data-ui-enhance-git-branch] svg{width:11px;height:11px;flex:none;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;opacity:.92}',
      '[data-ui-enhance-git-branch-name]{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      /* Workspace-row title in the left browser: the same quiet green pill, a size smaller
         because the row itself is 34px high. Nothing is drawn for a non-repository Workspace. */
      '[data-ui-enhance-workspace-branch]{display:inline-flex;align-items:center;gap:4px;flex:none;max-width:130px;min-width:0;margin-left:2px;padding:0 7px 0 5px;border-radius:999px;background:#52705c;color:#fff;font-size:11px;font-weight:500;line-height:18px;height:18px;letter-spacing:.01em;white-space:nowrap;user-select:none;pointer-events:none}',
      '[data-ui-enhance-workspace-branch] svg{width:11px;height:11px;flex:none;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;opacity:.92}',
      '[data-ui-enhance-workspace-branch-name]{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      /* 「一键恢复」button: matches the shipped 28px sidebar header icon buttons. */
      '[data-ui-enhance-resume-wrap]{position:relative;display:inline-flex;align-items:center;flex:none;margin-right:2px}',
      '[data-ui-enhance-resume-button]{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm);cursor:pointer;flex:none;transition:background-color .12s ease,color .12s ease}',
      '[data-ui-enhance-resume-button]:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '[data-ui-enhance-resume-button]:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}',
      '[data-ui-enhance-resume-button][data-phase="running"]{cursor:progress;color:var(--dsw-alias-label-tertiary)}',
      '[data-ui-enhance-resume-button][data-phase="error"]{color:var(--dsw-alias-state-error-primary)}',
      '[data-ui-enhance-resume-button][data-phase="done"]{color:var(--dsw-alias-state-success-primary)}',
      '[data-ui-enhance-resume-spinner]{box-sizing:border-box;width:13px;height:13px;border-radius:50%;border:1.6px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-label-primary);animation:ui-enhance-resume-spin .7s linear infinite}',
      '@keyframes ui-enhance-resume-spin{to{transform:rotate(360deg)}}',
      '[data-ui-enhance-resume-note]{position:absolute;top:calc(100% + 6px);left:0;z-index:70;white-space:nowrap;padding:5px 9px;border-radius:var(--dsw-radius-sm);font-size:12px;line-height:16px;color:var(--dsw-alias-label-primary);background-color:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);pointer-events:none}',
      '[data-ui-enhance-resume-note][data-phase="error"]{color:var(--dsw-alias-state-error-primary)}',
      /* 模型切换：会话标题栏里的下拉，触发器和菜单都避开原生 <select>，以便分组展示目录。 */
      '[data-dsh-plugin="ui-enhance-model-switch"]{display:inline-flex;align-items:center;flex:none;max-width:280px}',
      '[data-ui-enhance-model-trigger]{box-sizing:border-box;display:inline-flex;align-items:center;gap:4px;max-width:100%;height:26px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);background-color:transparent;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm);font-size:12px;line-height:1;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;transition:background-color .12s ease,color .12s ease,border-color .12s ease}',
      '[data-ui-enhance-model-trigger]:hover{background-color:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3)}',
      '[data-ui-enhance-model-trigger][data-open="true"]{background-color:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3)}',
      '[data-ui-enhance-model-trigger]:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '[data-ui-enhance-model-trigger][data-busy="true"]{cursor:progress;opacity:.65}',
      '[data-ui-enhance-model-menu]{position:fixed;z-index:1200;box-sizing:border-box;min-width:208px;max-width:340px;max-height:min(70vh,460px);overflow-y:auto;overscroll-behavior:contain;padding:5px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background-color:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);display:flex;flex-direction:column;gap:1px}',
      '[data-ui-enhance-model-group]{padding:7px 9px 4px;font-size:11px;line-height:14px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-tertiary);text-transform:none;user-select:none}',
      '[data-ui-enhance-model-item]{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;padding:6px 9px;border:none;border-radius:var(--dsw-radius-sm);background-color:transparent;color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px;text-align:left;cursor:pointer}',
      '[data-ui-enhance-model-item]:hover{background-color:var(--dsw-alias-interactive-bg-hover)}',
      '[data-ui-enhance-model-item]:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}',
      '[data-ui-enhance-model-item][data-picked="true"]{color:var(--dsw-alias-state-business-primary);font-weight:600}',
      '[data-ui-enhance-model-item]:disabled{cursor:default;opacity:.5}',
      '[data-ui-enhance-model-item-name]{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '[data-ui-enhance-model-tick]{flex:none;font-size:12px;line-height:1;opacity:.9}',
      '[data-ui-enhance-effort-item]{padding-left:18px;font-size:12px;line-height:16px}',
      '[data-ui-enhance-model-note]{padding:6px 9px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);user-select:none}',
      '[data-ui-enhance-model-note][data-tone="error"]{color:var(--dsw-alias-state-error-primary)}',
      '[data-dsh-plugin="ui-enhance-token-panel"]{margin:6px 10px 4px;padding:8px 10px;border-radius:var(--dsw-radius-md);background-color:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);user-select:none;flex:none}',
      '[data-ui-enhance-token-row]{display:flex;align-items:baseline;justify-content:space-between;gap:8px}',
      '[data-ui-enhance-token-row][data-strong]{color:var(--dsw-alias-label-primary);font-weight:600;font-size:12px;line-height:17px;margin-bottom:2px}',
      '[data-ui-enhance-token-label]{color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '[data-ui-enhance-token-value]{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);flex:none}',
      '[data-ui-enhance-token-meta]{margin-top:4px;padding-top:4px;border-top:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:14px}',
      '[data-ui-enhance-token-error]{color:var(--dsw-alias-state-error-primary);font-size:10px;line-height:14px}',
      '[data-dsh-plugin="ui-enhance-scope-chip"]{flex:none;height:20px;margin-right:6px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background-color:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:10px;line-height:18px;white-space:nowrap;cursor:pointer;outline:none}',
      '[data-dsh-plugin="ui-enhance-scope-chip"]:hover{background-color:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '[data-dsh-plugin="ui-enhance-scope-chip"]:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}',
      '[data-dsh-plugin="ui-enhance-scope-chip"][data-on="true"]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}',
      /* Workspace-wide model switch: a small star button portalled onto the Workspace header. */
      '[data-ui-enhance-model-bulk]{position:fixed;z-index:1100;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:1px solid transparent;border-radius:var(--dsw-radius-sm);background-color:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:background-color .14s ease,color .14s ease,border-color .14s ease,transform .14s cubic-bezier(.34,1.56,.64,1)}',
      '[data-ui-enhance-model-bulk]:hover{background-color:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-border-l2)}',
      '[data-ui-enhance-model-bulk]:active{transform:scale(.9)}',
      '[data-ui-enhance-model-bulk]:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '[data-ui-enhance-model-bulk][data-open="true"]{background-color:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-border-l3)}',
      '[data-ui-enhance-model-bulk][data-busy="true"]{cursor:progress;opacity:.6}',
      '[data-ui-enhance-model-bulk][data-busy="true"] svg{animation:ue-bulk-spin 1s linear infinite}',
      '@keyframes ue-bulk-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}',
      '[data-ui-enhance-model-bulk-menu]{position:fixed;z-index:1201;box-sizing:border-box;min-width:208px;max-width:340px;max-height:min(70vh,460px);overflow-y:auto;overscroll-behavior:contain;padding:5px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background-color:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);display:flex;flex-direction:column;gap:1px}',
      '[data-ui-enhance-model-effort]{flex:none;padding:0 5px;border-radius:999px;background-color:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:15px;font-variant-numeric:tabular-nums}',
    ].join('\n');
    /* ---------------------------------------------------------------------------
     * Beautify half: the chat background (solid / image / ShaderToy), background
     * presets, and the shared frosted-glass knobs. All state is browser-local under
     * the `ui-enhance:` key prefix, so it survives a reload and never touches the Host.
     * ------------------------------------------------------------------------- */

    const BEAUTIFY_KEY = 'ui-enhance.beautify';
    const BEAUTIFY_PRESET_KEY = 'ui-enhance.presets';
    const BEAUTIFY_CLASS = 'ue-beautify-on';
    const BEAUTIFY_BG_ID = 'ui-enhance-background';
    const GLASS_ATTR = 'data-ue-glass';

    /* ---------------------------------------------------------------------------
     * Window mode. The three columns become frosted-glass cards and the workspace
     * Session list gains DeepSeek-blue state plus sliding/springy motion.
     *
     * This is a separate class from `BEAUTIFY_CLASS` so the two can be toggled
     * independently: window framing is about the shell, Beautify is about the
     * backdrop. The tags below are the ONLY DOM writes this half performs — one
     * class on <html> and one class per column/row — and every one of them is
     * written through a "only if different" guard, so a repeat pass is a no-op.
     * ------------------------------------------------------------------------- */
    const WINDOW_CLASS = 'ue-window-on';
    const WINDOW_KEY = 'ui-enhance.window';
    /** Column landmarks in dsh-client-ui-layout, matched by suffix so hashes may change. */
    const WINDOW_COL_SELECTOR = '[class*="_sidebarCol"],[class*="_centerCol"],[class*="_rightbarCol"]';
    /** The grid that holds those columns. */
    const WINDOW_FRAME_SELECTOR = '[class*="_frame"]';
    const WINDOW_DIVIDER_SELECTOR = '[class*="_divider"]';
    /** One Session row in dsh-client-ui-workspace. */
    const WINDOW_ROW_SELECTOR = '[class*="_sessionRow"]';
    /** The row class the shipped UI puts on the active Session. */
    const WINDOW_ROW_CURRENT = '_selected';
    /** DeepSeek brand blue, used for the current-row mark and the hover tint. */
    const DS_BLUE = '#4D6BFE';

    const WINDOW_DEFAULTS = {
      on: true,
      radius: 16,
      gap: 10,
      /* 18 px, not 26: `backdrop-filter` cost scales with the blur kernel, and three
       * full-height glass columns re-blur their backdrop every frame. At an 18 px
       * radius over a 32%-opaque tint the frosting still reads as glass, but the GPU
       * samples far fewer taps. The slider exposes it if a thicker frost is wanted. */
      blur: 18,
      alpha: 32,
      sheen: 0.5,
      border: 0.14,
    };

    const SHADERTOY_URL = '/plugin/ui-enhance/shadertoy';
    /** ShaderToy works rarely need more than this; the cap keeps a 4K screen cheap.
     *
     * Lowered from 2.4 Mpx to 1.2 Mpx. The canvas is a full-screen BACKDROP seen
     * through layered glass with a 26 px blur, so the missing detail is destroyed by
     * the blur anyway -- 1.2 Mpx at 1440p is a third of the fragments for a
     * difference the eye cannot find behind the frosting. */
    const SHADER_MAX_PIXELS = 1200000;
    /** The backdrop targets the display's own cadence. Perf tiers no longer lower
     * this: a backdrop that animates at 30 fps reads as visible judder on a 60 Hz
     * panel, and the cheap lever is render resolution instead (see PERF_PROFILE). */
    const SHADER_FPS = 60;
    const SHADER_FRAME_INTERVAL_MS = 1000 / SHADER_FPS;
    /** The Host drives a real browser through the challenge; that is slow but finite. */
    const SHADER_FETCH_TIMEOUT_MS = 120000;
    /** localStorage holds the image as a data URL, so keep the source small. */
    const IMAGE_MAX_BYTES = 2 * 1024 * 1024;

    const BEAUTIFY_DEFAULTS = {
      on: true,
      mode: 'solid',
      solid: '#0b0d10',
      image: '',
      shaderId: '',
      presetId: '',
      /* Shader cost tier -- RESOLUTION ONLY. Every tier runs at 60 fps; 'high'
       * renders at the full pixel budget, 'medium' at half the pixels, 'low' at a
       * quarter. Resolution is the knob that actually moves GPU cost without
       * making the animation visibly stutter. */
      perfTier: 'medium',
      glassBlur: 12,
      glassAlpha: 0.45,
    };
    const BEAUTIFY_MODES = ['solid', 'image', 'shader'];
    /** Shader performance tiers, cheapest last. */
    const PERF_TIERS = ['high', 'medium', 'low'];
    /**
     * Per-tier render budget. `pixels` scales the canvas backing store; `fps` is
     * 60 on every tier so the tier never trades smoothness.
     */
    const PERF_PROFILE = {
      high: { pixels: 1.0, fps: 60 },
      medium: { pixels: 0.5, fps: 60 },
      low: { pixels: 0.25, fps: 60 },
    };
    function perfProfile(state) {
      const tier = state && PERF_TIERS.includes(state.perfTier) ? state.perfTier : BEAUTIFY_DEFAULTS.perfTier;
      return PERF_PROFILE[tier];
    }
    /**
     * Live budget for the running shader. The renderer is created once and its rAF
     * loop captures nothing per frame, so the tier is read through this mutable
     * holder instead of being baked into the closure at mount time. That way moving
     * the slider takes effect on the next frame without tearing the GL context down.
     */
    const shaderBudget = { pixels: SHADER_MAX_PIXELS, fps: SHADER_FPS, intervalMs: SHADER_FRAME_INTERVAL_MS };
    function applyPerfBudget(state) {
      const profile = perfProfile(state);
      shaderBudget.pixels = Math.max(120000, Math.round(SHADER_MAX_PIXELS * profile.pixels));
      shaderBudget.fps = profile.fps;
      shaderBudget.intervalMs = 1000 / profile.fps;
    }

    function clampNumber(value, fallback, min, max) {
      const number = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(number)) return fallback;
      return Math.min(max, Math.max(min, number));
    }

    function normalizeBeautify(raw) {
      const source = raw && typeof raw === 'object' ? raw : {};
      const solid =
        typeof source.solid === 'string' && /^#[0-9a-f]{3,8}$/i.test(source.solid)
          ? source.solid
          : BEAUTIFY_DEFAULTS.solid;
      return {
        on: source.on !== false,
        mode: BEAUTIFY_MODES.includes(source.mode) ? source.mode : BEAUTIFY_DEFAULTS.mode,
        solid,
        image: typeof source.image === 'string' ? source.image : '',
        shaderId: typeof source.shaderId === 'string' ? source.shaderId : '',
        presetId: typeof source.presetId === 'string' ? source.presetId : '',
        perfTier: PERF_TIERS.includes(source.perfTier) ? source.perfTier : BEAUTIFY_DEFAULTS.perfTier,
        glassBlur: clampNumber(source.glassBlur, BEAUTIFY_DEFAULTS.glassBlur, 0, 40),
        glassAlpha: clampNumber(source.glassAlpha, BEAUTIFY_DEFAULTS.glassAlpha, 0, 1),
      };
    }

    /** Same shape as the budget store: one browser-local value plus subscribers. */
    const beautifyStore = (() => {
      let state = null;
      const listeners = new Set();

      const load = () => {
        if (state !== null) return state;
        let parsed = null;
        try {
          const raw = window.localStorage.getItem(BEAUTIFY_KEY);
          parsed = raw === null ? null : JSON.parse(raw);
        } catch (error) {
          parsed = null;
        }
        state = normalizeBeautify(parsed || BEAUTIFY_DEFAULTS);
        return state;
      };

      const persist = () => {
        try {
          window.localStorage.setItem(BEAUTIFY_KEY, JSON.stringify(state));
          return true;
        } catch (error) {
          return false;
        }
      };

      const emit = () => {
        for (const listener of Array.from(listeners)) listener();
      };

      return {
        get() {
          return { ...load() };
        },
        set(patch) {
          const current = load();
          const next = normalizeBeautify({ ...current, ...(patch || {}) });
          if (JSON.stringify(next) === JSON.stringify(current)) return true;
          state = next;
          const saved = persist();
          emit();
          return saved;
        },
        replace(next) {
          state = normalizeBeautify(next);
          const saved = persist();
          emit();
          return saved;
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      };
    })();

    function useBeautifyState() {
      const [, bump] = React.useReducer((value) => value + 1, 0);
      React.useEffect(() => beautifyStore.subscribe(bump), []);
      return beautifyStore.get();
    }

    /** Clamp one window-mode knob into its permitted range. */
    function clampWindow(value, fallback, min, max) {
      const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
      return Math.min(max, Math.max(min, number));
    }

    function normalizeWindow(source) {
      const raw = source && typeof source === 'object' ? source : {};
      return {
        on: raw.on !== false,
        radius: clampWindow(raw.radius, WINDOW_DEFAULTS.radius, 0, 32),
        gap: clampWindow(raw.gap, WINDOW_DEFAULTS.gap, 0, 24),
        blur: clampWindow(raw.blur, WINDOW_DEFAULTS.blur, 0, 40),
        alpha: clampWindow(raw.alpha, WINDOW_DEFAULTS.alpha, 20, 95),
        sheen: clampWindow(raw.sheen, WINDOW_DEFAULTS.sheen, 0, 1),
        border: clampWindow(raw.border, WINDOW_DEFAULTS.border, 0, 0.5),
      };
    }

    const windowModeStore = (() => {
      let state = null;
      const listeners = new Set();

      const load = () => {
        if (state !== null) return state;
        let parsed = null;
        try {
          const raw = window.localStorage.getItem(WINDOW_KEY);
          parsed = raw === null ? null : JSON.parse(raw);
        } catch (error) {
          parsed = null;
        }
        state = normalizeWindow(parsed || WINDOW_DEFAULTS);
        return state;
      };

      const persist = () => {
        try {
          window.localStorage.setItem(WINDOW_KEY, JSON.stringify(state));
          return true;
        } catch (error) {
          return false;
        }
      };

      const emit = () => {
        for (const listener of Array.from(listeners)) listener();
      };

      return {
        get() {
          return { ...load() };
        },
        set(patch) {
          const current = load();
          const next = normalizeWindow({ ...current, ...(patch || {}) });
          if (JSON.stringify(next) === JSON.stringify(current)) return true;
          state = next;
          const saved = persist();
          emit();
          return saved;
        },
        replace(next) {
          state = normalizeWindow(next);
          const saved = persist();
          emit();
          return saved;
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      };
    })();

    function useWindowState() {
      const [, bump] = React.useReducer((value) => value + 1, 0);
      React.useEffect(() => windowModeStore.subscribe(bump), []);
      return windowModeStore.get();
    }

    /** Built-ins cover the three solid tints and the two works the user settled on. */
    const BUILTIN_PRESETS = [
      { id: 'builtin-ink', name: '墨黑', nameEn: 'Ink', emoji: '🌑', params: { mode: 'solid', solid: '#0b0d10' } },
      { id: 'builtin-dusk', name: '暮蓝', nameEn: 'Dusk', emoji: '🌌', params: { mode: 'solid', solid: '#0e1421' } },
      { id: 'builtin-sand', name: '暖沙', nameEn: 'Sand', emoji: '🏜️', params: { mode: 'solid', solid: '#1a1613' } },
      { id: 'builtin-clouds', name: '云海', nameEn: 'Clouds', emoji: '☁️', params: { mode: 'shader', shaderId: 'cdlyWr' } },
      { id: 'builtin-sun', name: '晴空', nameEn: 'Blue sky', emoji: '☀️', params: { mode: 'shader', shaderId: 'tdSXzD' } },
    ];

    function readCustomPresets() {
      try {
        const raw = window.localStorage.getItem(BEAUTIFY_PRESET_KEY);
        const parsed = raw === null ? null : JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(
          (item) =>
            item &&
            typeof item.id === 'string' &&
            typeof item.name === 'string' &&
            item.params &&
            typeof item.params === 'object',
        );
      } catch (error) {
        return [];
      }
    }

    /**
     * The shader work itself, not just its ID.
     *
     * The ID is a bookmark; this is the book. ShaderToy works can be retired or rate
     * limited, so re-fetching by ID on every reload is not equivalent to remembering
     * what was rendered. The work is small (a few kB of GLSL per pass) and the textures
     * are kept out of it -- they are re-fetched with the work when it has them.
     */
    const SHADER_WORK_KEY = 'ui-enhance.shader-work';

    /** Persist the current work so a reload restores the backdrop that was running. */
    function writeShaderWork(work, id) {
      try {
        if (work === null || typeof work !== 'object') {
          window.localStorage.removeItem(SHADER_WORK_KEY);
          return true;
        }
        window.localStorage.setItem(
          SHADER_WORK_KEY,
          JSON.stringify({ id: String(id || ''), work }),
        );
        return true;
      } catch (error) {
        return false;
      }
    }

    /** The last persisted work, or null when nothing usable was stored. */
    function readShaderWork() {
      try {
        const raw = window.localStorage.getItem(SHADER_WORK_KEY);
        if (raw === null) return null;
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object') return null;
        if (parsed.work === null || typeof parsed.work !== 'object') return null;
        return { id: String(parsed.id || ''), work: parsed.work };
      } catch (error) {
        return null;
      }
    }

    function writeCustomPresets(list) {
      try {
        window.localStorage.setItem(BEAUTIFY_PRESET_KEY, JSON.stringify(list));
        return true;
      } catch (error) {
        return false;
      }
    }

    /** One line of ShaderToy status; the panel renders it in a fixed-height row. */
    const shaderStatus = (() => {
      let value = { text: '', tone: 'info', seq: 0 };
      let seq = 0;
      const listeners = new Set();
      return {
        get() {
          return value;
        },
        set(text, tone) {
          /* `seq` bumps on every call, not only when the text changes.
           *
           * The status row used to skip emitting when the new text equalled the old
           * one, which made a slow pull look like a button that did nothing: two
           * statuses can carry the same string (an informational line set here, then
           * the same line set again by the renderer's compile path), and the panel
           * then never re-rendered at all. Every set now both emits and advances
           * `seq`, so a subscriber can always tell that a newer message exists. */
          seq += 1;
          value = { text: String(text === null || text === undefined ? '' : text), tone: tone || 'info', seq };
          for (const listener of Array.from(listeners)) listener();
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      };
    })();

    /**
     * The host locale binder for module-level code. `apply` installs it before any
     * notice can be raised; the helpers below (`showNotice`, `showReloadBlocked`) run
     * outside that closure and would otherwise reference a `t` that does not exist in
     * their scope, which is what made every notice throw "t is not defined".
     */
    let moduleT = null;
    const t = (key, values) => (moduleT === null ? String(key) : moduleT(key, values));

    /** The host locale binder, installed by `apply` before the beautify effect runs. */
    let beautifyT = null;
    const bt = (key, values) => {
      const template = beautifyT ? beautifyT(key) : key;
      return values ? fill(template, values) : template;
    };

    const BEAUTIFY_CSS = [
      'html.' + BEAUTIFY_CLASS + ',html.' + BEAUTIFY_CLASS + ' body{background:transparent!important}',
      /* `z-index:-1` is deliberate and is NOT the old bug.
       *
       * A negative z-index paints below in-flow content but still ABOVE the background
       * of the root element's own box. The old failure was that the shipped theme
       * painted an opaque colour on `html`/`body`, which covered this layer. The rule
       * just above clears exactly those two backgrounds when Beautify is on, so the
       * backdrop now lands where it should: over the cleared root background and under
       * every app element, without altering any layout box. */
      '#' + BEAUTIFY_BG_ID + '{position:fixed;inset:0;z-index:-1;pointer-events:none;background-position:center center;background-size:cover;background-repeat:no-repeat;background-color:#0b0d10}',
      '#' + BEAUTIFY_BG_ID + ' canvas{position:fixed;inset:0;z-index:-1;display:block;width:100%;height:100%;pointer-events:none}',
      /* The three panes share one set of knobs (`--ue-glass-*`), matching the sibling plugins.
       *
       * EXCEPT when window mode is on. `window.css` paints those panes from its own
       * knobs (`--ue-win-alpha` / `--ue-win-blur`) and its `.ue-col` selector outranks
       * this bare attribute selector, so with both active the tint and the blur were
       * set by one sheet and overridden by the other depending on which properties
       * happened to be `!important`. That is precisely "the opacity and blur sliders
       * do nothing on the pane": one rule won the background and the other won the
       * filter, so neither slider controlled the whole surface. Exactly one stylesheet
       * must own a pane, so this one steps aside for window mode. */
      'html.' + BEAUTIFY_CLASS + ':not(.' + WINDOW_CLASS + ') [' + GLASS_ATTR + ']{background-color:rgba(14,16,21,var(--ue-glass-alpha,.45))!important;backdrop-filter:blur(var(--ue-glass-blur,12px)) saturate(1.35);-webkit-backdrop-filter:blur(var(--ue-glass-blur,12px)) saturate(1.35)}',
      /* Rounded corners WITHOUT margins. `margin:6px` around a flex/grid column shrinks
       * its content box and, at the frame level, adds to the row's used width -- which
       * overflowed the viewport and put a scrollbar on the whole window. `inset` on the
       * border-box path is not an option either, so the gap is expressed as padding on
       * the pane itself, which the layout already accounts for. */
      'html.' + BEAUTIFY_CLASS + ':not(.' + WINDOW_CLASS + ') [' + GLASS_ATTR + ']{border-radius:12px;overflow:hidden;box-sizing:border-box}',
      'html.' + BEAUTIFY_CLASS + ':not(.' + WINDOW_CLASS + ') [' + GLASS_ATTR + ']:focus-within{background-color:rgba(22,25,31,calc(var(--ue-glass-alpha,.45) + .08))!important}',
      /* 美化入口（重写版）：最小按钮 + 纯 CSS 定位面板。面板位置不读
       * getBoundingClientRect，因此不存在“anchor 尚未设置就开始渲染”的窗口期。 */
      '[data-ue-ask-btn]{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;margin:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;outline:none;flex:none;transition:background-color .15s ease,color .15s ease}',
      '[data-ue-ask-btn]:hover{background-color:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '[data-ue-ask-btn][aria-expanded="true"]{background-color:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-brand-primary)}',
      '[data-ue-ask]{position:fixed;right:16px;bottom:100px;z-index:1200;box-sizing:border-box;width:300px;max-height:min(70vh,560px);overflow:auto;padding:12px 14px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu,#1d1d1f);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px}',
      /* The sidebar/main seat reuses the same body, so it must not inherit the popover's
         fixed positioning: it flows inside the panel column and scrolls on its own. */
      '[data-ue-ask="panel"][data-ue-ask="panel"]{position:static;right:auto;bottom:auto;z-index:auto;width:100%;max-width:none;max-height:none;box-sizing:border-box;overflow:visible;padding:14px 16px;border:0;border-radius:0;background:transparent;box-shadow:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px}',
      '[data-ue-ask] .ue-panel-head{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:10px}',
      '[data-ue-ask] .ue-panel-title{font-weight:600;font-size:13px}',
      '[data-ue-ask] .ue-panel-sub{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}',
      '[data-ue-ask] .ue-panel-sec{margin-top:12px}',
      '[data-ue-ask] .ue-panel-label{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-bottom:5px}',
      '[data-ue-ask] .ue-panel-row{display:flex;align-items:center;gap:8px}',
      '[data-ue-ask] .ue-panel-toggle{height:26px;min-width:64px;padding:0 12px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;cursor:pointer;outline:none}',
      '[data-ue-ask] .ue-panel-toggle[data-on="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '[data-ue-ask] .ue-panel-range{box-sizing:border-box;width:100%;margin:0;accent-color:var(--dsw-alias-brand-primary)}',
      '[data-ue-ask] .ue-panel-error{padding:8px;border-radius:8px;background:rgba(220,60,60,.12);color:#ff8080;font-size:11.5px}',
      '[data-ue-ask] .ue-panel-error-msg{margin-top:4px;word-break:break-word;opacity:.85}',
'[data-ue-ask] .ue-panel-tiers{gap:6px}',
'[data-ue-ask] .ue-panel-tier{flex:1 1 0;min-width:0;padding:0 6px}',
'[data-ue-ask] .ue-panel-hint{margin-top:5px;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}',
'[data-ue-ask] .ue-panel-input{box-sizing:border-box;display:block;width:100%;height:26px;margin:0 0 6px;padding:0 8px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;outline:none}',
'[data-ue-ask] .ue-panel-input:focus{border-color:var(--dsw-alias-brand-primary)}',
'[data-ue-ask] .ue-panel-input::placeholder{color:var(--dsw-alias-label-tertiary)}',
'[data-ue-ask] .ue-panel-btn{flex:1 1 0;min-width:0;height:26px;padding:0 8px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;cursor:pointer}',
'[data-ue-ask] .ue-panel-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
'[data-ue-ask] .ue-panel-btn:disabled{cursor:progress;opacity:.6}',
'[data-ue-ask] .ue-panel-presets{display:flex;flex-direction:column;gap:4px}',
'[data-ue-ask] .ue-panel-preset{display:flex;align-items:center;gap:4px;border-radius:var(--dsw-radius-sm)}',
'[data-ue-ask] .ue-panel-preset[data-active="true"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent)}',
'[data-ue-ask] .ue-panel-preset-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;height:24px;padding:0 8px;border:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;cursor:pointer}',
'[data-ue-ask] .ue-panel-preset-name:hover{color:var(--dsw-alias-brand-primary)}',
'[data-ue-ask] .ue-panel-preset-del{flex:none;width:22px;height:22px;padding:0;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:1;cursor:pointer}',
'[data-ue-ask] .ue-panel-preset-del:hover{background:rgba(220,60,60,.16);color:#ff8080}',
      '[data-ui-enhance-beautify-btn]{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;outline:none;flex:none}',
      '[data-ui-enhance-beautify-btn]:hover:not(:disabled),[data-ui-enhance-beautify-btn][aria-expanded="true"]{background-color:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '[data-ui-enhance-beautify-btn]:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}',
      '[data-ui-enhance-beautify]{box-sizing:border-box;width:332px;max-height:min(78vh,640px);overflow:auto;padding:10px 12px 12px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);background:linear-gradient(rgba(24,26,31,.92),rgba(24,26,31,.92)),var(--dsw-specific-menu,#1d1d1f);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;z-index:1200}',
      '[data-ui-enhance-beautify] .ue-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}',
      '[data-ui-enhance-beautify] .ue-title{font-weight:600;font-size:12.5px}',
      '[data-ui-enhance-beautify] .ue-sec{margin-top:10px}',
      '[data-ui-enhance-beautify] .ue-label{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-bottom:4px}',
      '[data-ui-enhance-beautify] .ue-row{display:flex;align-items:center;gap:6px;min-width:0}',
      '[data-ui-enhance-beautify] .ue-row+.ue-row{margin-top:6px}',
      '[data-ui-enhance-beautify] .ue-tabs{display:flex;gap:2px;padding:2px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover)}',
      '[data-ui-enhance-beautify] .ue-tab{flex:1;height:24px;padding:0 6px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;cursor:pointer;outline:none}',
      '[data-ui-enhance-beautify] .ue-tab[data-active]{background:var(--dsw-alias-bg-elevated,#333);color:var(--dsw-alias-label-primary);font-weight:600}',
      '[data-ui-enhance-beautify] .ue-input{box-sizing:border-box;flex:1;min-width:0;height:26px;padding:0 8px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-specific-input-major,#161618);color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;outline:none}',
      '[data-ui-enhance-beautify] .ue-shader-code-label{display:flex;align-items:baseline;gap:6px;margin-top:2px}',
      '[data-ui-enhance-beautify] .ue-shader-code-title{font-size:11.5px;color:var(--dsw-alias-label-primary)}',
      '[data-ui-enhance-beautify] .ue-shader-code-hint{font-size:10.5px;color:var(--dsw-alias-label-secondary)}',
      // Fixed height and its own scrollbar: the editor must never resize the panel, which is
      // what made the status line look like the layout was jumping.
      '[data-ui-enhance-beautify] .ue-shader-code{box-sizing:border-box;width:100%;height:180px;resize:vertical;padding:8px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-specific-input-major,#161618);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-mono,ui-monospace,Consolas,monospace);font-size:11px;line-height:1.45;tab-size:2;white-space:pre;overflow:auto;outline:none}',
      '[data-ui-enhance-beautify] .ue-btn{position:relative;display:inline-flex;align-items:center;justify-content:center;height:26px;padding:0 9px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;white-space:nowrap;cursor:pointer;outline:none}',
      '[data-ui-enhance-beautify] .ue-btn:hover{color:var(--dsw-alias-label-primary)}',
      '[data-ui-enhance-beautify] .ue-link{height:24px;padding:0 6px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:11.5px;cursor:pointer;outline:none}',
      '[data-ui-enhance-beautify] .ue-color{width:44px;height:26px;padding:0;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;cursor:pointer}',
      '[data-ui-enhance-beautify] .ue-presets{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}',
      '[data-ui-enhance-beautify] .ue-preset{position:relative;display:flex;flex-direction:column;align-items:center;gap:2px;padding:5px 2px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:10.5px;line-height:13px;cursor:pointer;outline:none;overflow:hidden}',
      '[data-ui-enhance-beautify] .ue-preset[data-active]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}',
      '[data-ui-enhance-beautify] .ue-preset-name{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '[data-ui-enhance-beautify] .ue-preset-del{position:absolute;top:0;right:2px;padding:2px;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:10px;cursor:pointer}',
      '[data-ui-enhance-beautify] .ue-range{flex:1;min-width:0;accent-color:var(--dsw-alias-brand-primary)}',
      '[data-ui-enhance-beautify] .ue-num{width:40px;text-align:right;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '[data-ui-enhance-beautify] .ue-status{height:16px;margin-top:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '[data-ui-enhance-beautify] .ue-status[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary,#e0a020)}',
      '[data-ui-enhance-beautify] .ue-status[data-tone="ok"]{color:var(--dsw-alias-label-secondary)}',
      '[data-ui-enhance-beautify] .ue-file{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}',
    ].join('\n');

    /* ---------------------------------------------------------------------------
     * Window-mode stylesheet. Kept separate from `BEAUTIFY_CSS` so the two feature
     * halves each own one <style> tag: window framing can be toggled (and its tag
     * removed) without disturbing the backdrop, and vice versa.
     * ------------------------------------------------------------------------- */

    const WINDOW_CSS = [
    /* ---------------------------------------------------------------------
     * Window mode: left / centre / right columns as frosted-glass cards.
       *
       * The columns are addressed by their SHIPPED class names, read from
       * dsh-client-ui-layout (`.mP3x-q_sidebarCol` / `_centerCol` / `_rightbarCol`,
       * matched by suffix so a hash rename still resolves) rather than by the
       * measuring heuristics the older glass pass used. A rule that names its
       * target is stable across re-renders; a rule that guesses rectangles is not,
       * and guessing is what made the earlier window mode look lost.
       *
       * Everything here is pure CSS on existing elements: no node is created,
       * moved, or observed, so the streaming re-renders cannot feed back into it.
       * --------------------------------------------------------------------- */
      /* The card:
       *
       *     tint      = colour at `--ue-win-alpha`
       *     blur      = `--ue-win-blur`
       *     thickness = `--ue-win-sheen` highlights
       *
       * This rule must be the ONLY thing that paints the pane.
       *
       * A second stylesheet (`BEAUTIFY_CSS`) also decorates these same nodes through
       * the `data-ue-glass` attribute, using its OWN variables (`--ue-glass-alpha`,
       * `--ue-glass-blur`) and `!important`. Both sheets are injected into <head>,
       * window.css last, so equal specificity was resolved by source order -- except
       * the selectors are NOT equally specific: `.ue-col` (0,1,0 plus the html prefix)
       * outranks the bare `[data-ue-glass]` attribute. The result was two sliders
       * fighting over one pane and the loser silently winning on some columns: the
       * 窗口 opacity/blur knobs moved the tint, but the pane's real transparency was
       * pinned by the fixed `.45` alpha of the *other* stylesheet, and the blur by its
       * fixed 12px. Left and right disagreed because the right bar is sized by a
       * second rule (`_rightbarCol` / `.acoR2W_panel`) that the two sheets style
       * differently. `!important` on every declaration is what makes the window knobs
       * authoritative; the attribute rule in `BEAUTIFY_CSS` is narrowed to nodes that
       * are NOT painted as cards, so exactly one rule owns each pane. */
      'html.' + WINDOW_CLASS + ' .ue-col{' +
        'background-color:color-mix(in srgb,var(--dsw-alias-bg-base) var(--ue-win-alpha,32%),transparent)!important;' +
        /* Liquid glass, painted as stacked gradients on the pane itself. Reading top to
         * bottom, the layers are the ones the eye uses to decide a surface is glass
         * rather than plastic:
         *
         *  1. a specular rim -- a 1px-bright band hugging the top edge and fading
         *     towards the sides, which is the highlight a rounded edge catches;
         *  2. a broad top bevel -- light entering the pane and scattering a few px in;
         *  3. a bottom counter-light -- the faint bounce off whatever sits below, which
         *     is what stops the lower edge reading as a cut;
         *  4. a corner vignette -- keeps the tint from going flat at the extremes.
         *
         * The sheen slider scales 1-3, so 0 gives a matte pane and 1 a full highlight.
         * These are background layers, not filters, so they cost nothing per frame. */
        'background-image:' +
          'linear-gradient(180deg,rgba(255,255,255,calc(var(--ue-win-sheen,.5) * .30)) 0%,' +
            'rgba(255,255,255,calc(var(--ue-win-sheen,.5) * .10)) 1.5%,' +
            'rgba(255,255,255,0) 9%),' +
          'linear-gradient(180deg,rgba(255,255,255,calc(var(--ue-win-sheen,.5) * .13)) 0%,' +
            'rgba(255,255,255,calc(var(--ue-win-sheen,.5) * .035)) 18%,' +
            'rgba(255,255,255,0) 42%),' +
          'linear-gradient(0deg,rgba(255,255,255,calc(var(--ue-win-sheen,.5) * .07)) 0%,' +
            'rgba(255,255,255,0) 12%),' +
          'radial-gradient(130% 120% at 50% -20%,rgba(255,255,255,calc(var(--ue-win-sheen,.5) * .10)) 0%,' +
            'rgba(255,255,255,0) 60%)!important;' +
        /* The blur chain is what makes the backdrop read as depth rather than as a
         * blurred picture: saturation pulls the colour BACK through the tint (a tinted
         * pane otherwise greys out), and the slight brightness lift is the pane being
         * lit from outside. */
        'backdrop-filter:none!important;' +
        '-webkit-backdrop-filter:none!important;' +
        'isolation:isolate!important;' +
        /* The 1px rim must be part of the column's width. With the default
         * `content-box` a bordered grid column measures `track + 2px`, so three panes
         * pushed 6px past the frame and scrolled the whole window sideways. */
        'box-sizing:border-box!important;' +
        /* A hairline light border with a darker edge is the glass-edge cue the eye
         * reads as a physical rim. */
        'border-top:1px solid rgba(255,255,255,calc(.12 + var(--ue-win-border,.14) * .80))!important;' +
        'border-left:1px solid rgba(255,255,255,calc(.08 + var(--ue-win-border,.14) * .55))!important;' +
        'border-right:1px solid rgba(255,255,255,calc(.08 + var(--ue-win-border,.14) * .55))!important;' +
        'border-bottom:1px solid rgba(255,255,255,calc(.04 + var(--ue-win-border,.14) * .30))!important;' +
        'border-radius:var(--ue-win-radius,16px)!important;' +
        /* An inset hairline follows the rounded edge and is what gives the pane a
         * visible thickness; the outer shadow lifts the card off the page. */
        'box-shadow:' +
          'inset 0 1px 0 0 rgba(255,255,255,calc(.30 * var(--ue-win-sheen,.5))),' +
          'inset 0 -1px 0 0 rgba(0,0,0,.14),' +
          'inset 0 0 0 1px rgba(255,255,255,calc(.035 + var(--ue-win-border,.14) * .18)),' +
          '0 1px 2px rgba(0,0,0,.28),' +
          '0 18px 44px -18px rgba(0,0,0,.60)' +
          '!important;' +
        'overflow:hidden!important;' +
        'transition:background-color .28s var(--ds-ease-in-out,ease),' +
          'border-color .28s var(--ds-ease-in-out,ease),' +
          'box-shadow .28s var(--ds-ease-in-out,ease),' +
          'border-radius .28s var(--ds-ease-in-out,ease),' +
          /* Resizing a pane eases on the theme's slow clock instead of snapping. */
          'width var(--ds-transition-duration-slow,.32s) var(--ds-ease-in-out,ease),' +
          'flex-basis var(--ds-transition-duration-slow,.32s) var(--ds-ease-in-out,ease)' +
      '}',
      /* One blur for the whole window. The three panes used to each run their own
       * backdrop-filter, which re-samples the backdrop per pane per frame; this
       * full-window layer blurs once and the panes just sit on top of it. It is
       * appended after the background canvas (which is `z-index:-1`), so it needs no
       * z-index of its own. */
      'html.' + WINDOW_CLASS + ' #' + BEAUTIFY_BG_ID + ' [data-ue-glass-layer]{' +
        'position:fixed;inset:0;pointer-events:none;' +
        'backdrop-filter:blur(var(--ue-win-blur,18px)) saturate(215%) brightness(1.10)!important;' +
        '-webkit-backdrop-filter:blur(var(--ue-win-blur,18px)) saturate(215%) brightness(1.10)!important' +
      '}',
      /* The right sidebar is NOT one of the three grid tracks the rule above rounds.
       * dsh-client-ui-layout mounts a zero-width track there and the occupant draws
       * the real panel itself, absolutely positioned against the frame right edge
       * (`.acoR2W_panel` -> `[data-dockkit-host=dock]`). Rounding the track therefore
       * rounds an invisible box. The visible panel is what receives the glass.
       */
      'html.' + WINDOW_CLASS + ' .acoR2W_panel{' +
        'border-radius:var(--ue-win-radius,16px)!important;' +
        'overflow:hidden!important' +
      '}',
      'html.' + WINDOW_CLASS + ' .acoR2W_panel > [data-dockkit-host=dock],' +
        'html.' + WINDOW_CLASS + ' .acoR2W_panel > [data-dockkit-empty]{' +
        'border-radius:var(--ue-win-radius,16px)!important;' +
        'overflow:hidden!important;' +
        'background-color:color-mix(in srgb,var(--dsw-alias-bg-base) var(--ue-win-alpha,32%),transparent)!important;' +
        'backdrop-filter:none!important;' +
        '-webkit-backdrop-filter:none!important;' +
        'border:1px solid rgba(255,255,255,calc(.10 + var(--ue-win-border,.14) * .55))!important;' +
        'box-sizing:border-box!important' +
      '}',
      /* Why the frosted columns read as plain grey: the shipped layout paints an
       * opaque fill on containers INSIDE each column, so the column backdrop-filter
       * only ever sampled that flat colour. Clearing the direct descendants lets the
       * shader, image or solid backdrop reach the glass.
       *
       * The `:not()` tail is load-bearing. The right sidebar's real surface is
       * `[data-dockkit-host=dock]` INSIDE `_rightbarCol`, so a blanket
       * `> * > *{background-color:transparent!important}` also erased the tint this
       * stylesheet had just given that surface -- the right card then showed the
       * shader directly through it and ignored the 窗口 opacity slider, which is the
       * reported "right side is not controlled by the glass settings". Any node this
       * stylesheet paints itself is excluded from the sweep. */
      'html.' + WINDOW_CLASS + ' .ue-col,' +
        'html.' + WINDOW_CLASS + ' .ue-col > *,' +
        'html.' + WINDOW_CLASS + ' .ue-col > * > *{' +
        'background-color:transparent!important' +
      '}',
      'html.' + WINDOW_CLASS + ' .ue-col > [data-dockkit-host],' +
        'html.' + WINDOW_CLASS + ' .ue-col > [data-dockkit-empty]{' +
        'background-color:color-mix(in srgb,var(--dsw-alias-bg-base) var(--ue-win-alpha,32%),transparent)!important' +
      '}',
      /* The card fill must be re-asserted after that sweep.
       *
       * Both rules end in `!important`, so the one that comes LATER in the sheet wins
       * for an equal-specificity match -- and `.ue-col > *` is one step more specific
       * than the `.ue-col` card rule for a direct child. Restating the tint at the
       * child's own specificity is what stops the sweep from quietly erasing it. */
      /* The column own tint IS the glass, so it is restored after that sweep. */
      'html.' + WINDOW_CLASS + ' .ue-col.ue-col{' +
        'background-color:color-mix(in srgb,var(--dsw-alias-bg-base) var(--ue-win-alpha,32%),transparent)!important' +
      '}',
      /* The opaque painters INSIDE the panes. The colour sweep above only reaches two
       * levels down, and the offenders sit deeper: the centre column's chat root
       * (`an3WzG_root`), and the right panel's tab host (`_tabHost_*` when a document
       * is open, `_emptyTabHost_*` when it is not) all paint the app base colour across
       * the whole pane, which is exactly why 正文 and the right sidebar looked immune to
       * the 窗口 opacity/blur sliders. Every other `_root` / `_surface` node measured
       * transparent, so clearing them changes nothing else. */
      'html.' + WINDOW_CLASS + ' .ue-col [class*="_root"],' +
        'html.' + WINDOW_CLASS + ' .acoR2W_panel [class*="_surface"],' +
        'html.' + WINDOW_CLASS + ' [class*="abHost"]{' +
        'background-color:transparent!important' +
      '}',
      /* The shipped bottom fades paint an opaque colour over the pane - that is the
       * black band that grows upward under the sidebar and, much taller, under the
       * composer. Clearing them leaves the column's own tint as the only layer;
       * repainting them with the same alpha would stack to ~86% and read as black. */
      'html.' + WINDOW_CLASS + ' [class*="_composerSeat"]{' +
        'background-image:none!important;' +
        'background-color:transparent!important' +
      '}',
      'html.' + WINDOW_CLASS + ' [class*="GAkraW_fade"]{' +
        'background-image:none!important;' +
        'background-color:transparent!important' +
      '}',
      /* Remaining opaque painters, found by scanning every surface of 120x80 px or
       * more in the running app: the right pane's document navigator
       * (`_4EiRdG_wholePage`), the composer card (`GRgSLq_card`) and the sidebar's
       * token-stats block (a classless div directly under `wtg9ga_root`). The colour
       * sweep above stops two levels down, so these have to be named. */
      'html.' + WINDOW_CLASS + ' .ue-col [class*="_wholePage"]{' +
        'background-color:transparent!important' +
      '}',
      'html.' + WINDOW_CLASS + ' [class*="GRgSLq_card"]{' +
        'background-color:transparent!important' +
      '}',
      'html.' + WINDOW_CLASS + ' [class*="wtg9ga_root"] div:not([class]){' +
        'background-color:transparent!important' +
      '}',
      'html.' + WINDOW_CLASS + ' [class*="GRgSLq_card"] div:not([class]),' +
        'html.' + WINDOW_CLASS + ' .ue-col [class*="st-strip"]{' +
        'background-color:transparent!important' +
      '}',
      /* Agent-teams view surfaces. The delegation/dependency sections and the
       * completion/inbox cards paint an opaque `rgb(35,35,36)` across most of the
       * right pane, so in that view the pane ignores the 窗口 opacity slider and
       * reads as a black slab. They are card surfaces, not content, so they follow
       * the same rule as every other surface: let the column tint be the only fill. */
      'html.' + WINDOW_CLASS + ' [class*="aYQbCq_"]{' +
        'background-color:transparent!important' +
      '}',
      /* The shipped frame is a grid of touching columns; the gaps are what turns the
       * three columns into separate cards. Padding on the frame keeps the outer
       * edges even with the inner gutters.
       *
       * `padding-top` is set separately because the Windows build reserves a drag
       * strip at the top of the frame via `--dsh-windows-titlebar-height`. Writing the
       * `padding` shorthand would wipe that reservation and pull the cards up under
       * the window controls, so the titlebar offset is preserved and the gutter is
       * added on top of it. */
      'html.' + WINDOW_CLASS + ' .ue-frame{' +
        /* The frame is a grid whose columns already split 100% of the width. Padding
         * without `border-box` adds to that used width, so `100% + 2*gap` overflowed the
         * viewport and put a scrollbar on the whole window. `border-box` folds the
         * gutter into the existing box instead. */
        'box-sizing:border-box!important;' +
        'gap:var(--ue-win-gap,10px)!important;' +
        'padding:var(--ue-win-gap,10px)!important;' +
        'padding-top:calc(var(--ue-win-gap,10px) + var(--dsh-windows-titlebar-height,0px))!important;' +
        'box-sizing:border-box;' +
        /* `backdrop-filter` blurs what is painted BEHIND the element. The shipped frame
         * paints an opaque base, so leaving it opaque would make the cards blur that
         * flat colour and the glass would read as plain grey. Clearing it lets whatever
         * sits behind the frame (the Beautify backdrop, or the window itself) show
         * through the frosted cards. */
        'background:transparent!important' +
      '}',
      /* With the frame transparent, something has to own the page colour underneath.
       * When Beautify is on its backdrop layer already paints behind everything; when
       * it is off this supplies the base tint so the glass still has a colour to blur
       * instead of the raw window background.
       *
       * The ground is deliberately DARKER than the card fill, and that is the whole
       * point. A frosted card is `color-mix(bg-base alpha%, transparent)` over
       * whatever is behind it, so the painted value is
       *
       *     pixel = cardLuma * alpha + groundLuma * (1 - alpha)
       *
       * If the ground is the same colour as the card, that expression collapses to a
       * constant and the 窗口不透明度 slider is mathematically dead -- which is exactly
       * the "opacity does nothing" report: with ground == card == 29 the spread across
       * alpha 20%..95% was 0.0 of 255. Sitting the ground ~10 luma below the card
       * gives the slider roughly 11 of 255 to work with: visible as glass thinning out,
       * never harsh. The two near-invisible radial washes are only there so the blur
       * itself has some structure to soften. */
      'html.' + WINDOW_CLASS + ':not(.' + BEAUTIFY_CLASS + ')' +
        ',html.' + WINDOW_CLASS + ':not(.' + BEAUTIFY_CLASS + ') body{' +
        'background-color:var(--ue-win-base,color-mix(in srgb,var(--dsw-alias-bg-base) 48%,#000))!important;' +
        'background-image:' +
          'radial-gradient(120% 90% at 18% 0%,rgba(120,150,255,.07) 0%,rgba(120,150,255,0) 58%),' +
          'radial-gradient(110% 85% at 88% 100%,rgba(255,180,120,.05) 0%,rgba(255,180,120,0) 62%)!important;' +
        'background-attachment:fixed!important' +
      '}',
      /* The drag strip is painted on `::before`; it must keep covering the gutter the
       * padding above opened, otherwise the top strip stops being draggable. */
      '[data-windows-titlebar] html.' + WINDOW_CLASS + ' .ue-frame:before{' +
        'height:calc(var(--dsh-windows-titlebar-height,0px) + var(--ue-win-gap,10px))!important' +
      '}',
      /* Dividers become invisible drag targets: the cards already read as separate,
       * so a visible hairline between them would double the separation. */
      'html.' + WINDOW_CLASS + ' .ue-frame .ue-divider{' +
        'width:0!important;background:transparent!important;border:none!important' +
      '}',
      'html.' + WINDOW_CLASS + ' .ue-frame .ue-divider:after{display:none!important}',

      /* --- every width / height change eases instead of jumping --- */
      /* The shipped frame only transitions `grid-template-columns` while
       * `[data-animating]` is set, which covers a drag but not the discrete changes:
       * opening or collapsing the right pane, or entering window mode and changing the
       * gutter. Those used to snap, which is the "right sidebar appears abruptly"
       * report.
       *
       * `--ds-transition-duration-slow` is the theme's own slow duration, so the feel
       * matches the rest of the product, and `--ds-ease-in-out` is its easing. */
      'html.' + WINDOW_CLASS + ' .ue-frame{' +
        'transition:' +
          'grid-template-columns var(--ds-transition-duration-slow,.32s) var(--ds-ease-in-out,ease),' +
          'grid-template-rows var(--ds-transition-duration-slow,.32s) var(--ds-ease-in-out,ease),' +
          'gap var(--ds-transition-duration-slow,.32s) var(--ds-ease-in-out,ease),' +
          'padding var(--ds-transition-duration-slow,.32s) var(--ds-ease-in-out,ease)' +
      '}',
      /* A drag must stay 1:1 with the pointer, so it opts out of the easing. */
      'html.' + WINDOW_CLASS + ' .ue-frame[data-dragging]{transition:none!important}',

      /* --- workspace session rows: DeepSeek blue, sliding hover block, springy press --- */
      /* The current Session is the one the user must find at a glance, so it gets the
       * brand colour as a tinted fill plus a solid leading rule rather than the shipped
       * neutral hover grey. */
      'html.' + WINDOW_CLASS + ' .ue-session-row{' +
        'position:relative;' +
        'border-radius:10px!important;' +
        'transition:background-color .18s var(--ds-ease-in-out,ease),color .18s var(--ds-ease-in-out,ease),transform .18s cubic-bezier(.34,1.4,.64,1)' +
      '}',
      /* No marker in front of the session title: the row fill already says which Session
       * is current, and a second vertical bar beside it only added noise. */
      'html.' + WINDOW_CLASS + ' .ue-session-row::before{' +
        'content:none!important;display:none!important;position:absolute;inset-block:6px;inset-inline-start:0;width:3px;border-radius:999px;' +
        /* Swapped with the title: the marker now wears the muted tint the title used to
         * wear, and the title wears the solid brand colour the marker used to wear. */
        'background:color-mix(in srgb,var(--dsw-alias-label-primary) 55%,transparent);opacity:0;transform:scaleY(.3);' +
        'transform-origin:center;' +
        'transition:opacity .2s var(--ds-ease-in-out,ease),transform .24s cubic-bezier(.34,1.56,.64,1)' +
      '}',
      /* The marker is drawn only on the current Session. */
      /* Kept harmless rather than deleted: another copy of this file may still paint the
       * marker, and a later merge must not resurrect it here. */
      'html.' + WINDOW_CLASS + ' .ue-session-row.ue-session-current::before{opacity:0!important;transform:none!important}',
      'html.' + WINDOW_CLASS + ' .ue-session-row.ue-session-current{' +
        'background-color:var(--ue-ds-blue,#4D6BFE)!important;' +
        'color:#fff!important;' +
        'font-weight:600' +
      '}',
      /* Hovering the current row must not change its colour: focus and hover read as
       * one state, so the fill stays exactly the brand colour it has when focused. */
      'html.' + WINDOW_CLASS + ' .ue-session-row.ue-session-current:hover{' +
        'background-color:var(--ue-ds-blue,#4D6BFE)!important' +
      '}',
      /* Hovering a non-current row is NOT painted on the row itself: the travelling
       * block behind the list owns the hover fill. Painting both would double the tint
       * where they overlap, which is what made the highlight look like a flicker
       * instead of a slide. The row keeps only its own stacking and press feedback. */
      'html.' + WINDOW_CLASS + ' .ue-session-row:not(.ue-session-current):hover{' +
        'background-color:transparent!important' +
      '}',
      /* Press feedback: the row dips inwards and springs back. */
      'html.' + WINDOW_CLASS + ' .ue-session-row:active{' +
        'transform:scale(.985)' +
      '}',
      /* The travelling block behind the hovered row. It is one fixed sibling of the
       * row list, moved with transform, so the highlight slides between rows instead
       * of blinking on and off.
       *
       * Its fill is EXACTLY the current Session's fill (`--ue-ds-blue`): a hovered row
       * and the current row must read as the same selection, not as two shades of blue.
       * The block replaces the row's own tint (the row hover rule below paints nothing),
       * so there is no double tint where they overlap.
       *
       * No shadow: the current row has none, and a shadow under a solid fill would make
       * the hover state look like a different kind of object. The only difference between
       * the two states is now the text weight, exactly as it was on the current row.
       *
       * `z-index:0` keeps it beneath the rows' own content; rows are lifted to z-index 1
       * so their text sits on top of the block. */
      'html.' + WINDOW_CLASS + ' .ue-hover-slider{' +
        'position:absolute;top:0;left:0;z-index:0;pointer-events:none;' +
        'border-radius:10px;' +
        'background-color:var(--ue-ds-blue,#4D6BFE);' +
        'opacity:0;' +
        'will-change:transform,opacity;' +
        /* Only the position is animated. Size follows the destination row immediately:
         * tweening width and height as well made the block chase a moving box, and the
         * two motions fought, which is what read as a stall before it finally landed. */
        'width:0;height:0;' +
        'transition:transform .16s cubic-bezier(.22,.61,.36,1),' +
          'opacity .12s var(--ds-ease-in-out,ease)' +
      '}',
      'html.' + WINDOW_CLASS + ' .ue-hover-slider[data-on="true"]{opacity:1}',
      /* Retiring: the block only fades out, so leaving the list is not a hard cut. It is
       * a keyframe (not the entry transition) so it cannot re-run the slide-in. */
      'html.' + WINDOW_CLASS + ' .ue-hover-slider[data-out="true"]{animation:ue-slider-out .12s var(--ds-ease-in-out,ease) both}',
      '@keyframes ue-slider-out{from{opacity:1}to{opacity:0}}',
      /* A row under the block wears the current row's colouring, white title included.
       * That is written by the motion pass (`data-ue-hover`), because only that pass
       * knows the block has really travelled to the row; CSS alone would turn the title
       * white while the block was still travelling. */
      'html.' + WINDOW_CLASS + ' .ue-session-row[data-ue-hover]{' +
        'color:#fff!important' +
      '}',
      /* The row list is the block's positioning context. Marked with a class so the
       * shipped element keeps its own styling and the change is undone on teardown. */
      'html.' + WINDOW_CLASS + ' .ue-slider-host{position:relative}',

      /* --- the shipped Session hover card: native surface, animated in ---
       * This plugin no longer draws its own hover window. The shipped card is used
       * as-is, with its opener delay removed on the React side, and these rules only
       * give the card its entrance: it grows out of its top-left corner and fades in.
       * The shell belongs to the host, so it is matched structurally: the nearest
       * ancestor that contains this plugin's own hover lines. That keeps the rules
       * independent of the host's hashed class names, which change between builds. */
      'html.' + WINDOW_CLASS + ' :where(div,section,aside):has(> [data-dsh-plugin="ui-enhance-model-line"],> [data-dsh-plugin="ui-enhance-context-line"]){' +
        'transform-origin:top left;' +
        'animation:ue-hover-in .16s cubic-bezier(.22,.61,.36,1) both;' +
        'will-change:transform,opacity' +
      '}',
      /* The same shell a level up, for the wrapper the host puts between the card and the
       * content. It must not add a second animation, so it only carries the origin. */
      'html.' + WINDOW_CLASS + ' :where(div,section,aside):has(> div > [data-dsh-plugin="ui-enhance-model-line"]){' +
        'transform-origin:top left' +
      '}',
      '@keyframes ue-hover-in{' +
        'from{opacity:0;transform:scale(.86) translate(-6px,-6px)}' +
        'to{opacity:1;transform:none}' +
      '}',

      /* Rows ride above the block. */
      'html.' + WINDOW_CLASS + ' .ue-session-row{position:relative;z-index:1}',
      /* The current row's own blue fill would otherwise sit under the block and mute
       * it; on hover the block is the thing the eye should follow. */
      /* (The former second hover rule that blended the brand colour toward white has
       * been removed: it only re-tinted the row the first rule had already fixed.) */
      'html.' + WINDOW_CLASS + ' .ue-session-row[data-ue-noop]{' +
        'outline:0' +
      '}',

      /* 不再在全局面板里强制 `scroll-behavior:smooth`：它把每一次程序化
       * `scrollTop` 赋值都变成动画，于是切换会话时会从头滚到底，长列表里
       * 每帧的滚动同步也变成动画，读数与手感都明显变卡。 */
      /* Entrances only: a card fades and lifts into place once, driven by CSS.
       * Nothing here is re-triggered by a re-render, because the animation is bound
       * to the element's first paint rather than to a state change. */
      'html.' + WINDOW_CLASS + ' .ue-col{' +
        'animation:ue-win-in .42s cubic-bezier(.32,.72,0,1) both' +
      '}',
      '@keyframes ue-win-in{from{opacity:0;transform:translateY(8px) scale(.995)}to{opacity:1;transform:none}}',
      /* `backdrop-filter` (and the entrance `transform`) give a column its own
       * stacking context, and that also makes it the containing block for the
       * shipped Windows titlebar toggle -- a `position:fixed; z-index:30` button.
       * Collapsed, the sidebar column is 1px wide with `overflow:hidden` for its
       * rounded corners, so the expand button is clipped and then painted *under*
       * the centre column: "点收起后展开按钮不见了". A collapsed rail has nothing
       * else to clip, so lift that one column and let it paint outside. */
      'html.' + WINDOW_CLASS + ' [class*="sidebarCol"]:has([class*="wtg9ga_collapsed"]){' +
        'position:relative!important;z-index:5!important;overflow:visible!important' +
      '}',
      '@media (prefers-reduced-motion:reduce){' +
        'html.' + WINDOW_CLASS + ' .ue-col{animation:none}' +
        'html.' + WINDOW_CLASS + ' .ue-session-row,html.' + WINDOW_CLASS + ' .ue-hover-slider{transition:none}' +
        'html.' + WINDOW_CLASS + ' .ue-hover-slider{animation:none}' +
        'html.' + WINDOW_CLASS + ' :where(div,section,aside):has(> [data-dsh-plugin="ui-enhance-model-line"]){animation:none}' +
      '}',
    ].join('\n');

    /** Accept a bare ShaderToy id or the work URL the user copies from the address bar. */
    function parseShaderId(raw) {
      const text = String(raw || '').trim();
      if (text === '') return '';
      const match = text.match(/shadertoy\.com\/view\/([A-Za-z0-9]+)/i);
      if (match) return match[1];
      return /^[A-Za-z0-9]{4,64}$/.test(text) ? text : '';
    }

    /** The site payload's Image pass; buffer passes are not rendered by this layer. */
    function imagePassOf(payload) {
      if (!payload || typeof payload !== 'object') return null;
      const passes = Array.isArray(payload.renderpass)
        ? payload.renderpass
        : Array.isArray(payload.Shader && payload.Shader.renderpass)
          ? payload.Shader.renderpass
          : [];
      const images = passes.filter((pass) => pass && pass.type === 'image' && typeof pass.code === 'string');
      if (images.length > 0) return images[images.length - 1];
      return passes.find((pass) => pass && typeof pass.code === 'string') || null;
    }

    /** Vertex source for each GLSL dialect; ES 3.00 has no `attribute` keyword in scope. */
    const shaderVertexSource = (webgl2) =>
      webgl2
        ? '#version 300 es\nin vec2 aPos;void main(){gl_Position=vec4(aPos,0.0,1.0);}'
        : 'attribute vec2 aPos;void main(){gl_Position=vec4(aPos,0.0,1.0);}';

    /**
     * The uniform surface a work is compiled against.
     *
     * ES 3.00 has no default precision for samplers, so the sampler type needs its own
     * qualifier there; the rest of the block is identical and matches ShaderToy's own.
     */
    function shaderUniformSource(webgl2) {
      return [
        webgl2 ? '#version 300 es' : '',
        'precision highp float;',
        'precision highp int;',
        webgl2 ? 'precision highp sampler2D;' : '',
        'uniform vec3 iResolution;',
        'uniform float iTime;',
        'uniform float iTimeDelta;',
        'uniform int iFrame;',
        'uniform float iFrameRate;',
        'uniform vec4 iMouse;',
        'uniform vec4 iDate;',
        'uniform sampler2D iChannel0;',
        'uniform sampler2D iChannel1;',
        'uniform sampler2D iChannel2;',
        'uniform sampler2D iChannel3;',
        'uniform vec3 iChannelResolution[4];',
        '#define HW_PERFORMANCE 1',
        // ES 3.00 dropped `texture2D`; ES 1.00 has no `texture`. Aliasing one way only
        // keeps works written for either dialect compiling.
        webgl2 ? '#define texture2D texture' : '#define texture texture2D',
        // `textureLod` exists only in ES 3.00. A plain sample keeps works that hand-roll
        // mip lookups from failing outright on WebGL1.
        webgl2 ? '' : '#define textureLod(s, c, l) texture2D(s, c)',
      ]
        .filter((line) => line !== '')
        .join('\n');
    }

    /**
     * Names that exist in ES 3.00 but not in ES 1.00. A compiler log mentioning any of them
     * means the work is simply newer than the context, which is not a plugin defect.
     * `texture` and `textureLod` are deliberately absent: the ES 1.00 wrapper aliases both,
     * so a log naming them is a genuine compile error rather than a dialect mismatch.
     */
    const ES3_ONLY = /\buint\b|\bivec[234]\b|\buvec[234]\b|\bround\s*\(|\bswitch\b|\bmat[234]x[234]\b|\btexelFetch\b|\btextureSize\b/;

    /** Kept for the tests that read the wrapper: the ES 1.00 uniform block. */
    const SHADER_UNIFORMS = shaderUniformSource(false);

    /** The fragment epilogue differs only in how the colour leaves `main`. */
    const shaderEpilogue = (webgl2) =>
      webgl2
        ? 'out vec4 ubi_FragColor;\nvoid main(){vec4 ubi_Color=vec4(0.0,0.0,0.0,1.0);mainImage(ubi_Color,gl_FragCoord.xy);ubi_FragColor=ubi_Color;}\n'
        : 'void main(){vec4 ubi_Color=vec4(0.0,0.0,0.0,1.0);mainImage(ubi_Color,gl_FragCoord.xy);gl_FragColor=ubi_Color;}\n';

    /**
     * ShaderToy's wrapper for one pass: the work supplies `mainImage`, this supplies
     * everything around it.
     * @param {object} pass one entry of `renderpass`.
     * @param {object} payload the whole work, for its shared `info.common`.
     * @param {boolean} [webgl2] dialect selection; ES 1.00 when omitted.
     */
    function buildFragmentSource(pass, payload, webgl2) {
      const common =
        (pass && typeof pass.common === 'string' && pass.common) ||
        (payload && payload.info && typeof payload.info.common === 'string' ? payload.info.common : '') ||
        '';
      return (
        shaderUniformSource(webgl2 === true) +
        '\n' +
        common +
        '\nvoid mainImage(out vec4 fragColor, in vec2 fragCoord);\n' +
        shaderEpilogue(webgl2 === true) +
        String((pass && pass.code) || '')
      );
    }

    /**
     * Every pass of a work, buffers first, in the order the site would run them.
     *
     * ShaderToy names passes `Buffer A`…`Buffer D` then `Image`, and a buffer may only read
     * earlier passes, so running them in name order is what makes a chain resolve.
     */
    const BUFFER_ORDER = ['a', 'b', 'c', 'd'];

    function orderedPassesOfWork(payload) {
      if (payload === null || typeof payload !== 'object') return [];
      const passes = Array.isArray(payload.renderpass)
        ? payload.renderpass
        : Array.isArray(payload.Shader && payload.Shader.renderpass)
          ? payload.Shader.renderpass
          : [];
      const usable = passes.filter((pass) => pass && typeof pass.code === 'string' && pass.code !== '');
      const keyOf = (pass) => {
        if (pass.type === 'image') return 'Image';
        if (typeof pass.name === 'string' && pass.name !== '') return pass.name;
        const index = typeof pass.bufferId === 'number' ? pass.bufferId : BUFFER_ORDER.indexOf(String(pass.type).toLowerCase());
        return 'Buffer ' + String.fromCharCode(65 + Math.max(0, index));
      };
      const buffers = usable.filter((pass) => pass.type !== 'image');
      const images = usable.filter((pass) => pass.type === 'image');
      const rank = (pass) => {
        const index = BUFFER_ORDER.indexOf(keyOf(pass).replace(/^Buffer\s*/i, '').toLowerCase());
        return index === -1 ? BUFFER_ORDER.length : index;
      };
      buffers.sort((left, right) => rank(left) - rank(right));
      return buffers.concat(images).map((pass) => ({ pass, key: keyOf(pass) }));
    }

    /** Which pass key a `channel` input points at, or null when it is not a pass. */
    function inputPassKey(input) {
      if (!input || typeof input !== 'object') return null;
      const type = String(input.ctype || input.type || '').toLowerCase();
      if (type === 'buffer') {
        const index = typeof input.bufferId === 'number' ? input.bufferId : -1;
        if (index >= 0 && index < BUFFER_ORDER.length) return 'Buffer ' + BUFFER_ORDER[index].toUpperCase();
        return null;
      }
      if (type === 'keyboard') return 'Keyboard';
      return null;
    }

    /**
     * Full-screen quad renderer for one ShaderToy Image pass. Raw WebGL on purpose: the
     * page loads no third-party code, and the work is already compiled by the site, so
     * only the wrapper and the standard uniforms have to be supplied here.
     * @returns `{ canvas, setWork, dispose }`, or null when WebGL is unavailable.
     */
    /**
     * Multi-pass ShaderToy renderer.
     *
     * A work is a chain: `Buffer A`…`Buffer D` each render into an off-screen target, then
     * `Image` draws to the canvas. Passes read each other through `iChannelN`, which is an
     * input of `ctype: 'buffer'` naming the producing pass, so every buffer is allocated its
     * own framebuffer and re-bound each frame as the chain is walked in order.
     *
     * Raw WebGL on purpose: the page loads no third-party code, and the work is already
     * written by the user, so only the wrapper and the standard uniforms come from here.
     * @returns `{ canvas, setWork, dispose }`, or null when WebGL is unavailable.
     */
    function createShaderRenderer(canvas, onError) {
      const contextOptions = {
        alpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
      };
      // WebGL2 first: many works use integer math and `textureLod`, which have no ES 1.00
      // equivalent. WebGL1 is the fallback so an older browser still renders.
      let gl = null;
      let isWebgl2 = true;
      try {
        gl = canvas.getContext('webgl2', contextOptions);
      } catch (error) {
        gl = null;
      }
      if (gl === null) {
        isWebgl2 = false;
        try {
          gl = canvas.getContext('webgl', contextOptions);
        } catch (error) {
          gl = null;
        }
      }
      if (gl === null) {
        onError(bt('beautifyNoGl'));
        return null;
      }

      // `RGBA8` is the drawing-buffer format on both dialects; ES 3.00 spells it `RGBA8`,
      // ES 2.00 only takes the sized-format-through-`RGBA` form.
      if (isWebgl2) {
        const colorBuffer = gl.getExtension('EXT_color_buffer_float');
        if (colorBuffer === null) {
          // Not fatal: buffers simply stay 8-bit, which is what most works expect anyway.
        }
      }

      const state = {
        /** One entry per compiled pass: { key, program, uniforms, attrib, target }. */
        passes: [],
        imageKey: '',
        quad: null,
        frame: 0,
        start: window.performance.now(),
        raf: 0,
        disposed: false,
        /** Textures uploaded from the work's channel images, keyed by channel index. */
        channels: [],
        sizes: [],
        /** Timestamp of the last painted frame, for the frame-rate cap. 0 = paint now. */
        lastDraw: 0,
        /** Last viewport size the canvas was sized for; 0 forces the first measure. */
        viewW: 0,
        viewH: 0,
        /** Cached pass key -> entry lookup, rebuilt only when the pass list changes. */
        byKey: null,
        byKeySize: -1,
        /** Canvas box, written by the ResizeObserver; 0 until layout has run. */
        boxW: 0,
        boxH: 0,
        boxDirty: false,
        /** Wall clock before which `paintFrame` returns without touching GL. */
        pausedUntil: 0,
      };
      const mouse = { x: 0, y: 0, clickX: 0, clickY: 0, down: 0 };
      /* The canvas box is measured off the rAF path: reading it every frame forced
       * layout on the same thread that scrolls the heavy views behind the backdrop. */
      const boxObserver =
        typeof ResizeObserver === 'undefined'
          ? null
          : new ResizeObserver((entries) => {
              const box = entries[entries.length - 1].contentRect;
              state.boxW = box.width;
              state.boxH = box.height;
              state.boxDirty = true;
            });
      if (boxObserver !== null) boxObserver.observe(canvas);

      const compile = (type, source) => {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
          const log = String(gl.getShaderInfoLog(shader) || '')
            .split('\n')
            .slice(0, 2)
            .join(' ');
          gl.deleteShader(shader);
          throw new Error(log || 'compile failed');
        }
        return shader;
      };

      /** One render target: a texture plus the framebuffer that renders into it. */
      const makeTarget = () => {
        const texture = gl.createTexture();
        const framebuffer = gl.createFramebuffer();
        return { texture, framebuffer, width: 0, height: 0 };
      };

      const resizeTarget = (target, width, height) => {
        if (target.width === width && target.height === height) return;
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, target.texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.texture, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        target.width = width;
        target.height = height;
      };

      /** A 1×1 placeholder so a channel always samples something. */
      const makeTexture = () => {
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return texture;
      };

      /**
       * `iResolution` is device pixels, but capped: the display ratio stays sharp without
       * making a full-screen complex shader crawl.
       *
       * The measured box MUST be the box the CSS actually paints into. The stylesheet
       * gives the canvas `position:fixed;inset:0;width:100%;height:100%`, i.e. the
       * viewport MINUS the classic scrollbar gutter, while `window.innerWidth` /
       * `innerHeight` INCLUDE that gutter. Sizing the drawing buffer from the window
       * therefore left an unpainted strip along the right/bottom edge -- the "~20px
       * hard black band under the transcript" report, which was the root background
       * showing through, not the shader drawing a dark area. Measure the canvas itself
       * so the two can never disagree.
       */
      const resize = () => {
        const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
        const box = canvas.getBoundingClientRect();
        let width = Math.max(1, Math.round((box.width || window.innerWidth) * ratio));
        let height = Math.max(1, Math.round((box.height || window.innerHeight) * ratio));
        const pixels = width * height;
        if (pixels > shaderBudget.pixels) {
          const scale = Math.sqrt(shaderBudget.pixels / pixels);
          width = Math.max(1, Math.round(width * scale));
          height = Math.max(1, Math.round(height * scale));
        }
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
        for (const entry of state.passes) {
          if (entry.target !== null) resizeTarget(entry.target, canvas.width, canvas.height);
        }
      };

      const upload = (channel, image) => {
        if (state.disposed) return;
        const texture = state.channels[channel];
        if (!texture) return;
        gl.activeTexture(gl.TEXTURE0 + channel);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        state.sizes[channel] = [image.width, image.height];
      };

      /** Standard uniforms for one pass; `intoPass` resolves buffer channels. */
      const bindUniforms = (entry, elapsed) => {
        const u = entry.uniforms;
        if (u.iResolution) gl.uniform3f(u.iResolution, canvas.width, canvas.height, 1);
        if (u.iTime) gl.uniform1f(u.iTime, elapsed);
        /* Report the real cadence, not a hard-coded 60 Hz: shaders that integrate by
         * `iTimeDelta` (or scale motion by `iFrameRate`) would otherwise animate at the
         * wrong speed now that the backdrop is capped to SHADER_FPS. */
        if (u.iTimeDelta) gl.uniform1f(u.iTimeDelta, shaderBudget.intervalMs / 1000);
        if (u.iFrame) gl.uniform1i(u.iFrame, state.frame);
        if (u.iFrameRate) gl.uniform1f(u.iFrameRate, shaderBudget.fps);
        if (u.iMouse) gl.uniform4f(u.iMouse, mouse.x, mouse.y, mouse.clickX, mouse.down ? mouse.clickY : -mouse.clickY);
        if (u.iDate) {
          const date = new Date();
          gl.uniform4f(
            u.iDate,
            date.getFullYear(),
            date.getMonth(),
            date.getDate(),
            date.getSeconds() + date.getMinutes() * 60 + date.getHours() * 3600,
          );
        }

        // Bind every sampler to its own unit, then fill in resolution per channel.
        const flat = new Float32Array(12);
        for (let channel = 0; channel < 4; channel += 1) {
          const location = u['iChannel' + channel];
          if (location) gl.uniform1i(location, channel);
          const target = entry.channelTargets[channel];
          const external = state.sizes[channel];
          if (target && target.width > 0) {
            flat[channel * 3] = target.width;
            flat[channel * 3 + 1] = target.height;
          } else if (external) {
            flat[channel * 3] = external[0];
            flat[channel * 3 + 1] = external[1];
          } else {
            flat[channel * 3] = 1;
            flat[channel * 3 + 1] = 1;
          }
          flat[channel * 3 + 2] = 1;
        }
        if (u.iChannelResolution) gl.uniform3fv(u.iChannelResolution, flat);
      };

      /** Bind each channel to either a buffer target or an uploaded image. */
      const bindChannels = (entry) => {
        for (let channel = 0; channel < 4; channel += 1) {
          gl.activeTexture(gl.TEXTURE0 + channel);
          const target = entry.channelTargets[channel];
          if (target) {
            gl.bindTexture(gl.TEXTURE_2D, target.texture);
          } else if (state.channels[channel]) {
            gl.bindTexture(gl.TEXTURE_2D, state.channels[channel]);
          }
        }
      };

      const draw = (now) => {
        if (state.disposed) return;
        state.raf = window.requestAnimationFrame(draw);

        /* An exception anywhere below would end the rAF chain and freeze the backdrop
         * on its last frame with no visible error, so every frame is guarded and the
         * first failure is surfaced instead of the loop dying silently. */
        try {
          paintFrame(now);
        } catch (error) {
          state.frameErrors = (state.frameErrors || 0) + 1;
          if (state.frameErrors === 1 || state.frameErrors % 300 === 0) {
            onError(String((error && error.message) || error));
          }
        }
      };

      const paintFrame = (now) => {
        /* Frame-rate cap. Every perf tier targets 60 fps, so this gate only exists to
         * stop a 120/144 Hz panel from redrawing the backdrop faster than the eye
         * needs; the cost lever is render resolution, not cadence.
         *
         * `state.lastDraw` starts at 0 so the first frame always paints. */
        /* 2 ms of slack: rAF timestamps on a 60 Hz panel land a hair under
         * 16.67 ms apart, and a strict comparison would then skip every second
         * frame and halve the backdrop to 30 fps. */
        if (now - state.lastDraw < shaderBudget.intervalMs - 2) return;
        state.lastDraw = now;
        /* A scroll is in progress: the backdrop is behind an opaque moving view anyway,
         * and skip-and-hold costs nothing while it frees the frame for the list. */
        if (now < state.pausedUntil) return;

        /* Tab in the background: skip the whole render. Nothing is visible, and this is
         * the single biggest saving when the window is minimised or covered. */
        if (document.visibilityState === 'hidden') return;

        /* Only re-measure when the painted box actually changed. `resize()` reallocates
         * every render target, so running it on every frame was pure waste -- but the
         * trigger has to be the canvas box, not the window: a scrollbar appearing or the
         * right panel collapsing changes the former without touching the latter, and
         * that is precisely the case that used to leave an unpainted strip.
         *
         * A 0x0 box means layout has not run yet. Storing it here would leave `viewW`
         * permanently at 0 and force a realloc every single frame, which reads as the
         * backdrop flickering black. Skip until the box is real. */
        if (state.boxW > 0 && state.boxH > 0 && (state.boxW !== state.viewW || state.boxH !== state.viewH || state.boxDirty)) {
          state.viewW = state.boxW;
          state.viewH = state.boxH;
          state.boxDirty = false;
          resize();
        }
        if (state.passes.length === 0) return;
        const elapsed = (now - state.start) / 1000;

        /* The key -> pass map only changes when the pass list is rebuilt, so cache it
         * instead of allocating a Map on every frame. */
        if (state.byKey === null || state.byKeySize !== state.passes.length) {
          state.byKey = new Map(state.passes.map((entry) => [entry.key, entry]));
          state.byKeySize = state.passes.length;
        }
        const byKey = state.byKey;

        for (const entry of state.passes) {
          // Resolve this pass's buffer inputs against the targets produced earlier.
          entry.channelTargets = [null, null, null, null];
          for (const input of entry.inputs) {
            const channel = Number(input.channel);
            if (!(channel >= 0 && channel <= 3)) continue;
            const key = inputPassKey(input);
            if (key === null) continue;
            const source = byKey.get(key);
            if (source && source.target !== null && source !== entry) {
              entry.channelTargets[channel] = source.target;
            }
          }

          gl.useProgram(entry.program);
          if (entry.target !== null) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, entry.target.framebuffer);
            gl.viewport(0, 0, canvas.width, canvas.height);
          } else {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, canvas.width, canvas.height);
          }
          bindChannels(entry);
          bindUniforms(entry, elapsed);
          gl.bindBuffer(gl.ARRAY_BUFFER, state.quad);
          gl.enableVertexAttribArray(entry.attrib);
          gl.vertexAttribPointer(entry.attrib, 2, gl.FLOAT, false, 0, 0);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        state.frame += 1;
      };

      const onMove = (event) => {
        const width = state.viewW || 1;
        const height = state.viewH || 1;
        const scaleX = canvas.width / Math.max(1, width);
        const scaleY = canvas.height / Math.max(1, height);
        mouse.x = event.clientX * scaleX;
        mouse.y = (height - event.clientY) * scaleY;
      };
      const onDown = (event) => {
        onMove(event);
        mouse.clickX = mouse.x;
        mouse.clickY = mouse.y;
        mouse.down = 1;
      };
      const onUp = () => {
        mouse.down = 0;
      };
      window.addEventListener('pointermove', onMove, { passive: true });
      window.addEventListener('pointerdown', onDown, { passive: true });
      window.addEventListener('pointerup', onUp, { passive: true });
      /* Capture on `window` sees scrolls from every nested scroller; the handler only
       * writes a timestamp, so it is free even at one event per frame. */
      const onScroll = () => {
        state.pausedUntil = window.performance.now() + SHADER_SCROLL_PAUSE_MS;
      };
      window.addEventListener('scroll', onScroll, { capture: true, passive: true });

      const releasePasses = () => {
        for (const entry of state.passes) {
          if (entry.program) gl.deleteProgram(entry.program);
          if (entry.target !== null) {
            gl.deleteFramebuffer(entry.target.framebuffer);
            gl.deleteTexture(entry.target.texture);
          }
        }
        state.passes = [];
      };

      const setWork = (payload, textures) => {
        const ordered = orderedPassesOfWork(payload);
        if (ordered.length === 0) {
          onError(bt('beautifyNoPass'));
          return false;
        }
        const hasImage = ordered.some((item) => item.pass.type === 'image');
        if (!hasImage) {
          onError(bt('beautifyNoPass'));
          return false;
        }

        // Compile everything before touching the live state, so a failed edit keeps the
        // previous frame on screen instead of going black.
        const built = [];
        try {
          for (const item of ordered) {
            const vertex = compile(gl.VERTEX_SHADER, shaderVertexSource(isWebgl2));
            const fragment = compile(gl.FRAGMENT_SHADER, buildFragmentSource(item.pass, payload, isWebgl2));
            const program = gl.createProgram();
            gl.attachShader(program, vertex);
            gl.attachShader(program, fragment);
            gl.linkProgram(program);
            gl.deleteShader(vertex);
            gl.deleteShader(fragment);
            if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
              const log = String(gl.getProgramInfoLog(program) || 'link failed');
              gl.deleteProgram(program);
              throw new Error(log.slice(0, 160));
            }
            const uniforms = {};
            for (const name of [
              'iResolution',
              'iTime',
              'iTimeDelta',
              'iFrame',
              'iFrameRate',
              'iMouse',
              'iDate',
              'iChannel0',
              'iChannel1',
              'iChannel2',
              'iChannel3',
            ]) {
              uniforms[name] = gl.getUniformLocation(program, name);
            }
            uniforms.iChannelResolution = gl.getUniformLocation(program, 'iChannelResolution[0]');
            const attrib = gl.getAttribLocation(program, 'aPos');
            built.push({
              key: item.key,
              type: item.pass.type,
              program,
              uniforms,
              attrib,
              inputs: Array.isArray(item.pass.inputs) ? item.pass.inputs : [],
              // Buffers render into a target; only the Image pass draws to the canvas.
              target: item.pass.type === 'image' ? null : makeTarget(),
              channelTargets: [null, null, null, null],
            });
          }
        } catch (error) {
          for (const entry of built) {
            gl.deleteProgram(entry.program);
            if (entry.target !== null) {
              gl.deleteFramebuffer(entry.target.framebuffer);
              gl.deleteTexture(entry.target.texture);
            }
          }
          // Functions that only exist in ES 3.00 are the usual reason a valid work fails
          // here, so name that cause rather than showing the raw shader log.
          const detail = String((error && error.message) || error);
          if (!isWebgl2 && ES3_ONLY.test(detail)) {
            onError(bt('beautifyNeedGl2'));
          } else {
            onError(fill(bt('beautifyCompile'), { log: detail.slice(0, 180) }));
          }
          return false;
        }

        releasePasses();
        state.passes = built;
        state.imageKey = (built.find((entry) => entry.type === 'image') || {}).key || '';

        if (state.quad === null) {
          state.quad = gl.createBuffer();
          gl.bindBuffer(gl.ARRAY_BUFFER, state.quad);
          gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        }

        // Channel images: only channels not owned by a buffer pass need an upload.
        for (let channel = 0; channel < 4; channel += 1) {
          if (state.channels[channel]) gl.deleteTexture(state.channels[channel]);
          state.channels[channel] = makeTexture();
          state.sizes[channel] = [1, 1];
        }
        const map = textures && typeof textures === 'object' ? textures : {};
        for (const item of ordered) {
          for (const input of Array.isArray(item.pass.inputs) ? item.pass.inputs : []) {
            if (!input || typeof input !== 'object') continue;
            if (inputPassKey(input) !== null) continue;
            const channel = Number(input.channel);
            if (!(channel >= 0 && channel <= 3)) continue;
            const url = map[input.filepath];
            if (typeof url !== 'string') continue;
            const image = new Image();
            image.onload = () => upload(channel, image);
            image.src = url;
          }
        }

        resize();
        state.start = window.performance.now();
        state.frame = 0;
        /* The pass list was rebuilt: drop the cached lookup so it is regenerated,
         * and clear the frame gate so the new material paints immediately instead of
         * waiting out the previous frame's interval. */
        state.byKey = null;
        state.byKeySize = -1;
        state.lastDraw = 0;
        /* Paint one frame synchronously. The animation is driven by rAF, which is
         * throttled or suspended in a hidden or backgrounded tab; the backdrop must
         * still show its static first frame there. Without this the canvas stayed
         * black with a correctly compiled program until the tab was next visible. */
        try {
          paintFrame(window.performance.now());
        } catch (error) {
          onError(String((error && error.message) || error));
        }
        return true;
      };

      const dispose = () => {
        if (state.disposed) return;
        state.disposed = true;
        if (state.raf) window.cancelAnimationFrame(state.raf);
        state.raf = 0;
        if (boxObserver !== null) boxObserver.disconnect();
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerdown', onDown);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('scroll', onScroll, { capture: true });
        try {
          if (state.quad) gl.deleteBuffer(state.quad);
          for (const texture of state.channels) if (texture) gl.deleteTexture(texture);
          releasePasses();
        } catch (error) {
          /* context already gone */
        }
        const lose = gl.getExtension('WEBGL_lose_context');
        if (lose !== null) {
          try {
            lose.loseContext();
          } catch (error) {
            /* already lost */
          }
        }
        state.quad = null;
        state.channels = [];
      };

      state.raf = window.requestAnimationFrame(draw);
      return { canvas, setWork, dispose, isWebgl2 };
    }

    let beautifyShader = null;
    let beautifyShaderKey = '';
    let beautifyFetchToken = 0;
    let beautifyRootPatched = null;


    /**
     * The work currently being edited, in the same shape the site returns.
     *
     * Fetching used to hand the payload straight to the renderer, which left the panel with
     * nothing to show and no way to change the code it had just downloaded: the online
     * works were read-only by construction. The payload now lands here first, so a fetched
     * work becomes an ordinary editable definition and the fetch is simply how the text
     * arrives. `shaderWorkId` records which work the text came from, so the panel can
     * prefill the id field and a refetch stays possible.
     */
    let shaderWork = null;
    /** Id of the work in `shaderWork`, or '' for code the user typed. */
    let shaderWorkId = '';
    /**
     * Channel images of the fetched work, kept across code edits. Without this an edit would
     * blank every `iChannelN`, which is exactly the case the user hit with the two-image
     * work: the code compiled but sampled nothing.
     */
    let shaderTextures = {};

    /**
     * The edited work lives outside `beautifyStore` on purpose: that store is persisted on
     * every change, and a work carries tens of kilobytes of code that would be rewritten to
     * localStorage on each keystroke. This store only has to make the panel repaint.
     */
    const shaderWorkStore = (() => {
      const listeners = new Set();
      const emit = () => {
        for (const listener of Array.from(listeners)) listener();
      };
      return {
        set(next, id) {
          shaderWork = next;
          if (id !== undefined) shaderWorkId = id;
          // Written here rather than at each call site: every path that changes the
          // work goes through this one function, so persistence cannot be forgotten.
          writeShaderWork(shaderWork, shaderWorkId);
          emit();
        },
        touch() {
          emit();
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      };
    })();

    /* Restored before anything reads the state, so the first render already has a
     * backdrop instead of flashing the fallback and then swapping to the work. */
    {
      const restored = readShaderWork();
      if (restored !== null) {
        shaderWork = restored.work;
        shaderWorkId = restored.id;
      }
    }

    const copyWork = (payload) => {
      if (payload === null || typeof payload !== 'object') return null;
      try {
        return JSON.parse(JSON.stringify(payload));
      } catch (error) {
        return null;
      }
    };

    /** The single Image pass this client renders, or null when the work has none. */
    function imagePassOfWork(work) {
      if (work === null || typeof work !== 'object') return null;
      const passes = Array.isArray(work.renderpass)
        ? work.renderpass
        : Array.isArray(work.Shader && work.Shader.renderpass)
          ? work.Shader.renderpass
          : [];
      const images = passes.filter((pass) => pass && pass.type === 'image' && typeof pass.code === 'string');
      if (images.length > 0) return images[images.length - 1];
      return passes.find((pass) => pass && typeof pass.code === 'string') || null;
    }

    function backgroundLayer() {
      if (!document.body) return null;
      let node = document.getElementById(BEAUTIFY_BG_ID);
      if (node === null) {
        node = document.createElement('div');
        node.id = BEAUTIFY_BG_ID;
        node.setAttribute('aria-hidden', 'true');
        document.body.appendChild(node);
      }
      /* Paint order for a `position:fixed` sibling and a static app root in the same
       * stacking context is DOM order. Appended last, the backdrop would sit ON TOP of
       * the app and the glass would blur its own backdrop. Keep it first. */
      if (document.body.firstElementChild !== node) {
        document.body.insertBefore(node, document.body.firstElementChild || null);
      }
      /* The single blur for the whole window lives here. Appended last, it sits above
       * the background canvas (which is `z-index:-1`) and below the app. */
      if (node.querySelector('[data-ue-glass-layer]') === null) {
        const glass = document.createElement('div');
        glass.setAttribute('data-ue-glass-layer', '');
        glass.setAttribute('aria-hidden', 'true');
        node.appendChild(glass);
      }
      return node;
    }

    function stopShaderLayer() {
      beautifyFetchToken += 1;
      beautifyShaderKey = '';
      if (beautifyShader === null) return;
      const canvas = beautifyShader.canvas;
      try {
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      } catch (error) {
        /* already detached */
      }
      beautifyShader.dispose();
      beautifyShader = null;
    }

    function clearBackgroundLayer() {
      stopShaderLayer();
      const node = document.getElementById(BEAUTIFY_BG_ID);
      if (node !== null && node.parentNode) node.parentNode.removeChild(node);
    }

    /**
     * The shipped shell paints its own opaque background, which would hide a layer drawn
     * behind it. Clear only the app root's background colour and hand it back on disable.
     */
    function patchAppRoot(on) {
      if (on) {
        const root = document.body
          ? Array.from(document.body.children).find((child) => child.id !== BEAUTIFY_BG_ID)
          : null;
        if (!root) return;
        if (beautifyRootPatched !== null && beautifyRootPatched.node !== root) restoreAppRoot();
        if (beautifyRootPatched === null) {
          beautifyRootPatched = { node: root, background: root.style.backgroundColor };
          root.style.backgroundColor = 'transparent';
        }
        return;
      }
      restoreAppRoot();
    }

    function restoreAppRoot() {
      if (beautifyRootPatched === null) return;
      try {
        beautifyRootPatched.node.style.backgroundColor = beautifyRootPatched.background;
      } catch (error) {
        /* the node may be gone */
      }
      beautifyRootPatched = null;
    }

    /**
     * The three panes, found by the layout bundle's own class names.
     *
     * The layout plugin emits hashed CSS-module classes (`_sidebarCol`, `_centerCol`,
     * `_rightbarCol` with a per-build prefix), but the suffix is stable and matches
     * exactly the three columns that should be frosted. Matching on the suffix with
     * `[class*="_sidebarCol"]` survives the hash changing between builds.
     *
     * This replaced a purely structural guess that walked up from the composer card:
     * when the walk missed, the glass list came back empty and Beautify silently did
     * nothing -- which is the reported "no frosted background".
     */
    /* Derived from the single list above so the two can never drift apart again. */
    const PANE_SELECTOR = PANE_SELECTORS.join(',');

    function paneNodesBySelector() {
      const found = [];
      for (const node of Array.from(document.querySelectorAll(PANE_SELECTOR))) {
        // The layout also renders a `_leadingSeat`/handle inside the frame; only take
        // nodes that are actually laid out as columns.
        if (!(node instanceof HTMLElement)) continue;
        const rect = node.getBoundingClientRect();
        if (rect.height < window.innerHeight * 0.4) continue;
        if (rect.width < 40) continue;
        found.push(node);
      }
      return found;
    }

    /**
     * Every pane the layout currently renders, keyed by ROLE rather than by count.
     *
     * The previous version bailed out as soon as two panes were found, so a collapsed
     * or narrow right sidebar (the width filter above drops anything under 40px) made
     * the whole selector path return early with only the left and centre columns --
     * which is why the right card kept its square corners while the other two were
     * rounded. Matching each role independently means a pane that exists is always
     * decorated, regardless of how many of its siblings are present.
     *
     * `querySelectorAll` (not `querySelector`) because the layout can render the same
     * column class at more than one nesting level; the outer, laid-out one wins.
     */
    function panesByRole() {
      const roles = ['_sidebarCol', '_centerCol', '_rightbarCol'];
      const out = [];
      for (const role of roles) {
        for (const node of Array.from(document.querySelectorAll('[class*="' + role + '"]'))) {
          if (!(node instanceof HTMLElement)) continue;
          const rect = node.getBoundingClientRect();
          if (rect.width < 2 || rect.height < window.innerHeight * 0.4) continue;
          out.push(node);
          break;
        }
      }
      return out;
    }

    /**
     * The three panes have no public class name this bundle can rely on, so they are found
     * structurally: the composer card's ancestor whose box covers most of the viewport and
     * whose parent lays out two to four full-height columns.
     * ponytail: structural guess, not a public selector — a harness restyle degrades to
     * "no glass", never to a broken layout.
     */
    function detectPanes() {
      /* Role-based lookup first: it finds panes even when a sibling is collapsed, and it
       * never mistakes an overlay for a column. */
      const byRole = panesByRole();
      if (byRole.length >= 2) return byRole;
      const bySelector = paneNodesBySelector();
      if (bySelector.length >= 2) return bySelector;
      const card = document.querySelector('[data-composer-card]');
      if (!card) return [];
      let node = card;
      for (let depth = 0; node !== null && depth < 14; depth += 1) {
        const parent = node.parentElement;
        if (parent === null || parent === document.body) break;
        const box = parent.getBoundingClientRect();
        // Full-height columns are what separates the shell row from the stacked
        // header/transcript/composer wrappers inside the centre pane.
        if (box.width >= window.innerWidth * 0.7 && box.height >= window.innerHeight * 0.85) {
          const kids = Array.from(parent.children).filter((child) => {
            // Overlays are full-viewport but not columns: a fixed/absolute or
            // pointer-events:none child must never get a backdrop-filter container.
            const style = window.getComputedStyle(child);
            if (style.position === 'fixed' || style.position === 'absolute') return false;
            if (style.pointerEvents === 'none') return false;
            const rect = child.getBoundingClientRect();
            // Glass is a pane effect. A child spanning nearly the whole
            // viewport WIDTH is the main content area, not a side pane — and
            // blurring that fogs the entire screen. Panes are normally
            // full-height columns, so height alone must never disqualify one.
            if (rect.width >= window.innerWidth * 0.62) return false;
            return rect.width >= 80 && rect.height >= window.innerHeight * 0.5;
          });
          if (kids.length >= 2 && kids.length <= 4) return kids;
        }
        node = parent;
      }
      return [];
    }

    function applyGlass(targets) {
      for (const node of Array.from(document.querySelectorAll('[' + GLASS_ATTR + ']'))) {
        if (!targets.includes(node)) node.removeAttribute(GLASS_ATTR);
      }
      for (const node of targets) {
        // Last guard before the blur lands: never fog a box that fills the whole
        // viewport (an overlay or the shell root), because blurring that fogs the
        // entire window. The centre column is legitimately wide -- on a narrow window
        // it can exceed 62% -- and it is a pane like the other two, so a full-width
        // test is what we want here, not a "wider than most of the screen" test.
        const rect = node.getBoundingClientRect();
        if (rect.width >= window.innerWidth * 0.94 && rect.height >= window.innerHeight * 0.94) {
          node.removeAttribute(GLASS_ATTR);
          continue;
        }
        node.setAttribute(GLASS_ATTR, '');
      }
    }

    async function loadShaderWork(rawId, force) {
      const id = parseShaderId(rawId);
      /* Only a missing id is fatal here.
       *
       * This used to also bail out when `beautifyShader === null` -- correct while the
       * renderer was the only caller, but the panel's 拉取并保存 calls this directly,
       * so a pull started from solid or image mode returned before any status line was
       * written and before anything was stored. The work is stored unconditionally
       * below; only DRAWING it needs a renderer. */
      if (id === '') {
        shaderStatus.set(bt('beautifyShaderNoId'), 'warn');
        return;
      }
      /* The key is claimed only AFTER a work is actually on screen (see the success
       * paths below). Claiming it up front meant a failed fetch left `beautifyShaderKey
       * === id` with no shader drawn, so every later `syncBeautifyDom` pass concluded
       * "already loaded" and never retried: one transient Host/challenge failure pinned
       * the backdrop to the solid colour for the rest of the page's life. */
      /* The renderer only exists once the backdrop is in shader mode, but a pull can
       * start from the panel while the backdrop is still solid or on an image. This
       * used to bail out here, so "拉取并保存" downloaded the work, then dropped it
       * without storing anything: the name field cleared and no preset appeared.
       * The work is now persisted first and drawn by whichever sync pass runs after
       * the mode switch, which reads it back synchronously from `shaderWork`. */
      const token = (beautifyFetchToken += 1);
      shaderStatus.set(bt('beautifyShaderFetching'), 'info');
      let body = null;
      try {
        const response = await fetch(
          SHADERTOY_URL + '?id=' + encodeURIComponent(id) + (force ? '&force=1' : ''),
          { cache: 'no-store', signal: AbortSignal.timeout(SHADER_FETCH_TIMEOUT_MS) },
        );
        body = await response.json().catch(() => null);
        if (response.ok !== true || body === null || body.ok !== true) {
          throw new Error(fill(bt('beautifyShaderHttp'), { status: String(response.status) }));
        }
      } catch (error) {
        if (token === beautifyFetchToken) shaderStatus.set(String((error && error.message) || error), 'warn');
        return;
      }
      if (token !== beautifyFetchToken) return;
      // The downloaded work becomes the editable definition first, so the code panel shows
      // it and the renderer is fed from that same object. From here on a fetched work is
      // indistinguishable from code the user typed.
      const work = copyWork(body.shader);
      if (work === null) {
        shaderStatus.set(bt('beautifyShaderBadWork'), 'warn');
        return;
      }
      // Textures are kept so that editing the code does not lose the images it samples.
      shaderTextures = body.textures && typeof body.textures === 'object' ? body.textures : {};
      shaderWorkStore.set(work, id);
      /* No renderer means the backdrop is not painting shaders yet. The work is stored
       * and the success is reported; `syncBeautifyDom` lays it down as soon as the mode
       * switch creates the canvas. */
      if (beautifyShader === null) {
        shaderStatus.set(bt('beautifyShaderRendered'), 'ok');
        return;
      }
      if (!beautifyShader.setWork(work, shaderTextures)) return;
      // Only now is this work genuinely on screen, so only now is the key claimed.
      beautifyShaderKey = id;
      const count = Object.keys(shaderTextures).length;
      shaderStatus.set(
        count > 0 ? fill(bt('beautifyShaderRenderedTex'), { count: String(count) }) : bt('beautifyShaderRendered'),
        'ok',
      );
    }

    /**
     * Recompile the edited code and hand it to the running background.
     *
     * This is the second half of merging the online and local panels: after a fetch the code
     * sits in `shaderWork`, the editor writes back into it, and this pushes the result to the
     * same renderer, so an online work and a hand-written one take exactly one path. The
     * textures from the last fetch stay bound so the images survive an edit.
     * @param {string} code Image-pass source the editor currently holds.
     */
    function applyShaderCode(code) {
      if (beautifyShader === null) {
        // No canvas yet means the background is not in shader mode; nothing to draw into.
        shaderStatus.set(bt('beautifyShaderNoLayer'), 'warn');
        return false;
      }
      const work = shaderWork === null ? { info: {}, renderpass: [] } : copyWork(shaderWork);
      if (work === null) return false;
      if (!Array.isArray(work.renderpass)) work.renderpass = [];
      let pass = imagePassOfWork(work);
      if (pass === null) {
        pass = { type: 'image', name: 'Image', inputs: [], code: '' };
        work.renderpass.push(pass);
      }
      pass.code = String(code);
      shaderWorkStore.set(work, shaderWorkId);
      if (!beautifyShader.setWork(work, shaderTextures)) {
        // `setWork` reports its own compile error to `shaderStatus`; stop here so the panel
        // does not overwrite the line that says what is actually wrong.
        return false;
      }
      const count = Object.keys(shaderTextures).length;
      shaderStatus.set(
        count > 0 ? fill(bt('beautifyShaderRenderedTex'), { count: String(count) }) : bt('beautifyShaderRendered'),
        'ok',
      );
      return true;
    }

    /** Apply one full state object to the page; idempotent, so the store can call it freely. */
    function syncBeautifyDom(state) {
      if (!document.documentElement) return;
      const root = document.documentElement;
      const on = state.on !== false;
      root.classList.toggle(BEAUTIFY_CLASS, on);
      root.style.setProperty('--ue-glass-blur', state.glassBlur + 'px');
      root.style.setProperty('--ue-glass-alpha', String(state.glassAlpha));
      /* Publish the shader budget before anything renders: the resize/frame caps
       * read it, so changing the tier takes effect on the next frame without
       * rebuilding the GL context. */
      applyPerfBudget(state);
      patchAppRoot(on);

      if (!on) {
        applyGlass([]);
        clearBackgroundLayer();
        return;
      }

      applyGlass(detectPanes());
      const layer = backgroundLayer();
      if (layer === null) return;

      if (state.mode === 'shader') {
        layer.style.backgroundImage = 'none';
        layer.style.backgroundColor = state.solid || BEAUTIFY_DEFAULTS.solid;
        const wanted = parseShaderId(state.shaderId);
        if (wanted === '') {
          stopShaderLayer();
          shaderStatus.set(bt('beautifyShaderNoId'), 'info');
          return;
        }
        if (beautifyShader === null) {
          const canvas = document.createElement('canvas');
          canvas.setAttribute('aria-hidden', 'true');
          layer.appendChild(canvas);
          beautifyShader = createShaderRenderer(canvas, (message) => shaderStatus.set(message, 'warn'));
          if (beautifyShader === null) {
            canvas.remove();
            return;
          }
        }
        /* Paint the persisted work FIRST, before any network round trip.
         *
         * The backdrop's only source used to be `loadShaderWork`, which is an HTTP call
         * that drives a real browser through ShaderToy's challenge on the Host. When that
         * call failed -- challenge, timeout, no browser, rate limit -- this function
         * returned with nothing drawn, so the window sat on the flat solid colour and the
         * ShaderToy backdrop looked "broken" even though the work was stored in
         * localStorage the whole time. The work is small and already on disk, so it is
         * laid down synchronously here; the fetch below then only REFRESHES it.
         *
         * The in-memory copy is not trusted alone: a pull can store a work and switch the
         * mode in the same tick, before any re-render hands this function the updated
         * `shaderWork`. Reading storage back closes that window, so a freshly pulled work
         * paints on the first pass instead of triggering a second redundant fetch. */
        const stored = shaderWork !== null && shaderWorkId === wanted ? { id: wanted, work: shaderWork } : readShaderWork();
        if (beautifyShaderKey !== wanted && stored !== null && stored.id === wanted) {
          if (beautifyShader.setWork(shaderWork !== null && shaderWorkId === wanted ? shaderWork : stored.work, shaderTextures) === true) {
            beautifyShaderKey = wanted;
            shaderStatus.set(
              Object.keys(shaderTextures).length > 0
                ? fill(bt('beautifyShaderRenderedTex'), { count: String(Object.keys(shaderTextures).length) })
                : bt('beautifyShaderRendered'),
              'ok',
            );
            return;
          }
          /* A stored work that no longer compiles (or that the renderer rejects) must not
           * pin the layer: fall through to the fetch, which replaces it. */
          beautifyShaderKey = '';
        }
        if (beautifyShaderKey !== wanted) void loadShaderWork(wanted, false);
        return;
      }

      stopShaderLayer();
      for (const canvas of Array.from(layer.querySelectorAll('canvas'))) canvas.remove();
      layer.style.backgroundColor = state.solid || BEAUTIFY_DEFAULTS.solid;
      layer.style.backgroundImage =
        state.mode === 'image' && state.image !== ''
          ? 'url("' + String(state.image).replace(/"/g, '%22') + '")'
          : 'none';
    }

    /* -------------------------------------------------------------------------
     * Window mode: tagging and motion.
     *
     * Tags are written through `setIfChanged`, so a repeated pass costs a read and
     * no mutation. That property is what keeps this safe to run on a timer while the
     * transcript streams: an unchanged pass produces zero DOM mutations, so nothing
     * downstream can be woken by it.
     *
     * No MutationObserver watches document.body here. The shipped shell re-renders
     * the Session list constantly, and a body-scoped observer reacting to that is
     * exactly the loop that once froze this UI. A coalesced rAF poll costs one
     * querySelectorAll per frame at most, and only while the window is visible.
     * ----------------------------------------------------------------------- */

    /** Write an attribute/class only when it differs; returns true when it wrote. */
    function setIfChanged(node, key, value) {
      if (node.getAttribute(key) === value) return false;
      node.setAttribute(key, value);
      return true;
    }

    function toggleClassIfChanged(node, name, want) {
      const has = node.classList.contains(name);
      if (has === want) return false;
      node.classList.toggle(name, want);
      return true;
    }

    /** Point the `--ue-win-*` custom properties at the current state. */
    function applyWindowVars(state) {
      const root = document.documentElement;
      if (!root || !root.style) return;
      const set = (name, value) => {
        if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value);
      };
      set('--ue-win-radius', String(state.radius) + 'px');
      set('--ue-win-gap', String(state.gap) + 'px');
      set('--ue-win-blur', String(state.blur) + 'px');
      set('--ue-win-alpha', String(state.alpha) + '%');
      set('--ue-win-sheen', String(state.sheen));
      /* A bare NUMBER, not a colour: every consumer interpolates it inside its own
       * `rgba(255,255,255,calc(... * var(--ue-win-border) ...))`, so handing over a
       * complete `rgba()` made each of those `calc()` expressions invalid. An invalid
       * value drops the whole declaration, which silently cost the panes their
       * borders, their radius and their shadow -- the glass read as a flat opaque
       * rectangle. */
      set('--ue-win-border', String(state.border));
      set('--ue-ds-blue', DS_BLUE);
    }

    /**
     * The hover slider: one absolutely-positioned block that lives next to the row
     * list and is moved with `transform`, so the highlight travels between rows
     * instead of flickering off in one place and on in another.
     *
     * It is inserted once and then only moved. If the shipped list re-renders and
     * drops it, the next pass re-inserts it — that is a single node insertion on a
     * changed pass, not per frame.
     */
    let windowSlider = null;
    let sliderHost = null;

    function ensureSlider(host) {
      if (host === null) {
        if (windowSlider !== null && windowSlider.parentNode) windowSlider.parentNode.removeChild(windowSlider);
        if (sliderHost !== null) sliderHost.classList.remove('ue-slider-host');
        windowSlider = null;
        sliderHost = null;
        return null;
      }
      if (windowSlider !== null && windowSlider.parentNode === host) return windowSlider;
      if (windowSlider !== null && windowSlider.parentNode) windowSlider.parentNode.removeChild(windowSlider);
      if (sliderHost !== null && sliderHost !== host) sliderHost.classList.remove('ue-slider-host');
      // The host needs to be the positioning context for the absolute block. It is
      // marked with a class rather than an inline style so the rule lives in the
      // stylesheet with the rest of the window mode and is undone by removing the class.
      if (toggleClassIfChanged(host, 'ue-slider-host', true)) {
        /* counted by the caller through its own pass */
      }
      const node = document.createElement('div');
      node.className = 'ue-hover-slider';
      node.setAttribute('data-on', 'false');
      host.appendChild(node);
      windowSlider = node;
      sliderHost = host;
      return node;
    }

    /**
     * One tagging pass. Returns the number of nodes it changed, so the caller can
     * decide whether another frame is needed (it is not: a zero result is stable).
     */
    function syncWindowDom(state) {
      if (!document.documentElement) return 0;
      const root = document.documentElement;
      const on = state.on !== false;
      let changed = 0;

      if (toggleClassIfChanged(root, WINDOW_CLASS, on)) changed += 1;
      if (!on) {
        // Leave the page as the shipped UI renders it: strip every tag this mode added.
        for (const node of Array.from(document.querySelectorAll('.ue-col,.ue-frame,.ue-divider,.ue-session-row,.ue-slider-host'))) {
          if (node.classList.contains('ue-slider-host')) node.classList.remove('ue-slider-host');
          if (node.classList.contains('ue-col')) node.classList.remove('ue-col');
          if (node.classList.contains('ue-frame')) node.classList.remove('ue-frame');
          if (node.classList.contains('ue-divider')) node.classList.remove('ue-divider');
          if (node.classList.contains('ue-session-row')) {
            node.classList.remove('ue-session-row');
            node.classList.remove('ue-session-current');
            node.removeAttribute('data-ue-hover');
          }
          changed += 1;
        }
        ensureSlider(null);
        return changed;
      }

      applyWindowVars(state);


      // Columns and the frame they sit in.
      const frame = document.querySelector(WINDOW_FRAME_SELECTOR);
      if (frame !== null && toggleClassIfChanged(frame, 'ue-frame', true)) changed += 1;
      for (const col of Array.from(document.querySelectorAll(WINDOW_COL_SELECTOR))) {
        if (toggleClassIfChanged(col, 'ue-col', true)) changed += 1;
      }
      for (const divider of Array.from(document.querySelectorAll(WINDOW_DIVIDER_SELECTOR))) {
        if (toggleClassIfChanged(divider, 'ue-divider', true)) changed += 1;
      }

      // Session rows: tag the row, mark the current one, and record its box so the
      // slider can be aligned with it on the next hover.
      const rows = Array.from(document.querySelectorAll(WINDOW_ROW_SELECTOR));
      for (const row of rows) {
        if (toggleClassIfChanged(row, 'ue-session-row', true)) changed += 1;
        const current = Array.from(row.classList).some((name) => name.indexOf(WINDOW_ROW_CURRENT) >= 0);
        if (toggleClassIfChanged(row, 'ue-session-current', current)) changed += 1;
      }

      // The slider host is the row list's own container, so it scrolls with the rows.
      const first = rows[0];
      const host = first !== undefined ? first.parentElement : null;
      ensureSlider(host);
      return changed;
    }

    /**
     * Hover tracking for the slider. Delegated at the document level so it survives
     * the shipped list re-rendering rows underneath it, and so no listener is ever
     * added to a row that will be thrown away.
     *
     * The block TRAVELS between rows. The one thing that makes it read as a slide
     * rather than a blink is that it is never switched off while the pointer is still
     * inside the list: moving from row A to row B only changes its transform, and the
     * CSS transition carries it across the gap. It retires only when the pointer
     * leaves the row list altogether.
     */
    function installWindowMotion() {
      if (typeof document === 'undefined') return () => {};
      let lastRow = null;

      const sliderHome = (row) => {
        // The list container is the slider's positioning context. When rows are
        // indented under a workspace header the nearest positioned ancestor may be
        // several levels up, so walk to the element the slider is actually parented to.
        let node = row.parentElement;
        for (let depth = 0; node !== null && depth < 6; depth += 1) {
          if (windowSlider !== null && windowSlider.parentNode === node) return node;
          node = node.parentElement;
        }
        return row.parentElement;
      };

      const place = (row) => {
        const slider = windowSlider;
        if (!slider || !row) return;
        const listHost = slider.parentNode;
        if (!listHost) return;
        const box = row.getBoundingClientRect();
        const parentBox = listHost.getBoundingClientRect();
        // Both rects are viewport-relative, so their difference is already the offset
        // inside the host. Adding scrollTop here (as an earlier version did) shifted the
        // block by the scroll distance and put it on the wrong row.
        const x = Math.round(box.left - parentBox.left + listHost.scrollLeft);
        const y = Math.round(box.top - parentBox.top + listHost.scrollTop);
        const w = Math.round(box.width);
        const h = Math.round(box.height);
        slider.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
        slider.style.width = w + 'px';
        slider.style.height = h + 'px';
        // A leftover outro mark from the previous visit would suppress the slide-in.
        if (slider.getAttribute('data-out') === 'true') slider.removeAttribute('data-out');
        if (slider.getAttribute('data-on') !== 'true') slider.setAttribute('data-on', 'true');
        // The row the block really sits behind wears the current row's colouring. Written
        // from this pass, not from CSS, because only this pass knows whether the block has
        // actually travelled to that row.
        if (lastRow !== null && lastRow !== row) lastRow.removeAttribute('data-ue-hover');
        if (row.getAttribute('data-ue-hover') === null) row.setAttribute('data-ue-hover', '');
      };

      const retire = () => {
        if (windowSlider === null) return;
        windowSlider.setAttribute('data-on', 'false');
        windowSlider.setAttribute('data-out', 'true');
        if (lastRow !== null) lastRow.removeAttribute('data-ue-hover');
        lastRow = null;
      };

      const rowOf = (node) => {
        if (!node || typeof node.closest !== 'function') return null;
        return node.closest(WINDOW_ROW_SELECTOR);
      };

      const onOver = (event) => {
        const row = rowOf(event.target);
        if (row === null) return;
        if (row === lastRow) return;
        lastRow = row;
        place(row);
      };

      const onOut = (event) => {
        if (windowSlider === null) return;
        // Only the pointer leaving the whole row list retires the block; a move from
        // one row to the next is a slide, not an exit. `relatedTarget` is the element
        // being entered, so a row there means we are still inside the list.
        const to = rowOf(event.relatedTarget);
        if (to !== null) return;
        const from = rowOf(event.target);
        if (from === null) return;
        retire();
      };

      // Scrolling moves the rows under a stationary pointer, so the block has to
      // follow them or it detaches from the row it is highlighting.
      const onScroll = () => {
        if (lastRow === null || windowSlider === null) return;
        if (windowSlider.getAttribute('data-on') !== 'true') return;
        if (!lastRow.isConnected) {
          retire();
          return;
        }
        place(lastRow);
      };

      document.addEventListener('pointerover', onOver, true);
      document.addEventListener('pointerout', onOut, true);
      document.addEventListener('scroll', onScroll, true);
      return () => {
        document.removeEventListener('pointerover', onOver, true);
        document.removeEventListener('pointerout', onOut, true);
        document.removeEventListener('scroll', onScroll, true);
        if (lastRow !== null) lastRow.removeAttribute('data-ue-hover');
        ensureSlider(null);
        lastRow = null;
      };
    }

    const modelBadgeStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      height: '20px',
      padding: '0 7px',
      borderRadius: '999px',
      background: 'var(--dsw-alias-interactive-bg-hover)',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '11px',
      lineHeight: '20px',
      whiteSpace: 'nowrap',
      fontVariantNumeric: 'tabular-nums',
      flexShrink: 0,
      userSelect: 'none',
    };
    const modelLineStyle = {
      fontSize: '11px',
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-tertiary)',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    };

    return {
      inject: ['slots', 'locale', 'sidebarRight'],
      apply(ctx) {
        // Drop the force-reload marker before anything else reads the address bar.
        consumeRefreshMarker();

        ctx.effect(() => {
          const disposers = [
            ctx.locale.register(NS, 'zh', dictionaries.zh),
            ctx.locale.register(NS, 'en', dictionaries.en),
          ];
          return () => {
            for (const dispose of disposers) dispose();
          };
        }, 'ui-enhance: dictionaries');

        ctx.effect(() => {
          const tag = document.createElement('style');
          tag.dataset.pluginCss = 'ui-enhance/controls.css';
          tag.textContent = CONTROLS_CSS;
          document.head.appendChild(tag);
          return () => {
            tag.remove();
          };
        }, 'ui-enhance: controls style');

        /* 背景打底（#8）与焦点面板提亮（#9）的样式表。 */
        ctx.effect(() => {
          const tag = document.createElement('style');
          tag.dataset.pluginCss = 'ui-enhance/visual.css';
          tag.textContent = VISUAL_CSS;
          document.head.appendChild(tag);
          document.documentElement.setAttribute('data-ui-enhance-veil', 'on');
          return () => {
            tag.remove();
            document.documentElement.removeAttribute('data-ui-enhance-veil');
          };
        }, 'ui-enhance: visual layers');

        /**
         * Temporary field diagnostics while the floating panel is recovered: any renderer
         * error plus a DOM census are pushed to the Host probe ring, so a page-side problem
         * can be seen without opening DevTools. Removed once confirmed.
         */
        ctx.effect(() => {
          const onError = (event) => {
            probe('client-error', {
              message: String(event && event.message),
              source: String(event && event.filename),
              line: event && event.lineno,
            });
          };
          const onReject = (event) => {
            const reason = event && event.reason;
            probe('client-reject', { message: String((reason && reason.message) || reason) });
          };
          const box = (el) => {
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
          };
          const describe = (el) => {
            if (!el) return null;
            const cs = window.getComputedStyle(el);
            const parent = el.parentElement;
            const pcs = parent ? window.getComputedStyle(parent) : null;
            const chain = [];
            let up = parent;
            for (let i = 0; i < 5 && up; i += 1) {
              const ucs = window.getComputedStyle(up);
              chain.push({
                tag: up.tagName,
                cls: String(up.className || '').slice(0, 80),
                box: box(up),
                display: ucs.display,
                overflow: ucs.overflow,
                position: ucs.position,
                opacity: ucs.opacity,
              });
              up = up.parentElement;
            }
            let hit = 'none';
            try {
              const cx = Math.round(el.getBoundingClientRect().left + el.getBoundingClientRect().width / 2);
              const cy = Math.round(el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2);
              const found = document.elementFromPoint(cx, cy);
              hit = found ? (found === el || el.contains(found) ? 'self' : String(found.tagName) + '.' + String(found.className || '').slice(0, 60)) : 'null';
            } catch (err) {
              hit = 'error';
            }
            return {
              box: box(el),
              color: cs.color,
              opacity: cs.opacity,
              visibility: cs.visibility,
              display: cs.display,
              disabled: el.disabled === true,
              offsetParent: el.offsetParent ? el.offsetParent.tagName : null,
              parentCls: parent ? String(parent.className || '').slice(0, 80) : null,
              parentDisplay: pcs ? pcs.display : null,
              parentOverflow: pcs ? pcs.overflow : null,
              hit,
              chain,
            };
          };
          window.addEventListener('error', onError);
          window.addEventListener('unhandledrejection', onReject);
          const onVisibility = () => {
            probe('page-visibility', {
              pageId: PAGE_ID,
              state: document.visibilityState,
              focus: document.hasFocus(),
              refreshNodes: document.querySelectorAll('[data-ui-enhance-refresh]').length,
              refreshSideNodes: document.querySelectorAll('[data-ui-enhance-refresh-side]').length,
              hudNodes: document.querySelectorAll('[data-ui-enhance-hud]').length,
              href: window.location.href,
            });
          };
          document.addEventListener('visibilitychange', onVisibility);
          window.addEventListener('focus', onVisibility);
          const sample = (tag) => {
            const hud = document.querySelectorAll('[data-ui-enhance-hud]');
            const node = hud.length > 0 ? hud[0] : null;
            const rect = node && typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null;
            const utilities = document.querySelector('[class*="headerUtilities"]');
            probe(tag === 'dom-scan' ? 'dom-scan' : 'dom-watch', {
              build: CLIENT_BUILD,
              tag,
              hudNodes: hud.length,
              overlayNodes: document.querySelectorAll('[data-composer-overlay]').length,
              dockNodes: document.querySelectorAll('[data-ui-enhance-dock]').length,
              refreshNodes: document.querySelectorAll('[data-ui-enhance-refresh]').length,
              refreshSideNodes: document.querySelectorAll('[data-ui-enhance-refresh-side]').length,
              clearNodes: document.querySelectorAll('[data-ui-enhance-clear]').length,
              modelSwitch: describe(document.querySelector('[data-ui-enhance-model-trigger]')),
              modelSwitchCount: document.querySelectorAll('[data-ui-enhance-model-trigger]').length,
              modelMenuCount: document.querySelectorAll('[data-ui-enhance-model-menu]').length,
              tokenPanelCount: document.querySelectorAll('[data-ui-enhance-token-panel]').length,
              tokenRows: document.querySelectorAll('[data-ui-enhance-token-row]').length,
              scopeChipCount: document.querySelectorAll('[data-ui-enhance-scope-chip]').length,
              refresh: describe(document.querySelector('[data-ui-enhance-refresh]')),
              refreshSide: describe(document.querySelector('[data-ui-enhance-refresh-side]')),
              clear: describe(document.querySelector('[data-ui-enhance-clear]')),
              pageId: PAGE_ID,
              title: document.title,
              href: window.location.href,
              visibilityState: document.visibilityState,
              hasFocus: document.hasFocus(),
              viewport: { w: window.innerWidth, h: window.innerHeight },
              scrollY: window.scrollY,
              utilities: utilities ? String(utilities.className || '').slice(0, 60) : null,
              rect: rect
                ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
                : null,
              visibility: node ? window.getComputedStyle(node).visibility : null,
              display: node ? window.getComputedStyle(node).display : null,
            });
          };

          let booted = false;
          const timers = [2500, 6000, 10000, 16000, 24000].map((delay, index) =>
            window.setTimeout(() => {
              const tag = booted ? 'watch' + index : 'dom-scan';
              booted = true;
              sample(tag);
            }, delay),
          );
          return () => {
            window.removeEventListener('error', onError);
            window.removeEventListener('unhandledrejection', onReject);
            document.removeEventListener('visibilitychange', onVisibility);
            window.removeEventListener('focus', onVisibility);
            for (const id of timers) window.clearTimeout(id);
          };
        }, 'ui-enhance: field diagnostics');

        /**
         * Mirror this browser's budget map to the Host half. The Host listens on
         * `agent/pre-step`, so this is what lets a budget compact a Session while a turn is
         * still running (`/compact` itself is refused while the agent is busy).
         *
         * The Host keeps the mirror in memory, so it is re-sent on a timer and whenever the
         * page becomes visible again: a Host restart (plugin reinstall, app relaunch) must not
         * leave a budget unenforced until the next tier change.
         */
        const pushContextWindow = (size) => {
          if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return;
          fetch(CONTEXT_WINDOW_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ contextWindow: Math.round(size) }),
          }).catch(() => {});
        };

        ctx.effect(() => {
          let stopped = false;
          const push = (attempt) => {
            if (stopped) return;
            const budgets = windowStore.all();
            fetch(BUDGETS_PATH, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ budgets }),
            })
              .then((response) => {
                if (!response.ok) throw new Error('http-' + response.status);
              })
              .catch(() => {
                // The Host route may not be registered yet on a cold boot; retry briefly.
                if (stopped || attempt >= 2) return;
                window.setTimeout(() => push(attempt + 1), 2000 * (attempt + 1));
              });
          };
          const unsubscribe = windowStore.subscribe(() => push(0));
          const resync = window.setInterval(() => push(0), BUDGETS_RESYNC_MS);
          const onVisible = () => {
            if (document.visibilityState === 'visible') push(0);
          };
          document.addEventListener('visibilitychange', onVisible);
          push(0);
          return () => {
            stopped = true;
            unsubscribe();
            window.clearInterval(resync);
            document.removeEventListener('visibilitychange', onVisible);
          };
        }, 'ui-enhance: budget mirror');

        /**
         * Right-pane default state, owned by this plugin because the shipped panel
         * seeds the guide page. For a Session nobody has opened the column for, show
         * the workspace file tree; when the user collapses the column again, hand the
         * pane back to the guide page so the next expansion starts at "开始".
         */
        ctx.effect(() => {
          const sidebar = ctx.sidebarRight;
          if (!sidebar || typeof sidebar.openTab !== 'function' || !sidebar.mounted) return () => {};

          const timers = new Map();
          const decided = new Set();

          const readMarked = () => {
            try {
              const raw = window.localStorage.getItem(RIGHT_PANE_MARKER);
              const list = raw === null ? [] : JSON.parse(raw);
              return new Set(Array.isArray(list) ? list.filter((item) => typeof item === 'string') : []);
            } catch (error) {
              return new Set();
            }
          };
          const marked = readMarked();
          const mark = (sessionId) => {
            if (marked.has(sessionId)) return;
            marked.add(sessionId);
            try {
              window.localStorage.setItem(RIGHT_PANE_MARKER, JSON.stringify(Array.from(marked)));
            } catch (error) {
              /* best-effort: the in-memory mark still stops this page from repeating */
            }
          };

          /** The saved layout's tab kinds for a Session; `null` when nobody has touched the column. */
          const savedKinds = (sessionId) => {
            let raw;
            try {
              raw = window.localStorage.getItem(RIGHT_PANE_STORAGE + '.' + sessionId);
            } catch (error) {
              return [];
            }
            if (raw === null) return null;
            try {
              const envelope = JSON.parse(raw);
              const surface = envelope && envelope.bySession ? envelope.bySession[sessionId] : undefined;
              const tabs = surface && surface.layout && surface.layout.tabs ? surface.layout.tabs : {};
              return Object.values(tabs)
                .map((tab) => (tab && typeof tab.kind === 'string' ? tab.kind : ''))
                .filter((kind) => kind !== '');
            } catch (error) {
              return [];
            }
          };

          /** The shipped guide page alone is still the panel's default state, not a user choice. */
          const onlyGuide = (kinds) => kinds.every((kind) => kind === RIGHT_PANE_GUIDE);

          const screenOf = () => {
            try {
              return sidebar.screen();
            } catch (error) {
              return undefined;
            }
          };

          /** Open the file tree unless this Session already has the user's own pages. */
          const seed = (sessionId) => {
            if (decided.has(sessionId)) return;
            if (marked.has(sessionId)) {
              decided.add(sessionId);
              probe('pane-skip', { sessionId, why: 'marked' });
              return;
            }
            const kinds = savedKinds(sessionId);
            if (kinds !== null && kinds.length > 0 && !onlyGuide(kinds)) {
              decided.add(sessionId);
              mark(sessionId);
              probe('pane-skip', { sessionId, why: 'user-layout', kinds });
              return;
            }
            const current = screenOf();
            if (!current || current.sessionId !== sessionId) return;
            const present = Object.values(current.surface.layout.tabs || {}).map((tab) => (tab && tab.kind) || '');
            if (present.length > 0 && !onlyGuide(present)) {
              decided.add(sessionId);
              mark(sessionId);
              probe('pane-skip', { sessionId, why: 'user-tabs', kinds: present });
              return;
            }
            try {
              sidebar.openTab(RIGHT_PANE_FILES);
              decided.add(sessionId);
              mark(sessionId);
              probe('pane-seed', { sessionId, from: kinds === null ? 'fresh' : 'guide' });
            } catch (error) {
              probe('pane-seed-failed', { sessionId, message: String((error && error.message) || error) });
            }
          };

          /** Wait for the seat to mint and adopt the Session's sidebar store, then seed once. */
          const watch = (sessionId) => {
            if (typeof sessionId !== 'string' || sessionId === '') return;
            if (timers.has(sessionId) || decided.has(sessionId)) return;
            let attempts = 0;
            const timer = window.setInterval(() => {
              attempts += 1;
              if (decided.has(sessionId) || attempts > RIGHT_PANE_SEED_ATTEMPTS) {
                window.clearInterval(timer);
                timers.delete(sessionId);
                if (!decided.has(sessionId)) probe('pane-seed-timeout', { sessionId, attempts });
                return;
              }
              seed(sessionId);
            }, RIGHT_PANE_SEED_INTERVAL_MS);
            timers.set(sessionId, timer);
            seed(sessionId);
          };

          /**
           * Collapse reached: drop the file tree from this Session's layout so the
           * shipped empty-column rule seeds the guide page on the next expansion.
           * A layout the user filled with other pages is left alone.
           */
          const handBackToGuide = (sessionId) => {
            let tabs = [];
            try {
              tabs = typeof sidebar.tabsIn === 'function' ? sidebar.tabsIn(sessionId) : [];
            } catch (error) {
              tabs = [];
            }
            const kinds = tabs.map((tab) => tab.kind);
            probe('pane-collapse', { sessionId, kinds });
            if (!kinds.includes(RIGHT_PANE_FILES)) return;
            if (!kinds.every((kind) => kind === RIGHT_PANE_FILES || kind === RIGHT_PANE_GUIDE)) return;
            for (const tab of tabs) {
              if (tab.kind !== RIGHT_PANE_FILES) continue;
              try {
                sidebar.closeIn(sessionId, tab.id);
                probe('pane-collapse-guide', { sessionId, tabId: tab.id });
              } catch (error) {
                probe('pane-collapse-failed', { sessionId, message: String((error && error.message) || error) });
              }
            }
          };

          const mounted = sidebar.mounted;
          const unsubscribe = typeof mounted.subscribe === 'function' ? mounted.subscribe(watch) : null;
          watch(typeof mounted.getSnapshot === 'function' ? mounted.getSnapshot() : undefined);

          /**
           * Collapse is not published as an observable, so follow the on-screen
           * Session's expanded flag; the file tree we opened is the only thing the
           * shipped panel would restore on the next expansion.
           */
          const collapseState = { sessionId: undefined, expanded: undefined };
          const pollCollapse = () => {
            const current = typeof mounted.getSnapshot === 'function' ? mounted.getSnapshot() : undefined;
            if (typeof current !== 'string') {
              collapseState.sessionId = undefined;
              collapseState.expanded = undefined;
              return;
            }
            if (collapseState.sessionId !== current) {
              collapseState.sessionId = current;
              collapseState.expanded = undefined;
            }
            const expanded = typeof sidebar.isExpanded === 'function' ? sidebar.isExpanded() : undefined;
            if (typeof expanded !== 'boolean') return;
            if (collapseState.expanded === true && expanded === false) handBackToGuide(current);
            collapseState.expanded = expanded;
          };
          const collapseTimer = window.setInterval(pollCollapse, 200);

          probe('pane-boot', {
            build: CLIENT_BUILD,
            mounted: typeof mounted.getSnapshot === 'function' ? mounted.getSnapshot() || null : null,
          });

          return () => {
            if (unsubscribe !== null) unsubscribe();
            window.clearInterval(collapseTimer);
            for (const timer of timers.values()) window.clearInterval(timer);
            timers.clear();
          };
        }, 'ui-enhance: right pane default');

        const t = ctx.locale.bind(NS);
        // Same binder for the helpers that run outside this closure (notices, reload
        // guard). Without it those throw "t is not defined" the moment they fire.
        moduleT = t;

        const effortText = (effort) => {
          if (!effort) return '';
          const key = EFFORT_KEYS[effort];
          return key ? t(key) : String(effort);
        };

        const modelText = (selection) => {
          if (!selection || !selection.model) return '';
          const model = modelLabel(selection.model);
          const effort = effortText(selection.reasoningEffort);
          return effort === '' ? fill(t('modelLineOnly'), { model }) : fill(t('modelLine'), { model, effort });
        };

        /**
         * Beautify lives outside React: the background layer, the WebGL canvas and the
         * `data-ue-glass` marks are page-level side effects, so they survive slot remounts.
         * The store is the single source of truth; this effect is its only DOM writer.
         */
        beautifyT = t;
        ctx.effect(() => {
          const tag = document.createElement('style');
          tag.dataset.pluginCss = 'ui-enhance/beautify.css';
          tag.textContent = BEAUTIFY_CSS;
          document.head.appendChild(tag);

          const apply = () => {
            try {
              syncBeautifyDom(beautifyStore.get());
            } catch (error) {
              probe('beautify-sync-failed', {
                message: String((error && error.message) || error),
                stack: String((error && error.stack) || '').split('\n').slice(0, 4).join(' | '),
              });
            }
          };
          apply();
          const unsubscribe = beautifyStore.subscribe(apply);

          let frame = 0;
          const onResize = () => {
            if (frame !== 0) return;
            frame = window.requestAnimationFrame(() => {
              frame = 0;
              if (beautifyStore.get().on === false) return;
              applyGlass(detectPanes());
            });
          };
          window.addEventListener('resize', onResize);

          // The panes mount after the first paint and are rebuilt on navigation; only the
          // "nothing marked yet" case needs a retry, so this stays a slow safety net.
          // The same beat retries a ShaderToy backdrop whose fetch failed: the key is only
          // claimed once a work is on screen, so a non-empty key short-circuits this.
          const paneTimer = window.setInterval(() => {
            const state = beautifyStore.get();
            if (state.on === false) return;
            if (state.mode === 'shader' && beautifyShader !== null) {
              const wanted = parseShaderId(state.shaderId);
              if (wanted !== '' && beautifyShaderKey !== wanted) void loadShaderWork(wanted, false);
            }
            if (document.querySelector('[' + GLASS_ATTR + ']') !== null) return;
            applyGlass(detectPanes());
          }, 4000);

          return () => {
            unsubscribe();
            window.removeEventListener('resize', onResize);
            if (frame !== 0) window.cancelAnimationFrame(frame);
            window.clearInterval(paneTimer);
            clearBackgroundLayer();
            applyGlass([]);
            restoreAppRoot();
            document.documentElement.classList.remove(BEAUTIFY_CLASS);
            tag.remove();
          };
        }, 'ui-enhance: beautify');


    /* -----------------------------------------------------------------------
     * The shipped Session hover card opens after a fixed delay (800 ms in
     * dsh-client-ui-workspace). That constant is not exported, not configurable and
     * lives in a timer started per row, so the only place it can be removed is inside
     * the hook that starts it.
     *
     * The hook is wrapped, not rewritten: the wrapper records every timer armed during
     * the hook's synchronous body and cancels the single long one (the opener; the other
     * timers there are a few milliseconds each) before it can fire. Recording happens
     * through a `window.setTimeout` shim that is installed for the duration of that one
     * call and restored immediately after, so the rest of the page never sees it — and
     * once the delay has been captured the patch is not repeated.
     *
     * If the host ever renames or restructures its hooks, the wrapper finds no such
     * timer and the shipped delay simply stays in force; the hook still runs unchanged.
     *
     * The capture reports itself through the probe ring, so a page whose Host build
     * moved the hook is diagnosed from evidence instead of guesswork. That report is
     * the last consumer of the probe and goes with it once this page has been checked.
     * ----------------------------------------------------------------------- */
    const HOVER_PKG = '@deepseek-ai/dsh-client-ui-workspace';
    const HOVER_DELAY_MIN_MS = 200;
    const hoverPatch = { state: 'pending', detail: '', delayMs: 0, seen: [], sample: '' };

    function removeHoverDelay(require) {
      let mod;
      try {
        mod = require(HOVER_PKG);
      } catch (error) {
        hoverPatch.state = 'no-module';
        return;
      }
      if (!mod || typeof mod !== 'object') {
        hoverPatch.state = 'no-module';
        return;
      }
      const hosts = [mod.hooks, mod.default && mod.default.hooks].filter(
        (hooks) => hooks !== null && typeof hooks === 'object',
      );
      if (hosts.length === 0) {
        hoverPatch.state = 'no-hooks';
        return;
      }

      const realSetTimeout = window.setTimeout;
      const realClearTimeout = window.clearTimeout;
      const originals = new WeakMap();

      const hook = (fn, delay, ...rest) => {
        const id = realSetTimeout.call(window, fn, delay, ...rest);
        if (armed !== null) {
          armed.push({ id, ms: Number(delay), fn });
          census(armed);
        }
        return id;
      };
      const cancel = (id) => realClearTimeout.call(window, id);
      let armed = null;
      let openerMs = 0;

      /* Run one hook call with the recorder in place, then retire its timers. */
      const call = (target, self, args) => {
        if (armed !== null) return Reflect.apply(target, self, args);
        if (hoverPatch.delayMs !== 0) return Reflect.apply(target, self, args);
        armed = [];
        window.setTimeout = hook;
        window.clearTimeout = cancel;
        try {
          return Reflect.apply(target, self, args);
        } finally {
          window.setTimeout = realSetTimeout;
          window.clearTimeout = realClearTimeout;
          const seen = armed;
          armed = null;
          if (openerMs === 0) {
            const long = seen.filter((entry) => entry.ms >= HOVER_DELAY_MIN_MS);
            if (long.length === 1) {
              openerMs = long[0].ms;
              hoverPatch.delayMs = long[0].ms;
              // Only the very first one per page is held back; later timers of that
              // length are the host's own work and must run.
              realClearTimeout.call(window, long[0].id);
            }
          }
        }
      };

      /* Census only: the first hover's timers are reported so the delay that has to be
       * removed is identified from the code path, not assumed. Function sources are
       * captured cheaply here and read by the page-side report, never evaluated. */
      let sampled = false;
      const census = (seen) => {
        if (sampled) return;
        sampled = true;
        hoverPatch.seen = seen.map((entry) => entry.ms);
        const parts = [];
        for (const entry of seen) {
          try {
            const text = String(entry.fn).replace(/\s+/g, ' ');
            parts.push(entry.ms + ':' + text.slice(0, 240));
          } catch (error) {
            parts.push(entry.ms + ':?');
          }
        }
        hoverPatch.sample = parts.join(' || ').slice(0, 1400);
      };

      let wrapped = 0;
      for (const hooks of hosts) {
        for (const key of Object.keys(hooks)) {
          const value = hooks[key];
          if (typeof value !== 'function' || originals.has(value)) continue;
          const proxy = new Proxy(value, {
            apply(target, self, args) {
              return call(target, self, args);
            },
          });
          originals.set(value, proxy);
          hooks[key] = proxy;
          wrapped += 1;
        }
      }

      hoverPatch.state = wrapped > 0 ? 'wrapped' : 'no-hooks';
      hoverPatch.detail = wrapped + ' hook(s) wrapped';
    }

        /**
         * Window mode lives outside React for the same reason Beautify does: the tags it
         * puts on the shell (`<html class>`, one class per column and Session row) must
         * survive slot remounts and must not be owned by any component's render.
         *
         * The polling loop is the deliberate part. The shipped workspace list re-renders
         * on every streamed token, so an observer reacting to that would fire constantly;
         * instead one coalesced pass per idle frame re-tags what changed. A pass where
         * nothing changed writes nothing at all, which is what keeps this from feeding
         * back into the renderer — the failure mode that froze this UI once already.
         */
        ctx.effect(() => {
          const tag = document.createElement('style');
          tag.dataset.pluginCss = 'ui-enhance/window.css';
          tag.textContent = WINDOW_CSS;
          document.head.appendChild(tag);

          const apply = () => syncWindowDom(windowModeStore.get());
          apply();
          const unsubscribe = windowModeStore.subscribe(apply);
          const disposeMotion = installWindowMotion();

          let timer = 0;
          let stopped = false;
          const tick = () => {
            if (stopped) return;
            // Nothing to do while the document is hidden: the shell is not visible and
            // the next visibility change re-syncs before the user can see a stale frame.
            if (document.visibilityState !== 'hidden') apply();
            timer = window.setTimeout(tick, 500);
          };
          timer = window.setTimeout(tick, 500);

          // A resize re-lays the columns out, so the guard is cleared immediately rather
          // than at the next tick; a hidden tab would otherwise keep a stale paint.
          const onResize = () => apply();
          const onVisible = () => {
            if (document.visibilityState !== 'hidden') apply();
          };
          window.addEventListener('resize', onResize);
          document.addEventListener('visibilitychange', onVisible);

          return () => {
            stopped = true;
            unsubscribe();
            disposeMotion();
            window.clearTimeout(timer);
            window.removeEventListener('resize', onResize);
            document.removeEventListener('visibilitychange', onVisible);
            // Leave the shipped UI exactly as it renders itself.
            syncWindowDom({ ...windowModeStore.get(), on: false });
            document.documentElement.classList.remove(WINDOW_CLASS);
            if (tag.parentNode) tag.parentNode.removeChild(tag);
          };
        }, 'ui-enhance: window mode');

        ctx.effect(() => {
          /**
           * The composer is a Lexical editor, and Lexical owns its document: poking the DOM
           * (execCommand / a manual `<br>`) makes it reconcile the change away, which is why
           * the line the caret sat on disappeared. Drive its own line-break command instead —
           * the very command Shift+Enter ends up invoking.
           */
          const lexicalEditorOf = (node) => {
            if (!node || typeof node.closest !== 'function') return null;
            const root = node.__lexicalEditor ? node : node.closest('[contenteditable="true"]');
            const editor = root ? root.__lexicalEditor : null;
            if (!editor || typeof editor.dispatchCommand !== 'function') return null;
            return editor;
          };

          const insertLexicalLineBreak = (node) => {
            const editor = lexicalEditorOf(node);
            if (editor === null) return false;
            const commands = editor._commands;
            if (!(commands instanceof Map)) return false;
            let command = null;
            for (const candidate of commands.keys()) {
              if (candidate !== null && typeof candidate === 'object' && candidate.type === 'INSERT_LINE_BREAK_COMMAND') {
                command = candidate;
                break;
              }
            }
            if (command === null) return false;
            try {
              return editor.dispatchCommand(command, false) === true;
            } catch (error) {
              return false;
            }
          };

          const insertContentEditableBreak = (target) => {
            let done = false;
            try {
              done = document.execCommand('insertLineBreak');
            } catch (error) {
              done = false;
            }
            if (done) return;
            try {
              if (document.execCommand('insertParagraph')) return;
            } catch (error) {
              /* fall through to the range fallback */
            }
            const selection = window.getSelection();
            if (selection === null || selection.rangeCount === 0) return;
            const range = selection.getRangeAt(0);
            range.deleteContents();
            const br = document.createElement('br');
            range.insertNode(br);
            range.setStartAfter(br);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
            target.dispatchEvent(new Event('input', { bubbles: true }));
          };

          const onKeyDown = (event) => {
            if (event.key !== 'Enter' || !event.altKey) return;
            if (event.shiftKey || event.ctrlKey || event.metaKey) return;
            if (event.isComposing) return;
            const target = event.target;
            if (!(target instanceof HTMLElement)) return;
            /* Never take Enter from a control that owns it.
             *
             * The composer's textarea and the Lexical editor need the newline, but a
             * button, a link or an input inside a dialog (the 界面美化 panel's
             * 拉取并保存) needs its own activation. Intercepting those turned a real
             * click into a silent newline in whatever field held focus -- which is
             * exactly "点按钮没有任何反映". */
            const tag = String(target.tagName || '').toLowerCase();
            if (tag === 'button' || tag === 'a' || tag === 'select') return;
            if (tag === 'input' && String(target.type || '').toLowerCase() !== 'textarea') return;
            if (typeof target.closest === 'function' && target.closest('[data-ui-enhance-beautify],[data-ue-ask],[role="dialog"], [data-dsw-dialog]')) return;
            if (target instanceof HTMLTextAreaElement) {
              event.preventDefault();
              event.stopImmediatePropagation();
              insertTextareaNewline(target);
              return;
            }
            const editor = lexicalEditorOf(target);
            if (editor === null && !target.isContentEditable) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (insertLexicalLineBreak(target)) return;
            insertContentEditableBreak(target);
          };

          document.addEventListener('keydown', onKeyDown, true);
          return () => document.removeEventListener('keydown', onKeyDown, true);
        }, 'ui-enhance: alt+enter newline');

        const commandUi = ctx.get('commandUi');
        const uiWorkspace = ctx.get('uiWorkspace');
        if (commandUi && uiWorkspace && typeof commandUi.register === 'function') {
          ctx.effect(
            () =>
              commandUi.register({
                name: 'new',
                available: () => true,
                label: () => t('newLabel'),
                description: () => t('newHint'),
                ui: {
                  kind: 'action',
                  run: () => {
                    uiWorkspace.startSession();
                  },
                },
              }),
            'ui-enhance: /new command',
          );
        }

        const remoteService = ctx.get('remote');
        const remoteCommands = ctx.get('remote.commands') || (remoteService && remoteService.commands);
        const sessions = ctx.get('sessions');
        const requestedProjections = new Set();

        function ensureProjections(sessionId) {
          if (!sessions || typeof sessions.refreshProjections !== 'function') return;
          if (requestedProjections.has(sessionId)) return;
          requestedProjections.add(sessionId);
          try {
            const pending = sessions.refreshProjections(sessionId);
            if (pending && typeof pending.catch === 'function') pending.catch(() => {});
          } catch (error) {
            /* projection refresh is best-effort */
          }
        }

        async function compactSession(sessionId) {
          /* A running agent makes the shipped command refuse, and a sub-agent is running for
           * its whole life, so the manual button used to fail every time. The Host half can
           * reduce the surface mid-turn; the command stays as the fallback for a Session
           * that has no live agent. */
          try {
            const response = await fetch(COMPACT_PATH, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId }),
            });
            if (response.ok) {
              const body = await response.json();
              if (body && body.ok === true) return body;
            }
          } catch (error) {
            /* an older Host has no such route: fall back to the command */
          }
          const live = ctx.get('remote');
          const commands = remoteCommands || (live && live.commands);
          if (!commands || typeof commands.execute !== 'function') throw new Error('remote-unavailable');
          const result = await commands.execute(sessionId, '/compact', []);
          if (!result || result.ok !== true) {
            throw new Error((result && result.error && (result.error.message || result.error.code)) || 'compact-failed');
          }
          if (result.value === undefined) throw new Error('compact-unavailable');
          return result.value;
        }

        /** One compaction per Session at a time: the dock button and the auto path share this guard. */
        const activeCompactions = new Set();

        async function runCompact(sessionId) {
          if (activeCompactions.has(sessionId)) return false;
          activeCompactions.add(sessionId);
          try {
            await compactSession(sessionId);
            return true;
          } finally {
            activeCompactions.delete(sessionId);
          }
        }

        /** Agent ids appear both bare and `session-` prefixed; the Host keys by the bare uuid. */
        function bareSessionId(sessionId) {
          if (typeof sessionId !== 'string') return '';
          return sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId;
        }

        /**
         * Ask the Host to cancel this Session's in-flight work. `agent.cancel` aborts the phase
         * signal, which is exactly what a compaction stuck inside its summary is waiting on.
         * @returns 'aborted' when the Host cancelled a live agent, 'gone' when no agent is live.
         */
        async function abortSession(sessionId) {
          const response = await fetch(ABORT_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId }),
          });
          let body = null;
          try {
            body = await response.json();
          } catch (error) {
            body = null;
          }
          if (body && body.ok === true) return 'aborted';
          if (body && body.error === 'agent-not-live') return 'gone';
          throw new Error((body && body.error) || 'http-' + response.status);
        }

        /**
         * Poll the Host for a compaction marker this Session opened but never closed. That is
         * the durable signature of a hung compaction, and it survives a page reload even when
         * the local "compacting" flag is long gone.
         */
        function useOpenCompaction(sessionId) {
          const [open, setOpen] = React.useState(null);
          React.useEffect(() => {
            const key = bareSessionId(sessionId);
            if (key === '') return undefined;
            let alive = true;
            const tick = async () => {
              try {
                const response = await fetch(COMPACTIONS_PATH + '?sessionId=' + encodeURIComponent(sessionId));
                let body = null;
                try {
                  body = await response.json();
                } catch (error) {
                  return;
                }
                if (!alive || !body || body.ok !== true) return;
                const entry = body.session && body.session[key] ? body.session[key] : null;
                setOpen(entry);
              } catch (error) {
                /* polling is best-effort; a miss must not disturb the dock */
              }
            };
            void tick();
            const timer = window.setInterval(() => {
              void tick();
            }, COMPACTION_POLL_MS);
            return () => {
              alive = false;
              window.clearInterval(timer);
            };
          }, [sessionId]);
          return open;
        }

        /**
         * Keep the shipped ring and its click-open breakdown panel, but overwrite the
         * numbers it paints: the shipped value only tracks the newest `request/context`
         * record, so a per-session budget never reaches it until the next request.
         *
         * Every write is conditional (value compared first), so the MutationObservers
         * that watch React's rewrites settle instead of looping.
         */
        function useShippedMeterOverride(anchorRef, pressure, breakdown, budget) {
          const used =
            pressure && typeof pressure.projectedTokens === 'number'
              ? pressure.projectedTokens
              : pressure && pressure.pressureTokens;
          const capacity = budget !== undefined ? budget : pressure && pressure.contextWindow;
          const ready = typeof used === 'number' && typeof capacity === 'number' && capacity > 0;
          const percent = ready ? Math.min(100, Math.round((used / capacity) * 100)) : 0;
          const left = ready ? Math.max(0, capacity - used) : 0;

          const stateRef = React.useRef(null);
          stateRef.current = ready
            ? {
                ready: true,
                percent,
                text: percent + '%',
                used,
                capacity,
                warn: percent >= WARN_PERCENT,
                dash: (RING_CIRCUMFERENCE * percent) / 100,
                aria:
                  fill(t('meterAria'), { percent, left: formatAmount(left) }) +
                  (percent >= 100 ? ' · ' + t('meterFull') : ''),
                parts: breakdown ? [breakdown.systemTokens, breakdown.toolsTokens, breakdown.messageTokens] : null,
              }
            : { ready: false };

          const controllerRef = React.useRef(null);

          React.useEffect(() => {
            const own = anchorRef.current;
            const dock = own && typeof own.closest === 'function' ? own.closest('[data-composer-dock]') : null;
            if (!dock) return undefined;

            let meter = null;
            let prefix = '';
            let meterObserver = null;
            let panelNode = null;
            let panelObserver = null;

            const findMeter = () => {
              for (const child of Array.from(dock.children)) {
                if (!(child instanceof HTMLElement)) continue;
                if (child === own || child.contains(own)) continue;
                if (child.querySelector('svg circle[stroke-dasharray]') !== null) return child;
              }
              return null;
            };

            const findPanel = () => {
              if (prefix === '') return null;
              return document.querySelector('div[role="dialog"][class*="' + prefix + '_panel"]');
            };

            const patchMeter = () => {
              const state = stateRef.current;
              if (meter === null || !state || state.ready !== true) return;

              const circle = meter.querySelector('svg circle[stroke-dasharray]');
              if (circle !== null) {
                const dash = state.dash + ' ' + RING_CIRCUMFERENCE;
                if (circle.getAttribute('stroke-dasharray') !== dash) circle.setAttribute('stroke-dasharray', dash);
                if (state.warn) {
                  if (circle.style.stroke !== 'var(--dsw-alias-state-warn-primary)') {
                    circle.style.stroke = 'var(--dsw-alias-state-warn-primary)';
                  }
                } else if (circle.style.stroke !== '') {
                  circle.style.removeProperty('stroke');
                }
              }

              const button = meter.querySelector('button');
              if (button !== null) {
                if (button.getAttribute('aria-label') !== state.aria) button.setAttribute('aria-label', state.aria);
                const reading = button.querySelector('span');
                if (reading !== null && reading.textContent !== state.text) reading.textContent = state.text;
              }

              const bubble = meter.querySelector('span[role="tooltip"]');
              if (bubble !== null) {
                if (bubble.getAttribute('aria-label') !== state.aria) bubble.setAttribute('aria-label', state.aria);
                const label = bubble.querySelector('span');
                if (label !== null && label.textContent !== state.aria) label.textContent = state.aria;
              }
            };

            const patchPanel = () => {
              const state = stateRef.current;
              if (panelNode === null || !state || state.ready !== true) return;

              const percentEl = panelNode.querySelector('[class*="' + prefix + '_percent"]');
              if (percentEl !== null && percentEl.textContent !== state.text) percentEl.textContent = state.text;

              const figures = panelNode.querySelector('[class*="' + prefix + '_figures"]');
              if (figures !== null) {
                const text = '~' + formatAmount(state.used) + ' / ' + formatAmount(state.capacity);
                if (figures.textContent !== text) figures.textContent = text;
              }

              const bar = panelNode.querySelector('[class*="' + prefix + '_bar"]');
              if (bar === null) return;
              const segments = Array.from(bar.children);
              if (state.parts !== null && segments.length === state.parts.length) {
                const total = state.parts.reduce((sum, value) => sum + value, 0);
                for (let index = 0; index < segments.length; index += 1) {
                  const width = total > 0 ? (state.percent * state.parts[index]) / total : 0;
                  const next = width + '%';
                  if (segments[index].style.width !== next) segments[index].style.width = next;
                }
              } else if (segments.length === 1) {
                const next = state.percent + '%';
                if (segments[0].style.width !== next) segments[0].style.width = next;
              }
            };

            const syncPanel = () => {
              const next = findPanel();
              if (next !== panelNode) {
                if (panelObserver !== null) panelObserver.disconnect();
                panelObserver = null;
                panelNode = next;
                if (panelNode !== null) {
                  panelObserver = new MutationObserver(syncPanel);
                  panelObserver.observe(panelNode, {
                    subtree: true,
                    childList: true,
                    characterData: true,
                    attributes: true,
                    attributeFilter: ['style'],
                  });
                }
              }
              patchPanel();
            };

            const apply = () => {
              patchMeter();
              syncPanel();
              patchInsight();
            };

            const attach = (next) => {
              if (meterObserver !== null) meterObserver.disconnect();
              meterObserver = null;
              meter = next;
              prefix = next === null ? '' : String(next.className || '').split('_')[0];
              if (meter !== null) {
                meterObserver = new MutationObserver(() => {
                  patchMeter();
                  syncPanel();
                });
                meterObserver.observe(meter, {
                  subtree: true,
                  childList: true,
                  characterData: true,
                  attributes: true,
                  attributeFilter: ['stroke-dasharray', 'style', 'aria-label', 'aria-expanded'],
                });
              }
              apply();
            };

            const dockObserver = new MutationObserver(() => {
              const next = findMeter();
              if (next !== meter) attach(next);
              else apply();
            });
            dockObserver.observe(dock, { childList: true });

            /* The shipped hover tip is a body-level portal, so it is never a descendant
             * of the meter and `patchMeter` cannot see it. Its own percentage is computed
             * against `contextWindow`, so rescale it by the ratio the two denominators
             * differ by rather than looking for which meter it is tethered to. */
            /* Every write re-enters the observer, so remember the exact text we produced:
             * rescaling our own output would multiply by the window ratio on each pass and
             * pin the reading at 100%. A fresh value from the shipped side never matches. */
            const bubbleWritten = new WeakMap();
            const patchBubble = () => {
              const state = stateRef.current;
              const windowSize = pressure && typeof pressure.contextWindow === 'number' ? pressure.contextWindow : 0;
              if (!state || state.ready !== true) return;
              if (budget === undefined || windowSize <= 0 || windowSize === budget) return;
              for (const bubble of document.querySelectorAll('[class*="_bubble_"]')) {
                const label = bubble.querySelector('[class*="_label_"]');
                if (label === null) continue;
                const current = String(label.textContent || '');
                if (bubbleWritten.get(label) === current) continue;
                const match = /(已用|used)\s*([0-9]+)\s*%/i.exec(current);
                if (match === null) continue;
                const percent = Math.min(100, Math.round((Number(match[2]) * windowSize) / budget));
                const next = current.replace(match[0], match[1] + ' ' + percent + '%');
                if (next === current) continue;
                label.textContent = next;
                bubbleWritten.set(label, next);
              }
            };

            /* The context-insight panel is a separate plugin (`lc-*` classes) that prints
             * its own used / capacity / percentage from `contextWindow`. Rewrite all three
             * from the numbers the ring already uses, so one screen cannot show two
             * denominators. Its own markup is `<b>used</b><span>/ cap tokens</span>` plus a
             * `lc-overview-pct` block holding the percentage. */
            const patchInsight = () => {
              const state = stateRef.current;
              if (!state || state.ready !== true) return;
              if (budget === undefined) return;
              for (const num of document.querySelectorAll('[class*="lc-overview-num"]')) {
                const used = num.querySelector('b');
                const usedText = formatAmount(state.used);
                if (used !== null && used.textContent !== usedText) used.textContent = usedText;
                for (const span of num.querySelectorAll('span')) {
                  const text = String(span.textContent || '');
                  if (text.indexOf('tokens') < 0) continue;
                  const next = '/ ' + formatAmount(state.capacity) + ' tokens';
                  if (text !== next) span.textContent = next;
                }
                const percent = num.querySelector('[class*="lc-overview-pct"] b');
                if (percent !== null && percent.textContent !== state.text) percent.textContent = state.text;
              }
              /* The stacked bar draws every segment as a share of the model window, and its
               * occupied box already equals the sum of the segments -- so the ratio between
               * the two is all we need, with no window size involved. Scale the segments to
               * our percentage, rebuild the free remainder, and hide the reserve bands: they
               * mark the shipped window's headroom thresholds, which mean nothing at a
               * different tier. */
              for (const occupied of document.querySelectorAll('[class*="lc-occupied-box"]')) {
                const stack = occupied.parentElement;
                if (stack === null) continue;
                const base = parseFloat(String(occupied.style.width || ''));
                if (!(base > 0)) continue;
                const scale = state.percent / base;
                if (!(scale > 0) || Math.abs(scale - 1) < 0.001) continue;
                let sum = 0;
                for (const seg of stack.children) {
                  if (seg.className.indexOf('lc-stacked-seg') < 0) continue;
                  const width = parseFloat(String(seg.style.width || ''));
                  if (!(width > 0)) continue;
                  const next = width * scale;
                  sum += next;
                  const text = next.toFixed(4) + '%';
                  if (seg.style.width !== text) seg.style.width = text;
                }
                if (sum <= 0) continue;
                const occupiedText = Math.min(100, sum).toFixed(4) + '%';
                if (occupied.style.width !== occupiedText) occupied.style.width = occupiedText;
                for (const free of stack.children) {
                  if (free.className.indexOf('lc-stacked-free') < 0) continue;
                  const freeText = Math.max(0, 100 - sum).toFixed(4) + '%';
                  if (free.style.width !== freeText) free.style.width = freeText;
                }
                for (const reserve of stack.children) {
                  if (reserve.className.indexOf('lc-reserve') < 0) continue;
                  if (reserve.style.display !== 'none') reserve.style.display = 'none';
                }
              }
            };

            const bubbleObserver = new MutationObserver((records) => {
              let bubbleTouched = false;
              let insightTouched = false;
              const inspect = (node) => {
                if (node === null || node === undefined || node.nodeType !== 1) return;
                if (typeof node.closest === 'function') {
                  if (node.closest('[class*="_bubble_"]') !== null) bubbleTouched = true;
                  if (node.closest('[class*="lc-"]') !== null) insightTouched = true;
                }
                if (typeof node.querySelector === 'function') {
                  if (node.querySelector('[class*="_bubble_"]') !== null) bubbleTouched = true;
                  if (node.querySelector('[class*="lc-overview"]') !== null) insightTouched = true;
                }
              };
              for (const record of records) {
                if (record.type === 'characterData') inspect(record.target.parentElement);
                else for (const node of record.addedNodes) inspect(node);
              }
              if (bubbleTouched) patchBubble();
              if (insightTouched) patchInsight();
            });
            bubbleObserver.observe(document.body, { childList: true, subtree: true, characterData: true });

            const onPointer = () => syncPanel();
            dock.addEventListener('pointerdown', onPointer, true);
            dock.addEventListener('click', onPointer, true);

            attach(findMeter());

            controllerRef.current = { apply };

            return () => {
              dockObserver.disconnect();
              if (meterObserver !== null) meterObserver.disconnect();
              if (panelObserver !== null) panelObserver.disconnect();
              bubbleObserver.disconnect();
              dock.removeEventListener('pointerdown', onPointer, true);
              dock.removeEventListener('click', onPointer, true);
              controllerRef.current = null;
            };
          }, [anchorRef]);

          React.useEffect(() => {
            const controller = controllerRef.current;
            if (controller !== null) controller.apply();
          }, [ready, percent, used, capacity, breakdown]);
        }

        function amount(value) {
          return value === null || value === undefined ? t('unlimited') : (value / W).toFixed(2);
        }

        function WindowSelect(props) {
          useSessionWindow(props.sessionId);
          const [open, setOpen] = React.useState(false);
          const [anchor, setAnchor] = React.useState(null);
          const triggerRef = React.useRef(null);

          React.useEffect(() => {
            if (!open) return undefined;
            /* Realm-independent "is this node inside the menu?" test, for the same
             * reason as the Beautify panel: `instanceof Element` is false for real DOM
             * nodes from another realm, which made every click look external. */
            const inside = (node) => {
              /* Ancestor walk only: `Node.contains` is a method on the node's OWN realm's
               * prototype, so it can miss or throw for a target from another realm. */
              let cursor = node;
              for (let depth = 0; cursor !== null && depth < 64; depth += 1) {
                if (cursor.nodeType !== 1) {
                  cursor = cursor.parentNode || null;
                  continue;
                }
                if (cursor.hasAttribute && cursor.hasAttribute('data-ui-enhance-menu')) return true;
                if (triggerRef.current !== null && cursor === triggerRef.current) return true;
                cursor = cursor.parentNode || null;
              }
              return false;
            };
            const onPointerDown = (event) => {
              if (inside(event.target)) return;
              setOpen(false);
            };
            const onKey = (event) => {
              if (event.key !== 'Escape') return;
              event.stopPropagation();
              setOpen(false);
            };
            /* `scroll`/`resize` do not dismiss the menu, for the same reason they must
             * not dismiss the Beautify panel: a `scroll` event reports the scrolling
             * CONTAINER as its target, so `inside(target)` is false even while the user
             * scrolls the menu itself -- and opening the menu can scroll the dock into
             * view and close it in the same frame. */
            document.addEventListener('pointerdown', onPointerDown, true);
            document.addEventListener('keydown', onKey, true);
            return () => {
              document.removeEventListener('pointerdown', onPointerDown, true);
              document.removeEventListener('keydown', onKey, true);
            };
          }, [open]);

          /* Effective, not stored: a Session without its own budget inherits the
           * "default for all Sessions", and the trigger must show that inherited tier. */
          const effective = windowStore.effective(props.sessionId);
          const current = effective === undefined ? WINDOW_AUTO : String(effective);
          const label = effective === undefined ? t('windowAuto') : formatTier(effective);

          const choose = (value) => {
            const size = value === WINDOW_AUTO ? undefined : Number(value);
            windowStore.set(props.sessionId, size);
            if (typeof size === 'number') pushContextWindow(size);
            setOpen(false);
            if (triggerRef.current !== null) triggerRef.current.focus();
          };

          const options = [{ key: 'auto', value: WINDOW_AUTO, label: t('windowAuto') }].concat(
            WINDOW_TIERS.map((tier) => ({ key: String(tier), value: String(tier), label: formatTier(tier) })),
          );

          /* The "default for all Sessions" row mirrors the effective tier: it can only be
           * set while a concrete tier is in effect (an auto Session has nothing to copy). */
          const defaultBudget = windowStore.default();
          const inheritsDefault = typeof effective === 'number' && defaultBudget === effective;
          const defaultIsAuto = typeof effective !== 'number';

          let menu = null;
          if (open && anchor !== null) {
            menu = h(
              'div',
              {
                'data-ui-enhance-menu': '',
                role: 'menu',
                'aria-label': t('windowAria'),
                style: {
                  position: 'fixed',
                  left: Math.round(anchor.left) + 'px',
                  bottom: Math.round(window.innerHeight - anchor.top + 6) + 'px',
                  minWidth: Math.round(Math.max(anchor.width, 78)) + 'px',
                  zIndex: 1200,
                },
              },
              ...options.map((option) =>
                h(
                  'button',
                  {
                    key: option.key,
                    type: 'button',
                    role: 'menuitemradio',
                    'aria-checked': current === option.value ? 'true' : 'false',
                    'data-ui-enhance-menu-item': '',
                    'data-active': current === option.value ? 'true' : undefined,
                    onClick: () => choose(option.value),
                  },
                  h('span', { key: 'label' }, option.label),
                  current === option.value ? h('span', { key: 'check', 'aria-hidden': true }, '✓') : null,
                ),
              ),
              h(
                'button',
                {
                  key: 'default',
                  type: 'button',
                  role: 'menuitemcheckbox',
                  'aria-checked': inheritsDefault ? 'true' : 'false',
                  'aria-disabled': defaultIsAuto ? 'true' : undefined,
                  disabled: defaultIsAuto,
                  'data-ui-enhance-menu-item': '',
                  'data-active': inheritsDefault ? 'true' : undefined,
                  onClick: () => {
                    if (defaultIsAuto) return;
                    windowStore.setDefault(inheritsDefault ? undefined : effective);
                    setOpen(false);
                  },
                },
                h('span', { key: 'label' }, '所有会话默认（含子 Agent）'),
                inheritsDefault ? h('span', { key: 'check', 'aria-hidden': true }, '✓') : null,
              ),
            );
            if (ReactDOM !== null && typeof ReactDOM.createPortal === 'function') {
              menu = ReactDOM.createPortal(menu, document.body);
            }
          }

          return h(
            React.Fragment,
            null,
            h(
              'button',
              {
                ref: triggerRef,
                type: 'button',
                'data-dsh-plugin': 'ui-enhance-window',
                'data-ui-enhance-window': '',
                'aria-haspopup': 'menu',
                'aria-expanded': open ? 'true' : 'false',
                title: t('windowTitle'),
                'aria-label': t('windowAria'),
                onClick: () => {
                  if (open) {
                    setOpen(false);
                    return;
                  }
                  const node = triggerRef.current;
                  if (node !== null) {
                    const rect = node.getBoundingClientRect();
                    setAnchor({ left: rect.left, top: rect.top, width: rect.width });
                  }
                  setOpen(true);
                },
              },
              label,
            ),
            menu,
          );
        }

        /**
         * The reading panel this plugin floats to the left of the composer card: the Turn and
         * Session token/cost totals plus the remaining quota (percent and money). The context
         * budget and the compaction action live in the composer dock instead.
         */
        function HudPanel(props) {
          const sessionId = props.sessionId;
          const useProjection = props.useProjection;
          const useSession = props.useSession;
          const usage = typeof useProjection === 'function' ? useProjection('tokenUsage') : undefined;
          const selection = typeof useProjection === 'function' ? useProjection('modelSelection') : undefined;
          const pressure = typeof useProjection === 'function' ? useProjection('contextPressure') : undefined;
          const running = typeof useSession === 'function' ? useSession((state) => state.running === true) : false;
          const budget = useSessionWindow(sessionId);
          const quota = useQuota();
          const [compacting, setCompacting] = React.useState(false);
          const [failure, setFailure] = React.useState(null);

          // The panel lives in the card's overlay helper (a zero-height positioned div), so it
          // can be placed outside the card: `left` is CSS-relative to the card, and its height
          // is measured to span the card's full height, with the top placed so both bottoms sit
          // level. A very tall editor caps the panel and leaves it bottom-aligned.
          //
          // The measurement writes the two inline styles directly instead of routing them through
          // component state: a state update from a layout effect re-renders synchronously, and a
          // tall composer re-lays itself out while it grows, so measuring → setState → measure could
          // nest until React aborted the whole slot with "Maximum update depth exceeded" (and the
          // overlay then lost the panel). Styling the node imperatively cannot feed back into React.
          const hostRef = React.useRef(null);
          const measureRef = React.useRef(null);
          measureRef.current = () => {
            const node = hostRef.current;
            if (!node || typeof node.closest !== 'function') return;
            const anchor = node.closest('[data-composer-overlay]');
            const card = anchor ? anchor.parentElement : null;
            if (!card || typeof card.getBoundingClientRect !== 'function') return;
            const cardBox = card.getBoundingClientRect();
            const cardHeight = Math.round(cardBox.height);
            if (!(cardHeight > 0)) return;
            const height = Math.min(cardHeight, HUD_MAX_HEIGHT);
            const top = Math.max(0, cardHeight - height);
            node.style.top = top + 'px';
            node.style.height = height > 0 ? height + 'px' : '';
          };

          React.useLayoutEffect(() => {
            if (measureRef.current !== null) measureRef.current();
          });

          React.useEffect(() => {
            const node = hostRef.current;
            const measure = () => {
              if (measureRef.current !== null) measureRef.current();
            };
            const anchor = node && typeof node.closest === 'function' ? node.closest('[data-composer-overlay]') : null;
            const card = anchor ? anchor.parentElement : null;
            let observer = null;
            if (typeof ResizeObserver === 'function' && card) {
              observer = new ResizeObserver(measure);
              observer.observe(card);
              if (node) observer.observe(node);
            }
            window.addEventListener('resize', measure);
            return () => {
              if (observer) observer.disconnect();
              window.removeEventListener('resize', measure);
            };
          }, []);

          const hasUsage = usage !== undefined;
          React.useEffect(() => {
            if (!hasUsage) ensureProjections(sessionId);
          }, [hasUsage, sessionId]);

          const totals = bucketsOf(usage);
          const turn = useTurnUsage(sessionId, usage, running);
          const model = modelOf(selection);
          const turnTokens = bucketTotal(turn);
          const sessionTokens = bucketTotal(totals);

          const used =
            pressure && typeof pressure.projectedTokens === 'number'
              ? pressure.projectedTokens
              : pressure && pressure.pressureTokens;
          const capacity = budget !== undefined ? budget : pressure && pressure.contextWindow;
          const percent =
            typeof used === 'number' && typeof capacity === 'number' && capacity > 0
              ? Math.min(100, Math.round((used / capacity) * 100))
              : 0;

          const onCompact = async () => {
            if (compacting) return;
            setCompacting(true);
            setFailure(null);
            try {
              await runCompact(sessionId);
            } catch (error) {
              setFailure(fill(t('compactFailed'), { error: String((error && error.message) || error) }));
            } finally {
              setCompacting(false);
            }
          };

          // A per-session budget is not something the shipped threshold knows about, so the host
          // side of this plugin also mirrors the budget map and compacts mid-turn at the tier.
          // This client-side pass stays as a fallback for when the host path is unavailable: it can
          // only run while the turn is idle, which is why the host listener does the in-turn work.
          const autoArmed = budget !== undefined;
          React.useEffect(() => {
            if (!autoArmed || running || compacting || activeCompactions.has(sessionId)) return;
            if (percent < AUTO_COMPACT_PERCENT) return;
            const nowMs = Date.now();
            const last = autoCompactAt.get(sessionId) || 0;
            if (nowMs - last < AUTO_COMPACT_COOLDOWN_MS) return;
            autoCompactAt.set(sessionId, nowMs);
            void onCompact();
          }, [autoArmed, running, compacting, percent, sessionId]);

          const data = quota.phase === 'ready' ? quota.data : null;
          const buckets = data && data.buckets ? data.buckets : null;
          const main = buckets ? buckets.thirdparty : null;
          const claude = buckets ? buckets.claude : null;
          const codex = buckets ? buckets.codex : null;

          // The relay's weights win: they are what this account is actually charged, and they
          // already carry the peak-period multiplier. The shipped catalog is the fallback.
          const weights = data && data.modelWeights ? data.modelWeights : null;
          const relayRate = relayRateFor(weights, model);
          const rate = relayRate || priceFor(model);
          const turnCost = costOf(turn, rate);
          const sessionCost = costOf(totals, rate);
          const weeklyTotal = main && typeof main.weeklyQuota === 'number' ? main.weeklyQuota : null;
          const weeklyRest = main && typeof main.weeklyRemaining === 'number' ? main.weeklyRemaining : null;
          let quotaPercent = null;
          if (weeklyTotal !== null && weeklyTotal > 0 && weeklyRest !== null) {
            quotaPercent = Math.max(0, Math.min(100, (weeklyRest / weeklyTotal) * 100));
          }

          let quotaValue;
          let quotaMoney = null;
          if (quota.phase === 'loading') quotaValue = t('quotaShortPending');
          else if (main === null || weeklyRest === null) quotaValue = t('quotaShortUnknown');
          else if (weeklyTotal === 0) {
            quotaValue = t('quotaShortUnlimited');
            quotaMoney = t('quotaShortUnlimited');
          } else if (quotaPercent === null) quotaValue = t('quotaShortUnknown');
          else {
            quotaValue = fill(t('quotaShort'), { percent: formatPercent(quotaPercent) });
            quotaMoney = formatQuotaMoney(weeklyRest / W);
          }

          const over = Boolean(main && main.overWeekly);
          const warnStyle = over ? { color: 'var(--dsw-alias-state-warn-primary)' } : undefined;
          const lines = [];
          if (main) {
            lines.push(
              fill(t('tipWeekly'), {
                quota: weeklyTotal === null || weeklyTotal === 0 ? t('unlimited') : amount(weeklyTotal),
                used: amount(main.weeklyUsed),
                rest: amount(weeklyRest),
              }) + (quotaPercent === null ? '' : ' (' + formatPercent(quotaPercent) + '%)'),
            );
          }
          if (claude) {
            lines.push(fill(t('tipClaude'), { rest: amount(claude.weeklyRemaining), quota: amount(claude.weeklyQuota) }));
          }
          if (codex) lines.push(t('tipCodex'));
          if (quota.phase === 'ready' && quota.fetchedAt) {
            lines.push(fill(t('tipUpdated'), { time: formatClock(new Date(quota.fetchedAt)) }));
          }
          if (quota.phase === 'error') lines.push(fill(t('tipError'), { error: quota.error }));
          if (rate === null) lines.push(t('tipPriceUnknown'));
          else if (relayRate !== null)
            lines.push(
              fill(t('tipRateRelay'), {
                input: relayRate.input,
                output: relayRate.output,
                cacheRead: relayRate.cacheRead,
                cacheWrite: relayRate.cacheWrite,
              }),
            );
          else
            lines.push(
              fill(t('tipPrice'), {
                input: rate.input,
                output: rate.output,
                cacheRead: rate.cacheRead,
                cacheWrite: rate.cacheWrite,
              }),
            );
          lines.push(
            budget === undefined
              ? t('tipBudgetAuto')
              : fill(t('tipBudget'), { budget: formatTier(budget), percent: AUTO_COMPACT_PERCENT }),
          );
          if (failure) lines.push(failure);
          lines.push(t('tipKeys'));

          const usageRow = (key, label, tokens, cost) => {
            const known = typeof tokens === 'number';
            return h(
              'div',
              { key, 'data-ui-enhance-hud-row': '' },
              h('span', { key: 'label', 'data-ui-enhance-hud-label': '' }, label),
              h('span', { key: 'value', 'data-ui-enhance-hud-value': '' }, known ? formatAmount(tokens) : '—'),
              known ? h('span', { key: 'unit', 'data-ui-enhance-hud-unit': '' }, t('hudTokens')) : null,
              known ? h('span', { key: 'cost', 'data-ui-enhance-hud-cost': '' }, formatMoney(cost)) : null,
            );
          };

          return h(
            'div',
            {
              ref: hostRef,
              'data-dsh-plugin': 'ui-enhance-hud',
              'data-ui-enhance-hud': '',
              title: lines.join('\n'),
            },
            usageRow('turn', t('hudTurn'), turnTokens, turnCost),
            usageRow('session', t('hudSession'), sessionTokens, sessionCost),
            // Remaining quota reads as money aligned with the two cost columns above: the amount
            // is right-aligned by the same `hud-cost` rule (`margin-left:auto`).
            h(
              'div',
              { key: 'quota', 'data-ui-enhance-hud-row': '' },
              h('span', { key: 'label', 'data-ui-enhance-hud-label': '' }, t('hudQuota')),
              h('span', { key: 'value', 'data-ui-enhance-hud-value': '', style: warnStyle }, quotaValue),
              quotaMoney === null
                ? null
                : h('span', { key: 'cost', 'data-ui-enhance-hud-cost': '', style: warnStyle }, quotaMoney),
            ),
          );
        }

        /**
         * The shipped dock row under the composer card: the per-session context budget and the
         * manual compaction action, sitting next to the shipped context ring. The token/cost
         * readings live in the floating panel to the left of the card.
         */
        function DockControls(props) {
          const sessionId = props.sessionId;
          // DockControls mounts once per open Session, so it is the natural host for the
          // page-wide focus highlight (#9); the veil (#8) is a plain stylesheet attribute.
          usePaneFocus(true);
          const budget = useSessionWindow(sessionId);
          const hostOpen = useOpenCompaction(sessionId);
          const [compacting, setCompacting] = React.useState(false);
          const [stopping, setStopping] = React.useState(false);
          const [failure, setFailure] = React.useState(null);
          const [notice, setNotice] = React.useState(null);
          const [clearArmed, setClearArmed] = React.useState(false);
          const [clearing, setClearing] = React.useState(false);
          const abortRequested = React.useRef(false);
          const graceTimer = React.useRef(null);
          const clearTimer = React.useRef(null);

          React.useEffect(
            () => () => {
              if (graceTimer.current !== null) window.clearTimeout(graceTimer.current);
              if (clearTimer.current !== null) window.clearTimeout(clearTimer.current);
            },
            [],
          );

          // Diagnostics: does this page actually expose the workspace service the clear action needs?
          React.useEffect(() => {
            const workspace = uiWorkspace || (typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : null);
            probe('clear-mount', {
              sessionId: bareSessionId(sessionId),
              workspace: workspace ? typeof workspace : 'none',
              start: !!(workspace && typeof workspace.startSession === 'function'),
            });
          }, []);

          // A compaction is in flight when this page started one, when the Host reports one the
          // Session opened and never closed, or while a stop is being delivered. A Host-reported
          // compaction only offers the stop action once it has outlived a normal summary, so a
          // routine mid-turn auto compaction never flashes the button.
          const stuck =
            hostOpen !== null &&
            typeof hostOpen.at === 'number' &&
            Date.now() - hostOpen.at >= COMPACT_STUCK_MS;
          const busy = compacting || stopping || stuck;

          const onCompact = async () => {
            if (busy) return;
            abortRequested.current = false;
            setCompacting(true);
            setFailure(null);
            setNotice(null);
            try {
              await runCompact(sessionId);
            } catch (error) {
              if (!abortRequested.current) {
                setFailure(fill(t('compactFailed'), { error: String((error && error.message) || error) }));
              }
            } finally {
              setCompacting(false);
            }
          };

          const onAbort = async () => {
            if (stopping) return;
            abortRequested.current = true;
            setStopping(true);
            setFailure(null);
            setNotice(null);
            try {
              const outcome = await abortSession(sessionId);
              setNotice(outcome === 'gone' ? t('compactGone') : t('compactStopped'));
            } catch (error) {
              abortRequested.current = false;
              setFailure(fill(t('compactFailed'), { error: String((error && error.message) || error) }));
            } finally {
              setStopping(false);
              // A command request that the Host aborted mid-summary may never settle, so the
              // local lock is released on a timer instead of waiting for that promise.
              if (graceTimer.current !== null) window.clearTimeout(graceTimer.current);
              graceTimer.current = window.setTimeout(() => {
                graceTimer.current = null;
                activeCompactions.delete(sessionId);
                setCompacting(false);
              }, ABORT_GRACE_MS);
            }
          };

          const disarmClear = () => {
            if (clearTimer.current !== null) {
              window.clearTimeout(clearTimer.current);
              clearTimer.current = null;
            }
            setClearArmed(false);
          };

          /**
           * Open a blank Session in the current workspace and switch to it. The Session log is
           * append-only, so the context of this one cannot be reset in place: leaving it (it stays
           * in the sidebar history) and starting a fresh blank Session is the equivalent, and it
           * also hands the composer a clean transcript.
           */
          const startFreshSession = () => {
            const workspace = uiWorkspace || (typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : null);
            if (!workspace || typeof workspace.startSession !== 'function') {
              setClearing(false);
              setFailure(t('clearUnavailable'));
              return;
            }
            try {
              const started = workspace.startSession();
              if (started && typeof started.catch === 'function') started.catch(() => {});
            } catch (error) {
              setClearing(false);
              setFailure(fill(t('clearFailed'), { error: String((error && error.message) || error) }));
            }
          };

          const onClear = async () => {
            if (clearing) return;
            // First click only arms the action; a stray click must never drop the transcript.
            if (!clearArmed) {
              setClearArmed(true);
              setFailure(null);
              setNotice(null);
              probe('clear-arm', { sessionId: bareSessionId(sessionId) });
              if (clearTimer.current !== null) window.clearTimeout(clearTimer.current);
              clearTimer.current = window.setTimeout(() => {
                clearTimer.current = null;
                setClearArmed(false);
              }, CLEAR_ARM_MS);
              return;
            }
            disarmClear();
            setClearing(true);
            setFailure(null);
            setNotice(null);
            probe('clear-go', { sessionId: bareSessionId(sessionId) });
            // Stop this Session's in-flight turn first: the abandoned Session must not keep
            // consuming quota in the background. Cancelling an idle agent is a no-op, and a slow
            // cancel must never keep the user on the transcript they asked to leave.
            try {
              await Promise.race([
                abortSession(sessionId),
                new Promise((resolve) => window.setTimeout(resolve, CLEAR_ABORT_MS)),
              ]);
            } catch (error) {
              /* an unreachable abort route must not block the switch */
            }
            window.setTimeout(() => setClearing(false), CLEAR_RESET_MS);
            startFreshSession();
          };

          const showStop = compacting || stopping || stuck;
          const label = stopping ? t('compactStopping') : showStop ? t('compactStop') : t('compact');
          const clearLabel = clearing ? t('clearBusy') : clearArmed ? t('clearArm') : t('clearShort');
          const clearTitle = clearing ? t('clearBusy') : clearArmed ? t('clearConfirm') : t('clearTitle');
          const title =
            stopping
              ? t('compactStopping')
              : failure ||
                notice ||
                (showStop
                  ? t('compactStop')
                  : budget === undefined
                    ? t('compact')
                    : fill(t('compactAuto'), { percent: AUTO_COMPACT_PERCENT }) + ' · ' + t('compact'));

          return h(
            'div',
            { 'data-dsh-plugin': 'ui-enhance-dock', 'data-ui-enhance-dock': '' },
            h(WindowSelect, { key: 'window', sessionId }),
            h(
              'button',
              {
                key: 'compact',
                type: 'button',
                'data-ui-enhance-compact': '',
                'data-ui-enhance-compact-stop': showStop ? '' : undefined,
                title,
                'aria-label': label,
                disabled: stopping,
                // Keep the composer focused: compacting must not steal the caret.
                onMouseDown: (event) => event.preventDefault(),
                onClick: showStop ? onAbort : onCompact,
              },
              h(
                'svg',
                { viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': true },
                showStop
                  ? h('rect', { x: 4, y: 4, width: 8, height: 8, rx: 1.5, fill: 'currentColor' })
                  : h('path', {
                      d: 'M6 2.5v3.5H2.5M10 13.5V10h3.5M2.5 6L6 2.5M13.5 10L10 13.5',
                      fill: 'none',
                      stroke: 'currentColor',
                      strokeWidth: 1.4,
                      strokeLinecap: 'round',
                      strokeLinejoin: 'round',
                    }),
              ),
            ),
            h(
              'button',
              {
                key: 'clear',
                type: 'button',
                'data-ui-enhance-clear': '',
                'data-ui-enhance-clear-armed': clearArmed ? '' : undefined,
                title: clearTitle,
                'aria-label': clearArmed ? t('clearConfirm') : t('clearLabel'),
                disabled: clearing,
                // Keep the composer focused, like the compaction action beside it.
                onMouseDown: (event) => event.preventDefault(),
                onClick: onClear,
                // Clicking away cancels the armed state instead of leaving it hot.
                onBlur: () => {
                  if (clearArmed) disarmClear();
                },
              },
              h(
                'svg',
                {
                  viewBox: '0 0 16 16',
                  width: 12,
                  height: 12,
                  'aria-hidden': true,
                  style: { marginRight: 3, flex: 'none' },
                },
                h('path', {
                  // Speech bubble with a plus: "start a new, empty conversation".
                  d: 'M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v6A1.5 1.5 0 0 1 12.5 11H7.5L4 14v-3H3.5A1.5 1.5 0 0 1 2 9.5zM8 4.5v4M6 6.5h4',
                  fill: 'none',
                  stroke: 'currentColor',
                  strokeWidth: 1.3,
                  strokeLinecap: 'round',
                  strokeLinejoin: 'round',
                }),
              ),
              h('span', { key: 'label' }, clearLabel),
            ),
          );
        }

        /**
         * Beautify entry point: one small button in the composer dock, beside the context
         * controls, opening the settings popover. The popover is portal-mounted for the same
         * reason the budget menu is — the dock clips its overflow.
         */

        /* ─────────────────────────────────────────────────────────────────────────
         * 美化面板入口（重写版）
         *
         * 这一版刻意做成最小实现，因为旧实现无法收敛：setOpen(true) 后整个子树被
         * React 卸载，而关闭路径一条日志都没打出来过，说明问题在渲染而不是交互。
         * 因此这里遵守四条硬规则：
         *
         *   1. 没有任何自定义 hook。旧版在渲染体里调用 useBeautifyState/useWindowState，
         *      一旦它们改动了 hook 数量，React 就会抛错并卸载整棵子树。
         *   2. 渲染体不做任何计算。旧版在 useState 初始化器里读 shaderWork、在 JSX 里
         *      算 anchor 坐标，任何一次读取失败都会炸掉整次渲染。
         *   3. 面板用纯 CSS 定位（右侧、底部锚定），不依赖 getBoundingClientRect。
         *      旧版靠 anchor 坐标定位，anchor 与 open 是两个 state，存在渲染时 anchor
         *      仍为 null 的窗口。
         *   4. 面板内部的一切包裹在 ErrorBoundary 里。即使将来某段功能出错，按钮和
         *      面板外壳也还在，用户能看到错误而不是看到一个凭空消失的按钮。
         * ───────────────────────────────────────────────────────────────────────── */

        /** Keeps a render error from tearing down the whole seat. */
        class BeautifyPanelBoundary extends React.Component {
          constructor(props) {
            super(props);
            this.state = { error: null };
          }

          static getDerivedStateFromError(error) {
            return { error: error };
          }

          componentDidCatch(error) {
            probe('beautify-boundary', { msg: String((error && error.message) || error) });
          }

          render() {
            if (this.state.error === null) return this.props.children;
            return h(
              'div',
              { className: 'ue-panel-error' },
              h('div', null, '面板渲染出错'),
              h('div', { className: 'ue-panel-error-msg' }, String((this.state.error && this.state.error.message) || this.state.error)),
            );
          }
        }

        /**
         * The beautify controls as a global panel in the right-hand column.
         *
         * The composer popover holds the same controls but only exists while a session
         * is open, so nothing in the sidebar exposed the radius/gap/blur/alpha sliders.
         * This panel reuses `BeautifyPanelBody`, so the two seats cannot drift apart.
         */
        function BeautifyPanelIcon(props) {
          const size = props && typeof props.size === 'number' ? props.size : 18;
          return h(
            'svg',
            {
              width: size,
              height: size,
              viewBox: '0 0 16 16',
              'aria-hidden': true,
              style: { display: 'block' },
            },
            h('path', {
              d: 'M8 1.6l1.36 3.04L12.4 6l-3.04 1.36L8 10.4 6.64 7.36 3.6 6l3.04-1.36z',
              fill: 'currentColor',
            }),
          );
        }

        function BeautifyPanelMain() {
          return h(
            'div',
            { 'data-ue-ask': 'panel', className: 'ue-panel' },
            h(BeautifyPanelBody, null),
          );
        }

        function BeautifyPanelBody() {
          const state = useBeautifyState();
          const winState = useWindowState();
          /* Presets live in localStorage, not in the store: they are a user list, not
           * a setting. Re-reading them on every render is a handful of array entries
           * and keeps the panel correct after any external write. */
          const [presets, setPresets] = React.useState(() => readCustomPresets());
          const [presetName, setPresetName] = React.useState('');
          const [pullId, setPullId] = React.useState('');
          const [busy, setBusy] = React.useState('');

          const setBeautify = (patch) => beautifyStore.set(Object.assign({}, beautifyStore.get(), patch));

          /* The beautify store keys the master switch as `on`; `normalizeBeautify`
           * drops any unknown field, so writing `enabled` silently did nothing and the
           * toggle read as dead. */
          const toggleOn = () => setBeautify({ on: state.on === false });

          const savePreset = () => {
            const name = String(presetName || '').trim();
            if (name === '') return;
            /* Snapshot exactly what the panel can restore: backdrop mode, its source,
             * and the two glass knobs. The master switch is deliberately excluded so
             * a preset never turns the effect on or off behind the user's back. */
            const params = {
              mode: state.mode,
              solid: state.solid,
              image: state.image,
              shaderId: state.shaderId,
              glassBlur: state.glassBlur,
              glassAlpha: state.glassAlpha,
              perfTier: state.perfTier,
            };
            /* The work travels with the preset. Without this a preset only remembered
             * the ID, so restoring it showed an empty backdrop -- the report "the preset
             * is empty even though a shader is running". */
            const work = state.mode === 'shader' ? copyWork(shaderWork) : null;
            const next = readCustomPresets().filter((item) => item.name !== name);
            next.push({ id: 'user-' + Date.now().toString(36), name, params, work });
            if (writeCustomPresets(next)) {
              setPresets(readCustomPresets());
              setPresetName('');
              shaderStatus.set('已保存「' + name + '」', 'ok');
            } else {
              shaderStatus.set('保存失败：本地存储已满', 'warn');
            }
          };

          const deletePreset = (id) => {
            const next = readCustomPresets().filter((item) => item.id !== id);
            if (writeCustomPresets(next)) {
              setPresets(readCustomPresets());
              if (state.presetId === id) setBeautify({ presetId: '' });
              shaderStatus.set('已删除预设', 'info');
            }
          };

          const applyPreset = (item) => {
            if (!item || !item.params) return;
            /* Restore the work BEFORE the settings, because turning shader mode on
             * renders immediately and would otherwise paint one frame of nothing. */
            if (item.work && typeof item.work === 'object') {
              shaderWorkStore.set(copyWork(item.work), String(item.params.shaderId || ''));
              if (beautifyShader !== null) {
                if (Object.keys(shaderTextures).length === 0 && item.params.shaderId) {
                  // Textures are not stored in presets; refilling them is cheap and the
                  // work still renders meanwhile with its placeholders.
                  loadShaderWork(item.params.shaderId, false).catch(() => {});
                } else {
                  beautifyShader.setWork(shaderWork, shaderTextures);
                }
              }
            }
            setBeautify(Object.assign({}, item.params, { presetId: item.id }));
            shaderStatus.set('已应用「' + item.name + '」', 'ok');
          };

          /* Pull a ShaderToy work by id, persist it as a preset, and make it current.
           * `loadShaderWork` owns the network round-trip and the challenge the Host
           * performs, so the panel only waits on the resulting state. */
          const pullAndSave = async () => {
            const id = parseShaderId(pullId);
            /* Name the id and what was parsed before anything can fail. A click that
             * produced no visible text at all was indistinguishable from a click that
             * never reached this handler, and the panel is the only place that can
             * tell the difference. */
            probe('beautify-pull', { phase: 'start', raw: String(pullId || '').slice(0, 80), id });
            if (id === '') {
              shaderStatus.set('请输入 ShaderToy 链接或 ID', 'warn');
              return;
            }
            setBusy('pull');
            shaderStatus.set('正在拉取 ' + id + ' …', 'info');
            /* `loadShaderWork` reports failures through `shaderStatus` and returns; it
             * never throws. Success is decided from the work store below. */
            try {
              await loadShaderWork(id, true);
            } catch (error) {
              probe('beautify-pull', { phase: 'threw', msg: String((error && error.message) || error) });
              shaderStatus.set('拉取失败：' + String((error && error.message) || error), 'warn');
              setBusy('');
              return;
            }
            /* Decide success from what the pull actually persisted, not from the
             * closure variable: this handler closes over `shaderWorkId` from an
             * earlier render, so a successful pull read as stale and the code path
             * reported "拉取未完成" while the work was in fact stored. */
            const stored = readShaderWork();
            probe('beautify-pull', {
              phase: 'stored',
              ok: stored !== null && stored.id === id,
              got: stored !== null ? String(stored.id || '') : null,
              status: String(shaderStatus.get().text || ''),
            });
            if (stored === null || stored.id !== id) {
              /* Name the reason the pull produced no work instead of overwriting the
               * message `loadShaderWork` just wrote -- that message carries the HTTP
               * status or parse failure, which is the only actionable detail here. */
              const reported = String(shaderStatus.get().text || '');
              if (reported === '' || reported === '正在拉取 ' + id + ' …') shaderStatus.set('拉取未完成，请重试', 'warn');
              setBusy('');
              return;
            }
            {
              const shaderName = String(presetName || '').trim() || ('Shader ' + id);
              /* The work travels with the preset, exactly as `savePreset` does. A
               * preset holding only an id renders an empty backdrop once the work
               * store is cleared or the id is later retired by the site. */
              const params = {
                mode: 'shader',
                shaderId: id,
                solid: state.solid,
                image: state.image,
                glassBlur: state.glassBlur,
                glassAlpha: state.glassAlpha,
                perfTier: state.perfTier,
              };
              const next = readCustomPresets().filter((item) => item.name !== shaderName);
              next.push({
                id: 'user-' + Date.now().toString(36),
                name: shaderName,
                params,
                work: copyWork(stored.work),
              });
              const saved = writeCustomPresets(next);
              if (saved) setPresets(readCustomPresets());
              setBeautify(Object.assign({}, params));
              /* Give feedback in every outcome. The path used to clear the fields and
               * say nothing, which is indistinguishable from the button doing nothing. */
              shaderStatus.set(
                saved ? '已保存「' + shaderName + '」' : bt('beautifyStorageFull'),
                saved ? 'ok' : 'warn',
              );
              setPresetName('');
              setPullId('');
              setBusy('');
            }
          };

          const tierButton = (tier, label) =>
            h(
              'button',
              {
                type: 'button',
                className: 'ue-panel-toggle ue-panel-tier',
                'data-on': (state.perfTier || 'medium') === tier ? 'true' : 'false',
                onClick: () => setBeautify({ perfTier: tier }),
              },
              label,
            );

          return h(
            React.Fragment,
            null,
            h(
              'div',
              { className: 'ue-panel-head' },
              h('span', { className: 'ue-panel-title' }, '界面美化'),
              h('span', { className: 'ue-panel-sub' }, 'v' + CLIENT_BUILD),
            ),

            h(
              'div',
              { className: 'ue-panel-sec' },
              h('div', { className: 'ue-panel-label' }, '背景特效'),
              h(
                'div',
                { className: 'ue-panel-row' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'ue-panel-toggle',
                    'data-on': state.on !== false ? 'true' : 'false',
                    onClick: toggleOn,
                  },
                  state.on !== false ? '已开启' : '已关闭',
                ),
              ),
            ),

            h(
              'div',
              { className: 'ue-panel-sec' },
              h('div', { className: 'ue-panel-label' }, '性能'),
              h('div', { className: 'ue-panel-row ue-panel-tiers' }, tierButton('high', '高 100%'), tierButton('medium', '中 50%'), tierButton('low', '低 25%')),
              h('div', { className: 'ue-panel-hint' }, '全部 ' + PERF_PROFILE.high.fps + 'fps · 分辨率 ' + Math.round(PERF_PROFILE.high.pixels * 100) + '% / ' + Math.round(PERF_PROFILE.medium.pixels * 100) + '% / ' + Math.round(PERF_PROFILE.low.pixels * 100) + '%'),
            ),

            h(
              'div',
              { className: 'ue-panel-sec' },
              h('div', { className: 'ue-panel-label' }, 'Shader 拉取'),
              h('input', {
                type: 'text',
                className: 'ue-panel-input',
                placeholder: 'ShaderToy 链接或 ID',
                value: pullId,
                onChange: (event) => setPullId(event.target.value),
                /* Enter starts the pull. Without a keyboard path the only way in was
                 * the button, and a click that the panel swallowed looked like a dead
                 * control with no way to retry from the keyboard.
                 *
                 * `event.isComposing` is checked because these fields receive CJK text:
                 * an Enter that commits an IME candidate must not start a 20-second
                 * network pull. */
                onKeyDown: (event) => {
                  if (event.key !== 'Enter' || event.isComposing) return;
                  event.preventDefault();
                  if (busy === 'pull') return;
                  void pullAndSave();
                },
              }),
              h('input', {
                type: 'text',
                className: 'ue-panel-input',
                placeholder: '预设名称（留空自动命名）',
                value: presetName,
                onChange: (event) => setPresetName(event.target.value),
                /* Enter here also pulls: the name is only meaningful together with the
                 * id above, so the two fields read as one form. Typing "夕阳" is
                 * Chinese input, so an IME-confirming Enter is excluded. */
                onKeyDown: (event) => {
                  if (event.key !== 'Enter' || event.isComposing) return;
                  event.preventDefault();
                  if (busy === 'pull') return;
                  void pullAndSave();
                },
              }),
              h(
                'div',
                { className: 'ue-panel-row' },
                h(
                  'button',
                  { type: 'button', className: 'ue-panel-btn', disabled: busy === 'pull', onClick: pullAndSave },
                  busy === 'pull' ? '拉取中…' : '拉取并保存',
                ),
                h(
                  'button',
                  { type: 'button', className: 'ue-panel-btn', onClick: savePreset },
                  '保存当前为预设',
                ),
              ),
            ),

            h(
              'div',
              { className: 'ue-panel-sec' },
              h('div', { className: 'ue-panel-label' }, '预设（' + presets.length + ' 个自定义）'),
              presets.length === 0
                ? h('div', { className: 'ue-panel-hint' }, '还没有保存的预设')
                : h(
                    'div',
                    { className: 'ue-panel-presets' },
                    ...presets.map((item) =>
                      h(
                        'div',
                        {
                          key: item.id,
                          className: 'ue-panel-preset',
                          'data-active': state.presetId === item.id ? 'true' : 'false',
                        },
                        h(
                          'button',
                          { type: 'button', className: 'ue-panel-preset-name', onClick: () => applyPreset(item) },
                          item.name,
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'ue-panel-preset-del',
                            title: '删除',
                            'aria-label': '删除 ' + item.name,
                            onClick: () => deletePreset(item.id),
                          },
                          '×',
                        ),
                      ),
                    ),
                  ),
            ),

            h(
              'div',
              { className: 'ue-panel-sec' },
              h('div', { className: 'ue-panel-label' }, '窗口模式'),
              h(
                'div',
                { className: 'ue-panel-row' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'ue-panel-toggle',
                    'data-on': winState.on ? 'true' : 'false',
                    onClick: () => windowModeStore.set({ on: !winState.on }),
                  },
                  winState.on ? '已开启' : '已关闭',
                ),
              ),
            ),

            h(
              'div',
              { className: 'ue-panel-sec' },
              h('div', { className: 'ue-panel-label' }, '窗口圆角 ' + Math.round(winState.radius) + 'px'),
              h('input', {
                type: 'range',
                className: 'ue-panel-range',
                min: 0,
                max: 32,
                step: 1,
                value: winState.radius,
                onChange: (event) => windowModeStore.set({ radius: Number(event.target.value) }),
              }),
            ),

            h(
              'div',
              { className: 'ue-panel-sec' },
              h('div', { className: 'ue-panel-label' }, '窗口间隙 ' + Math.round(winState.gap) + 'px'),
              h('input', {
                type: 'range',
                className: 'ue-panel-range',
                min: 0,
                max: 24,
                step: 1,
                value: winState.gap,
                onChange: (event) => windowModeStore.set({ gap: Number(event.target.value) }),
              }),
            ),

            h(
              'div',
              { className: 'ue-panel-sec' },
              h('div', { className: 'ue-panel-label' }, '背景模糊 ' + Math.round(winState.blur) + 'px'),
              h('input', {
                type: 'range',
                className: 'ue-panel-range',
                min: 0,
                max: 40,
                step: 1,
                value: winState.blur,
                onChange: (event) => windowModeStore.set({ blur: Number(event.target.value) }),
              }),
            ),

            h(
              'div',
              { className: 'ue-panel-sec' },
              h('div', { className: 'ue-panel-label' }, '窗口不透明度 ' + Math.round(winState.alpha) + '%'),
              h('input', {
                type: 'range',
                className: 'ue-panel-range',
                min: 20,
                max: 95,
                step: 1,
                value: winState.alpha,
                onChange: (event) => windowModeStore.set({ alpha: Number(event.target.value) }),
              }),
            ),
          );
        }

        function BeautifyAskButton() {
          const [ui, setUi] = React.useState({ open: false });

          const toggle = React.useCallback((event) => {
            if (event && event.target) {
              const t = event.target;
              probe('ask-toggle', {
                tag: t.nodeType === 1 ? String(t.tagName || '?').toLowerCase() : String(t.nodeType),
                isElement: t.nodeType === 1,
              });
            }
            setUi((prev) => {
              const open = !prev.open;
              probe('beautify-toggle', { open: open });
              return { open: open };
            });
          }, []);

          // Close on Escape and on a click outside both the button and the panel.
          React.useEffect(() => {
            if (!ui.open) return undefined;

            const onKey = (event) => {
              if (event.key === 'Escape') setUi({ open: false });
            };
            const onDown = (event) => {
              /**
               * Decide "outside" without ever trusting the event target to be an
               * Element. A press on a text node, on an SVG glyph inside the button, or
               * on any node whose parent chain stops early used to fall through to
               * `cursor = null` and be classified as OUTSIDE, which closed the panel
               * on the very press that was meant to use it -- the "the toggle cannot be
               * clicked" report. Resolve the originating element defensively, then walk
               * the parent chain; only a complete walk that never meets the panel or
               * its trigger counts as outside.
               */
              const raw = event && event.target ? event.target : null;
              /* Diagnostics for the "toggle cannot be clicked" report: record the raw
               * target, its resolved element, and the walk that decides inside/outside. */
              const dbg = {
                rawType: raw === null ? 'null' : String(raw.nodeType),
                rawTag: raw && raw.nodeType === 1 ? String(raw.tagName || '?').toLowerCase() : String(raw && raw.nodeType),
                chain: [],
              };
              let cursor = raw;
              // A text node (nodeType 3) still knows its element parent.
              if (cursor && cursor.nodeType !== 1) cursor = cursor.parentElement || null;
              // Anything else non-element simply cannot be outside a panel we own.
              if (cursor === null || cursor === undefined) return;

              let inside = false;
              for (let depth = 0; cursor && depth < 128; depth += 1) {
                if (cursor.nodeType === 1) {
                  if (dbg.chain.length < 8) {
                    dbg.chain.push(
                      String(cursor.tagName || '?').toLowerCase() +
                        (cursor.hasAttribute && cursor.hasAttribute('data-ue-ask') ? '#PANEL' : '') +
                        (cursor.hasAttribute && cursor.hasAttribute('data-ue-ask-btn') ? '#BTN' : ''),
                    );
                  }
                  if (cursor.hasAttribute && cursor.hasAttribute('data-ue-ask')) { inside = true; break; }
                  if (cursor.hasAttribute && cursor.hasAttribute('data-ue-ask-btn')) { inside = true; break; }
                }
                cursor = cursor.parentNode || null;
                if (cursor && cursor.nodeType !== 1) cursor = cursor.parentElement || cursor.parentNode || null;
              }
              dbg.inside = inside;
              probe('ask-outside', dbg);
              if (!inside) setUi({ open: false });
            };

            document.addEventListener('keydown', onKey, true);
            document.addEventListener('pointerdown', onDown, true);
            return () => {
              document.removeEventListener('keydown', onKey, true);
              document.removeEventListener('pointerdown', onDown, true);
            };
          }, [ui.open]);

          const panel = ui.open
            ? h(
                BeautifyPanelBoundary,
                null,
                h(
                  'div',
                  { 'data-ue-ask': '', role: 'dialog', 'aria-label': '界面美化' },
                  h(BeautifyPanelBody, null),
                ),
              )
            : null;

          return h(
            React.Fragment,
            null,
            h(
              'button',
              {
                'data-ue-ask-btn': '',
                type: 'button',
                title: '界面美化',
                'aria-label': '界面美化',
                'aria-haspopup': 'dialog',
                'aria-expanded': ui.open ? 'true' : 'false',
                onMouseDown: (event) => event.preventDefault(),
                onClick: toggle,
              },
              h(
                'svg',
                { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, style: { flex: 'none' } },
                h('path', {
                  d: 'M8 1.6l1.36 3.04L12.4 6l-3.04 1.36L8 10.4 6.64 7.36 3.6 6l3.04-1.36z',
                  fill: 'currentColor',
                }),
              ),
            ),
            panel,
          );
        }

        function BeautifyButton() {
          // beautify-render-probe: fires only if React actually renders this seat.
          React.useEffect(() => {
            probe('beautify-render', { v: '0.9.26' });
            return () => probe('beautify-unmount', {});
          }, []);
          /* TEMPORARY: capture the real exception text.
           *
           * The DOM probe proved the whole seat is torn down after setOpen(true), which
           * only React does when a render throws. Guessing which line threw is what cost
           * the previous rounds, so record the message and stack instead. */
          React.useEffect(() => {
            const onErr = (event) => {
              const e = event && event.error;
              probe('beautify-error', {
                msg: String((e && e.message) || (event && event.message) || 'unknown'),
                stack: String((e && e.stack) || '').split('\n').slice(0, 4).join(' | '),
              });
            };
            const onRej = (event) => {
              const r = event && event.reason;
              probe('beautify-reject', { msg: String((r && r.message) || r || 'unknown') });
            };
            window.addEventListener('error', onErr, true);
            window.addEventListener('unhandledrejection', onRej, true);
            return () => {
              window.removeEventListener('error', onErr, true);
              window.removeEventListener('unhandledrejection', onRej, true);
            };
          }, []);
          const state = useBeautifyState();
          const winState = useWindowState();
          const [open, setOpen] = React.useState(false);
          const [anchor, setAnchor] = React.useState(null);
          const [imageUrl, setImageUrl] = React.useState(state.image);
          const [shaderInput, setShaderInput] = React.useState(state.shaderId);
          const [codeDraft, setCodeDraft] = React.useState(() => {
            const pass = imagePassOfWork(shaderWork);
            return pass !== null ? String(pass.code || '') : '';
          });
          const [presetName, setPresetName] = React.useState('');
          const [customs, setCustoms] = React.useState(() => readCustomPresets());
          const [shader, setShader] = React.useState(() => shaderStatus.get());
          const [notice, setNotice] = React.useState(null);
          const triggerRef = React.useRef(null);

          React.useEffect(() => shaderStatus.subscribe(() => setShader(shaderStatus.get())), []);

          // A fetch replaces the work, so the editor follows it. Typing does not round-trip
          // through this effect: it writes into `shaderWork` itself and keeps its own text,
          // so the caret never jumps while the renderer is recompiled underneath.
          React.useEffect(
            () =>
              shaderWorkStore.subscribe(() => {
                const pass = imagePassOfWork(shaderWork);
                setCodeDraft(pass !== null ? String(pass.code || '') : '');
              }),
            [],
          );

          React.useEffect(() => {
            if (!open) return undefined;
            /* Is this node part of the panel or its trigger? Answered WITHOUT
             * `instanceof Element`: in the desktop client the event target can come
             * from a different realm than this module (a re-evaluated bundle, an
             * iframe), and `instanceof` then returns false for real DOM nodes. Every
             * click would look "outside" and close the panel instantly -- which is the
             * reported "click and it disappears".
             *
             * `nodeType === 1` plus a structural `closest` walk is realm-independent. */
            const inside = (node) => {
              if (!node || node.nodeType !== 1) return false;
              /* Pure ancestor walk, no `contains` call.
               *
               * `Node.contains` is a method on the node's OWN realm's prototype. When the
               * event target comes from a different realm (a re-evaluated bundle, an
               * iframe) the call is not guaranteed to resolve, and a thrown or false
               * result would report "outside" for a click on the trigger itself. Reading
               * `parentNode` and attributes works across realms. */
              let cursor = node;
              for (let depth = 0; cursor !== null && depth < 64; depth += 1) {
                if (cursor.nodeType !== 1) {
                  cursor = cursor.parentNode || null;
                  continue;
                }
                if (cursor.hasAttribute && cursor.hasAttribute('data-ui-enhance-beautify')) return true;
                if (triggerRef.current !== null && cursor === triggerRef.current) return true;
                cursor = cursor.parentNode || null;
              }
              return false;
            };
            /** Diagnostics only: name the node a close came from. */
            const describeTarget = (node) => {
              if (!node || node.nodeType !== 1) return String(node);
              const cls = typeof node.className === 'string' ? node.className : '';
              return (node.tagName || '?').toLowerCase() + (cls ? '.' + cls.split(/\s+/).slice(0, 2).join('.') : '');
            };
            const onPointerDown = (event) => {
              if (inside(event.target)) return;
              probe('beautify-close', { by: 'pointerdown', tag: describeTarget(event.target) });
              setOpen(false);
            };
            const onKey = (event) => {
              if (event.key !== 'Escape') return;
              probe('beautify-close', { by: 'escape' });
              event.stopPropagation();
              setOpen(false);
            };
            /* `scroll` and `resize` deliberately do NOT close the panel.
             *
             * The panel is `position:fixed` and portal-mounted, so neither action can
             * knock it out of position. Worse, both used to fire spuriously: a `scroll`
             * event reports the SCROLLING CONTAINER as its target, not the element under
             * the pointer, so `inside(target)` was false for genuine in-panel scrolling
             * and the panel slammed shut the moment a slider dragged. Opening the panel
             * could itself scroll the composer into view and close it immediately.
             *
             * Two ways out remain, both explicit: press Escape, or click outside. */
            document.addEventListener('pointerdown', onPointerDown, true);
            document.addEventListener('keydown', onKey, true);
            return () => {
              document.removeEventListener('pointerdown', onPointerDown, true);
              document.removeEventListener('keydown', onKey, true);
            };
          }, [open]);

          const commit = (patch) => {
            const saved = beautifyStore.set(patch);
            setNotice(saved ? null : { text: bt('beautifyStorageFull'), tone: 'warn' });
          };

          const reset = () => {
            const saved = beautifyStore.replace(BEAUTIFY_DEFAULTS);
            setNotice(saved ? null : { text: bt('beautifyStorageFull'), tone: 'warn' });
            setImageUrl(BEAUTIFY_DEFAULTS.image);
            setShaderInput(BEAUTIFY_DEFAULTS.shaderId);
          };

          const onFile = (event) => {
            const file = event.target.files && event.target.files[0];
            event.target.value = '';
            if (!file) return;
            if (file.size > IMAGE_MAX_BYTES) {
              setNotice({ text: bt('beautifyImageTooBig'), tone: 'warn' });
              return;
            }
            const reader = new FileReader();
            reader.onload = () => {
              const data = typeof reader.result === 'string' ? reader.result : '';
              if (data === '') return;
              setImageUrl(data);
              commit({ mode: 'image', image: data });
            };
            reader.onerror = () => setNotice({ text: bt('beautifyImageTooBig'), tone: 'warn' });
            reader.readAsDataURL(file);
          };

          const applyShader = (force) => {
            const id = parseShaderId(shaderInput);
            if (id === '') {
              setNotice({ text: bt('beautifyShaderNoId'), tone: 'warn' });
              return;
            }
            setNotice(null);
            setShaderInput(id);
            if (state.mode === 'shader' && state.shaderId === id) {
              void loadShaderWork(id, force);
              return;
            }
            commit({ mode: 'shader', shaderId: id });
          };

          const presetLabel = (preset) =>
            /^en/i.test(document.documentElement.lang || '') ? preset.nameEn || preset.name : preset.name;

          const applyPreset = (preset) => {
            commit({ ...preset.params, presetId: preset.id });
            setImageUrl(typeof preset.params.image === 'string' ? preset.params.image : '');
            setShaderInput(typeof preset.params.shaderId === 'string' ? preset.params.shaderId : '');
          };

          const savePreset = () => {
            const name = presetName.trim();
            if (name === '') {
              setNotice({ text: bt('beautifyPresetNameNeeded'), tone: 'warn' });
              return;
            }
            const params = {
              mode: state.mode,
              solid: state.solid,
              image: state.image,
              shaderId: state.shaderId,
              glassBlur: state.glassBlur,
              glassAlpha: state.glassAlpha,
            };
            const item = { id: 'user-' + Date.now().toString(36), name: name.slice(0, 24), emoji: '⭐', params };
            const next = customs.concat(item).slice(-40);
            if (!writeCustomPresets(next)) {
              setNotice({ text: bt('beautifyStorageFull'), tone: 'warn' });
              return;
            }
            setCustoms(next);
            setPresetName('');
            setNotice(null);
          };

          const removePreset = (id) => {
            const next = customs.filter((item) => item.id !== id);
            if (!writeCustomPresets(next)) {
              setNotice({ text: bt('beautifyStorageFull'), tone: 'warn' });
              return;
            }
            setCustoms(next);
          };

          const allPresets = BUILTIN_PRESETS.concat(customs.map((item) => ({ ...item, custom: true })));

          let panel = null;
          if (open && anchor !== null) {
            const tone = notice !== null ? notice.tone : shader.tone;
            const statusText = notice !== null ? notice.text : shader.text;

            const modeBody =
              state.mode === 'solid'
                ? h(
                    'div',
                    { key: 'solid', className: 'ue-row' },
                    h('input', {
                      type: 'color',
                      className: 'ue-color',
                      value: state.solid,
                      'aria-label': bt('beautifySolid'),
                      onChange: (event) => commit({ mode: 'solid', solid: event.target.value }),
                    }),
                    h('span', { className: 'ue-label', style: { margin: 0 } }, state.solid),
                  )
                : state.mode === 'image'
                  ? h(
                      'div',
                      { key: 'image' },
                      h(
                        'div',
                        { className: 'ue-row' },
                        h('input', {
                          className: 'ue-input',
                          value: imageUrl,
                          placeholder: bt('beautifyImageUrl'),
                          onChange: (event) => setImageUrl(event.target.value),
                          onBlur: () => commit({ mode: 'image', image: imageUrl.trim() }),
                          onKeyDown: (event) => {
                            if (event.key === 'Enter') commit({ mode: 'image', image: imageUrl.trim() });
                          },
                        }),
                      ),
                      h(
                        'div',
                        { className: 'ue-row' },
                        h(
                          'label',
                          { className: 'ue-btn' },
                          bt('beautifyPickFile'),
                          h('input', { type: 'file', accept: 'image/*', className: 'ue-file', onChange: onFile }),
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'ue-link',
                            onClick: () => {
                              setImageUrl('');
                              commit({ image: '' });
                            },
                          },
                          bt('beautifyImageClear'),
                        ),
                      ),
                    )
                  : h(
                      'div',
                      { key: 'shader' },
                      h(
                        'div',
                        { className: 'ue-row' },
                        h('input', {
                          className: 'ue-input',
                          value: shaderInput,
                          placeholder: 'https://www.shadertoy.com/view/…',
                          onChange: (event) => setShaderInput(event.target.value),
                          onKeyDown: (event) => {
                            if (event.key === 'Enter') applyShader(false);
                          },
                        }),
                        h(
                          'button',
                          { type: 'button', className: 'ue-btn', onClick: () => applyShader(false) },
                          bt('beautifyShaderFetch'),
                        ),
                      ),
                      h(
                        'div',
                        { className: 'ue-row' },
                        h(
                          'button',
                          { type: 'button', className: 'ue-link', onClick: () => applyShader(true) },
                          bt('beautifyShaderForce'),
                        ),
                      ),
                      // Fetch and hand-editing are the same panel on purpose: the fetch only
                      // fills the editor, so whatever arrives is immediately editable and
                      // there is no separate read-only view to switch between.
                      h(
                        'label',
                        { className: 'ue-shader-code-label' },
                        h('span', { className: 'ue-shader-code-title' }, bt('beautifyShaderCode')),
                        h('span', { className: 'ue-shader-code-hint' }, bt('beautifyShaderCodeHint')),
                      ),
                      h('textarea', {
                        className: 'ue-shader-code',
                        spellCheck: false,
                        wrap: 'off',
                        value: codeDraft,
                        placeholder: bt('beautifyShaderEmpty'),
                        onChange: (event) => setCodeDraft(event.target.value),
                        onKeyDown: (event) => {
                          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                            event.preventDefault();
                            applyShaderCode(codeDraft);
                          }
                        },
                      }),
                      h(
                        'div',
                        { className: 'ue-row' },
                        h(
                          'button',
                          { type: 'button', className: 'ue-btn', onClick: () => applyShaderCode(codeDraft) },
                          bt('beautifyShaderApply'),
                        ),
                      ),
                    );

            panel = h(
              'div',
              {
                'data-ui-enhance-beautify': '',
                role: 'dialog',
                'aria-label': bt('beautifyTitle'),
                style: {
                  position: 'fixed',
                  left: Math.round(Math.max(8, Math.min(anchor.left, window.innerWidth - 348))) + 'px',
                  bottom: Math.round(window.innerHeight - anchor.top + 6) + 'px',
                },
              },
              h(
                'div',
                { className: 'ue-head' },
                h('span', { className: 'ue-title' }, bt('beautifyTitle')),
                h('button', { type: 'button', className: 'ue-link', onClick: reset }, bt('beautifyReset')),
              ),
              h(
                'div',
                { className: 'ue-row' },
                h('input', {
                  type: 'checkbox',
                  checked: state.on,
                  onChange: (event) => commit({ on: event.target.checked }),
                }),
                h('span', null, bt('beautifyOn')),
              ),
              h(
                'div',
                { className: 'ue-sec' },
                h(
                  'div',
                  { className: 'ue-tabs', role: 'tablist' },
                  ...[
                    ['solid', 'beautifySolid'],
                    ['image', 'beautifyImage'],
                    ['shader', 'beautifyShader'],
                  ].map(([mode, key]) =>
                    h(
                      'button',
                      {
                        key: mode,
                        type: 'button',
                        role: 'tab',
                        className: 'ue-tab',
                        'data-active': state.mode === mode ? '' : undefined,
                        'aria-selected': state.mode === mode ? 'true' : 'false',
                        onClick: () => commit({ mode }),
                      },
                      bt(key),
                    ),
                  ),
                ),
                h('div', { style: { marginTop: 6 } }, modeBody),
              ),
              h(
                'div',
                { className: 'ue-sec' },
                h('div', { className: 'ue-label' }, bt('beautifyPresets')),
                h(
                  'div',
                  { className: 'ue-presets' },
                  ...allPresets.map((preset) =>
                    h(
                      'button',
                      {
                        key: preset.id,
                        type: 'button',
                        className: 'ue-preset',
                        title: preset.name,
                        'data-active': state.presetId === preset.id ? '' : undefined,
                        onClick: () => applyPreset(preset),
                      },
                      h('span', { style: { fontSize: '15px', lineHeight: '17px' } }, preset.emoji || '🎨'),
                      h('span', { className: 'ue-preset-name' }, presetLabel(preset)),
                      preset.custom
                        ? h(
                            'span',
                            {
                              className: 'ue-preset-del',
                              role: 'button',
                              title: bt('beautifyPresetDelete'),
                              onClick: (event) => {
                                event.stopPropagation();
                                removePreset(preset.id);
                              },
                            },
                            '×',
                          )
                        : null,
                    ),
                  ),
                ),
                h(
                  'div',
                  { className: 'ue-row', style: { marginTop: 6 } },
                  h('input', {
                    className: 'ue-input',
                    value: presetName,
                    placeholder: bt('beautifyPresetName'),
                    onChange: (event) => setPresetName(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') savePreset();
                    },
                  }),
                  h('button', { type: 'button', className: 'ue-btn', onClick: savePreset }, bt('beautifyPresetSave')),
                ),
              ),
              h(
                'div',
                { className: 'ue-sec' },
                h('div', { className: 'ue-label' }, bt('windowMode')),
                h(
                  'div',
                  { className: 'ue-row' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'ue-btn',
                      style: { flex: 1 },
                      'data-active': winState.on ? 'true' : 'false',
                      onClick: () => windowModeStore.set({ on: !winState.on }),
                    },
                    winState.on ? bt('windowOn') : bt('windowOff'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'ue-link',
                      onClick: () => windowModeStore.replace(WINDOW_DEFAULTS),
                    },
                    bt('windowReset'),
                  ),
                ),
                // The sliders drive `--ue-win-*` custom properties, so dragging one is a
                // single property write on <html> rather than a restyle of the columns.
                h(
                  'div',
                  { className: 'ue-row' },
                  h('span', { className: 'ue-label', style: { margin: 0, minWidth: 52 } }, bt('windowRadius')),
                  h('input', {
                    type: 'range',
                    className: 'ue-range',
                    min: 0,
                    max: 32,
                    step: 1,
                    value: winState.radius,
                    onChange: (event) => windowModeStore.set({ radius: Number(event.target.value) }),
                  }),
                  h('span', { className: 'ue-num' }, winState.radius + 'px'),
                ),
                h(
                  'div',
                  { className: 'ue-row' },
                  h('span', { className: 'ue-label', style: { margin: 0, minWidth: 52 } }, bt('windowGap')),
                  h('input', {
                    type: 'range',
                    className: 'ue-range',
                    min: 0,
                    max: 24,
                    step: 1,
                    value: winState.gap,
                    onChange: (event) => windowModeStore.set({ gap: Number(event.target.value) }),
                  }),
                  h('span', { className: 'ue-num' }, winState.gap + 'px'),
                ),
                h(
                  'div',
                  { className: 'ue-row' },
                  h('span', { className: 'ue-label', style: { margin: 0, minWidth: 52 } }, bt('beautifyGlassBlur')),
                  h('input', {
                    type: 'range',
                    className: 'ue-range',
                    min: 0,
                    max: 40,
                    step: 1,
                    value: winState.blur,
                    onChange: (event) => windowModeStore.set({ blur: Number(event.target.value) }),
                  }),
                  h('span', { className: 'ue-num' }, winState.blur + 'px'),
                ),
                h(
                  'div',
                  { className: 'ue-row' },
                  h('span', { className: 'ue-label', style: { margin: 0, minWidth: 52 } }, bt('windowOpacity')),
                  h('input', {
                    type: 'range',
                    className: 'ue-range',
                    min: 20,
                    max: 95,
                    step: 1,
                    value: winState.alpha,
                    onChange: (event) => windowModeStore.set({ alpha: Number(event.target.value) }),
                  }),
                  h('span', { className: 'ue-num' }, winState.alpha + '%'),
                ),
              ),
              h(
                { className: 'ue-sec' },
                h('div', { className: 'ue-label' }, bt('beautifyGlass')),
                h(
                  'div',
                  { className: 'ue-row' },
                  h(
                    'span',
                    { className: 'ue-label', style: { margin: 0, minWidth: 52 } },
                    bt('beautifyGlassBlur'),
                  ),
                  h('input', {
                    type: 'range',
                    className: 'ue-range',
                    min: 0,
                    max: 40,
                    step: 1,
                    value: state.glassBlur,
                    onChange: (event) => commit({ glassBlur: Number(event.target.value) }),
                  }),
                  h('span', { className: 'ue-num' }, state.glassBlur + 'px'),
                ),
                h(
                  'div',
                  { className: 'ue-row' },
                  h(
                    'span',
                    { className: 'ue-label', style: { margin: 0, minWidth: 52 } },
                    bt('beautifyGlassAlpha'),
                  ),
                  h('input', {
                    type: 'range',
                    className: 'ue-range',
                    min: 0,
                    max: 1,
                    step: 0.05,
                    value: state.glassAlpha,
                    onChange: (event) => commit({ glassAlpha: Number(event.target.value) }),
                  }),
                  h('span', { className: 'ue-num' }, Math.round(state.glassAlpha * 100) + '%'),
                ),
              ),
              h('div', { className: 'ue-status', 'data-tone': tone }, statusText),
            );

            if (ReactDOM !== null && typeof ReactDOM.createPortal === 'function') {
              panel = ReactDOM.createPortal(panel, document.body);
            }
          }

          return h(
            React.Fragment,
            null,
            h(
              'button',
              {
                ref: triggerRef,
                type: 'button',
                'data-ui-enhance-beautify-btn': '',
                'aria-haspopup': 'dialog',
                'aria-expanded': open ? 'true' : 'false',
                title: bt('beautify'),
                'aria-label': bt('beautify'),
                // Keep the composer focused, like the neighbouring dock actions.
                onMouseDown: (event) => event.preventDefault(),
                onClick: (event) => {
                  if (open) {
                    probe('beautify-toggle', { next: false, reason: 'trigger-toggle' });
                    setOpen(false);
                    return;
                  }
                  const node = triggerRef.current;
                  /* `anchor` gates rendering, so a null ref would open a panel that never
                   * paints. Fall back to pointer coordinates so opening always succeeds. */
                  const rect = node !== null ? node.getBoundingClientRect() : null;
                  const point = event && typeof event.clientX === 'number' ? { left: event.clientX, top: event.clientY } : null;
                  const next = rect !== null ? { left: rect.left, top: rect.top } : point;
                  if (next !== null) setAnchor(next);
                  probe('beautify-toggle', { next: true, hasNode: node !== null, hasAnchor: next !== null });
                  setOpen(true);
                  // beautify-after-probe: sample the DOM after the state update flushes.
                  // If the button disappears too, the whole seat was torn down and the cause
                  // is a render throw, not the panel's own visibility.
                  requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                      try {
                        const btn = document.querySelectorAll('[data-ui-enhance-beautify-btn]').length;
                        const pnl = document.querySelectorAll('[data-ui-enhance-beautify]').length;
                        probe('beautify-after', { btn: btn, panel: pnl });
                      } catch (e) {
                        probe('beautify-after', { err: String((e && e.message) || e) });
                      }
                    });
                  });
                },
              },
              h(
                'svg',
                { viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': true, style: { flex: 'none' } },
                h('path', {
                  d: 'M8 1.6l1.36 3.04L12.4 6l-3.04 1.36L8 10.4 6.64 7.36 3.6 6l3.04-1.36z',
                  fill: 'currentColor',
                }),
                h('path', {
                  d: 'M12.3 10.1l.62 1.38 1.38.62-1.38.62-.62 1.38-.62-1.38-1.38-.62 1.38-.62z',
                  fill: 'currentColor',
                }),
              ),
            ),
            open && anchor !== null ? panel : null,
          );
        }

        /**
         * Invisible anchor inside the shipped dock. The ring below the card stays visible, but
         * its numbers must follow this session's budget, so the driver keeps rewriting them.
         */
        function MeterBridge(props) {
          const anchorRef = React.useRef(null);
          const budget = useSessionWindow(props.sessionId);
          const pressure = typeof props.useProjection === 'function' ? props.useProjection('contextPressure') : undefined;
          const breakdown =
            typeof props.useProjection === 'function' ? props.useProjection('contextBreakdown') : undefined;
          useShippedMeterOverride(anchorRef, pressure, breakdown, budget);
          React.useEffect(() => {
            if (!pressure) ensureProjections(props.sessionId);
          }, [pressure, props.sessionId]);
          return h('span', {
            ref: anchorRef,
            'data-ui-enhance-meter-anchor': '',
            'aria-hidden': 'true',
            style: { display: 'none' },
          });
        }

        function barColor(percent) {
          return percent >= WARN_PERCENT
            ? 'var(--dsw-alias-state-warn-primary)'
            : 'var(--dsw-alias-brand-primary)';
        }

        /** sessionId -> the gauge reading one row shows, using that session's own budget. */
        function barEntries(projections) {
          const entries = {};
          if (!projections) return entries;
          for (const id of Object.keys(projections)) {
            const snapshot = projections[id];
            const values = snapshot ? snapshot.values : undefined;
            const pressure = values ? values.contextPressure : undefined;
            if (!pressure) continue;
            const used =
              typeof pressure.projectedTokens === 'number' ? pressure.projectedTokens : pressure.pressureTokens;
            const budget = windowStore.effective(id);
            const capacity = budget !== undefined ? budget : pressure.contextWindow;
            if (typeof used !== 'number' || typeof capacity !== 'number' || capacity <= 0) continue;
            const percent = Math.min(100, Math.round((used / capacity) * 100));
            entries[id] = { percent, color: barColor(percent) };
          }
          return entries;
        }

        /**
         * Write the gauge of every Session row. The row itself belongs to the shipped browser,
         * so the gauge is one appended child and every write is compared first — the
         * MutationObserver that watches row creation therefore settles instead of looping.
         */
        function paintSessionBars(entries) {
          const rows = document.querySelectorAll('[data-row-key^="session:"]');
          for (const row of rows) {
            const key = row.getAttribute('data-row-key') || '';
            const entry = entries ? entries[key.slice('session:'.length)] : undefined;
            let bar = row.querySelector('[data-ui-enhance-ctx-bar]');
            if (!entry) {
              if (bar !== null) bar.remove();
              continue;
            }
            if (bar === null) {
              bar = document.createElement('span');
              bar.setAttribute('data-ui-enhance-ctx-bar', '');
              bar.setAttribute('aria-hidden', 'true');
              row.appendChild(bar);
            }
            const scale = String(Math.min(1, entry.percent / 100));
            if (bar.style.getPropertyValue('--ui-enhance-ctx-scale') !== scale) {
              bar.style.setProperty('--ui-enhance-ctx-scale', scale);
            }
            if (bar.style.getPropertyValue('--ui-enhance-ctx-color') !== entry.color) {
              bar.style.setProperty('--ui-enhance-ctx-color', entry.color);
            }
            if (bar.getAttribute('data-percent') !== String(entry.percent)) {
              bar.setAttribute('data-percent', String(entry.percent));
            }
          }
        }

        /** Renders nothing: it only keeps every Session row's gauge in sync. */
        function SidebarContextBars(props) {
          const useSessions = props.useSessions;
          const projections =
            typeof useSessions === 'function' ? useSessions((state) => state.projectionsBySession) : null;
          const [, bump] = React.useReducer((value) => value + 1, 0);
          React.useEffect(() => windowStore.subscribe(bump), []);

          // Cheap enough to rebuild every render, and never stale: only publishes re-render.
          const entries = barEntries(projections);
          const entriesRef = React.useRef(entries);
          entriesRef.current = entries;

          React.useEffect(() => {
            if (!projections) return;
            for (const id of Object.keys(projections)) {
              const snapshot = projections[id];
              const values = snapshot ? snapshot.values : undefined;
              if (values && values.contextPressure) continue;
              ensureProjections(id);
            }
          }, [projections]);

          React.useEffect(() => {
            paintSessionBars(entries);
          }, [entries]);

          React.useEffect(() => {
            let frame = 0;
            const schedule = () => {
              if (frame !== 0) return;
              frame = window.requestAnimationFrame(() => {
                frame = 0;
                paintSessionBars(entriesRef.current);
              });
            };
            const touchesRows = (node) => {
              if (!(node instanceof Element)) return false;
              return node.hasAttribute('data-row-key') || node.querySelector('[data-row-key]') !== null;
            };
            const observer = new MutationObserver((records) => {
              for (const record of records) {
                if (record.type === 'attributes') {
                  const t = record.target;
                  if (t instanceof Element &&
                      (t.hasAttribute('data-ui-enhance-pane') || t.hasAttribute('data-ui-enhance-ctx-bar'))) {
                    continue;
                  }
                  schedule();
                  return;
                }
                for (const node of record.addedNodes) {
                  if (touchesRows(node)) {
                    schedule();
                    return;
                  }
                }
                for (const node of record.removedNodes) {
                  if (touchesRows(node)) {
                    schedule();
                    return;
                  }
                }
              }
            });
            observer.observe(document.body, {
              childList: true,
              subtree: true,
              attributes: true,
              attributeFilter: ['data-row-key'],
            });
            schedule();
            return () => {
              observer.disconnect();
              if (frame !== 0) window.cancelAnimationFrame(frame);
              paintSessionBars({});
            };
          }, []);

          return null;
        }

        /**
         * The checkout branch of every Workspace, drawn in the left browser's workspace title.
         * The shipped WorkspaceBrowser renders that title row itself and declares no slot for
         * decoration, so the pill is appended to the row's `[data-row-key="workspace:<id>"]`
         * element (its `rowActions` cell marks where the folder name ends) and painted from the
         * Workspace snapshot plus this plugin's git endpoint. Rows are rebuilt by React, so the
         * observer below repaints; nothing is drawn for a Workspace outside a repository.
         */
        const WORKSPACE_ROW_SELECTOR = '[data-row-key^="workspace:"]';
        const WORKSPACE_BRANCH_ATTR = 'data-ui-enhance-workspace-branch';
        const WORKSPACE_BRANCH_NAME_ATTR = 'data-ui-enhance-workspace-branch-name';
        const WORKSPACE_BRANCH_POLL_MS = 15000;
        const SVG_NS = 'http://www.w3.org/2000/svg';

        /** Write every Workspace row's branch pill; compares before writing so the observer settles. */
        function paintWorkspaceBranches(paths, branches) {
          const rows = document.querySelectorAll(WORKSPACE_ROW_SELECTOR);
          for (const row of rows) {
            const key = row.getAttribute('data-row-key') || '';
            const path = paths === null ? undefined : paths.get(key.slice('workspace:'.length));
            const entry = path === undefined ? undefined : branches.get(path);
            const branch = entry !== undefined && typeof entry.branch === 'string' ? entry.branch : null;
            let badge = row.querySelector('[' + WORKSPACE_BRANCH_ATTR + ']');
            if (branch === null) {
              if (badge !== null) badge.remove();
              continue;
            }
            if (badge === null) {
              badge = document.createElement('span');
              badge.setAttribute(WORKSPACE_BRANCH_ATTR, '');
              const icon = document.createElementNS(SVG_NS, 'svg');
              icon.setAttribute('viewBox', '0 0 16 16');
              icon.setAttribute('aria-hidden', 'true');
              icon.setAttribute('focusable', 'false');
              for (const [tag, attrs] of [
                ['circle', { cx: '4', cy: '3.5', r: '1.6' }],
                ['circle', { cx: '12', cy: '4.5', r: '1.6' }],
                ['circle', { cx: '4', cy: '12.5', r: '1.6' }],
                ['path', { d: 'M4 5.1v5.8' }],
                ['path', { d: 'M12 6.1c0 2.2-1.7 3.5-4.4 3.5H4' }],
              ]) {
                const part = document.createElementNS(SVG_NS, tag);
                for (const name of Object.keys(attrs)) part.setAttribute(name, attrs[name]);
                icon.appendChild(part);
              }
              badge.appendChild(icon);
              const text = document.createElement('span');
              text.setAttribute(WORKSPACE_BRANCH_NAME_ATTR, '');
              badge.appendChild(text);
              const actions = row.querySelector('[class*="rowActions"]');
              if (actions !== null && actions.parentElement === row) row.insertBefore(badge, actions);
              else row.appendChild(badge);
            }
            const text = badge.querySelector('[' + WORKSPACE_BRANCH_NAME_ATTR + ']');
            if (text !== null && text.textContent !== branch) text.textContent = branch;
            const title =
              entry !== undefined && entry.detached === true
                ? fill(t('gitDetached'), { branch })
                : fill(t('gitBranch'), { branch });
            if (badge.getAttribute('title') !== title) badge.setAttribute('title', title);
          }
        }

        /** Renders nothing: it only keeps every Workspace row's branch pill in sync. */
        function WorkspaceBranchPills(props) {
          const useWorkspaces = props.useWorkspaces;
          const items = typeof useWorkspaces === 'function' ? useWorkspaces((state) => (state ? state.items : undefined)) : undefined;

          const pathsRef = React.useRef(null);
          const branchesRef = React.useRef(new Map());
          const inflightRef = React.useRef(new Set());
          const readersRef = React.useRef(null);

          const paths = new Map();
          for (const item of Array.isArray(items) ? items : []) {
            if (item === null || typeof item !== 'object') continue;
            if (typeof item.workspaceId !== 'string' || typeof item.path !== 'string') continue;
            paths.set(item.workspaceId, item.path);
          }
          pathsRef.current = paths;

          React.useEffect(() => {
            let frame = 0;
            const schedule = () => {
              if (frame !== 0) return;
              frame = window.requestAnimationFrame(() => {
                frame = 0;
                paintWorkspaceBranches(pathsRef.current, branchesRef.current);
              });
            };

            const read = (path) => {
              if (inflightRef.current.has(path)) return;
              const known = branchesRef.current.get(path);
              if (known !== undefined && Date.now() - known.at < WORKSPACE_BRANCH_POLL_MS) return;
              inflightRef.current.add(path);
              fetch(GIT_BRANCH_URL + '?path=' + encodeURIComponent(path), { cache: 'no-store' })
                .then((response) => (response.ok ? response.json() : null))
                .then((report) => {
                  branchesRef.current.set(path, {
                    at: Date.now(),
                    branch:
                      report && report.ok === true && report.repo === true && typeof report.branch === 'string'
                        ? report.branch
                        : null,
                    detached: !!(report && report.detached === true),
                  });
                })
                .catch(() => {
                  branchesRef.current.set(path, { at: Date.now(), branch: null, detached: false });
                })
                .then(() => {
                  inflightRef.current.delete(path);
                  schedule();
                });
            };

            const readAll = () => {
              for (const path of pathsRef.current.values()) read(path);
            };
            readersRef.current = { readAll, schedule };

            const timer = window.setInterval(() => {
              readAll();
              schedule();
            }, 5000);

            const observer = new MutationObserver(() => schedule());
            observer.observe(document.body, { childList: true, subtree: true });

            readAll();
            schedule();
            return () => {
              readersRef.current = null;
              observer.disconnect();
              window.clearInterval(timer);
              if (frame !== 0) window.cancelAnimationFrame(frame);
              for (const node of document.querySelectorAll('[' + WORKSPACE_BRANCH_ATTR + ']')) node.remove();
            };
          }, []);

          React.useEffect(() => {
            const readers = readersRef.current;
            if (readers === null) return;
            readers.readAll();
            readers.schedule();
          }, [items]);

          return null;
        }

/**
 * Feature #7 (left-side token aggregation panel) and #5 ("current Workspace only" scope).
 *
 * Both read the one Host route `/plugin/ui-enhance/session-summary`, which accepts an
 * optional `?scope=workspace`. The panel is anchored just above the sidebar's own footer
 * area, and the scope chip beside the sidebar's header actions, so each surface sits where
 * the user already looks for a filter over the list below it.
 */
const SUMMARY_URL = '/plugin/ui-enhance/session-summary';
/** Host-side fan-out that rewrites every visible Session's model in one request. */
const MODEL_BULK_PATH = '/plugin/ui-enhance/model-bulk';
const SUMMARY_PANEL_ATTR = 'data-ui-enhance-token-panel';
const SCOPE_CHIP_ATTR = 'data-ui-enhance-scope-chip';
const SUMMARY_POLL_MS = 20000;
const SCOPE_STORAGE_KEY = 'ui-enhance.workspace-only';
/** The sidebar's own landmark classes, matched by suffix so a hash rename still resolves. */
const SIDEBAR_SELECTOR = '[class*="_sidebarCol"]';
const SIDEBAR_HEADER_ACTIONS = '[class*="headerActions"]';
const SIDEBAR_FOOT_AREA = '[class*="_footArea"]';

/** "29.7亿" style compaction, matching how the HUD already prints large amounts. */
function formatTokenAmount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (value >= 1e8) return (value / 1e8).toFixed(1).replace(/\.0$/, '') + '亿';
  if (value >= 1e4) return (value / 1e4).toFixed(1).replace(/\.0$/, '') + '万';
  return String(Math.round(value));
}

/**
 * Renders nothing: it keeps the aggregation panel and the scope chip in sync with the
 * Host's Session listing. Painting is done directly into the sidebar's DOM so the rows
 * themselves stay owned by the shipped component.
 */
function TokenAggregate(props) {
  const t = props.t;
  const [scopeOnly, setScopeOnly] = React.useState(() => {
    try {
      return window.localStorage.getItem(SCOPE_STORAGE_KEY) === '1';
    } catch (error) {
      return false;
    }
  });
  const scopeRef = React.useRef(scopeOnly);
  const stateRef = React.useRef({ totals: null, at: 0, error: null });

  scopeRef.current = scopeOnly;

  // Persist the scope choice so a reload keeps the user's filter.
  React.useEffect(() => {
    try {
      window.localStorage.setItem(SCOPE_STORAGE_KEY, scopeOnly ? '1' : '0');
    } catch (error) {
      /* storage may be unavailable in a private window */
    }
  }, [scopeOnly]);

  React.useEffect(() => {
    let disposed = false;

    const read = () => {
      const url = scopeRef.current ? SUMMARY_URL + '?scope=workspace' : SUMMARY_URL;
      fetch(url, { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .then((report) => {
          if (disposed) return;
          stateRef.current =
            report && report.ok === true
              ? { totals: report.totals, at: Date.now(), error: null }
              : { totals: null, at: Date.now(), error: (report && report.error) || 'unavailable' };
          paint();
        })
        .catch((error) => {
          if (disposed) return;
          stateRef.current = { totals: null, at: Date.now(), error: String((error && error.message) || error) };
          paint();
        });
    };

    /** Find (or create) the panel host, sitting just above the sidebar's footer actions. */
    const hostOf = () => {
      let host = document.querySelector('[' + SUMMARY_PANEL_ATTR + ']');
      if (host !== null) {
        if (host.isConnected) return host;
        host.remove();
      }
      const sidebar = document.querySelector(SIDEBAR_SELECTOR);
      if (sidebar === null) return null;
      host = document.createElement('div');
      host.setAttribute(SUMMARY_PANEL_ATTR, '');
      host.setAttribute('data-dsh-plugin', 'ui-enhance-token-panel');
      const foot = sidebar.querySelector(SIDEBAR_FOOT_AREA);
      if (foot !== null && foot.parentElement !== null) foot.parentElement.insertBefore(host, foot);
      else sidebar.appendChild(host);
      return host;
    };

    const paintPanel = () => {
      const host = hostOf();
      if (host === null) return;
      const state = stateRef.current;
      const totals = state.totals;

      // Only touch the DOM when the rendered content actually changed. Rebuilding on every
      // call would feed the MutationObserver below and lock the main thread.
      const detail0 = totals !== null && totals !== undefined ? totals.detail || {} : {};
      const signature =
        state.error !== null
          ? 'error:' + String(state.error)
          : totals === null
            ? 'loading'
            : [
                totals.tokens,
                detail0.uncachedInputTokens,
                detail0.outputTokens,
                detail0.cacheReadTokens,
                totals.sessions,
                totals.live,
              ].join('|');
      if (host.getAttribute('data-ue-signature') === signature) return;
      host.setAttribute('data-ue-signature', signature);

      host.textContent = '';
      if (state.error !== null) {
        const note = document.createElement('div');
        note.setAttribute('data-ui-enhance-token-error', '');
        note.textContent = String(t('tokenPanelError')) + ' ' + String(state.error);
        host.appendChild(note);
        return;
      }
      if (totals === null) {
        const note = document.createElement('div');
        note.setAttribute('data-ui-enhance-token-error', '');
        note.textContent = t('tokenPanelLoading');
        host.appendChild(note);
        return;
      }
      const row = (label, value, key, strong) => {
        const line = document.createElement('div');
        line.setAttribute('data-ui-enhance-token-row', '');
        line.setAttribute('data-key', key);
        if (strong === true) line.setAttribute('data-strong', '');
        const name = document.createElement('span');
        name.setAttribute('data-ui-enhance-token-label', '');
        name.textContent = label;
        const amount = document.createElement('span');
        amount.setAttribute('data-ui-enhance-token-value', '');
        amount.textContent = value;
        line.appendChild(name);
        line.appendChild(amount);
        return line;
      };
      const detail = totals.detail || {};
      host.appendChild(row(t('tokenPanelTotal'), formatTokenAmount(totals.tokens), 'total', true));
      host.appendChild(row(t('tokenPanelInput'), formatTokenAmount(detail.uncachedInputTokens), 'input', false));
      host.appendChild(row(t('tokenPanelOutput'), formatTokenAmount(detail.outputTokens), 'output', false));
      host.appendChild(row(t('tokenPanelCache'), formatTokenAmount(detail.cacheReadTokens), 'cache', false));
      const meta = document.createElement('div');
      meta.setAttribute('data-ui-enhance-token-meta', '');
      meta.textContent = fill(t('tokenPanelMeta'), {
        sessions: String(totals.sessions),
        live: String(totals.live),
      });
      host.appendChild(meta);
      host.setAttribute('title', fill(t('tokenPanelTip'), { sessions: String(totals.sessions) }));
    };

    /** Find (or create) the scope chip beside the sidebar's header actions. */
    const chipHostOf = () => {
      let chip = document.querySelector('[' + SCOPE_CHIP_ATTR + ']');
      if (chip !== null) {
        if (chip.isConnected) return chip;
        chip.remove();
      }
      const actions = document.querySelector(SIDEBAR_HEADER_ACTIONS);
      if (actions === null || actions.parentElement === null) return null;
      chip = document.createElement('button');
      chip.type = 'button';
      chip.setAttribute(SCOPE_CHIP_ATTR, '');
      chip.setAttribute('data-dsh-plugin', 'ui-enhance-scope-chip');
      chip.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        setScopeOnly((value) => !value);
      });
      actions.parentElement.insertBefore(chip, actions);
      return chip;
    };

    const paintChip = () => {
      const chip = chipHostOf();
      if (chip === null) return;
      const on = scopeRef.current;
      const label = on ? t('scopeOnlyWorkspace') : t('scopeAllWorkspaces');
      const tip = on ? t('scopeOnlyTip') : t('scopeAllTip');
      // Compared before writing: the observer below must not see a write it caused itself.
      const chipOn = chip.getAttribute('data-on');
      if (chipOn !== (on ? 'true' : 'false')) chip.setAttribute('data-on', on ? 'true' : 'false');
      if (chip.textContent !== label) chip.textContent = label;
      if (chip.getAttribute('title') !== tip) chip.setAttribute('title', tip);
    };

    const paint = () => {
      if (disposed) return;
      paintPanel();
      paintChip();
    };

    const timer = window.setInterval(() => {
      read();
      paint();
    }, SUMMARY_POLL_MS);

    // Observe only the sidebar's own structure, never the whole document: the shipped app
    // re-renders constantly while a turn streams, and each of those renders must not cost a
    // full repaint. The callback is coalesced through rAF and every writer above is
    // idempotent, so this cannot feed itself.
    let frame = 0;
    const schedule = () => {
      if (frame !== 0 || disposed) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        paint();
      });
    };
    let watched = null;
    const observer = new MutationObserver(schedule);
    const attach = () => {
      const sidebar = document.querySelector(SIDEBAR_SELECTOR);
      if (sidebar === watched) return;
      observer.disconnect();
      watched = sidebar;
      if (sidebar !== null) observer.observe(sidebar, { childList: true, subtree: true });
    };

    // The sidebar element itself appears (and is replaced) as the shell mounts, so a light
    // document-level watcher only re-attaches the scoped observer.
    let attachFrame = 0;
    const scheduleAttach = () => {
      if (attachFrame !== 0 || disposed) return;
      attachFrame = window.requestAnimationFrame(() => {
        attachFrame = 0;
        attach();
        schedule();
      });
    };
    const shellObserver = new MutationObserver(scheduleAttach);
    shellObserver.observe(document.body, { childList: true, subtree: true });

    read();
    paint();

    return () => {
      disposed = true;
      observer.disconnect();
      shellObserver.disconnect();
      window.clearInterval(timer);
      if (frame !== 0) window.cancelAnimationFrame(frame);
      if (attachFrame !== 0) window.cancelAnimationFrame(attachFrame);
      for (const node of document.querySelectorAll('[' + SUMMARY_PANEL_ATTR + ']')) node.remove();
      for (const node of document.querySelectorAll('[' + SCOPE_CHIP_ATTR + ']')) node.remove();
    };
  }, [t, scopeOnly]);

  return null;
}

/**
 * Feature #1 + #2: model switch dropdown and reasoning-effort switch.
 *
 * Reads the live catalog from ctx.remote.session.modelCatalog() and writes through
 * ctx.remote.session.selectModel({ sessionId, provider, model, reasoningEffort? }).
 * Both settle to { ok, value } / { ok:false, error:{code,message} }.
 *
 * The trigger is a custom menu (NOT a native <select>) so the popup can show provider
 * groups, model descriptions and the effort ladder in the app's own styling.
 */
const MODEL_TRIGGER_ATTR = 'data-ui-enhance-model-trigger';
const MODEL_MENU_ATTR = 'data-ui-enhance-model-menu';

/** Catalog is globally fixed per Host generation, so one page-wide lazy load is enough. */
let modelCatalogCache = null;
let modelCatalogPromise = null;

function readModelCatalog(remote) {
  if (modelCatalogCache !== null) return Promise.resolve(modelCatalogCache);
  if (modelCatalogPromise !== null) return modelCatalogPromise;
  if (!remote || typeof remote.modelCatalog !== 'function') {
    modelCatalogCache = { ok: false, error: { code: 'unavailable', message: 'remote.session missing' } };
    return Promise.resolve(modelCatalogCache);
  }
  modelCatalogPromise = Promise.resolve(remote.modelCatalog())
    .then((response) => {
      if (!response || response.ok !== true) {
        modelCatalogCache = {
          ok: false,
          error: (response && response.error) || { code: 'catalog-failed', message: 'no result' },
        };
      } else {
        modelCatalogCache = { ok: true, value: response.value };
      }
      return modelCatalogCache;
    })
    .catch((error) => {
      modelCatalogCache = { ok: false, error: { code: 'catalog-threw', message: String((error && error.message) || error) } };
      return modelCatalogCache;
    })
    .finally(() => {
      modelCatalogPromise = null;
    });
  return modelCatalogPromise;
}

/** The effort ladder a model declares, or an empty list when it offers no choice. */
function effortsOf(groups, selection) {
  if (!selection || !Array.isArray(groups)) return [];
  for (const group of groups) {
    if (group.id !== selection.provider) continue;
    for (const model of group.models || []) {
      if (model.id !== selection.model) continue;
      const reasoning = model.reasoning;
      if (!reasoning || !Array.isArray(reasoning.efforts)) return [];
      return reasoning.efforts;
    }
  }
  return [];
}

function defaultEffortOf(groups, selection) {
  if (!selection || !Array.isArray(groups)) return undefined;
  for (const group of groups) {
    if (group.id !== selection.provider) continue;
    for (const model of group.models || []) {
      if (model.id !== selection.model) continue;
      return model.reasoning ? model.reasoning.defaultEffort : undefined;
    }
  }
  return undefined;
}

/**
 * One dropdown in the session header: pick provider/model, and pick the reasoning effort
 * for the chosen model. Everything is written through the shipped Session controller, so
 * the change applies to the Session's next request and persists as the new default.
 */
function ModelSwitch(props) {
  const t = props.t;
  const sessionId = props.sessionId;
  const active = props.active === true;
  const sessionApi = ctx.get('remote.session');

  const [catalog, setCatalog] = React.useState({ status: 'loading', groups: [], error: null });
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState(null);
  const rootRef = React.useRef(null);
  const triggerRef = React.useRef(null);
  const [anchor, setAnchor] = React.useState(null);

  const selection = typeof props.useProjection === 'function' ? props.useProjection('modelSelection') : undefined;
  const current = selection ? selection.next ?? selection.lastUsed : null;

  React.useEffect(() => {
    let dropped = false;
    readModelCatalog(sessionApi).then((loaded) => {
      if (dropped) return;
      if (loaded.ok) setCatalog({ status: 'ready', groups: loaded.value.groups || [], error: null });
      else setCatalog({ status: 'error', groups: [], error: loaded.error });
    });
    return () => {
      dropped = true;
    };
    // The catalog is page-global: one load per page is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      const root = rootRef.current;
      if (root && event.target instanceof Node && root.contains(event.target)) return;
      setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  const choose = (nextSelection) => {
    if (busy || !sessionApi || typeof sessionApi.selectModel !== 'function') return;
    if (!sessionId) return;
    const effort = nextSelection.reasoningEffort;
    const request = {
      sessionId,
      provider: nextSelection.provider,
      model: nextSelection.model,
    };
    if (effort !== undefined) request.reasoningEffort = effort;
    setBusy(true);
    setFailure(null);
    Promise.resolve(sessionApi.selectModel(request))
      .then((result) => {
        if (result && result.ok === true) {
          probe('model-switch', { ok: true, ...request });
          setOpen(false);
        } else {
          const error = (result && result.error) || { code: 'select-failed', message: 'no result' };
          const text = (error.code || 'error') + ': ' + (error.message || '');
          probe('model-switch', { ok: false, ...request, error: text });
          setFailure(text);
        }
      })
      .catch((error) => {
        const text = String((error && error.message) || error);
        probe('model-switch', { ok: false, ...request, error: text });
        setFailure(text);
      })
      .finally(() => setBusy(false));
  };

  if (!sessionId || typeof sessionApi?.selectModel !== 'function') return null;

  const groups = catalog.groups;
  const efforts = effortsOf(groups, current);
  const shownEffort = current ? current.reasoningEffort ?? defaultEffortOf(groups, current) : undefined;
  const effortName = (() => {
    if (!shownEffort) return '';
    const hit = efforts.find((level) => level.id === shownEffort);
    return hit ? hit.name || hit.id : String(shownEffort);
  })();

  const modelName = (() => {
    if (!current) return t('modelSwitchLoading');
    for (const group of groups) {
      if (group.id !== current.provider) continue;
      for (const model of group.models || []) if (model.id === current.model) return model.name || model.id;
    }
    return modelLabel(current.model);
  })();

  if (!active) {
    // Inactive Session rows keep the plain pill so a hover card stays narrow.
    return h(
      'span',
      { 'data-dsh-plugin': 'ui-enhance-model', title: modelText(current), style: modelBadgeStyle },
      modelText(current),
    );
  }

  const toggle = () => {
    if (busy) return;
    if (catalog.status !== 'ready') {
      modelCatalogCache = null;
      setCatalog({ status: 'loading', groups: [], error: null });
      readModelCatalog(sessionApi).then((loaded) => {
        if (loaded.ok) setCatalog({ status: 'ready', groups: loaded.value.groups || [], error: null });
        else setCatalog({ status: 'error', groups: [], error: loaded.error });
      });
      return;
    }
    const node = triggerRef.current;
    if (node && !open) {
      const rect = node.getBoundingClientRect();
      setAnchor({ left: rect.left, top: rect.bottom + 6, width: rect.width });
    }
    setOpen(!open);
  };

  const triggerLabel = shownEffort
    ? fill(t('modelSwitchTrigger'), { model: modelName, effort: effortName })
    : modelName;

  const menuItems = [];
  if (catalog.status === 'loading') {
    menuItems.push(h('div', { key: 'loading', 'data-ui-enhance-model-note': '' }, t('modelSwitchLoading')));
  } else if (catalog.status === 'error') {
    menuItems.push(
      h('div', { key: 'error', 'data-ui-enhance-model-note': '', 'data-tone': 'error' },
        fill(t('modelSwitchError'), {
          error: (catalog.error && (catalog.error.code || catalog.error.message)) || 'error',
        }),
      ),
    );
  } else {
    for (const group of groups) {
      menuItems.push(
        h('div', { key: 'group-' + group.id, 'data-ui-enhance-model-group': '' }, group.name || group.id),
      );
      for (const model of group.models || []) {
        const picked = current && current.provider === group.id && current.model === model.id;
        menuItems.push(
          h(
            'button',
            {
              key: 'model-' + group.id + '/' + model.id,
              type: 'button',
              'data-ui-enhance-model-item': '',
              'data-picked': picked ? 'true' : 'false',
              title: model.description || model.name || model.id,
              disabled: busy,
              onClick: () =>
                choose({
                  provider: group.id,
                  model: model.id,
                  reasoningEffort:
                    picked && shownEffort
                      ? shownEffort
                      : model.reasoning
                        ? model.reasoning.defaultEffort
                        : undefined,
                }),
            },
            h('span', { key: 'name', 'data-ui-enhance-model-item-name': '' }, model.name || model.id),
            picked ? h('span', { key: 'tick', 'data-ui-enhance-model-tick': '' }, '✓') : null,
          ),
        );
      }
    }
    if (efforts.length > 1) {
      menuItems.push(h('div', { key: 'effort-title', 'data-ui-enhance-model-group': '' }, t('modelEffortGroup')));
      for (const level of efforts) {
        const picked = shownEffort === level.id;
        menuItems.push(
          h(
            'button',
            {
              key: 'effort-' + level.id,
              type: 'button',
              'data-ui-enhance-model-item': '',
              'data-ui-enhance-effort-item': '',
              'data-picked': picked ? 'true' : 'false',
              title: level.description || level.name || level.id,
              disabled: busy || !current,
              onClick: () =>
                current &&
                choose({
                  provider: current.provider,
                  model: current.model,
                  reasoningEffort: level.id,
                }),
            },
            h('span', { key: 'name', 'data-ui-enhance-model-item-name': '' }, level.name || level.id),
            picked ? h('span', { key: 'tick', 'data-ui-enhance-model-tick': '' }, '✓') : null,
          ),
        );
      }
    }
  }
  if (failure) {
    menuItems.push(h('div', { key: 'failure', 'data-ui-enhance-model-note': '', 'data-tone': 'error' }, failure));
  }

  const menu =
    open && anchor && typeof ReactDOM !== 'undefined' && ReactDOM && typeof ReactDOM.createPortal === 'function'
      ? ReactDOM.createPortal(
          h(
            'div',
            {
              [MODEL_MENU_ATTR]: '',
              'data-dsh-plugin': 'ui-enhance-model-menu',
              style: { left: anchor.left + 'px', top: anchor.top + 'px' },
            },
            ...menuItems,
          ),
          document.body,
        )
      : null;

  return h(
    'span',
    { ref: rootRef, 'data-dsh-plugin': 'ui-enhance-model-switch' },
    h(
      'button',
      {
        ref: triggerRef,
        type: 'button',
        [MODEL_TRIGGER_ATTR]: '',
        title: current ? modelText(current) : t('modelSwitchLoading'),
        disabled: busy,
        'data-busy': busy ? 'true' : 'false',
        'data-open': open ? 'true' : 'false',
        onClick: toggle,
      },
      triggerLabel,
    ),
    menu,
  );
}

/**
 * One-click model switch for every Session the sidebar currently shows in the active
 * Workspace ("一键切换所有会话的模型和强度").
 *
 * Placement: the anchor is `sidebar.workspaces`, a single Slot whose `replaceRisk` is
 * `shadows-shipped-ui` — registering there would REPLACE the shipped workspace browser
 * instead of decorating it. So this registers into the append-only `sidebar.footer.action`
 * list and portals its trigger to the Workspace section header by measuring the live DOM.
 * Nothing in the native workspace pane is mutated: the button is a sibling overlay that
 * follows the header's rect, and disappears with it.
 *
 * Writing: the Session controller only exposes a per-Session `selectModel`, so the fan-out
 * runs once on the Host (`/plugin/ui-enhance/model-bulk`). That keeps one consistent
 * snapshot of the Session list and avoids N concurrent RPCs from the renderer.
 */
const MODEL_BULK_ATTR = 'data-ui-enhance-model-bulk';
const MODEL_BULK_MENU_ATTR = 'data-ui-enhance-model-bulk-menu';

/** The header row that names the active Workspace: first row inside the sidebar column. */
const WORKSPACE_HEADER_SELECTOR = '[class*="_sidebarCol"] [class*="header"]';

function WorkspaceModelBulk(props) {
  const t = props.t;
  const sessionApi = ctx.get('remote.session');
  const [catalog, setCatalog] = React.useState({ status: 'loading', groups: [], error: null });
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState(null);
  const [tone, setTone] = React.useState('muted');
  const [effort, setEffort] = React.useState('');
  const rootRef = React.useRef(null);
  const triggerRef = React.useRef(null);
  const [anchor, setAnchor] = React.useState(null);
  const mountedRef = React.useRef(true);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  React.useEffect(() => {
    let dropped = false;
    readModelCatalog(sessionApi).then((loaded) => {
      if (dropped) return;
      if (loaded.ok) setCatalog({ status: 'ready', groups: loaded.value.groups || [], error: null });
      else setCatalog({ status: 'error', groups: [], error: loaded.error });
    });
    return () => {
      dropped = true;
    };
    // The catalog is page-global; one load is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Track the Workspace header so the floating trigger stays glued to it while the user
  // scrolls or resizes the column. Reads are rAF-coalesced and only write on real change.
  React.useEffect(() => {
    let frame = 0;
    let lastKey = '';
    const place = () => {
      frame = 0;
      const node = triggerRef.current;
      if (!node) return;
      const header = document.querySelector(WORKSPACE_HEADER_SELECTOR);
      if (!header) {
        if (lastKey !== 'none') {
          lastKey = 'none';
          setAnchor(null);
        }
        return;
      }
      const rect = header.getBoundingClientRect();
      if (rect.width < 40) return;
      // Sit at the right end of the header row, vertically centred on it.
      const top = rect.top + rect.height / 2 - 11;
      const left = rect.right - 30;
      const key = Math.round(left) + ',' + Math.round(top);
      if (key === lastKey) return;
      lastKey = key;
      setAnchor({ left, top });
    };
    const schedule = () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(place);
    };
    place();
    schedule();
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    // A cheap poll covers the column re-laying out without observing document.body.
    const timer = window.setInterval(schedule, 600);
    return () => {
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      window.clearInterval(timer);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, []);

  React.useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open]);

  const apply = (group, model) => {
    if (busy) return;
    // Every Session the sidebar lists belongs to the active Workspace; archived and
    // deleted Sessions are already absent from controller.list, so no extra filter.
    const cwd = typeof props.cwd === 'string' ? props.cwd : undefined;
    const body = { scope: 'workspace', provider: group.id, model: model.id };
    if (cwd !== undefined) body.cwd = cwd;
    const efforts = model.reasoning && Array.isArray(model.reasoning.efforts) ? model.reasoning.efforts : [];
    const wanted = effort !== '' ? effort : model.reasoning ? model.reasoning.defaultEffort : undefined;
    if (wanted !== undefined && wanted !== '' && (efforts.length === 0 || efforts.some((e) => e.id === wanted))) {
      body.reasoningEffort = wanted;
    }
    setBusy(true);
    setNote(null);
    setTone('muted');
    fetch(MODEL_BULK_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then((response) => (response.ok ? response.json() : { ok: false, error: 'http-' + response.status }))
      .then((result) => {
        if (!mountedRef.current) return;
        if (!result || result.ok !== true) {
          setNote(fill(t('modelBulkFailed'), { error: String((result && result.error) || 'error') }));
          setTone('error');
          probe('model-bulk-client', { ok: false, ...body });
          return;
        }
        probe('model-bulk-client', { ok: true, ...body, okCount: result.okCount, failed: result.failed });
        if (result.failed === 0) {
          setNote(fill(t('modelBulkDone'), { count: String(result.okCount) }));
          setTone('muted');
        } else {
          setNote(fill(t('modelBulkPartial'), { ok: String(result.okCount), failed: String(result.failed) }));
          setTone('warn');
        }
        setOpen(false);
        // The Session list carries the new pill: drop the cached catalog so it re-reads.
        modelCatalogCache = null;
      })
      .catch((error) => {
        if (!mountedRef.current) return;
        setNote(fill(t('modelBulkFailed'), { error: String((error && error.message) || error) }));
        setTone('error');
      })
      .finally(() => {
        if (mountedRef.current) setBusy(false);
      });
  };

  const toggle = () => {
    if (busy) return;
    if (catalog.status !== 'ready') {
      modelCatalogCache = null;
      setCatalog({ status: 'loading', groups: [], error: null });
      readModelCatalog(sessionApi).then((loaded) => {
        if (loaded.ok) setCatalog({ status: 'ready', groups: loaded.value.groups || [], error: null });
        else setCatalog({ status: 'error', groups: [], error: loaded.error });
      });
      return;
    }
    setOpen((was) => !was);
  };

  if (!anchor) return null;

  const items = [];
  if (catalog.status === 'loading') {
    items.push(h('div', { key: 'loading', 'data-ui-enhance-model-note': '' }, t('modelSwitchLoading')));
  } else if (catalog.status === 'error') {
    items.push(
      h('div', { key: 'error', 'data-ui-enhance-model-note': '', 'data-tone': 'error' },
        fill(t('modelSwitchError'), {
          error: (catalog.error && (catalog.error.code || catalog.error.message)) || 'error',
        }),
      ),
    );
  } else {
    items.push(h('div', { key: 'hint', 'data-ui-enhance-model-note': '' }, t('modelBulkHint')));
    for (const group of catalog.groups || []) {
      items.push(h('div', { key: 'g-' + group.id, 'data-ui-enhance-model-group': '' }, group.name || group.id));
      for (const model of group.models || []) {
        const efforts = model.reasoning && Array.isArray(model.reasoning.efforts) ? model.reasoning.efforts : [];
        items.push(
          h(
            'button',
            {
              key: 'm-' + group.id + '/' + model.id,
              type: 'button',
              'data-ui-enhance-model-item': '',
              title: model.description || model.name || model.id,
              disabled: busy,
              onClick: () => apply(group, model),
            },
            h('span', { key: 'n', 'data-ui-enhance-model-item-name': '' }, model.name || model.id),
            efforts.length > 1
              ? h('span', { key: 'e', 'data-ui-enhance-model-effort': '' }, String(efforts.length) + '×')
              : null,
          ),
        );
      }
    }
    // Effort ladder of the first group's default model, as a shared override.
    const first = (catalog.groups || [])[0];
    const firstModel = first && (first.models || [])[0];
    const ladder = firstModel && firstModel.reasoning && Array.isArray(firstModel.reasoning.efforts)
      ? firstModel.reasoning.efforts
      : [];
    if (ladder.length > 1) {
      items.push(h('div', { key: 'effort-title', 'data-ui-enhance-model-group': '' }, t('modelEffortGroup')));
      for (const level of ladder) {
        const picked = effort === level.id;
        items.push(
          h(
            'button',
            {
              key: 'eff-' + level.id,
              type: 'button',
              'data-ui-enhance-model-item': '',
              'data-picked': picked ? 'true' : 'false',
              title: level.description || level.name || level.id,
              disabled: busy,
              onClick: () => setEffort(picked ? '' : level.id),
            },
            h('span', { key: 'n', 'data-ui-enhance-model-item-name': '' }, level.name || level.id),
            picked ? h('span', { key: 'k', 'data-ui-enhance-model-tick': '' }, '✓') : null,
          ),
        );
      }
    }
  }
  if (note !== null) {
    items.push(h('div', { key: 'note', 'data-ui-enhance-model-note': '', 'data-tone': tone }, note));
  }

  const menu =
    open && typeof ReactDOM !== 'undefined' && ReactDOM && typeof ReactDOM.createPortal === 'function'
      ? ReactDOM.createPortal(
          h(
            'div',
            {
              [MODEL_BULK_MENU_ATTR]: '',
              'data-dsh-plugin': 'ui-enhance-model-bulk-menu',
              style: { left: anchor.left + 'px', top: String(anchor.top + 30) + 'px' },
            },
            ...items,
          ),
          document.body,
        )
      : null;

  // The trigger is portalled next to the Workspace header rather than rendered in the
  // footer, so it reads as part of the section it acts on.
  const trigger =
    typeof ReactDOM !== 'undefined' && ReactDOM && typeof ReactDOM.createPortal === 'function'
      ? ReactDOM.createPortal(
          h(
            'button',
            {
              ref: triggerRef,
              type: 'button',
              [MODEL_BULK_ATTR]: '',
              'data-dsh-plugin': 'ui-enhance-model-bulk',
              title: t('modelBulkTitle'),
              'data-busy': busy ? 'true' : 'false',
              'data-open': open ? 'true' : 'false',
              style: { left: anchor.left + 'px', top: anchor.top + 'px' },
              onClick: toggle,
            },
            h('svg', { key: 'i', viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': 'true' },
              h('path', {
                key: 'p',
                d: 'M8 1.6 9.9 6l4.5.4-3.4 3 1 4.4L8 11.4l-4 2.4 1-4.4-3.4-3L6.1 6Z',
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: '1.4',
                strokeLinejoin: 'round',
              }),
            ),
          ),
          document.body,
        )
      : null;

  return h('span', { ref: rootRef, 'data-dsh-plugin': 'ui-enhance-model-bulk-host' }, trigger, menu);
}

        /** Model + reasoning-effort pill: session header (current session) and row hover card. */
        function ModelBadge(props) {
          const selection = typeof props.useProjection === 'function' ? props.useProjection('modelSelection') : undefined;
          const current = selection ? selection.next ?? selection.lastUsed : null;
          if (!current) return null;
          const text = modelText(current);
          if (text === '') return null;
          return h(
            'span',
            {
              'data-dsh-plugin': 'ui-enhance-model',
              title: text,
              style: modelBadgeStyle,
            },
            text,
          );
        }

        /**
         * Shared force-reload behaviour. A second click confirms, because replacing the page
         * drops whatever is typed but not yet sent; the armed state disarms itself after a few
         * seconds so an accidental click cannot linger. The confirmed click first checks that
         * the bundles the next document would load still work: a broken plugin otherwise makes
         * the desktop shell show its "startup failure" dialog and leaves the app unusable until
         * it is restarted, so a reload that would hit that state is refused instead.
         */
        function useForceReload(slot) {
          const [armed, setArmed] = React.useState(false);
          const [busy, setBusy] = React.useState(false);
          const [blocked, setBlocked] = React.useState(false);
          const timer = React.useRef(null);

          React.useEffect(() => {
            probe('refresh-mount', { slot });
            watchAutoResumeReport();
            auditBootOnce();
            return () => {
              if (timer.current !== null) window.clearTimeout(timer.current);
            };
          }, []);

          const onClick = () => {
            if (busy) return;
            if (!armed) {
              setArmed(true);
              setBlocked(false);
              probe('refresh-arm', { slot });
              if (timer.current !== null) window.clearTimeout(timer.current);
              timer.current = window.setTimeout(() => {
                timer.current = null;
                setArmed(false);
              }, 4000);
              return;
            }
            if (timer.current !== null) window.clearTimeout(timer.current);
            timer.current = null;
            setArmed(false);
            setBusy(true);
            probe('refresh-check', { slot });
            void (async () => {
              let verdict;
              try {
                verdict = await preflightBoot();
              } catch (error) {
                // An unverifiable boot keeps the historical behaviour: reload anyway.
                verdict = {
                  ok: true,
                  checked: 0,
                  served: false,
                  source: 'unverified',
                  problems: [],
                  error: String((error && error.message) || error),
                };
              }
              if (!verdict.ok) {
                probe('refresh-blocked', {
                  slot,
                  checked: verdict.checked,
                  served: verdict.served,
                  source: verdict.source,
                  problems: (verdict.problems || []).slice(0, 3),
                });
                setBusy(false);
                setBlocked(true);
                if (timer.current !== null) window.clearTimeout(timer.current);
                timer.current = window.setTimeout(() => {
                  timer.current = null;
                  setBlocked(false);
                }, 4000);
                showReloadBlocked(verdict);
                return;
              }
              probe('refresh-go', {
                slot,
                checked: verdict.checked,
                served: verdict.served,
                source: verdict.source,
                noPlan: verdict.noPlan === true,
                error: verdict.error,
              });
              try {
                await forceReloadUi();
              } catch (error) {
                setBusy(false);
              }
            })();
          };

          const title = busy
            ? t('refreshBusy')
            : blocked
              ? t('refreshBlockedHint')
              : armed
                ? t('refreshConfirm')
                : t('refresh') + ' · ' + t('refreshHint');
          return { armed, busy, blocked, onClick, title };
        }

        /** The circular-arrow glyph shared by every force-reload entry point. */
        function refreshGlyph(size) {
          return h(
            'svg',
            { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': true, style: { flex: 'none' } },
            h('path', {
              d: 'M13 8a5 5 0 1 1-1.5-3.54M13 2.7v2.8h-2.8',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.4,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
            }),
          );
        }

        /** Session-header utility: icon-only force reload. */
        function RefreshButton() {
          const { armed, busy, blocked, onClick, title } = useForceReload('header');
          return h(
            'button',
            {
              type: 'button',
              'data-ui-enhance-refresh': '',
              'data-ui-enhance-refresh-armed': armed ? '' : undefined,
              'data-ui-enhance-refresh-blocked': blocked ? '' : undefined,
              title,
              'aria-label': t('refresh'),
              disabled: busy,
              // Keep the composer focused: this is a utility, not a navigation control.
              onMouseDown: (event) => event.preventDefault(),
              onClick,
            },
            refreshGlyph(13),
          );
        }

        /**
         * Sidebar-foot action beside Settings: present on every view (the header utility only
         * exists while a Session is open), and labelled whenever the sidebar is wide.
         */
        function SidebarRefreshButton(seatProps) {
          const { armed, busy, blocked, onClick, title } = useForceReload('sidebar');
          const props = seatProps || {};
          const wide = props.wide !== false;
          const label = busy
            ? t('refreshBusy')
            : blocked
              ? t('refreshBlocked')
              : armed
                ? t('refreshArmed')
                : t('refreshShort');
          return h(
            'button',
            {
              type: 'button',
              'data-ui-enhance-refresh-side': '',
              'data-ui-enhance-refresh-armed': armed ? '' : undefined,
              'data-ui-enhance-refresh-blocked': blocked ? '' : undefined,
              'data-ui-enhance-refresh-wide': wide ? '' : undefined,
              title,
              'aria-label': t('refresh'),
              disabled: busy,
              onMouseDown: (event) => event.preventDefault(),
              onClick,
            },
            refreshGlyph(13),
            wide ? h('span', { style: { marginLeft: 6 } }, label) : null,
          );
        }

        /**
         * The workspace's checked-out git branch, drawn in the file tree's title bar. The Host
         * reads `.git/HEAD` for the directory the tree is rooted at (a plain read, no `git`
         * process), so this only has to fetch and show it; a tree root outside a repository
         * renders nothing. The branch is re-read on focus and on a slow timer because it can
         * also be changed from a terminal.
         */
        const GIT_BRANCH_URL = '/plugin/ui-enhance/git';
        const GIT_BRANCH_POLL_MS = 15000;
        function GitBranchBadge(props) {
          const useSessions = props.useSessions;
          const sessionId = props.sessionId;
          const ownerPath = typeof props.absolutePath === 'string' ? props.absolutePath : '';
          const cwd =
            typeof useSessions === 'function' && sessionId !== undefined
              ? useSessions((sessions) => (sessions && sessions.byId ? sessions.byId[sessionId]?.cwd : undefined))
              : undefined;
          const root = ownerPath !== '' ? ownerPath : typeof cwd === 'string' ? cwd : '';
          const [git, setGit] = React.useState(null);
          React.useEffect(() => {
            if (root === '') return undefined;
            let disposed = false;
            let timer = null;
            const load = () => {
              fetch(GIT_BRANCH_URL + '?path=' + encodeURIComponent(root), { cache: 'no-store' })
                .then((response) => (response.ok ? response.json() : null))
                .then((report) => {
                  if (disposed) return;
                  const next =
                    report && report.ok === true && report.repo === true && typeof report.branch === 'string'
                      ? { branch: report.branch, detached: report.detached === true }
                      : null;
                  setGit((previous) => {
                    if (previous === null && next === null) return previous;
                    if (
                      previous !== null &&
                      next !== null &&
                      previous.branch === next.branch &&
                      previous.detached === next.detached
                    ) {
                      return previous;
                    }
                    return next;
                  });
                })
                .catch(() => {
                  if (!disposed) setGit(null);
                });
            };
            load();
            timer = window.setInterval(load, GIT_BRANCH_POLL_MS);
            const onWake = () => {
              if (document.visibilityState === 'visible') load();
            };
            document.addEventListener('visibilitychange', onWake);
            window.addEventListener('focus', onWake);
            return () => {
              disposed = true;
              if (timer !== null) window.clearInterval(timer);
              document.removeEventListener('visibilitychange', onWake);
              window.removeEventListener('focus', onWake);
            };
          }, [root]);
          if (git === null) return null;
          return h(
            'span',
            {
              'data-ui-enhance-git-branch': '',
              title: git.detached ? fill(t('gitDetached'), { branch: git.branch }) : fill(t('gitBranch'), { branch: git.branch }),
            },
            h(
              'svg',
              { viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' },
              h('circle', { cx: 4, cy: 3.5, r: 1.6 }),
              h('circle', { cx: 12, cy: 4.5, r: 1.6 }),
              h('circle', { cx: 4, cy: 12.5, r: 1.6 }),
              h('path', { d: 'M4 5.1v5.8' }),
              h('path', { d: 'M12 6.1c0 2.2-1.7 3.5-4.4 3.5H4' }),
            ),
            h('span', { 'data-ui-enhance-git-branch-name': '' }, git.branch),
          );
        }

        /* 「一键恢复」--------------------------------------------------------------
         * One click resumes every Session whose last turn never ended because the DSH
         * process exited mid-turn. The Host already owns that whole path (durable-log
         * scan, crashed-tail repair, continuation prompt through the normal send call),
         * so this button is only the manual trigger plus an inline result report.
         *
         * It lives in the 「工作区」 header row next to the search and new-session
         * actions: the shipped row already saturates its own widths, so the button is
         * portalled into an anchor inserted just before the action cluster.
         */
        const RESUME_URL = '/plugin/ui-enhance/auto-resume';
        const RESUME_ANCHOR = 'data-ui-enhance-resume-host';
        const RESUME_HEADER_SELECTOR = '[class*="sectionHeader"]';

        /** The anchor node inside the 「工作区」 header row, created on first use. */
        function findResumeHost() {
          let host = document.querySelector('[' + RESUME_ANCHOR + ']');
          if (host !== null) {
            if (host.isConnected) return host;
            host.remove();
          }
          const header = document.querySelector(RESUME_HEADER_SELECTOR);
          if (header === null) return null;
          host = document.createElement('div');
          host.setAttribute(RESUME_ANCHOR, '');
          host.style.cssText = 'display:inline-flex;align-items:center;flex:none;';
          const actions = header.querySelector('[class*="headerActions"]');
          if (actions !== null && actions.parentElement === header) {
            header.insertBefore(host, actions);
          } else {
            header.appendChild(host);
          }
          return host;
        }

        /** Re-resolve the anchor whenever the shipped header is rebuilt. */
        function useResumeHost() {
          const [host, setHost] = React.useState(null);
          React.useEffect(() => {
            let frame = 0;
            const check = () => {
              frame = 0;
              const next = findResumeHost();
              setHost((previous) => {
                if (next === null) return null;
                if (previous !== null && previous === next && previous.isConnected) return previous;
                return next;
              });
            };
            const schedule = () => {
              if (frame !== 0) return;
              frame = window.requestAnimationFrame(check);
            };
            check();
            const observer = new MutationObserver(schedule);
            observer.observe(document.body, { childList: true, subtree: true });
            return () => {
              observer.disconnect();
              if (frame !== 0) window.cancelAnimationFrame(frame);
            };
          }, []);
          return host;
        }

        /**
         * The button itself: a 28px icon button that runs one manual scan and reports
         * the outcome in a short-lived tooltip-like note.
         */
        function ResumeButton(props) {
          const t = props.t;
          const host = useResumeHost();
          const [phase, setPhase] = React.useState('idle');
          const [note, setNote] = React.useState(null);
          const timerRef = React.useRef(0);

          React.useEffect(
            () => () => {
              if (timerRef.current !== 0) window.clearTimeout(timerRef.current);
            },
            [],
          );

          const run = React.useCallback(async () => {
            if (phase === 'running') return;
            setPhase('running');
            setNote(null);
            let nextPhase = 'error';
            let nextNote = t('resumeFailed');
            try {
              const response = await fetch(RESUME_URL + '?run=continue', {
                method: 'GET',
                cache: 'no-store',
                credentials: 'same-origin',
                headers: { accept: 'application/json' },
              });
              const body = await response.json().catch(() => null);
              const report = body && body.report ? body.report : null;
              if (response.status === 409) {
                nextPhase = 'empty';
                nextNote = t('resumeBusy');
              } else if (body === null || body.ok !== true || report === null) {
                nextPhase = 'error';
                nextNote = t('resumeFailed');
              } else if (typeof report.skipped === 'string' && report.skipped === 'disabled') {
                nextPhase = 'empty';
                nextNote = t('resumeNone');
              } else {
                const interrupted = typeof report.interrupted === 'number' ? report.interrupted : 0;
                const prompted = typeof report.prompted === 'number' ? report.prompted : 0;
                if (interrupted === 0) {
                  nextPhase = 'empty';
                  nextNote = t('resumeNone');
                } else if (prompted === interrupted) {
                  nextPhase = 'done';
                  nextNote = fill(t('resumeDone'), { n: prompted });
                } else {
                  nextPhase = 'done';
                  nextNote = fill(t('resumePartial'), { n: prompted, m: interrupted });
                }
              }
              probe('resume-button', {
                phase: nextPhase,
                interrupted: report && report.interrupted,
                prompted: report && report.prompted,
              });
            } catch (error) {
              nextPhase = 'error';
              nextNote = t('resumeFailed');
            }
            setPhase(nextPhase);
            setNote(nextNote);
            if (timerRef.current !== 0) window.clearTimeout(timerRef.current);
            timerRef.current = window.setTimeout(() => {
              setPhase('idle');
              setNote(null);
            }, 4200);
          }, [phase, t]);

          if (host === null) return null;

          const button = h(
            'button',
            {
              type: 'button',
              'data-ui-enhance-resume-button': '',
              'data-phase': phase,
              'aria-label': t('resumeTip'),
              title: note === null ? t('resumeTip') : note,
              onClick: () => {
                void run();
              },
            },
            phase === 'running'
              ? h('span', { 'data-ui-enhance-resume-spinner': '' }, '')
              : h(
                  'svg',
                  {
                    width: 14,
                    height: 14,
                    viewBox: '0 0 16 16',
                    fill: 'none',
                    'aria-hidden': 'true',
                    focusable: 'false',
                  },
                  h('path', {
                    d: 'M13.5 8a5.5 5.5 0 1 1-1.61-3.89',
                    stroke: 'currentColor',
                    'stroke-width': 1.4,
                    'stroke-linecap': 'round',
                  }),
                  h('path', {
                    d: 'M13.5 2.2v3.1h-3.1',
                    stroke: 'currentColor',
                    'stroke-width': 1.4,
                    'stroke-linecap': 'round',
                    'stroke-linejoin': 'round',
                  }),
                ),
          );

          return ReactDOM.createPortal(
            h(
              'div',
              { 'data-ui-enhance-resume-wrap': '' },
              button,
              note === null ? null : h('div', { 'data-ui-enhance-resume-note': '', 'data-phase': phase }, note),
            ),
            host,
          );
        }

        ctx.slots.inject('sidebar.right.tab.files.actions', () =>
          ctx.slots.register(
            {
              name: 'sidebar.right.tab.files.actions',
              id: 'ui-enhance-git-branch',
              order: 4,
            },
            GitBranchBadge,
          ),
        );

        ctx.slots.inject('conversation.input.overlay', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.overlay',
              id: 'ui-enhance-hud',
              order: 10,
            },
            HudPanel,
          ),
        );

        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'ui-enhance-dock-controls',
              order: 11,
            },
            DockControls,
          ),
        );

        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'ui-enhance-meter',
              order: 12,
            },
            MeterBridge,
          ),
        );

        /* The 美化 button belongs next to the permission control in the composer tool
         * row, not above the composer with the meter. `conversation.input.left` is the
         * list seat immediately beside `conversation.input.permission` (the 完全权限
              BeautifyAskButton,
         *
         * `conversation.input.permission` itself is a SINGLE seat that shadows shipped
         * UI (replaceRisk: shadows-shipped-ui) -- taking it over would hide the native
         * permission control, which is the failure mode that froze the client before.
         * A list seat next to it is additive and safe. */
        // Remove the shipped hover card's opener delay before the sidebar is wired, so
        // the very first hover already opens without the wait. The wrapper reports the
        // delay it held back the first time a row is hovered.
        removeHoverDelay(require);
        ctx.effect(() => {
          const timer = window.setInterval(() => {
            if (hoverPatch.delayMs === 0) return;
            probe('hover-delay-patch', {
              state: hoverPatch.state,
              ms: hoverPatch.delayMs,
              detail: hoverPatch.detail,
              seen: hoverPatch.seen,
              sample: hoverPatch.sample,
            });
            window.clearInterval(timer);
          }, 400);
          return () => window.clearInterval(timer);
        }, 'ui-enhance: hover delay report');

        // beautify-slot-probe: an injection that fails silently is indistinguishable
        // from a component that renders nothing, so record both outcomes.
        probe('beautify-slot', { phase: 'before', hasInject: !!(ctx && ctx.slots && ctx.slots.inject) });
        try {
          ctx.slots.inject('conversation.input.left', () =>
            ctx.slots.register(
              {
                name: 'conversation.input.left',
                id: 'ui-enhance-ask',
                order: 13,
              },
              BeautifyAskButton,
            ),
          );
          probe('beautify-slot', { phase: 'ok' });
        } catch (error) {
          probe('beautify-slot', { phase: 'threw', msg: String((error && error.message) || error) });
        }

        /*
         * Give the beautify controls a permanent seat in the right-hand column. The
         * composer popover stays as the quick path, but it is only reachable while a
         * session is open, so the sliders had no discoverable home in the sidebar.
         */
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: 'ui-enhance-beautify',
              order: 30,
              label: () => '界面美化',
            },
            BeautifyPanelIcon,
          ),
        );

        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: 'ui-enhance-beautify',
            },
            BeautifyPanelMain,
          ),
        );

        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'ui-enhance-workspace-branch',
              order: 101,
            },
            WorkspaceBranchPills,
          ),
        );

        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'ui-enhance-context-bars',
              order: 100,
            },
            SidebarContextBars,
          ),
        );

        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'ui-enhance-refresh-side',
              order: 90,
            },
            SidebarRefreshButton,
          ),
        );

        // One-click model switch for the whole Workspace. Registered in the append-only
        // footer list (replaceRisk: none); its trigger portals onto the Workspace header,
        // so the shipped workspace browser is decorated, never replaced.
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'ui-enhance-model-bulk',
              order: 102,
            },
            (props) => h(WorkspaceModelBulk, { ...props, t }),
          ),
        );

        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.utilities',
              id: 'ui-enhance-model-header-switch',
              order: -8,
            },
            (props) =>
              h(ModelSwitch, {
                ...props,
                t,
                active: true,
                sessionId: props.sessionId,
                useProjection: props.useProjection,
              }),
          ),
        );

        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.utilities',
              id: 'ui-enhance-refresh',
              order: -7,
            },
            RefreshButton,
          ),
        );

        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'ui-enhance-resume',
              order: 103,
            },
            (props) => h(ResumeButton, { ...props, t }),
          ),
        );

        /* The built-in hover card (dsh-client-ui-workspace, openDelayMs 800) drew its content
         * from the `sidebar.session.row.hover` slot, so it always appeared with an 800 ms lag
         * and duplicated the instant panel below. Supplying it nothing lets it render an empty
         * shell; the instant panel is the only hover surface this plugin owns. */

        /* Feature #7 + #5: the token panel and the Workspace scope chip render themselves
           into the sidebar's own DOM, so this slot entry only boots their syncing effect. */
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'ui-enhance-token-aggregate',
              order: 99,
            },
            (props) => h(TokenAggregate, { t }),
          ),
        );
      },
    };
  },
});
