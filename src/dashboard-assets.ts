export const dashboardHtml = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>QuotaFlow Control Plane</title>
  <link rel="stylesheet" href="/assets/app.css">
</head>
<body>
  <div class="shell">
    <aside class="sidebar">
      <a class="brand" href="#overview" aria-label="QuotaFlow Overview">
        <span class="brand-mark" aria-hidden="true"></span>
        <span>
          <strong>QuotaFlow</strong>
          <small>Local workspace</small>
        </span>
      </a>

      <p class="sidebar-section">Workspace</p>
      <nav class="nav" aria-label="Dashboard">
        <button class="nav-item is-active" type="button" data-view="overview">
          <span>Overview</span>
        </button>
        <button class="nav-item" type="button" data-view="tasks">
          <span>Tasks</span>
        </button>
        <button class="nav-item" type="button" data-view="github">
          <span>GitHub</span>
        </button>
        <button class="nav-item" type="button" data-view="budgets">
          <span>Budgets</span>
        </button>
      </nav>

      <section class="sidebar-recents" aria-labelledby="recent-task-label">
        <p id="recent-task-label" class="sidebar-section">Recent tasks</p>
        <div id="sidebar-recents"></div>
      </section>

      <div class="sidebar-note">
        <span class="local-dot" aria-hidden="true"></span>
        <div>
          <strong>Local control</strong>
          <small>Guarded task and GitHub actions</small>
        </div>
      </div>
    </aside>

    <main class="main">
      <header class="topbar">
        <div>
          <h1 id="view-title">Overview</h1>
          <p id="view-subtitle" class="view-subtitle">任务、门禁和资源状态的统一视图</p>
        </div>
        <div class="live-block">
          <label class="project-filter">
            <span>项目</span>
            <select id="project-filter">
              <option value="">全部项目</option>
            </select>
          </label>
          <label class="project-filter">
            <span>时间</span>
            <select id="time-filter">
              <option value="">全部时间</option>
              <option value="1h">最近 1 小时</option>
              <option value="24h">最近 24 小时</option>
              <option value="7d">最近 7 天</option>
              <option value="30d">最近 30 天</option>
            </select>
          </label>
          <span class="live-pill" data-state="connecting"><span aria-hidden="true"></span><b id="live-label">Connecting</b></span>
          <button id="refresh-button" class="icon-button" type="button" aria-label="刷新数据" title="刷新数据">↻</button>
          <small id="last-updated">等待数据</small>
        </div>
      </header>

      <div id="error-banner" class="error-banner" hidden role="alert"></div>

      <section class="view is-visible" data-view-panel="overview" aria-labelledby="view-title">
        <div id="metrics" class="metrics" aria-label="关键指标"></div>

        <div class="overview-grid">
          <section class="panel panel-wide">
            <div class="panel-heading">
              <div>
                <h2>最近任务</h2>
              </div>
              <button class="text-button" type="button" data-open-view="tasks">查看全部</button>
            </div>
            <div id="overview-task-list" class="task-stack"></div>
          </section>

          <section class="panel">
            <div class="panel-heading">
              <div>
                <h2>事件流</h2>
              </div>
            </div>
            <div id="event-stream" class="event-stream"></div>
          </section>
        </div>

        <section class="panel">
          <div class="panel-heading">
            <div>
              <h2>Lane 与仓库</h2>
            </div>
          </div>
          <div id="execution-map" class="execution-map"></div>
        </section>
      </section>

      <section class="view" data-view-panel="tasks" aria-labelledby="view-title">
        <section class="panel">
          <div class="panel-heading panel-heading-wrap">
            <div>
              <h2>任务队列</h2>
            </div>
            <div class="task-tools">
              <label class="search-field">
                <span class="sr-only">搜索任务</span>
                <input id="task-search" type="search" placeholder="搜索标题、ID 或仓库">
              </label>
              <label class="select-field">
                <span class="sr-only">状态筛选</span>
                <select id="task-status-filter">
                  <option value="">全部状态</option>
                </select>
              </label>
              <label class="select-field">
                <span class="sr-only">Lane 筛选</span>
                <select id="task-lane-filter">
                  <option value="">全部 Lane</option>
                </select>
              </label>
            </div>
          </div>
          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>任务</th>
                  <th>状态</th>
                  <th>优先级</th>
                  <th>模式</th>
                  <th>更新时间</th>
                  <th></th>
                </tr>
              </thead>
              <tbody id="task-table-body"></tbody>
            </table>
          </div>
          <div id="task-empty" class="empty-state" hidden>没有匹配的任务</div>
        </section>
      </section>

      <section class="view" data-view-panel="github" aria-labelledby="view-title">
        <div id="github-metrics" class="metrics metrics-compact" aria-label="GitHub 指标"></div>
        <div class="overview-grid">
          <section class="panel panel-wide">
            <div class="panel-heading panel-heading-wrap">
              <div>
                <h2>最近门禁</h2>
              </div>
              <label class="select-field">
                <span class="sr-only">审查状态筛选</span>
                <select id="review-filter">
                  <option value="">全部审查状态</option>
                  <option value="approved">审查已通过</option>
                  <option value="missing">缺少独立审查</option>
                  <option value="changes_requested">请求修改</option>
                </select>
              </label>
            </div>
            <div class="table-wrap">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>PR</th>
                    <th>HEAD</th>
                    <th>状态</th>
                    <th>原因</th>
                    <th>更新时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody id="gate-table-body"></tbody>
              </table>
            </div>
            <div id="gate-empty" class="empty-state" hidden>暂无 Gate 记录</div>
          </section>

          <section class="panel">
            <div class="panel-heading">
              <div>
                <h2>重跑记录</h2>
              </div>
            </div>
            <div id="rerun-list" class="event-stream"></div>
          </section>
        </div>
      </section>

      <section class="view" data-view-panel="budgets" aria-labelledby="view-title">
        <div id="budget-cards" class="metrics metrics-compact" aria-label="预算指标"></div>
        <div class="overview-grid">
          <section class="panel panel-wide">
            <div class="panel-heading">
              <div>
                <h2>预算窗口</h2>
              </div>
            </div>
            <div id="budget-list" class="budget-list"></div>
          </section>
          <section class="panel">
            <div class="panel-heading">
              <div>
                <h2>执行通道</h2>
              </div>
            </div>
            <div id="lane-list" class="event-stream"></div>
          </section>
        </div>
      </section>
    </main>
  </div>

  <dialog id="task-dialog" class="task-dialog" aria-labelledby="dialog-title">
    <div class="dialog-shell">
      <header class="dialog-header">
        <div>
          <h2 id="dialog-title">任务详情</h2>
          <p id="dialog-meta" class="view-subtitle"></p>
        </div>
        <button id="dialog-close" class="icon-button" type="button" aria-label="关闭详情">×</button>
      </header>
      <div id="dialog-content" class="dialog-content"></div>
    </div>
  </dialog>

  <dialog id="action-dialog" class="action-dialog" aria-labelledby="action-dialog-title">
    <form method="dialog" class="action-dialog-shell">
      <h2 id="action-dialog-title">确认操作</h2>
      <p id="action-dialog-message"></p>
      <div id="action-dialog-error" class="action-dialog-error" hidden></div>
      <div class="action-dialog-buttons">
        <button id="action-dialog-cancel" class="secondary-button" type="button">取消</button>
        <button id="action-dialog-confirm" class="danger-button" type="button">确认</button>
      </div>
    </form>
  </dialog>

  <dialog id="github-action-dialog" class="action-dialog" aria-labelledby="github-action-title">
    <form method="dialog" class="action-dialog-shell">
      <h2 id="github-action-title">确认 GitHub 操作</h2>
      <p id="github-action-message"></p>
      <code id="github-action-target" class="github-action-target"></code>
      <label class="github-confirm-field">
        <span>输入完整目标以确认</span>
        <input id="github-action-input" type="text" autocomplete="off" spellcheck="false">
      </label>
      <div id="github-action-error" class="action-dialog-error" hidden></div>
      <div class="action-dialog-buttons">
        <button id="github-action-cancel" class="secondary-button" type="button">取消</button>
        <button id="github-action-confirm" class="danger-button" type="button">确认</button>
      </div>
    </form>
  </dialog>

  <script src="/assets/app.js" defer></script>
</body>
</html>`;

export const dashboardCss = `:root {
  --bg: #090d10;
  --bg-raised: #0e1418;
  --panel: rgba(16, 23, 28, 0.88);
  --panel-strong: #121b20;
  --line: #243139;
  --line-soft: rgba(123, 153, 165, 0.14);
  --text: #eef5f1;
  --muted: #8ea1a5;
  --faint: #5e7075;
  --mint: #8eb7ff;
  --mint-dim: rgba(142, 183, 255, 0.11);
  --amber: #f0b86b;
  --red: #ef7f78;
  --blue: #84b9ff;
  --shadow: 0 24px 70px rgba(0, 0, 0, 0.38);
  --mono: "IBM Plex Mono", "SFMono-Regular", Consolas, monospace;
  --sans: "Avenir Next", "Helvetica Neue", ui-sans-serif, sans-serif;
}

* { box-sizing: border-box; }
html { background: var(--bg); }
body {
  margin: 0;
  min-height: 100vh;
  color: var(--text);
  font-family: var(--sans);
  background: var(--bg);
}
button, input, select { font: inherit; }
button { color: inherit; }
button, a, select { -webkit-tap-highlight-color: transparent; }
button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible {
  outline: 2px solid var(--mint);
  outline-offset: 3px;
}
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0;
}
.shell { display: grid; grid-template-columns: 224px minmax(0, 1fr); min-height: 100vh; }
.sidebar {
  position: sticky; top: 0; height: 100vh; padding: 18px 12px;
  display: flex; flex-direction: column; gap: 20px;
  border-right: 1px solid var(--line-soft);
  background: rgba(7, 11, 13, 0.82);
  backdrop-filter: blur(16px);
}
.brand {
  display: flex; align-items: center; gap: 10px; color: var(--text);
  text-decoration: none; padding: 0 8px 8px;
}
.brand-mark {
  width: 10px; height: 10px; background: var(--mint);
  box-shadow: 0 0 18px rgba(142, 183, 255, 0.48);
}
.brand strong { display: block; font-size: 14px; letter-spacing: -0.02em; }
.brand small { display: block; color: var(--muted); font: 10px/1.3 var(--mono); text-transform: uppercase; letter-spacing: 0.13em; }
.sidebar-section {
  margin: 0; padding: 0 10px 6px; color: var(--faint);
  font: 9px/1 var(--mono); text-transform: uppercase; letter-spacing: 0.12em;
}
.nav { display: grid; gap: 6px; }
.nav-item {
  display: block;
  width: 100%; border: 1px solid transparent; background: transparent;
  color: var(--muted); text-align: left; padding: 9px 11px; cursor: pointer;
  font-size: 12px;
}
.nav-item:hover { color: var(--text); background: rgba(255,255,255,0.025); }
.nav-item.is-active { color: var(--text); border-color: var(--line); background: var(--panel); }
.sidebar-recents { min-height: 0; overflow: auto; }
.sidebar-recent {
  display: block; width: 100%; border: 0; background: transparent; color: var(--muted);
  padding: 8px 10px; text-align: left; cursor: pointer;
}
.sidebar-recent:hover { color: var(--text); background: rgba(255,255,255,0.025); }
.sidebar-recent span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.sidebar-recent small { display: block; margin-top: 4px; color: var(--faint); font: 9px/1 var(--mono); }
.sidebar-note { margin-top: auto; display: flex; gap: 10px; align-items: flex-start; padding: 14px 10px; border-top: 1px solid var(--line); }
.sidebar-note strong, .sidebar-note small { display: block; }
.sidebar-note strong { font-size: 12px; }
.sidebar-note small { margin-top: 3px; color: var(--muted); font-size: 10px; }
.local-dot { width: 7px; height: 7px; margin-top: 5px; border-radius: 50%; background: var(--mint); box-shadow: 0 0 12px var(--mint); }
.main { min-width: 0; padding: 22px clamp(20px, 3vw, 40px) 48px; }
.topbar {
  display: flex; justify-content: space-between; align-items: flex-end; gap: 26px;
  margin-bottom: 18px; padding-bottom: 15px; border-bottom: 1px solid var(--line-soft);
}
h1, h2, h3, p { margin-top: 0; }
h1 { margin-bottom: 5px; font-size: 27px; line-height: 1; letter-spacing: -0.04em; font-weight: 600; }
h2 { margin-bottom: 0; font-size: 15px; letter-spacing: -0.02em; font-weight: 600; }
h3 { margin-bottom: 5px; font-size: 14px; }
.view-subtitle { margin-bottom: 0; color: var(--muted); font-size: 13px; }
.live-block { display: flex; align-items: center; gap: 10px; }
.live-block small { color: var(--muted); font: 10px/1 var(--mono); white-space: nowrap; }
.project-filter { display: flex; align-items: center; gap: 7px; color: var(--faint); font: 9px/1 var(--mono); }
.project-filter select {
  max-width: 210px; height: 32px; border: 1px solid var(--line); background: var(--bg-raised);
  color: var(--text); padding: 0 28px 0 9px; font: 10px/1 var(--mono);
}
.live-pill {
  display: inline-flex; align-items: center; gap: 7px; padding: 7px 10px;
  border: 1px solid rgba(119,224,181,0.28); color: var(--mint); background: var(--mint-dim);
  font: 10px/1 var(--mono); text-transform: uppercase; letter-spacing: 0.1em;
}
.live-pill span { width: 6px; height: 6px; border-radius: 50%; background: var(--mint); box-shadow: 0 0 10px var(--mint); }
.live-pill b { font-weight: 500; }
.live-pill[data-state="connecting"] { color: var(--amber); border-color: rgba(240,184,107,0.3); background: rgba(240,184,107,0.08); }
.live-pill[data-state="offline"] { color: var(--red); border-color: rgba(239,127,120,0.3); background: rgba(239,127,120,0.08); }
.live-pill[data-state="offline"] span { background: var(--red); box-shadow: 0 0 10px var(--red); }
.icon-button {
  display: grid; place-items: center; width: 34px; height: 34px;
  border: 1px solid var(--line); background: var(--bg-raised); cursor: pointer;
  color: var(--muted); font: 18px/1 var(--mono);
}
.icon-button:hover { color: var(--text); border-color: var(--muted); }
.error-banner { margin-bottom: 18px; padding: 12px 14px; border: 1px solid rgba(239,127,120,0.4); color: #ffd2cf; background: rgba(239,127,120,0.09); font-size: 13px; }
.view { display: none; animation: reveal 220ms ease-out; }
.view.is-visible { display: block; }
@keyframes reveal { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.metrics { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; margin-bottom: 18px; }
.metrics-compact { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.metric-card {
  position: relative; min-height: 88px; padding: 13px 14px; overflow: hidden;
  border: 1px solid var(--line); background: var(--panel);
}
.metric-label { display: block; color: var(--muted); font: 10px/1 var(--mono); letter-spacing: 0.1em; text-transform: uppercase; }
.metric-value { display: block; margin-top: 12px; font: 600 25px/1 var(--mono); letter-spacing: -0.05em; }
.metric-detail { display: block; margin-top: 7px; color: var(--faint); font-size: 11px; }
.metric-card[data-tone="mint"] .metric-value { color: var(--mint); }
.metric-card[data-tone="amber"] .metric-value { color: var(--amber); }
.metric-card[data-tone="red"] .metric-value { color: var(--red); }
.metric-card[data-tone="blue"] .metric-value { color: var(--blue); }
.overview-grid {
  display: grid; grid-template-columns: minmax(0, 1.65fr) minmax(280px, 0.85fr);
  grid-auto-rows: max-content; align-items: start; gap: 18px; margin-bottom: 18px;
}
.overview-grid > .panel { align-self: start; height: max-content; }
.panel { border: 1px solid var(--line); background: var(--panel); box-shadow: var(--shadow); }
.panel-heading { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 13px 15px; border-bottom: 1px solid var(--line-soft); }
.panel-heading-wrap { align-items: flex-end; }
.text-button { border: 0; background: transparent; color: var(--mint); cursor: pointer; font: 11px/1 var(--mono); }
.text-button:hover { text-decoration: underline; text-underline-offset: 4px; }
.task-stack { display: grid; }
.task-row {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 20px; align-items: center;
  width: 100%; padding: 12px 15px; border: 0; border-bottom: 1px solid var(--line-soft);
  color: inherit; background: transparent; text-align: left; font: inherit; cursor: pointer;
}
.task-row:last-child { border-bottom: 0; }
.task-row:hover { background: rgba(255,255,255,0.022); }
.task-title { margin: 0; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.task-subline { margin-top: 6px; color: var(--faint); font: 10px/1.3 var(--mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.task-row-end { display: flex; align-items: center; gap: 12px; }
.status {
  display: inline-flex; align-items: center; gap: 6px; padding: 5px 8px;
  border: 1px solid var(--line); color: var(--muted); background: rgba(255,255,255,0.02);
  font: 9px/1 var(--mono); text-transform: uppercase; letter-spacing: 0.08em; white-space: nowrap;
}
.status::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.status-running, .status-completed, .status-ready-for-human-merge { color: var(--mint); border-color: rgba(142,183,255,0.3); }
.status-queued, .status-waiting-quota, .status-waiting-dependency, .status-waiting-human, .status-cancelling { color: var(--amber); border-color: rgba(240,184,107,0.3); }
.status-failed, .status-blocked, .status-cancelled { color: var(--red); border-color: rgba(239,127,120,0.3); }
.priority { color: var(--muted); font: 11px/1 var(--mono); }
.event-stream { max-height: 300px; overflow: auto; }
.event-item { display: grid; grid-template-columns: 8px minmax(0, 1fr); gap: 11px; padding: 13px 18px; border-bottom: 1px solid var(--line-soft); }
.event-item:last-child { border-bottom: 0; }
.event-mark { width: 6px; height: 6px; margin-top: 5px; background: var(--faint); transform: rotate(45deg); }
.event-kind { color: var(--text); font: 10px/1.4 var(--mono); }
.event-title { margin-top: 4px; color: var(--muted); font-size: 11px; line-height: 1.45; }
.event-time { margin-top: 5px; color: var(--faint); font: 9px/1 var(--mono); }
.execution-map { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1px; background: var(--line-soft); }
.map-item { padding: 17px 20px; background: var(--panel-strong); }
.map-item strong { display: block; font-size: 12px; }
.map-item small { display: block; margin-top: 6px; color: var(--muted); font: 10px/1.5 var(--mono); }
.task-tools { display: flex; gap: 9px; flex-wrap: wrap; }
.search-field input, .select-field select {
  height: 36px; border: 1px solid var(--line); background: var(--bg-raised); color: var(--text); padding: 0 11px; font-size: 12px;
}
.search-field input { width: min(310px, 42vw); }
.table-wrap { overflow-x: auto; }
.data-table { width: 100%; border-collapse: collapse; min-width: 720px; }
.data-table th {
  padding: 10px 16px; color: var(--faint); text-align: left; border-bottom: 1px solid var(--line);
  font: 9px/1 var(--mono); text-transform: uppercase; letter-spacing: 0.1em;
}
.data-table td { padding: 13px 16px; color: var(--muted); border-bottom: 1px solid var(--line-soft); font-size: 11px; }
.data-table tbody tr { cursor: pointer; }
.data-table tbody tr:hover { background: rgba(255,255,255,0.022); }
.data-table tbody tr:last-child td { border-bottom: 0; }
.cell-main { display: block; max-width: 400px; color: var(--text); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cell-sub { display: block; margin-top: 4px; color: var(--faint); font: 9px/1.3 var(--mono); }
.mono { font-family: var(--mono); }
.faint { color: var(--faint); }
.gate-actions { white-space: nowrap; }
.gate-actions .text-button + .text-button { margin-left: 10px; }
.empty-state { padding: 28px 20px; color: var(--faint); text-align: center; font: 11px/1.5 var(--mono); }
.budget-list { display: grid; }
.budget-row { padding: 17px 20px; border-bottom: 1px solid var(--line-soft); }
.budget-row:last-child { border-bottom: 0; }
.budget-top { display: flex; justify-content: space-between; gap: 18px; align-items: baseline; }
.budget-top strong { font: 12px/1 var(--mono); }
.budget-top span { color: var(--muted); font: 10px/1 var(--mono); }
.bar {
  display: block; width: 100%; height: 5px; margin-top: 12px; border: 0;
  background: #182329; appearance: none; overflow: hidden;
}
.bar::-webkit-progress-bar { background: #182329; }
.bar::-webkit-progress-value { background: var(--mint); }
.bar::-moz-progress-bar { background: var(--mint); }
.budget-meta { display: flex; justify-content: space-between; margin-top: 8px; color: var(--faint); font-size: 10px; }
.task-dialog {
  width: min(920px, calc(100vw - 36px)); max-height: calc(100vh - 36px);
  padding: 0; color: var(--text); border: 1px solid var(--line); background: #0c1216; box-shadow: var(--shadow);
}
.task-dialog::backdrop { background: rgba(2, 5, 7, 0.76); backdrop-filter: blur(4px); }
.dialog-shell { display: grid; max-height: calc(100vh - 38px); }
.dialog-header { display: flex; justify-content: space-between; gap: 20px; padding: 22px; border-bottom: 1px solid var(--line); }
.dialog-content { overflow: auto; padding: 22px; }
.detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.detail-block { padding: 15px; border: 1px solid var(--line-soft); background: var(--bg-raised); }
.detail-block h3 { margin-bottom: 10px; color: var(--muted); font: 10px/1 var(--mono); text-transform: uppercase; letter-spacing: 0.1em; }
.kv { display: grid; grid-template-columns: 115px minmax(0, 1fr); gap: 10px; margin-top: 7px; font-size: 11px; }
.kv span:first-child { color: var(--faint); }
.kv span:last-child { overflow-wrap: anywhere; }
.prompt-box { max-height: 260px; overflow: auto; white-space: pre-wrap; color: #c8d5d3; font: 10px/1.55 var(--mono); }
.timeline { display: grid; gap: 10px; }
.timeline-item { padding-left: 13px; border-left: 1px solid var(--line); }
.timeline-item strong { display: block; font: 10px/1.4 var(--mono); }
.timeline-item small { color: var(--faint); font-size: 10px; }
.worker-runs { display: grid; gap: 10px; }
.worker-run { padding: 11px 0 0; border-top: 1px solid var(--line-soft); }
.worker-run:first-child { padding-top: 0; border-top: 0; }
.worker-run-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.worker-run-head strong { font: 10px/1.4 var(--mono); }
.worker-run small { display: block; margin-top: 5px; color: var(--faint); font: 9px/1.5 var(--mono); overflow-wrap: anywhere; }
.worker-run .secondary-button { margin-top: 9px; }
.worker-log { margin-top: 9px; padding: 10px; border: 1px solid var(--line-soft); background: #080d10; }
.action-bar { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; }
.primary-button, .secondary-button, .danger-button {
  min-height: 34px; padding: 0 13px; border: 1px solid var(--line);
  background: var(--bg-raised); color: var(--text); cursor: pointer; font-size: 11px;
}
.primary-button { border-color: rgba(142,183,255,0.45); background: var(--mint-dim); color: var(--mint); }
.secondary-button:hover { border-color: var(--muted); }
.danger-button { border-color: rgba(239,127,120,0.45); color: var(--red); background: rgba(239,127,120,0.07); }
.primary-button:disabled, .secondary-button:disabled, .danger-button:disabled { opacity: 0.45; cursor: wait; }
.action-dialog {
  width: min(430px, calc(100vw - 32px)); padding: 0; color: var(--text);
  border: 1px solid var(--line); background: #0c1216; box-shadow: var(--shadow);
}
.action-dialog::backdrop { background: rgba(2,5,7,0.76); backdrop-filter: blur(4px); }
.action-dialog-shell { padding: 22px; }
.action-dialog-shell h2 { margin-bottom: 10px; }
.action-dialog-shell p { color: var(--muted); font-size: 12px; line-height: 1.6; }
.github-action-target {
  display: block; margin-top: 12px; padding: 9px 10px; overflow-wrap: anywhere;
  border: 1px solid var(--line); background: #080d10; color: var(--text); font: 10px/1.5 var(--mono);
}
.github-confirm-field { display: grid; gap: 7px; margin-top: 12px; color: var(--faint); font: 9px/1.3 var(--mono); }
.github-confirm-field input {
  width: 100%; min-height: 38px; padding: 0 10px; border: 1px solid var(--line);
  background: var(--bg-raised); color: var(--text); font: 11px/1 var(--mono);
}
.github-confirm-field input:focus { border-color: var(--mint); outline: none; }
.action-dialog-error { margin-bottom: 12px; padding: 9px 10px; border: 1px solid rgba(239,127,120,0.35); color: var(--red); font-size: 11px; }
.action-dialog-buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
@media (max-width: 1100px) {
  .metrics { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .overview-grid { grid-template-columns: 1fr; }
}
@media (max-width: 760px) {
  .shell { grid-template-columns: 1fr; }
  .sidebar { position: static; height: auto; padding: 16px; gap: 16px; border-right: 0; border-bottom: 1px solid var(--line); }
  .nav { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .nav-item { text-align: center; padding: 9px 4px; font-size: 10px; }
  .sidebar-section, .sidebar-recents, .sidebar-note { display: none; }
  .main { padding: 24px 14px 40px; }
  .topbar { align-items: flex-start; flex-direction: column; }
  .live-block { width: 100%; flex-wrap: wrap; }
  .project-filter { width: 100%; }
  .project-filter select { max-width: none; flex: 1; }
  .metrics, .metrics-compact { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .panel-heading-wrap { align-items: stretch; flex-direction: column; }
  .task-tools { flex-direction: column; }
  .search-field input { width: 100%; }
  .detail-grid { grid-template-columns: 1fr; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; scroll-behavior: auto !important; }
}`;

export const dashboardJs = `function storedPreference(key) {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

function savePreference(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Local storage is optional in restricted browser contexts.
  }
}

const state = {
  view: 'overview',
  project: storedPreference('quotaflow.dashboard.project'),
  timeRange: storedPreference('quotaflow.dashboard.time'),
  lane: storedPreference('quotaflow.dashboard.lane'),
  review: storedPreference('quotaflow.dashboard.review'),
  overview: null,
  tasks: [],
  github: { gates: [], reruns: [] },
  budgets: { policies: [], lanes: [] },
  config: null,
  session: null,
  lastEventId: null,
  eventSource: null,
  pendingAction: null,
  pendingGithubAction: null,
  error: null,
};

const viewCopy = {
  overview: ['Overview', '任务、门禁和资源状态的统一视图'],
  tasks: ['Tasks', '检查队列、状态、优先级和运行模式'],
  github: ['GitHub', '当前 HEAD 门禁、失败分类和 CI 复跑记录'],
  budgets: ['Budgets', '预算窗口、Lane 和账户资源策略'],
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function matchesProject(repository) {
  return !state.project || repository === state.project;
}

function timeRangeMs(value) {
  return {
    '1h': 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
  }[value] || 0;
}

function matchesTime(value) {
  const range = timeRangeMs(state.timeRange);
  return !range || Number(value) >= Date.now() - range;
}

function matchesLane(task) {
  return !state.lane || (task.laneIds || []).includes(state.lane);
}

function reviewStatus(gate) {
  const reasons = new Set((gate.evaluation?.reasons || []).map((reason) => reason.code));
  if (reasons.has('changes_requested')) return 'changes_requested';
  if (reasons.has('independent_review_missing')) return 'missing';
  return 'approved';
}

function matchesReview(gate) {
  return !state.review || reviewStatus(gate) === state.review;
}

function visibleTasks() {
  return state.tasks.filter((task) =>
    matchesProject(task.repository) && matchesTime(task.updatedAt) && matchesLane(task));
}

function visibleGates() {
  return (state.github.gates || []).filter((gate) =>
    matchesProject(gate.repository) && matchesTime(gate.updatedAt) && matchesReview(gate));
}

function visibleReruns() {
  return (state.github.reruns || []).filter((rerun) =>
    matchesProject(rerun.repository) && matchesTime(rerun.updatedAt));
}

function countByStatus(tasks) {
  return tasks.reduce((counts, task) => {
    counts[task.status] = (counts[task.status] || 0) + 1;
    return counts;
  }, {});
}

function setLiveState(value) {
  const pill = $('.live-pill');
  pill.dataset.state = value;
  $('#live-label').textContent = value === 'live' ? 'Live' : value === 'offline' ? 'Reconnecting' : 'Connecting';
}

function formatDate(value) {
  if (!value) return '尚无记录';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
}

function formatOptionalDate(value) {
  return value ? formatDate(value) : '—';
}

function formatRelative(value) {
  if (!value) return '—';
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 10) return '刚刚';
  if (seconds < 60) return seconds + ' 秒前';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + ' 分钟前';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + ' 小时前';
  return Math.floor(hours / 24) + ' 天前';
}

function shortSha(value) {
  return value ? value.slice(0, 8) : '—';
}

function formatBytes(value) {
  if (!Number.isFinite(Number(value))) return '—';
  const bytes = Number(value);
  if (bytes < 1024) return bytes + ' B';
  return (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) + ' KiB';
}

function statusNode(status, label) {
  const normalized = String(status || 'unknown');
  return element(
    'span',
    'status status-' + normalized.replaceAll('_', '-'),
    label || normalized.replaceAll('_', ' '),
  );
}

function setError(error) {
  state.error = error instanceof Error ? error.message : error ? String(error) : null;
  const banner = $('#error-banner');
  banner.hidden = !state.error;
  banner.textContent = state.error || '';
}

async function api(path) {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Request failed with ' + response.status);
  return body;
}

function requestId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}

function showActionConfirmation(task, action) {
  const cancel = action === 'cancel';
  const start = action === 'start';
  state.pendingAction = {
    task,
    action,
    requestId: requestId(),
  };
  $('#action-dialog-title').textContent = cancel ? '取消任务' : start ? '启动 Worker' : '重试任务';
  $('#action-dialog-message').textContent = cancel
    ? '将请求停止“' + task.title + '”。运行中的任务会先进入 cancelling，由 Worker 完成受监督停止。'
    : start
      ? '将为“' + task.title + '”启动一次性 Worker。Worker 会重新检查 Lane、额度、预算和调度状态，只有实际可运行时才会调用 Agent。'
      : '将把“' + task.title + '”重新加入队列。该操作不会直接启动 Agent。';
  $('#action-dialog-confirm').textContent = cancel ? '确认取消' : start ? '确认启动' : '确认重试';
  $('#action-dialog-confirm').className = cancel ? 'danger-button' : 'primary-button';
  $('#action-dialog-confirm').disabled = false;
  $('#action-dialog-cancel').disabled = false;
  $('#action-dialog-error').hidden = true;
  $('#action-dialog-error').textContent = '';
  $('#action-dialog').showModal();
}

async function executePendingAction() {
  const pending = state.pendingAction;
  const session = state.session;
  if (!pending || !session) {
    setError('Dashboard 会话不可用，请刷新后重试');
    return;
  }
  const confirm = $('#action-dialog-confirm');
  const cancel = $('#action-dialog-cancel');
  const errorBox = $('#action-dialog-error');
  confirm.disabled = true;
  cancel.disabled = true;
  errorBox.hidden = true;
  try {
    const response = await fetch('/api/tasks/' + encodeURIComponent(pending.task.id) + '/actions', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        'x-quotaflow-csrf': session.csrfToken,
      },
      body: JSON.stringify({
        action: pending.action,
        requestId: pending.requestId,
        confirmTaskId: pending.task.id,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || body.error || '操作失败');
    const taskDialogOpen = $('#task-dialog').open;
    $('#action-dialog').close();
    state.pendingAction = null;
    await refresh();
    if (taskDialogOpen) openTask(pending.task.id);
  } catch (error) {
    errorBox.textContent = error instanceof Error ? error.message : '操作失败';
    errorBox.hidden = false;
  } finally {
    confirm.disabled = false;
    cancel.disabled = false;
  }
}

function githubConfirmTarget(gate) {
  return gate.repository + '#' + gate.pullNumber + '@' + gate.headSha;
}

function showGithubActionConfirmation(gate, action) {
  const target = githubConfirmTarget(gate);
  state.pendingGithubAction = {
    gate,
    action,
    target,
    requestId: requestId(),
  };
  const approve = action === 'approve';
  $('#github-action-title').textContent = approve ? '提交 Bot 批准' : '合并 Pull Request';
  $('#github-action-message').textContent = approve
    ? 'GitHub App 将为当前 HEAD 提交正式批准。执行前会重新读取 PR，HEAD 或 PR 状态变化会中止操作。'
    : '将使用 merge commit 合并当前 HEAD。执行前会重新读取 PR、CI、审查和 mergeable 状态，任一条件变化都会中止操作。';
  $('#github-action-target').textContent = target;
  $('#github-action-input').value = '';
  $('#github-action-input').placeholder = target;
  $('#github-action-error').hidden = true;
  $('#github-action-error').textContent = '';
  $('#github-action-confirm').textContent = approve ? '确认批准' : '确认合并';
  $('#github-action-confirm').className = approve ? 'primary-button' : 'danger-button';
  $('#github-action-confirm').disabled = false;
  $('#github-action-cancel').disabled = false;
  $('#github-action-dialog').showModal();
  $('#github-action-input').focus();
}

async function executeGithubAction() {
  const pending = state.pendingGithubAction;
  const session = state.session;
  const input = $('#github-action-input');
  const errorBox = $('#github-action-error');
  if (!pending || !session) {
    errorBox.textContent = 'Dashboard 会话不可用，请刷新后重试';
    errorBox.hidden = false;
    return;
  }
  if (input.value !== pending.target) {
    errorBox.textContent = '确认目标不匹配';
    errorBox.hidden = false;
    return;
  }
  const confirm = $('#github-action-confirm');
  const cancel = $('#github-action-cancel');
  confirm.disabled = true;
  cancel.disabled = true;
  errorBox.hidden = true;
  try {
    const response = await fetch('/api/github/actions', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        'x-quotaflow-csrf': session.csrfToken,
      },
      body: JSON.stringify({
        action: pending.action,
        repository: pending.gate.repository,
        pullNumber: pending.gate.pullNumber,
        expectedHeadSha: pending.gate.headSha,
        confirmTarget: pending.target,
        requestId: pending.requestId,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || body.error || 'GitHub 操作失败');
    if (body.outcome?.status === 'failed') {
      throw new Error(body.outcome.error || 'GitHub 操作失败');
    }
    $('#github-action-dialog').close();
    state.pendingGithubAction = null;
    await refresh();
  } catch (error) {
    errorBox.textContent = error instanceof Error ? error.message : 'GitHub 操作失败';
    errorBox.hidden = false;
  } finally {
    confirm.disabled = false;
    cancel.disabled = false;
  }
}

async function refresh() {
  const button = $('#refresh-button');
  button.disabled = true;
  try {
    const [overview, tasks, github, budgets, config, session] = await Promise.all([
      api('/api/overview'),
      api('/api/tasks'),
      api('/api/github?limit=500'),
      api('/api/budgets'),
      api('/api/config'),
      api('/api/session'),
    ]);
    state.overview = overview;
    state.tasks = tasks.items || [];
    state.github = github;
    state.budgets = budgets;
    state.config = config;
    state.session = session;
    state.lastEventId = overview.latestEventId ?? state.lastEventId;
    setError(null);
    renderAll();
    if (!state.eventSource) connectEventStream();
    $('#last-updated').textContent = '更新于 ' + formatDate(overview.generatedAt);
  } catch (error) {
    setError(error);
  } finally {
    button.disabled = false;
  }
}

function populateProjectFilter() {
  const select = $('#project-filter');
  const projects = new Set([
    ...(state.config?.repositories || []).map((repository) => repository.repository),
    ...state.tasks.map((task) => task.repository),
    ...(state.github.gates || []).map((gate) => gate.repository),
  ].filter(Boolean));
  select.replaceChildren();
  const all = element('option', null, '全部项目');
  all.value = '';
  select.append(all);
  [...projects].sort().forEach((repository) => {
    const option = element('option', null, repository);
    option.value = repository;
    select.append(option);
  });
  if (state.project && !projects.has(state.project)) state.project = '';
  select.value = state.project;
}

function connectEventStream() {
  if (state.eventSource) state.eventSource.close();
  if (!window.EventSource) {
    setLiveState('offline');
    return;
  }
  const params = new URLSearchParams();
  if (state.lastEventId !== null) params.set('cursor', String(state.lastEventId));
  if (state.project) params.set('repository', state.project);
  const source = new EventSource('/api/events/stream?' + params.toString());
  state.eventSource = source;
  setLiveState('connecting');
  source.addEventListener('open', () => setLiveState('live'));
  source.addEventListener('ready', (message) => {
    try {
      const ready = JSON.parse(message.data);
      if (Number.isSafeInteger(ready.cursor)) state.lastEventId = ready.cursor;
      setLiveState('live');
    } catch {
      setError('SSE ready message is invalid');
    }
  });
  source.addEventListener('events', (message) => {
    try {
      mergeLiveEvents(JSON.parse(message.data));
    } catch {
      setError('SSE event payload is invalid');
    }
  });
  source.addEventListener('stream_error', () => setLiveState('offline'));
  source.addEventListener('error', () => setLiveState('offline'));
}

function mergeLiveEvents(events) {
  if (!Array.isArray(events)) throw new Error('Invalid event list');
  const byTask = new Map(state.tasks.map((task) => [task.id, task]));
  const recent = state.overview?.recentEvents || [];
  let changed = false;
  for (const event of events) {
    if (!Number.isSafeInteger(event.id) || event.id <= state.lastEventId) continue;
    state.lastEventId = event.id;
    if (event.task && matchesProject(event.task.repository)) {
      byTask.set(event.task.id, event.task);
      changed = true;
    }
    if (matchesProject(event.repository)) {
      recent.unshift({
        id: event.id,
        taskId: event.taskId,
        taskTitle: event.taskTitle,
        repository: event.repository,
        kind: event.kind,
        detail: event.detail,
        createdAt: event.createdAt,
      });
    }
  }
  if (!changed) return;
  state.tasks = [...byTask.values()];
  if (state.overview) state.overview.recentEvents = recent
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, 40);
  renderOverview();
  renderTasks();
  $('#last-updated').textContent = '实时更新 ' + formatDate(Date.now());
  setLiveState('live');
}

function selectView(view) {
  if (!viewCopy[view]) return;
  state.view = view;
  $$('.nav-item').forEach((button) => button.classList.toggle('is-active', button.dataset.view === view));
  $$('.view').forEach((panel) => panel.classList.toggle('is-visible', panel.dataset.viewPanel === view));
  $('#view-title').textContent = viewCopy[view][0];
  $('#view-subtitle').textContent = viewCopy[view][1];
  history.replaceState(null, '', '#' + view);
}

function renderAll() {
  populateProjectFilter();
  populateLaneFilter();
  renderOverview();
  renderTasks();
  renderGithub();
  renderBudgets();
}

function metricCard(label, value, detail, tone) {
  const card = element('article', 'metric-card');
  if (tone) card.dataset.tone = tone;
  card.append(element('span', 'metric-label', label));
  card.append(element('strong', 'metric-value', value));
  card.append(element('span', 'metric-detail', detail));
  return card;
}

function renderOverview() {
  if (!state.overview) return;
  const tasks = visibleTasks().slice().sort((left, right) => right.updatedAt - left.updatedAt);
  const counts = countByStatus(tasks);
  const gates = visibleGates();
  const reruns = visibleReruns();
  const metrics = $('#metrics');
  metrics.replaceChildren(
    metricCard('Active', counts.running || 0, (counts.cancelling || 0) + ' cancelling', 'mint'),
    metricCard('Waiting', (counts.waiting_quota || 0) + (counts.waiting_dependency || 0) + (counts.waiting_human || 0), 'quota / dependency / human', 'amber'),
    metricCard('Completed', counts.completed || 0, tasks.length + ' total tasks', 'blue'),
    metricCard('Blocked', (counts.blocked || 0) + (counts.failed || 0), 'blocked or failed', 'red'),
    metricCard('GitHub', gates.filter((gate) => gate.evaluation?.status === 'blocked').length, reruns.length + ' rerun claims', 'mint'),
  );

  const recents = $('#sidebar-recents');
  recents.replaceChildren();
  tasks.slice(0, 7).forEach((task) => {
    const button = element('button', 'sidebar-recent');
    button.type = 'button';
    button.append(element('span', null, task.title));
    button.append(element('small', null, task.status + ' · P' + task.priority));
    button.addEventListener('click', () => openTask(task.id));
    recents.append(button);
  });
  if (!recents.children.length) recents.append(element('small', 'empty-state', '暂无任务'));

  const taskList = $('#overview-task-list');
  taskList.replaceChildren();
  tasks.slice(0, 6).forEach((task) => {
    const row = element('button', 'task-row');
    row.type = 'button';
    row.dataset.taskId = task.id;
    const copy = element('div');
    copy.append(element('h3', 'task-title', task.title));
    copy.append(element('p', 'task-subline', task.repository + ' · ' + task.id));
    const end = element('div', 'task-row-end');
    end.append(element('span', 'priority', 'P' + task.priority));
    end.append(statusNode(task.status));
    row.append(copy, end);
    row.addEventListener('click', () => openTask(task.id));
    taskList.append(row);
  });
  if (!taskList.children.length) taskList.append(element('div', 'empty-state', '暂无任务'));

  const stream = $('#event-stream');
  stream.replaceChildren();
  (state.overview.recentEvents || [])
    .filter((event) => {
      if (!matchesProject(event.repository) || !matchesTime(event.createdAt)) return false;
      if (!state.lane) return true;
      return state.tasks.some((task) =>
        task.id === event.taskId && (task.laneIds || []).includes(state.lane));
    })
    .slice(0, 9)
    .forEach((event) => {
      const item = element('article', 'event-item');
      item.append(element('span', 'event-mark'));
      const copy = element('div');
      copy.append(element('div', 'event-kind', event.kind));
      copy.append(element('div', 'event-title', event.taskTitle));
      copy.append(element('div', 'event-time', formatRelative(event.createdAt)));
      item.append(copy);
      stream.append(item);
    });
  if (!stream.children.length) stream.append(element('div', 'empty-state', '暂无事件'));

  const map = $('#execution-map');
  map.replaceChildren();
  (state.overview.repositories || [])
    .filter((repository) => matchesProject(repository.repository))
    .forEach((repository) => {
      const item = element('div', 'map-item');
      item.append(element('strong', null, repository.repository));
      item.append(element('small', null, repository.branchPrefixes.map((prefix) => prefix + '*').join(' · ')));
      map.append(item);
    });
  (state.overview.lanes || []).forEach((lane) => {
    const item = element('div', 'map-item');
    item.append(element('strong', null, lane.id));
    item.append(element('small', null, lane.agent + ' / ' + lane.model + ' / ' + lane.provider));
    map.append(item);
  });
}

function populateStatusFilter() {
  const select = $('#task-status-filter');
  const current = select.value;
  select.replaceChildren();
  const all = element('option', null, '全部状态');
  all.value = '';
  select.append(all);
  [...new Set(visibleTasks().map((task) => task.status))].sort().forEach((status) => {
    const option = element('option', null, status);
    option.value = status;
    select.append(option);
  });
  select.value = [...select.options].some((option) => option.value === current) ? current : '';
}

function populateLaneFilter() {
  const select = $('#task-lane-filter');
  const lanes = new Set([
    ...(state.budgets?.lanes || []).map((lane) => lane.id),
    ...state.tasks.flatMap((task) => task.laneIds || []),
  ].filter(Boolean));
  select.replaceChildren();
  const all = element('option', null, '全部 Lane');
  all.value = '';
  select.append(all);
  [...lanes].sort().forEach((lane) => {
    const option = element('option', null, lane);
    option.value = lane;
    select.append(option);
  });
  if (state.lane && !lanes.has(state.lane)) state.lane = '';
  select.value = state.lane;
}

function filteredTasks() {
  const search = $('#task-search').value.trim().toLowerCase();
  const status = $('#task-status-filter').value;
  return visibleTasks().filter((task) => {
    if (status && task.status !== status) return false;
    if (!search) return true;
    return [task.id, task.title, task.repository, task.repoPath].some((value) => String(value).toLowerCase().includes(search));
  });
}

function renderTasks() {
  populateStatusFilter();
  const items = filteredTasks();
  const body = $('#task-table-body');
  body.replaceChildren();
  items.forEach((task) => {
    const row = element('tr');
    row.addEventListener('click', () => openTask(task.id));
    const taskCell = element('td');
    taskCell.append(element('span', 'cell-main', task.title));
    taskCell.append(element('span', 'cell-sub', task.repository + ' · ' + task.id));
    const statusCell = element('td');
    statusCell.append(statusNode(task.status));
    const priorityCell = element('td', 'priority', task.priority);
    const modeCell = element('td', 'mono', task.accessMode);
    const updatedCell = element('td', 'mono', formatRelative(task.updatedAt));
    const actionCell = element('td');
    const inspect = element('button', 'text-button', 'Inspect →');
    inspect.type = 'button';
    inspect.addEventListener('click', (event) => {
      event.stopPropagation();
      openTask(task.id);
    });
    actionCell.append(inspect);
    row.append(taskCell, statusCell, priorityCell, modeCell, updatedCell, actionCell);
    body.append(row);
  });
  $('#task-empty').hidden = items.length > 0;
}

function renderGithub() {
  const gates = visibleGates();
  const reruns = visibleReruns();
  const blocked = gates.filter((gate) => gate.evaluation?.status === 'blocked').length;
  $('#github-metrics').replaceChildren(
    metricCard('Gates', gates.length, blocked + ' blocked', blocked ? 'amber' : 'mint'),
    metricCard('Ready', gates.filter((gate) => gate.evaluation?.status === 'ready_for_human_merge').length, 'human merge required', 'mint'),
    metricCard('Reruns', reruns.length, reruns.filter((rerun) => rerun.state === 'failed').length + ' failed', 'blue'),
    metricCard('Requested', reruns.filter((rerun) => rerun.state === 'requested').length, 'same-head attempts', 'amber'),
  );
  const body = $('#gate-table-body');
  body.replaceChildren();
  gates.forEach((gate) => {
    const row = element('tr');
    const actions = element('td', 'gate-actions');
    const writesEnabled = state.session?.githubRepositories?.includes(gate.repository);
    row.append(
      element('td', 'mono', '#' + gate.pullNumber),
      element('td', 'mono', shortSha(gate.headSha)),
      element('td', null, ''),
      element('td', null, (gate.evaluation?.reasons || []).map((reason) => reason.code).join(', ') || 'all checks passed'),
      element('td', 'mono', formatRelative(gate.updatedAt)),
      actions,
    );
    row.children[2].append(statusNode(gate.evaluation?.status === 'ready_for_human_merge' ? 'ready_for_human_merge' : 'blocked'));
    if (
      reviewStatus(gate) === 'missing'
      && state.session?.githubActions?.includes('approve')
      && writesEnabled
    ) {
      const approve = element('button', 'text-button', 'Bot 批准');
      approve.type = 'button';
      approve.addEventListener('click', () => showGithubActionConfirmation(gate, 'approve'));
      actions.append(approve);
    }
    if (
      gate.evaluation?.status === 'ready_for_human_merge'
      && state.session?.githubActions?.includes('merge')
      && writesEnabled
    ) {
      const merge = element('button', 'text-button', '合并');
      merge.type = 'button';
      merge.addEventListener('click', () => showGithubActionConfirmation(gate, 'merge'));
      actions.append(merge);
    }
    if (!actions.children.length) actions.append(element('span', 'faint', '—'));
    body.append(row);
  });
  $('#gate-empty').hidden = gates.length > 0;

  const list = $('#rerun-list');
  list.replaceChildren();
  reruns.slice(0, 10).forEach((rerun) => {
    const item = element('article', 'event-item');
    item.append(element('span', 'event-mark'));
    const copy = element('div');
    copy.append(element('div', 'event-kind', '#' + rerun.pullNumber + ' · run ' + rerun.runId));
    copy.append(element('div', 'event-title', rerun.state + ' · requests ' + rerun.requestCount + ' · ' + shortSha(rerun.headSha)));
    copy.append(element('div', 'event-time', formatRelative(rerun.updatedAt)));
    item.append(copy);
    list.append(item);
  });
  if (!list.children.length) list.append(element('div', 'empty-state', '暂无复跑记录'));
}

function renderBudgets() {
  const policies = state.budgets.policies || [];
  const lanes = state.budgets.lanes || [];
  const used = policies.reduce((sum, policy) => sum + Number(policy.used || 0), 0);
  const available = policies.reduce((sum, policy) => sum + Number(policy.available || 0), 0);
  const active = policies.reduce((sum, policy) => sum + Number(policy.activeLeases || 0), 0);
  $('#budget-cards').replaceChildren(
    metricCard('Policies', policies.length, 'configured accounts', 'blue'),
    metricCard('Used', used.toFixed(2), 'current estimate', 'amber'),
    metricCard('Available', available.toFixed(2), 'after reserve', 'mint'),
    metricCard('Active holds', active, 'attempt leases', 'red'),
  );

  const list = $('#budget-list');
  list.replaceChildren();
  policies.forEach((policy) => {
    const row = element('div', 'budget-row');
    const top = element('div', 'budget-top');
    top.append(element('strong', null, policy.account + ' / ' + policy.unit));
    top.append(element('span', null, Number(policy.used || 0).toFixed(2) + ' used'));
    const bar = element('progress', 'bar');
    bar.max = Math.max(1, Number(policy.limit || 0));
    bar.value = Math.max(0, Number(policy.used || 0));
    const meta = element('div', 'budget-meta');
    meta.append(element('span', null, 'available ' + Number(policy.available || 0).toFixed(2)));
    meta.append(element('span', null, 'limit ' + policy.limit + ' · reserve ' + policy.reserve));
    row.append(top, bar, meta);
    list.append(row);
  });
  if (!policies.length) list.append(element('div', 'empty-state', '未配置预算策略'));

  const laneList = $('#lane-list');
  laneList.replaceChildren();
  lanes.forEach((lane) => {
    const item = element('article', 'event-item');
    item.append(element('span', 'event-mark'));
    const copy = element('div');
    copy.append(element('div', 'event-kind', lane.id));
    copy.append(element('div', 'event-title', lane.agent + ' · ' + lane.model));
    copy.append(element('div', 'event-time', lane.provider + ' · ' + lane.account + ' · ' + lane.slots + ' slot(s)'));
    item.append(copy);
    laneList.append(item);
  });
  if (!laneList.children.length) laneList.append(element('div', 'empty-state', '未配置 Lane'));
}

function keyValue(container, label, value) {
  const row = element('div', 'kv');
  row.append(element('span', null, label));
  row.append(element('span', 'mono', value));
  container.append(row);
}

function detailBlock(title, content) {
  const block = element('section', 'detail-block');
  block.append(element('h3', null, title));
  block.append(content);
  return block;
}

async function openTask(taskId) {
  const dialog = $('#task-dialog');
  const content = $('#dialog-content');
  $('#dialog-title').textContent = '载入任务…';
  $('#dialog-meta').textContent = taskId;
  content.replaceChildren(element('div', 'empty-state', '正在读取任务状态'));
  dialog.showModal();
  try {
    const detail = await api('/api/tasks/' + encodeURIComponent(taskId));
    $('#dialog-title').textContent = detail.task.title;
    $('#dialog-meta').textContent = detail.task.id + ' · ' + detail.task.repoPath;
    content.replaceChildren();
    const grid = element('div', 'detail-grid');

    const facts = element('div');
    keyValue(facts, 'Status', detail.task.status);
    keyValue(facts, 'Priority', detail.task.priority);
    keyValue(facts, 'Access', detail.task.accessMode);
    keyValue(facts, 'Checkpoint', shortSha(detail.task.checkpoint));
    keyValue(facts, 'Created', formatDate(detail.task.createdAt));
    keyValue(facts, 'Updated', formatDate(detail.task.updatedAt));
    grid.append(detailBlock('Task', facts));

    const attempts = element('div', 'timeline');
    (detail.attempts || []).slice().reverse().forEach((attempt) => {
      const item = element('div', 'timeline-item');
      item.append(element('strong', null, '#' + attempt.id + ' ' + attempt.agent + ' / ' + attempt.stage));
      item.append(element('small', null, attempt.model + ' · ' + formatDate(attempt.startedAt)));
      attempts.append(item);
    });
    if (!attempts.children.length) attempts.append(element('small', null, '尚无尝试'));
    grid.append(detailBlock('Attempts', attempts));

    const workerRuns = element('div', 'worker-runs');
    (detail.workerRuns || []).forEach((run) => {
      const item = element('article', 'worker-run');
      const head = element('div', 'worker-run-head');
      head.append(element('strong', null, run.state));
      head.append(statusNode(
        run.state === 'exited'
          ? 'completed'
          : run.state === 'started'
            ? 'running'
            : run.state === 'failed'
              ? 'failed'
              : 'queued',
        run.state,
      ));
      item.append(head);
      item.append(element(
        'small',
        null,
        run.requestId
          + ' · PID ' + (run.pid ?? '—')
          + ' · exit ' + (run.exitCode ?? '—'),
      ));
      item.append(element(
        'small',
        null,
        'requested ' + formatOptionalDate(run.requestedAt)
          + ' · started ' + formatOptionalDate(run.startedAt)
          + ' · ended ' + formatOptionalDate(run.exitedAt),
      ));
      if (run.error) item.append(element('div', 'error-banner', run.error));
      if (run.logAvailable) {
        const log = element('pre', 'prompt-box worker-log');
        log.hidden = true;
        const button = element(
          'button',
          'secondary-button',
          '查看日志 · ' + formatBytes(run.logBytes),
        );
        button.type = 'button';
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            const response = await api(
              '/api/tasks/' + encodeURIComponent(detail.task.id)
                + '/workers/' + encodeURIComponent(run.requestId) + '/log',
            );
            log.textContent = response.truncated
              ? '仅显示最后 ' + formatBytes(response.bytes) + '（源文件 '
                + formatBytes(response.sourceBytes) + '）\\n\\n' + response.text
              : response.text || '（日志为空）';
            log.hidden = false;
            button.textContent = '刷新日志 · ' + formatBytes(response.bytes);
          } catch (error) {
            log.textContent = error instanceof Error ? error.message : '日志读取失败';
            log.hidden = false;
          } finally {
            button.disabled = false;
          }
        });
        item.append(button, log);
      } else {
        item.append(element('small', null, '日志尚未写入或文件不可用'));
      }
      workerRuns.append(item);
    });
    if (!workerRuns.children.length) {
      workerRuns.append(element('small', null, '尚无 Dashboard Worker 运行'));
    }
    grid.append(detailBlock('Worker runs', workerRuns));

    const actions = element('div', 'action-bar');
    if (!['completed', 'cancelled'].includes(detail.task.status)) {
      const cancel = element('button', 'danger-button', '取消任务');
      cancel.type = 'button';
      cancel.addEventListener('click', () => showActionConfirmation(detail.task, 'cancel'));
      actions.append(cancel);
    }
    if (['failed', 'blocked', 'waiting_quota', 'waiting_dependency', 'waiting_human'].includes(detail.task.status)) {
      const retry = element('button', 'primary-button', '重新入队');
      retry.type = 'button';
      retry.addEventListener('click', () => showActionConfirmation(detail.task, 'retry'));
      actions.append(retry);
    }
    if (
      ['queued', 'waiting_quota'].includes(detail.task.status)
      && state.session?.actions?.includes('start')
    ) {
      const start = element('button', 'primary-button', '启动 Worker');
      start.type = 'button';
      start.addEventListener('click', () => showActionConfirmation(detail.task, 'start'));
      actions.append(start);
    }
    const prompt = element('div', 'prompt-box', detail.task.prompt);
    if (actions.children.length) grid.append(detailBlock('Actions', actions));
    content.append(grid, detailBlock('Prompt', prompt));

    const handoff = element('div', 'prompt-box', detail.handoffNote?.note ? JSON.stringify(detail.handoffNote.note, null, 2) : '当前 checkpoint 没有 handoff 笔记');
    content.append(detailBlock('Handoff', handoff));

    const timeline = element('div', 'timeline');
    (detail.events || []).slice(-30).reverse().forEach((event) => {
      const item = element('div', 'timeline-item');
      item.append(element('strong', null, event.kind));
      item.append(element('small', null, formatDate(event.createdAt)));
      timeline.append(item);
    });
    content.append(detailBlock('Events', timeline));
  } catch (error) {
    content.replaceChildren(element('div', 'error-banner', error.message));
  }
}

$$('.nav-item').forEach((button) => button.addEventListener('click', () => selectView(button.dataset.view)));
$$('[data-open-view]').forEach((button) => button.addEventListener('click', () => selectView(button.dataset.openView)));
$('#refresh-button').addEventListener('click', refresh);
$('#project-filter').addEventListener('change', (event) => {
  state.project = event.target.value;
  savePreference('quotaflow.dashboard.project', state.project);
  renderAll();
  connectEventStream();
});
$('#time-filter').addEventListener('change', (event) => {
  state.timeRange = event.target.value;
  savePreference('quotaflow.dashboard.time', state.timeRange);
  renderAll();
});
$('#task-lane-filter').addEventListener('change', (event) => {
  state.lane = event.target.value;
  savePreference('quotaflow.dashboard.lane', state.lane);
  renderAll();
});
$('#review-filter').addEventListener('change', (event) => {
  state.review = event.target.value;
  savePreference('quotaflow.dashboard.review', state.review);
  renderAll();
});
$('#task-search').addEventListener('input', renderTasks);
$('#task-status-filter').addEventListener('change', renderTasks);
$('#dialog-close').addEventListener('click', () => $('#task-dialog').close());
$('#task-dialog').addEventListener('click', (event) => {
  if (event.target === $('#task-dialog')) $('#task-dialog').close();
});
$('#action-dialog-cancel').addEventListener('click', () => {
  state.pendingAction = null;
  $('#action-dialog').close();
});
$('#action-dialog-confirm').addEventListener('click', executePendingAction);
$('#action-dialog').addEventListener('close', () => {
  if (!$('#action-dialog-confirm').disabled) state.pendingAction = null;
});
$('#github-action-cancel').addEventListener('click', () => {
  state.pendingGithubAction = null;
  $('#github-action-dialog').close();
});
$('#github-action-confirm').addEventListener('click', executeGithubAction);
$('#github-action-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    executeGithubAction();
  }
});
$('#github-action-dialog').addEventListener('close', () => {
  if (!$('#github-action-confirm').disabled) state.pendingGithubAction = null;
});
$('#github-action-dialog').addEventListener('cancel', (event) => {
  if ($('#github-action-confirm').disabled) event.preventDefault();
});
window.addEventListener('beforeunload', () => state.eventSource?.close());

const initialView = location.hash.slice(1);
if (!timeRangeMs(state.timeRange)) state.timeRange = '';
if (!['approved', 'missing', 'changes_requested'].includes(state.review)) state.review = '';
$('#time-filter').value = state.timeRange;
$('#review-filter').value = state.review;
selectView(viewCopy[initialView] ? initialView : 'overview');
refresh();
setInterval(() => {
  if (!document.hidden && !$('#task-dialog').open) refresh();
}, 60000);`;
