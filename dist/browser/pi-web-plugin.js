// Cost meter — browser half.
//
// Surfaces: a Cost page under a project, a machine-wide Cost page (no project
// needed), a one-line note beside each session in the navigator, and a price
// table in Settings. Every number comes from the server half's `cost.*`
// operations; the browser never reads a transcript itself.

const PERIODS = [
  { id: "1", label: "Today", days: 1 },
  { id: "7", label: "7 days", days: 7 },
  { id: "30", label: "30 days", days: 30 },
];

const ICON = (svg) =>
  svg`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="8.2"></circle><path d="M12 7.6v8.8M14.6 9.9c-.5-.9-1.5-1.4-2.6-1.4-1.4 0-2.4.7-2.4 1.8 0 2.6 5 1.2 5 3.8 0 1.1-1 1.8-2.4 1.8-1.1 0-2.1-.5-2.6-1.4"></path></svg>`;

function money(amount, currency) {
  const symbol = currency === "CNY" ? "¥" : "$";
  if (!Number.isFinite(amount)) return `${symbol}0`;
  if (amount > 0 && amount < 0.01) return `${symbol}${amount.toFixed(4)}`;
  if (amount < 1) return `${symbol}${amount.toFixed(3)}`;
  return `${symbol}${amount.toFixed(2)}`;
}

function compact(number) {
  const value = Number(number) || 0;
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

const plugin = {
  apiVersion: 2,
  name: "Cost meter",

  activate(context) {
    const { html, svg, ui, callOperation, on, openPage, runtimePluginId } = context;

    // Everything that belongs to one activation lives here: a module outlives a toggle.
    const scope = {
      period: "1",
      mode: "project",
      panelCwd: undefined,
      panel: { read: "idle", attempt: 0 },
      session: { read: "idle", id: undefined },
      notes: new Map(),
      settings: { read: "idle", draft: undefined, message: undefined },
    };
    const unsubscribers = [];
    let render = () => {};

    const call = async (name, input) => {
      if (callOperation === undefined) throw new Error("This page needs a newer PI WEB");
      return await callOperation(name, input ?? {});
    };

    const readPanel = async () => {
      const current = PERIODS.find((entry) => entry.id === scope.period) ?? PERIODS[0];
      const cwd = scope.mode === "project" ? scope.panelCwd : undefined;
      scope.panel = { ...scope.panel, read: "reading" };
      render();
      try {
        const data = await call("cost.overview", { days: current.days, ...(cwd === undefined ? {} : { cwd }) });
        scope.panel = { read: "ready", attempt: 0, data, days: current.days };
      } catch (error) {
        scope.panel = { ...scope.panel, read: "failed", attempt: (scope.panel.attempt ?? 0) + 1, error };
      }
      render();
    };

    const readSession = async (sessionId) => {
      if (typeof sessionId !== "string" || sessionId === "") return;
      scope.session = { read: "reading", id: sessionId };
      try {
        const data = await call("cost.session", { sessionId });
        if (scope.session.id !== sessionId) return;
        scope.session = { read: "ready", id: sessionId, data };
        scope.notes.set(sessionId, data === undefined ? undefined : { text: `${money(data.totals.cost, data.currency)}` });
      } catch {
        if (scope.session.id === sessionId) scope.session = { read: "failed", id: sessionId };
      }
      render();
    };

    /** A navigator row note: what this session cost today, filled in once known. */
    const noteFor = (sessionId) => {
      const hit = scope.notes.get(sessionId);
      if (hit === undefined && !scope.notes.has(sessionId)) {
        scope.notes.set(sessionId, undefined);
        void call("cost.session", { sessionId })
          .then((data) => {
            scope.notes.set(sessionId, data === undefined ? undefined : { text: `${money(data.totals.cost, data.currency)}` });
            render();
          })
          .catch(() => scope.notes.set(sessionId, undefined));
        return undefined;
      }
      return hit?.text;
    };

    const readSettings = async () => {
      scope.settings = { ...scope.settings, read: "reading" };
      render();
      try {
        const data = await call("cost.state");
        scope.settings = { read: "ready", data, draft: JSON.stringify(data.prices, null, 2), message: undefined };
      } catch (error) {
        scope.settings = { read: "failed", error, message: undefined };
      }
      render();
    };

    // A row is `title` (left) + `value`/`detail` (right): the label has to be the title.
    const totalsRows = (data) => [
      { id: "calls", title: "Calls", value: String(data.totals.calls) },
      { id: "cost", title: "Cost", value: money(data.totals.cost, data.currency) },
      { id: "in", title: "Input tokens", value: compact(data.totals.tokens.input) },
      { id: "out", title: "Output tokens", value: compact(data.totals.tokens.output) },
      { id: "cacheRead", title: "Cache read", value: compact(data.totals.tokens.cacheRead) },
      { id: "cacheWrite", title: "Cache write", value: compact(data.totals.tokens.cacheWrite) },
      { id: "total", title: "All tokens", value: compact(data.totals.tokens.total) },
    ];

    const listGroups = (data, sessionEntry) => {
      const groups = [];
      if (sessionEntry !== undefined && sessionEntry.read === "ready" && sessionEntry.data !== undefined) {
        groups.push({
          id: "session",
          heading: "Selected session",
          rows: totalsRows(sessionEntry.data),
          notes: sessionEntry.data.byModel?.length
            ? [`By model: ${sessionEntry.data.byModel.map((e) => `${e.key} ${money(e.cost, sessionEntry.data.currency)}`).join(" · ")}`]
            : [],
        });
      }
      if (scope.panel.read !== "ready" || data === undefined) return groups;
      const projectScope = data.scope === "project";
      groups.push({
        id: "totals",
        heading: projectScope ? `This project · last ${String(data.days)} day(s)` : `This machine · last ${String(data.days)} day(s)`,
        rows: totalsRows(data),
        notes: [
          ...(projectScope ? [] : [`Across ${String(data.byProject.length)} projects and ${String(data.bySession.length)} sessions.`]),
          ...(data.totals.unpricedCalls > 0
            ? [`${String(data.totals.unpricedCalls)} calls have no price: ${data.totals.unpricedModels.slice(0, 6).join(", ")}`]
            : []),
        ],
      });
      if (projectScope) {
        groups.push({
          id: "sessions",
          heading: "Sessions in this project",
          rows: data.bySession.slice(0, 20).map((entry) => ({
            id: entry.key,
            title: `Session ${entry.key.slice(0, 8)}`,
            value: money(entry.cost, data.currency),
            detail: `${String(entry.calls)} calls · in ${compact(entry.tokens.input)} · out ${compact(entry.tokens.output)}`,
          })),
        });
      } else {
        groups.push({
          id: "projects",
          heading: "By project",
          rows: data.byProject.slice(0, 20).map((entry) => ({
            id: entry.key,
            title: entry.key.split("/").slice(-1)[0] || entry.key,
            value: money(entry.cost, data.currency),
            detail: `${entry.key} · ${String(entry.calls)} calls`,
          })),
        });
      }
      groups.push({
        id: "models",
        heading: "By model",
        rows: data.byModel.slice(0, 12).map((entry) => ({
          id: entry.key,
          title: entry.key,
          value: money(entry.cost, data.currency),
          detail: `${String(entry.calls)} calls · in ${compact(entry.tokens.input)} · out ${compact(entry.tokens.output)} · cache ${compact(entry.tokens.cacheRead)}`,
        })),
      });
      groups.push({
        id: "days",
        heading: "By day",
        rows: data.byDay.slice(0, 14).map((entry) => ({
          id: entry.key,
          title: entry.key,
          value: money(entry.cost, data.currency),
          detail: `${String(entry.calls)} calls · ${compact(entry.tokens.total)} tokens`,
        })),
      });
      return groups;
    };

    const pageToolbar = (showScope) => html`
      <div class="toolbar" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        ${showScope
          ? html`
              <button type="button" class=${scope.mode === "project" ? "active" : ""} style="min-height:var(--pi-control-height-touch, 30px);padding:0 10px"
                @click=${() => { scope.mode = "project"; scope.panel.read = "idle"; void readPanel(); }}>This project</button>
              <button type="button" class=${scope.mode === "machine" ? "active" : ""} style="min-height:var(--pi-control-height-touch, 30px);padding:0 10px"
                @click=${() => { scope.mode = "machine"; scope.panel.read = "idle"; void readPanel(); }}>This machine</button>
              <span style="opacity:.4">|</span>`
          : ""}
        ${PERIODS.map((entry) => html`<button type="button" class=${entry.id === scope.period ? "active" : ""} style="min-height:var(--pi-control-height-touch, 30px);padding:0 10px"
          @click=${() => { scope.period = entry.id; void readPanel(); }}>${entry.label}</button>`)}
        <span style="flex:1"></span>
        <button type="button" style="min-height:var(--pi-control-height-touch, 30px);padding:0 10px" @click=${() => void readPanel()}>Refresh</button>
      </div>`;

    const pageBody = (panel, forceMachineScope) => {
      render = () => panel.host.requestRender();
      const cwd = forceMachineScope ? undefined : panel.workspace?.path;
      if (cwd !== scope.panelCwd) {
        scope.panelCwd = cwd;
        if (scope.mode === "project") scope.panel.read = "idle";
      }
      if (scope.mode === "project" && cwd === undefined) scope.mode = "machine";
      if (scope.panel.read === "idle") void readPanel();
      if (ui?.renderList === undefined) return html`<p class="muted">This page needs a newer PI WEB.</p>`;

      const session = panel.state?.selectedSession;
      if (session?.id !== undefined && scope.session.id !== session.id && scope.session.read !== "reading") void readSession(session.id);
      const sessionEntry = session === undefined || scope.session.id !== session.id
        ? undefined
        : { read: scope.session.read, data: scope.session.data };

      const failure = scope.panel.read === "failed" ? ui?.readFailure?.(scope.panel.error, Math.max((scope.panel.attempt ?? 1) - 1, 0)) : undefined;
      if (scope.panel.read === "failed" && failure?.kind !== "final") setTimeout(() => void readPanel(), 4000);

      return html`
        ${ui.renderList({
          read: scope.panel.read === "idle" ? "reading" : scope.panel.read,
          words: {
            empty: "No billed calls in this period.",
            reading: "Reading session transcripts…",
            failed: failure?.kind === "final" ? failure.words : "Reconnecting…",
            stale: "Could not refresh — showing the last read.",
          },
          groups: listGroups(scope.panel.data, sessionEntry),
          notes: [`Currency ${scope.panel.data?.currency ?? "USD"} · source: Pi session transcripts`],
        })}`;
    };

    unsubscribers.push(
      on?.("session-selected", (event) => void readSession(event?.sessionId)),
      on?.("session-activity-settled", (event) => {
        scope.notes.delete(event?.sessionId);
        void readSession(event?.sessionId);
        if (scope.panel.read !== "idle") void readPanel();
      }),
    );

    const costPage = (id, title, order, forceMachineScope, withScope) => ({
      id,
      title,
      icon: ICON(svg),
      order,
      toolbar: () => pageToolbar(withScope && !forceMachineScope),
      render: (panel) => pageBody(panel, forceMachineScope),
    });

    return {
      contributions: {
        workspacePanels: [
          {
            ...costPage("workspace.cost", "Cost", 320, false, true),
            routeAliases: ["cost"],
            onInvalidate: () => void readPanel(),
          },
        ],
        globalPanels: [costPage("global.cost", "Cost (machine)", 330, true, false)],
        // A short, dynamic note in the navigator: what this session cost today.
        // It also puts the running total of the machine in front of the reader
        // without a page of its own.
        activityNotes: [
          {
            id: "note.cost",
            order: 200,
            note: ({ sessionId }) => noteFor(sessionId),
          },
        ],
        composer: [
          {
            id: "composer.cost",
            slot: "trailing",
            title: "Open the Cost page",
            icon: ICON(svg),
            order: 400,
            available: () => callOperation !== undefined,
            run: (composer) => {
              if (composer.sessionId !== undefined) void readSession(composer.sessionId);
              openPage?.(`${runtimePluginId}:workspace.cost`);
            },
          },
        ],
        settingsSections: [
          {
            id: "settings.cost",
            title: "Cost meter",
            order: 1200,
            render: () => {
              if (scope.settings.read === "idle") void readSettings();
              if (scope.settings.read === "reading") return html`<p class="muted">Reading the price table…</p>`;
              if (scope.settings.read === "failed") return html`<p class="muted">Could not read the price table.</p>`;
              const data = scope.settings.data;
              return html`
                <div style="display:flex;flex-direction:column;gap:10px">
                  <p class="muted" style="margin:0">
                    USD per 1,000,000 tokens, taken from the public OpenRouter model list. A model this table does not know falls back to the cost the provider recordings.
                    Transcripts are read from <code>${data.sessionRoot}</code>.
                  </p>
                  <div style="display:flex;gap:10px;align-items:end;flex-wrap:wrap">
                    <label style="display:flex;flex-direction:column;gap:4px">Currency
                      <select .value=${data.currency} @change=${(e) => { scope.settings.draftCurrency = e.target.value; }}>
                        <option value="USD">USD</option>
                        <option value="CNY">CNY</option>
                      </select>
                    </label>
                    <label style="display:flex;flex-direction:column;gap:4px">USD → CNY
                      <input type="number" step="0.01" style="width:100px" .value=${String(data.fxRate)}
                        @change=${(e) => { scope.settings.draftRate = Number(e.target.value); }} />
                    </label>
                    <label style="display:flex;flex-direction:column;gap:4px">Scan window (days)
                      <input type="number" style="width:110px" .value=${String(data.scanDays)}
                        @change=${(e) => { scope.settings.draftDays = Number(e.target.value); }} />
                    </label>
                  </div>
                  <textarea spellcheck="false" style="min-height:320px;font-family:ui-monospace,monospace;font-size:12px"
                    .value=${scope.settings.draft ?? JSON.stringify(data.prices, null, 2)}
                    @input=${(e) => { scope.settings.draft = e.target.value; }}></textarea>
                  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                    <button type="button" @click=${async () => {
                      let parsed;
                      try { parsed = JSON.parse(scope.settings.draft); }
                      catch (error) { scope.settings.message = `Invalid JSON: ${String(error.message)}`; scope.settings.read = "ready"; render(); return; }
                      scope.settings.message = "Saving…"; render();
                      try {
                        await call("cost.set", {
                          prices: parsed,
                          ...(scope.settings.draftCurrency === undefined ? {} : { currency: scope.settings.draftCurrency }),
                          ...(scope.settings.draftRate === undefined ? {} : { fxRate: scope.settings.draftRate }),
                          ...(scope.settings.draftDays === undefined ? {} : { scanDays: scope.settings.draftDays }),
                        });
                        scope.panel.read = "idle";
                        scope.notes.clear();
                        scope.settings.read = "idle"; scope.settings.draft = undefined;
                        await readSettings();
                      } catch (error) { scope.settings.message = `Could not save: ${String(error.message)}`; render(); }
                    }}>Save</button>
                    <button type="button" @click=${async () => {
                      await call("cost.reset");
                      scope.panel.read = "idle"; scope.notes.clear();
                      scope.settings.read = "idle"; scope.settings.draft = undefined;
                      await readSettings();
                    }}>Restore defaults</button>
                    <span class="muted">${scope.settings.message ?? ""}</span>
                  </div>
                </div>`;
            },
          },
        ],
      },
      dispose: () => {
        for (const off of unsubscribers) off?.();
      },
    };
  },
};

export default plugin;
