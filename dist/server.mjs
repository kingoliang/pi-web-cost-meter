// Cost meter — server half.
//
// Reads this machine's Pi session transcripts and prices their token usage with
// an editable price table. Nothing is sent anywhere: the only files read are the
// session transcripts under the agent session directory, and the only state kept
// is the price table in this plugin's own storage.
//
// Transcript shapes read here (verified against pi session v3 files):
//   { type: "session", id, timestamp, cwd }
//   { type: "model_change", timestamp, provider, modelId }
//   { type: "message", timestamp, message: { role, model, provider,
//       usage: { input, output, cacheRead, cacheWrite, reasoning, totalTokens,
//                cost: { input, output, cacheRead, cacheWrite, total } } } }
// A message's own model/provider wins; otherwise the last model_change before it.

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const PLUGIN_ID = "cost-meter";
const PRICES_KEY = "prices";
const DEFAULT_SCAN_DAYS = 90;
const MAX_FILES = 8000;
const MAX_LINES_PER_FILE = 200000;

/** USD per 1,000,000 tokens, from the public OpenRouter model list (/api/v1/models).
 *  Sync date: 2026-10-16. Editable in Settings; a provider-recorded cost still wins. */
const DEFAULT_PRICES = {
  "claude-fable-5": { input: 10.0, output: 50.0, cacheRead: 1.0, cacheWrite: 12.5 },
  "claude-fable-5-1": { input: 10.0, output: 50.0, cacheRead: 0.25, cacheWrite: 12.5 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-opus-4-5": { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-6": { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-7": { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-5": { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-5-5": { input: 4.0, output: 20.0, cacheRead: 0.2, cacheWrite: 5.0 },
  "claude-sonnet-4-5": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-5": { input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-5-5": { input: 2.0, output: 10.0, cacheRead: 0.1, cacheWrite: 2.5 },
  "deepseek-v4-flash": { input: 0.091, output: 0.182, cacheRead: 0.0182, cacheWrite: 0.091 },
  "deepseek-v4-pro": { input: 0.337734, output: 0.675468, cacheRead: 0.028144, cacheWrite: 0.337734 },
  "deepseek-v4.1-flash": { input: 0.036, output: 0.6633, cacheRead: 0.0054, cacheWrite: 0.036 },
  "qwen3.6-flash": { input: 0.1875, output: 1.125, cacheRead: 0.0, cacheWrite: 0.234375 },
  "qwen3.7-flash": { input: 0.03, output: 0.13, cacheRead: 0.006, cacheWrite: 0.038 },
  "qwen3.8-flash": { input: 0.15, output: 0.47, cacheRead: 0.016, cacheWrite: 0.15 },
};

const EMPTY = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0 };

function sessionRoot() {
  const override = process.env["PI_CODING_AGENT_SESSION_DIR"];
  if (typeof override === "string" && override.trim() !== "") return override.trim();
  return join(homedir(), ".pi", "agent", "sessions");
}

/** An unknown model still bills: match by a normalised id, longest key first. */
function normalizeId(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/[^a-z0-9.]+/g, "")
    .trim();
}

function makeMatcher(prices) {
  const keys = Object.keys(prices)
    .map((key) => ({ key, norm: normalizeId(key) }))
    .filter((entry) => entry.norm !== "")
    .sort((left, right) => right.norm.length - left.norm.length);
  return (model) => {
    const norm = normalizeId(model);
    if (norm === "") return undefined;
    for (const entry of keys) if (entry.norm === norm) return entry.key;
    for (const entry of keys) if (norm.includes(entry.norm) || entry.norm.includes(norm)) return entry.key;
    return undefined;
  };
}

function numberOrZero(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function usageOf(usage) {
  return {
    input: numberOrZero(usage?.input),
    output: numberOrZero(usage?.output),
    cacheRead: numberOrZero(usage?.cacheRead),
    cacheWrite: numberOrZero(usage?.cacheWrite),
    reasoning: numberOrZero(usage?.reasoning),
    totalTokens: numberOrZero(usage?.totalTokens),
    recordedCost: numberOrZero(usage?.cost?.total),
  };
}

function addUsage(target, usage) {
  for (const key of Object.keys(EMPTY)) target[key] += usage[key] ?? 0;
  target.recordedCost += usage.recordedCost ?? 0;
  target.calls += 1;
}

function emptyTotals() {
  return { ...EMPTY, recordedCost: 0, calls: 0 };
}

async function listTranscripts(root, scanDays) {
  const cutoff = Date.now() - scanDays * 86_400_000;
  const found = [];
  let dirs;
  try {
    dirs = await readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory() || dir.name.startsWith(".")) continue;
    const dirPath = join(root, dir.name);
    let files;
    try {
      files = await readdir(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      const path = join(dirPath, file.name);
      try {
        const info = await stat(path);
        if (info.mtimeMs < cutoff) continue;
        found.push({ path, mtimeMs: info.mtimeMs, size: info.size });
      } catch {
        /* a file that vanished mid-scan is simply not counted */
      }
      if (found.length >= MAX_FILES) return found;
    }
  }
  return found;
}

async function parseTranscript(entry) {
  const events = [];
  let header = { id: "", cwd: "" };
  let model = { provider: "", model: "" };
  let lines = 0;
  const stream = createReadStream(entry.path, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      if (line === "" || (lines += 1) > MAX_LINES_PER_FILE) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record?.type === "session") {
        header = { id: String(record.id ?? ""), cwd: String(record.cwd ?? "") };
        continue;
      }
      if (record?.type === "model_change") {
        model = { provider: String(record.provider ?? ""), model: String(record.modelId ?? "") };
        continue;
      }
      if (record?.type !== "message") continue;
      const message = record.message;
      if (message?.role !== "assistant" || message.usage === undefined) continue;
      const usage = usageOf(message.usage);
      if (usage.totalTokens === 0 && usage.input === 0 && usage.output === 0) continue;
      events.push({
        at: Date.parse(record.timestamp ?? message.timestamp ?? "") || 0,
        sessionId: header.id,
        cwd: header.cwd,
        provider: String(message.provider ?? model.provider ?? ""),
        model: String(message.model ?? model.model ?? ""),
        ...usage,
      });
    }
  } catch {
    /* a truncated last line is normal while a turn is running */
  } finally {
    reader.close();
    stream.close();
  }
  if (header.id === "" && events.length > 0) {
    const stem = entry.path.split("/").pop() ?? "";
    header.id = stem.replace(/\.jsonl$/, "").split("_").slice(-1)[0] ?? "";
    for (const event of events) event.sessionId = header.id;
  }
  return { events, header };
}

function priceOf(prices, match, model) {
  const key = match(model);
  if (key === undefined) return { key: undefined, rate: undefined };
  const rate = prices[key];
  return {
    key,
    rate: {
      input: numberOrZero(rate.input),
      output: numberOrZero(rate.output),
      cacheRead: numberOrZero(rate.cacheRead),
      cacheWrite: numberOrZero(rate.cacheWrite ?? rate.cacheRead),
    },
  };
}

/** The price table wins when it knows the model: it is the current, corrected table,
 * while a recorded cost was written by the provider at call time (and so goes stale
 * when prices change). A model the table does not know falls back to what the
 * provider recorded, which beats calling it free. */
function costOf(usage, rate) {
  if (rate !== undefined) {
    const perMillion = 1_000_000;
    const amount =
      (usage.input * rate.input +
        usage.output * rate.output +
        usage.cacheRead * rate.cacheRead +
        usage.cacheWrite * rate.cacheWrite) /
      perMillion;
    return { amount, source: "priced" };
  }
  if (usage.recordedCost > 0) return { amount: usage.recordedCost, source: "reported" };
  return { amount: 0, source: "unpriced" };
}

function dayKey(at, offsetMinutes) {
  return new Date(at + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

function createState(logger) {
  const cache = new Map();
  let prices = { ...DEFAULT_PRICES };
  let config = { currency: "USD", fxRate: 7.2, scanDays: DEFAULT_SCAN_DAYS, peakMultiplier: 1 };
  let match = makeMatcher(prices);

  async function load(storage) {
    const stored = await storage.read(PRICES_KEY).catch(() => undefined);
    if (stored === undefined) return;
    const overrides = stored?.prices;
    if (overrides !== null && typeof overrides === "object") prices = { ...DEFAULT_PRICES, ...overrides };
    if (typeof stored?.currency === "string" && stored.currency !== "") config.currency = stored.currency.toUpperCase();
    if (Number.isFinite(stored?.fxRate) && stored.fxRate > 0) config.fxRate = stored.fxRate;
    if (Number.isFinite(stored?.scanDays) && stored.scanDays > 0) config.scanDays = Math.min(Math.round(stored.scanDays), 3650);
    match = makeMatcher(prices);
  }

  async function save(storage) {
    await storage.write(PRICES_KEY, { prices, ...config });
    match = makeMatcher(prices);
  }

  function apply(input) {
    const next = input ?? {};
    if (next.prices !== undefined) {
      const clean = {};
      for (const [key, value] of Object.entries(next.prices ?? {})) {
        if (typeof key !== "string" || key.trim() === "" || value === null || typeof value !== "object") continue;
        clean[key.trim()] = {
          input: numberOrZero(value.input),
          output: numberOrZero(value.output),
          cacheRead: numberOrZero(value.cacheRead),
          cacheWrite: numberOrZero(value.cacheWrite ?? value.cacheRead),
        };
      }
      prices = clean;
    }
    if (typeof next.currency === "string" && next.currency.trim() !== "") config.currency = next.currency.trim().toUpperCase();
    if (Number.isFinite(next.fxRate) && next.fxRate > 0) config.fxRate = next.fxRate;
    if (next.scanDays !== undefined) config.scanDays = Math.min(Math.max(Math.round(numberOrZero(next.scanDays)) || DEFAULT_SCAN_DAYS, 1), 3650);
  }

  async function eventsFor(signal) {
    const entries = await listTranscripts(sessionRoot(), config.scanDays);
    const events = [];
    const seen = new Set();
    for (const entry of entries) {
      if (signal?.aborted === true) break;
      const key = entry.path;
      seen.add(key);
      const hit = cache.get(key);
      if (hit !== undefined && hit.mtimeMs === entry.mtimeMs && hit.size === entry.size) {
        events.push(...hit.events);
        continue;
      }
      const parsed = await parseTranscript(entry);
      cache.set(key, { mtimeMs: entry.mtimeMs, size: entry.size, events: parsed.events });
      logger.debug?.(`priced ${String(parsed.events.length)} calls`, { file: entry.path });
      events.push(...parsed.events);
    }
    for (const key of [...cache.keys()]) if (!seen.has(key)) cache.delete(key);
    return events;
  }

  function summarize(events, until) {
    const offset = 0;
    const byDay = new Map();
    const byModel = new Map();
    const bySession = new Map();
    const byProject = new Map();
    const totals = { ...emptyTotals(), unpricedModels: new Set(), unpricedCalls: 0 };
    const bucket = (map, key, seed) => {
      let entry = map.get(key);
      if (entry === undefined) {
        entry = { key, totals: emptyTotals(), ...seed };
        map.set(key, entry);
      }
      return entry;
    };
    for (const event of events) {
      if (until !== undefined && event.at > until) continue;
      const { rate } = priceOf(prices, match, event.model);
      const cost = costOf(event, rate);
      const usage = { ...event, recordedCost: cost.amount };
      addUsage(totals, usage);
      if (cost.source === "unpriced") {
        totals.unpricedCalls += 1;
        if (event.model !== "") totals.unpricedModels.add(event.model);
      }
      const day = bucket(byDay, dayKey(event.at, offset), {});
      addUsage(day.totals, usage);
      const model = bucket(byModel, event.model === "" ? "(unknown)" : event.model, { provider: event.provider });
      addUsage(model.totals, usage);
      model.totals.cost ??= 0;
      const session = bucket(bySession, event.sessionId === "" ? "(unknown)" : event.sessionId, { cwd: event.cwd });
      addUsage(session.totals, usage);
      session.totals.lastAt = Math.max(session.totals.lastAt ?? 0, event.at);
      const project = bucket(byProject, event.cwd === "" ? "(unknown)" : event.cwd, {});
      addUsage(project.totals, usage);
      project.totals.lastAt = Math.max(project.totals.lastAt ?? 0, event.at);
    }
    const withCost = (entry) => ({
      ...entry,
      totals: { ...entry.totals, cost: costAmount(entry.totals) },
    });
    return {
      totals: { ...totals, cost: costAmount(totals), unpricedModels: [...totals.unpricedModels].slice(0, 20) },
      byDay: [...byDay.values()].map(withCost).sort((a, b) => (a.key < b.key ? 1 : -1)),
      byModel: [...byModel.values()].map(withCost).sort((a, b) => b.totals.cost - a.totals.cost),
      bySession: [...bySession.values()].map(withCost).sort((a, b) => b.totals.cost - a.totals.cost),
      byProject: [...byProject.values()].map(withCost).sort((a, b) => b.totals.cost - a.totals.cost),
    };
  }

  function costAmount(totals) {
    // Totals already carry recorded+priced amounts: recompute from the buckets
    // is unnecessary because addUsage summed recordedCost == cost per event.
    return totals.recordedCost;
  }

  return { load, save, apply, eventsFor, summarize, get prices() { return prices; }, get config() { return config; }, get defaults() { return DEFAULT_PRICES; } };
}

function toClient(summary, config) {
  const scale = config.currency === "CNY" ? config.fxRate : 1;
  const shape = (entry) => ({
    key: entry.key,
    calls: entry.totals.calls,
    tokens: {
      input: entry.totals.input,
      output: entry.totals.output,
      cacheRead: entry.totals.cacheRead,
      cacheWrite: entry.totals.cacheWrite,
      total: entry.totals.totalTokens,
    },
    cost: entry.totals.cost * scale,
    ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
    ...(entry.provider === undefined ? {} : { provider: entry.provider }),
    ...(entry.totals.lastAt === undefined ? {} : { lastAt: entry.totals.lastAt }),
  });
  return {
    currency: config.currency,
    fxRate: config.fxRate,
    totals: {
      cost: summary.totals.cost * scale,
      calls: summary.totals.calls,
      tokens: {
        input: summary.totals.input,
        output: summary.totals.output,
        cacheRead: summary.totals.cacheRead,
        cacheWrite: summary.totals.cacheWrite,
        total: summary.totals.totalTokens,
      },
      unpricedCalls: summary.totals.unpricedCalls,
      unpricedModels: summary.totals.unpricedModels,
    },
    byDay: summary.byDay.map(shape),
    byModel: summary.byModel.map(shape),
    bySession: summary.bySession.map(shape),
    byProject: summary.byProject.map(shape),
  };
}

const plugin = {
  apiVersion: 1,
  name: "Cost meter",
  activate: (context) => {
    const state = createState(context.logger);

    return {
      health: async () => {
        try {
          await readdir(sessionRoot());
          return { status: "healthy", message: `Reading ${sessionRoot()}` };
        } catch (error) {
          return { status: "degraded", message: `Cannot read ${sessionRoot()}: ${String(error?.message ?? error)}` };
        }
      },
      operations: {
        "cost.state": async () => {
          await state.load(context.storage);
          return { prices: state.prices, defaults: state.defaults, currency: state.config.currency, fxRate: state.config.fxRate, scanDays: state.config.scanDays, sessionRoot: sessionRoot() };
        },
        "cost.set": async (input) => {
          await state.load(context.storage);
          state.apply(input);
          await state.save(context.storage);
          return { prices: state.prices, currency: state.config.currency, fxRate: state.config.fxRate, scanDays: state.config.scanDays };
        },
        "cost.reset": async () => {
          state.apply({ prices: { ...DEFAULT_PRICES } });
          await state.save(context.storage);
          return { prices: state.prices };
        },
        "cost.rescan": async () => {
          const events = await state.eventsFor();
          return { calls: events.length };
        },
        "cost.overview": async (input, { signal }) => {
          await state.load(context.storage);
          const days = Math.min(Math.max(Math.round(numberOrZero(input?.days) || 30), 1), 365);
          // `cwd` narrows the whole report to one project; without it the report
          // covers every session this machine has transcripts for.
          const cwd = typeof input?.cwd === "string" && input.cwd !== "" ? input.cwd : undefined;
          const until = Date.now() + 60_000;
          // days counts today: days=1 is today from local midnight, days=7 is the
          // last seven calendar days including today. Subtracting first and then
          // flooring would reach back one day too far.
          const startOfToday = new Date();
          startOfToday.setHours(0, 0, 0, 0);
          const from = startOfToday.getTime() - (days - 1) * 86_400_000;
          const events = (await state.eventsFor(signal)).filter(
            (event) => event.at >= from && (cwd === undefined || event.cwd === cwd),
          );
          const summary = state.summarize(events, until);
          return { ...toClient(summary, state.config), days, scope: cwd === undefined ? "machine" : "project", cwd: cwd ?? "" };
        },
        "cost.session": async (input, { signal }) => {          await state.load(context.storage);
          const sessionId = typeof input?.sessionId === "string" ? input.sessionId : "";
          if (sessionId === "") return undefined;
          const events = (await state.eventsFor(signal)).filter((event) => event.sessionId === sessionId);
          if (events.length === 0) return undefined;
          return { ...toClient(state.summarize(events), state.config), sessionId };
        },
      },
      stop: async () => {},
    };
  },
};

export default plugin;
