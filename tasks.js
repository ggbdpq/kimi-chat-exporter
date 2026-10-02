import { openJobDb, EXECUTOR_LOCK } from "./lib/job-db.js";
import { opfsStore, clearWorkspace } from "./lib/opfs.js";
import { getLocale, t } from "./lib/i18n.js";
import { bindLocaleSwitch, initPageI18n } from "./lib/i18n-dom.js";

const db = await openJobDb();
const $ = (id) => document.getElementById(id);

// Job states drive the chip text, its colour tone and whether it gets a live dot.
const STATES = {
  queued: { key: "tasks.state.queued", tone: "" },
  running: { key: "tasks.state.running", tone: "live", live: true },
  pausing: { key: "tasks.state.pausing", tone: "live", live: true },
  paused: { key: "tasks.state.paused", tone: "warn" },
  interrupted: { key: "tasks.state.interrupted", tone: "warn" },
  "waiting-login": { key: "tasks.state.waitingLogin", tone: "warn" },
  "blocked-storage": { key: "tasks.state.blockedStorage", tone: "warn" },
  completed: { key: "tasks.state.completed", tone: "ok" },
  "completed-with-errors": { key: "tasks.state.completedWithErrors", tone: "warn" },
  failed: { key: "tasks.state.failed", tone: "danger" },
};
const PHASE_KEYS = {
  listing: "tasks.phase.listing",
  validating: "tasks.phase.validating",
  fetching: "tasks.phase.fetching",
  enriching: "tasks.phase.enriching",
  downloading: "tasks.phase.downloading",
  packing: "tasks.phase.packing",
  ready: "tasks.phase.ready",
};
// Labels are resolved per paint so a language switch needs no rebuild.
function phaseLabel(phase) {
  return PHASE_KEYS[phase] ? t(PHASE_KEYS[phase]) : "";
}

let selected = "",
  active = null,
  latest = null,
  // Bumped by every render; a slow render that loses the race never touches
  // the DOM, so an interrupted selection can't leave two details on screen.
  renderToken = 0,
  // The engine keeps the last "message" in its progress object across phases,
  // so a message that survived a phase change is stale and gets replaced by the
  // phase name instead of being shown as if it belonged to the new phase.
  lastPhase = "",
  lastPhaseMessage = "",
  channel = new BroadcastChannel("kimi-export-progress");
const downloadUrls = new Map();

function error(e) {
  $("error").hidden = !e;
  $("error").textContent = e ? String(e.message || e) : "";
}
function el(tag, text, className) {
  const n = document.createElement(tag);
  if (text != null) n.textContent = text;
  if (className) n.className = className;
  return n;
}
// Icon glyphs are stroked SVG rather than text: a "×" character sits on the
// font's baseline and never lands dead-centre in a round badge.
function icon(d, size = 10) {
  const ns = "http://www.w3.org/2000/svg";
  const node = document.createElementNS(ns, "svg");
  node.setAttribute("viewBox", "0 0 16 16");
  node.setAttribute("width", size);
  node.setAttribute("height", size);
  node.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.9");
  path.setAttribute("stroke-linecap", "round");
  node.append(path);
  return node;
}
// Every action funnels through here so a click can never double-fire and a
// failure always lands in the page-level alert.
function button(text, fn, className = "btn") {
  const b = el("button", text, className);
  b.type = "button";
  b.onclick = async () => {
    b.disabled = true;
    try {
      error("");
      await fn();
    } catch (e) {
      error(e);
    } finally {
      b.disabled = false;
    }
  };
  return b;
}
function bytes(n) {
  let i = 0;
  const u = ["B", "KiB", "MiB", "GiB"];
  while (n >= 1024 && i < 3) {
    n /= 1024;
    i++;
  }
  return `${Number(n || 0).toFixed(i ? 1 : 0)} ${u[i]}`;
}
function stateChip(state, className = "state") {
  const known = STATES[state];
  const meta = known ? { ...known, text: t(known.key) } : { text: state, tone: "" };
  const chip = el("span", null, className);
  if (meta.tone) chip.dataset.tone = meta.tone;
  if (meta.live) {
    const dot = el("i", null, "dot");
    dot.dataset.live = "true";
    chip.append(dot);
  }
  chip.append(meta.text);
  return chip;
}
/**
 * Rail and detail label. One chat shows its own title; a batch keeps the head of
 * the first title and names the count, so the row reads "Title… and 12 chats".
 * The name is a shrinkable ellipsis and the count never shrinks, so the label
 * cannot overflow its column. Jobs created before the single-chat path carried
 * a title stored the id as the name, hence the id guard.
 */
function jobLabel(job) {
  const targets = job.targets || [];
  const first = targets[0];
  const name = first?.name && first.name !== first.id ? first.name : "";
  if (!name)
    return { name: t(job.allChats ? "tasks.job.allChats" : "tasks.job.generic"), suffix: "" };
  return {
    name,
    suffix: targets.length > 1 ? t("tasks.job.more", { count: targets.length }) : "",
  };
}

function progressLine(job) {
  const p = job.progress;
  if (!p) return "";
  const packing = p.phase === "packing";
  const done = (packing ? p.filesDone : p.chatsDone) || 0;
  const total = (packing ? p.filesTotal : p.chatsTotal) || 0;
  return total ? `${done} / ${total}` : "";
}

async function send(type, payload = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...payload });
  if (!result?.ok) {
    const e = new Error(result?.error || t("tasks.error.serviceUnavailable"));
    e.name = result?.name || "Error";
    throw e;
  }
  return result;
}

function jobCard(job) {
  const card = el("div", null, "card");
  card.setAttribute("role", "button");
  card.setAttribute("tabindex", "0");
  if (job.id === selected) card.setAttribute("aria-current", "true");
  const { name, suffix } = jobLabel(job);
  const subject = el("span", null, "card__subject");
  const subjectName = el("span", name, "card__name");
  subject.append(subjectName);
  if (suffix) {
    subjectName.title = name;
    subject.append(el("span", suffix, "card__more"));
  }
  const top = el("span", null, "card__top");
  top.append(subject, stateChip(job.state));
  const delBtn = el("button", null, "card__delete");
  delBtn.type = "button";
  delBtn.append(icon("M4.6 4.6 11.4 11.4M11.4 4.6 4.6 11.4"));
  delBtn.title = t("tasks.delete.title");
  delBtn.setAttribute("aria-label", t("tasks.delete.title"));
  if (active?.jobId === job.id) {
    delBtn.disabled = true;
    delBtn.title = t("tasks.delete.running");
  }
  delBtn.onclick = (e) => {
    e.stopPropagation();
    void deleteJob(job.id).catch(error);
  };
  const meta = el("span", null, "card__meta");
  meta.append(
    el("span", new Date(job.createdAt).toLocaleString(getLocale()), "mono"),
    el("span", progressLine(job), "num"),
  );
  card.append(delBtn, top, meta);
  card.onclick = async () => {
    try {
      error("");
      await select(job.id);
    } catch (e) {
      error(e);
    }
  };
  card.onkeydown = (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      card.click();
    }
  };
  return card;
}

async function refresh() {
  const jobs = (await db.listJobs()).sort((a, b) => b.createdAt - a.createdAt);
  const clearBtn = $("btn-clear-jobs");
  if (clearBtn) clearBtn.disabled = !jobs.length;
  if (!jobs.length) {
    selected = "";
    $("jobs").replaceChildren();
    showEmpty();
    return;
  }
  showLayout();
  // Decide the current job before painting the rail: jobCard() reads
  // `selected`, so cards painted first would stay unmarked while their detail
  // is already on screen.
  if (!jobs.some((j) => j.id === selected)) selected = jobs[0].id;
  $("jobs").replaceChildren(...jobs.map(jobCard));
  await render();
}

// Without jobs neither column has anything to show, so the ledger gives way to
// a standalone empty state instead of an empty "Job details" card.
function showEmpty() {
  $("layout").hidden = true;
  $("empty").hidden = false;
}
function showLayout() {
  $("layout").hidden = false;
  $("empty").hidden = true;
}

async function select(id) {
  selected = id;
  latest = null;
  await refresh();
}

function detailHead(job) {
  const head = el("div", null, "detail__head");
  head.append(el("p", `kimi-export-${String(job.exportDate).slice(0, 10)}/`, "folder mono"));
  head.append(stateChip(job.state));
  return head;
}

function detailTitle(job) {
  const { name, suffix } = jobLabel(job);
  if (!suffix) return el("h2", name, "detail__title");
  const title = el("h2", null, "detail__title detail__title--row");
  const head = el("span", name, "detail__name");
  head.title = name;
  title.append(head, el("span", suffix, "detail__more"));
  return title;
}

function detailActions(job) {
  const actions = el("div", null, "actions");
  if (active?.jobId === job.id) {
    actions.append(button(t("common.pause"), pauseJob, "btn btn--primary"));
  } else {
    if (!["completed", "completed-with-errors"].includes(job.state))
      actions.append(
        button(
          t(job.state === "queued" ? "tasks.action.start" : "tasks.action.resume"),
          () => resumeJob(job.id),
          "btn btn--primary",
        ),
      );
    if (job.state === "completed-with-errors" || job.state === "failed")
      actions.append(
        button(
          t("tasks.action.retryFailed"),
          () => retryFailed(job.id, { all: true }),
          "btn btn--primary",
        ),
      );
  }
  // A finished, healthy job has no action left: return nothing so the flex
  // column does not keep an empty row (and its gap) around.
  return actions.childElementCount ? actions : null;
}

// The rail counts archive units: one tick per chat, or per file while packing.
// Past 60 units the ticks stop being readable, so it degrades to a plain bar.
function drawUnits(total, done) {
  const track = $("units-track");
  track.replaceChildren();
  $("units-count").textContent = total ? `${done} / ${total}` : "—";
  $("units-pct").textContent = total ? `${Math.round((done / total) * 100)}%` : "";
  const native = el("progress", null, "sr-only");
  native.max = total || 1;
  if (total) native.value = done;
  native.setAttribute("aria-label", $("units-label").textContent);
  track.append(native);
  if (!total) return;
  if (total > 60) {
    const bar = el("div", null, "units__bar");
    const fill = el("i");
    fill.style.setProperty("--fill", `${Math.round((done / total) * 100)}%`);
    bar.append(fill);
    track.append(bar);
    return;
  }
  const ticks = el("div", null, "units__ticks");
  for (let i = 0; i < total; i++) {
    const tick = el("i", null, "tick");
    tick.dataset.state = i < done ? "done" : i === done ? "current" : "todo";
    ticks.append(tick);
  }
  track.append(ticks);
}

function paintProgress(p) {
  if (!p || !$("units-count")) return;
  const packing = p.phase === "packing";
  // Listing has no total yet, so the rail stays indeterminate and the head
  // counts what has arrived instead of pretending to be a percentage.
  const listing = p.phase === "listing";
  $("units-label").textContent = t(
    listing ? "tasks.units.read" : packing ? "tasks.units.packingFiles" : "tasks.units.chats",
  );
  drawUnits(listing ? 0 : (packing ? p.filesTotal : p.chatsTotal) || 0, (packing ? p.filesDone : p.chatsDone) || 0);
  if (listing) {
    $("units-count").textContent = String(p.listingDone || 0);
    $("units-pct").textContent = "";
  }
  // A finished run keeps whatever message it last had, so never trust it then.
  const carried =
    p.phase === "ready" || (p.phase !== lastPhase && p.message && p.message === lastPhaseMessage);
  lastPhase = p.phase;
  lastPhaseMessage = p.message || "";
  // The head is a single row: a reading too long for its slot truncates, so the
  // untruncated text goes on the element for hover.
  const message = $("units-message");
  const text = carried ? phaseLabel(p.phase) : p.message || phaseLabel(p.phase);
  message.textContent = text;
  if (text) message.title = text;
  else message.removeAttribute("title");
  $("stat-bytes").textContent = p.bytes ? bytes(p.bytes) : "—";
  $("stat-rate").textContent = p.rate ? `${bytes(p.rate)}/s` : "—";
  const volume = $("stat-volume");
  volume.textContent = p.packedBytes ? bytes(p.packedBytes) : "—";
  const rows = (p.active || []).map((item) => {
    const row = el("div", null, "row");
    row.append(
      el("span", item.label, "row__label"),
      button(t("common.skip"), () => skipItem(item.key)),
    );
    return row;
  });
  $("active").replaceChildren(...rows);
  $("active-count").textContent = String(rows.length);
  $("active-band").hidden = !rows.length;
}

function band(title, id) {
  const section = el("section", null, "band");
  const head = el("div", null, "band__head");
  head.append(el("h3", title, "band__title"));
  const count = el("span", null, "row__note num");
  count.id = `${id}-count`;
  head.append(count);
  const rows = el("div", null, "rows");
  rows.id = id;
  section.append(head, rows);
  return section;
}

async function render() {
  const token = ++renderToken;
  const job = await db.getJob(selected);
  if (!job) {
    selected = "";
    if (token === renderToken) showEmpty();
    return;
  }
  const items = await db.listItems(job.id);

  const lead = el("div", null, "detail__lead");
  lead.append(detailHead(job), detailTitle(job));
  if (job.error) lead.append(el("p", job.error, "alert"));

  const units = el("div", null, "units");
  const head = el("div", null, "units__head");
  const count = el("span", null, "units__count");
  const label = el("span", t("tasks.units.chats"), "row__note");
  label.id = "units-label";
  const value = el("b", "—", "num");
  value.id = "units-count";
  count.append(label, value);
  const pct = el("span", "—", "units__pct");
  pct.id = "units-pct";
  const message = el("span", "", "units__message");
  message.id = "units-message";
  message.setAttribute("aria-live", "polite");
  // The reading sits left of the percentage it belongs to; the dot between the
  // two is pure CSS (.units__message + .units__pct in tasks.css).
  head.append(count, message, pct);
  const track = el("div", null, "units__track");
  track.id = "units-track";
  units.append(head, track);

  const ledger = el("dl", null, "ledger");
  for (const [name, id] of [
    [t("tasks.ledger.transferred"), "stat-bytes"],
    [t("tasks.ledger.rate"), "stat-rate"],
    [t("tasks.ledger.size"), "stat-volume"],
  ]) {
    const cell = el("div");
    const dd = el("dd", "—");
    dd.id = id;
    cell.append(el("dt", name), dd);
    ledger.append(cell);
  }
  units.append(ledger);

  const activeBand = band(t("tasks.band.active"), "active");
  activeBand.id = "active-band";
  const nodes = [lead];
  if (job.options?.downloadMedia) {
    let hasMediaPerm = false;
    try {
      hasMediaPerm = await chrome.permissions.contains({ origins: ["<all_urls>"] });
    } catch {
      hasMediaPerm = false;
    }
    if (!hasMediaPerm) {
      const banner = el("div", null, "notice");
      const text = el("span", t("tasks.notice.mediaPerm"), "notice__text");
      const authBtn = el("button", t("tasks.notice.grant"), "notice__action");
      authBtn.type = "button";
      authBtn.onclick = async () => {
        authBtn.disabled = true;
        try {
          error("");
          const ok = await chrome.permissions.request({ origins: ["<all_urls>"] });
          if (ok) await render();
          else throw new Error(t("tasks.notice.grantDenied"));
        } catch (e) {
          error(e);
        } finally {
          authBtn.disabled = false;
        }
      };
      banner.append(text, authBtn);
      nodes.push(banner);
    }
  }
  const actions = detailActions(job);
  if (actions) nodes.push(actions);
  nodes.push(units, activeBand);
  const failures = collectFailures(items);
  if (failures.length) nodes.push(failuresBand(job, failures));
  if ((job.artifacts || []).length) nodes.push(await artifactsBand(job));

  if (token !== renderToken) return;
  $("detail").replaceChildren(...nodes);
  paintProgress(latest || job.progress);
}

function collectFailures(items) {
  const failures = items.filter(
    (i) => ["failed", "skipped"].includes(i.state) && ["chat", "asset", "pack-error"].includes(i.kind),
  );
  for (const item of items.filter((i) => i.kind === "chat"))
    for (const kind of ["toolFailures", "fileFailures", "citationFailures"])
      for (const problem of item.report?.[kind] || [])
        failures.push({ chatId: item.chatId, kind: "enrichment", error: problem.error });
  return failures;
}

function failuresBand(job, failures) {
  const details = el("details", null, "band disclosure");
  details.append(el("summary", t("tasks.failures.title", { count: failures.length })));
  const rows = el("div", null, "rows");
  for (const item of failures) {
    const row = el("div", null, "row");
    row.append(
      el(
        "span",
        t("tasks.failures.line", {
          name: item.name || item.chatId || t("tasks.failures.pack"),
          error: item.error || t("tasks.failures.unfinished"),
        }),
        "row__label",
      ),
    );
    if (!active)
      row.append(
        button(
          t("common.retry"),
          () =>
            retryFailed(
              job.id,
              item.kind === "asset"
                ? { key: item.key }
                : item.chatId
                  ? { chatId: item.chatId }
                  : { all: true },
            ),
        ),
      );
    rows.append(row);
  }
  details.append(rows);
  return details;
}

async function artifactsBand(job) {
  const section = el("section", null, "band");
  const head = el("div", null, "band__head");
  head.append(
    el("h3", t("tasks.artifacts.title"), "band__title"),
    el("span", String(job.artifacts.length), "row__note num"),
  );
  const rows = el("div");
  for (const artifact of job.artifacts) {
    const download = await db.getItem(job.id, `download:${artifact.path}`);
    const row = el("div", null, "artifact");
    const body = el("div", null, "artifact__body");
    const meta = el("div", null, "artifact__meta");
    meta.append(el("span", bytes(artifact.bytes)));
    if (download)
      meta.append(
        el(
          "span",
          {
            in_progress: t("tasks.download.inProgress"),
            complete: t("tasks.download.complete"),
            interrupted: t("tasks.download.interrupted"),
          }[download.state] || download.state,
        ),
      );
    body.append(el("span", artifact.name, "artifact__name"), meta);
    row.append(
      body,
      button(t("common.download"), () => downloadArtifact(job, artifact), "btn btn--primary"),
    );
    rows.append(row);
  }
  section.append(head, rows);
  return section;
}

async function acquireRun(jobId, retry = null, auto = false) {
  if (active) throw new Error(t("tasks.error.busy"));
  const job = await db.getJob(jobId);
  if (!job) throw new Error(t("tasks.error.missing"));
  const resume = job.state !== "queued";
  if (
    (resume || !auto) &&
    !confirm(
      resume
        ? t("tasks.confirm.resume")
        : t("tasks.confirm.start"),
    )
  )
    return;
  // Return after dispatch; the lock callback stays alive until the worker settles.
  let dispatched;
  const ready = new Promise((resolve, reject) => {
    dispatched = { resolve, reject };
  });
  void navigator.locks
    .request(EXECUTOR_LOCK, { ifAvailable: true }, async (lock) => {
      if (!lock) {
        dispatched.reject(new Error(t("tasks.error.otherPage")));
        return;
      }
      let resolveDone, dbRunId, worker;
      const done = new Promise((resolve) => {
        resolveDone = resolve;
      });
      try {
        const fresh = await db.getJob(jobId);
        if (fresh.runId !== job.runId || fresh.state !== job.state)
          throw new Error(t("tasks.error.stale"));
        dbRunId = crypto.randomUUID();
        await db.updateJob(jobId, { runId: dbRunId, state: "running", error: null });
        worker = new Worker(chrome.runtime.getURL("lib/job-worker.js"), { type: "module" });
        active = { jobId, runId: dbRunId, worker, done, resolveDone };
        worker.onmessage = async ({ data }) => {
          if (!active || data.jobId !== active.jobId || data.runId !== active.runId) return;
          if (data.type === "bridge") {
            try {
              const value =
                data.action === "readTokens"
                  ? await send("readTokens", data.payload)
                  : await chrome.permissions.contains({
                      origins: [`https://${data.payload.host}/*`],
                    });
              worker.postMessage({
                type: "bridgeResult",
                id: data.id,
                jobId,
                runId: dbRunId,
                value,
              });
            } catch (e) {
              worker.postMessage({
                type: "bridgeResult",
                id: data.id,
                jobId,
                runId: dbRunId,
                error: e.message,
                name: e.name,
              });
            }
          }
          if (data.type === "progress") {
            if (selected === jobId) {
              latest = data.progress;
              paintProgress(latest);
            }
            channel.postMessage(data);
          }
          if (data.type === "settled") {
            if (data.error) error(data.error);
            resolveDone();
          }
        };
        worker.onerror = (e) => {
          error(e.message);
          resolveDone();
        };
        selected = jobId;
        latest = null;
        worker.postMessage({
          type: "run",
          jobId,
          runId: dbRunId,
          resume,
          retry,
          // Only consulted by jobs created before the locale was snapshotted.
          locale: getLocale(),
        });
        await refresh();
        dispatched.resolve();
        await done;
        const ended = await db.getJob(jobId);
        if (["running", "pausing"].includes(ended?.state))
          await db.updateJob(
            jobId,
            { state: "interrupted", error: t("tasks.error.executorExit") },
            dbRunId,
          );
      } catch (e) {
        if (dbRunId)
          await db.updateJob(jobId, { state: "failed", error: e.message }, dbRunId).catch(() => {});
        dispatched.reject(e);
        error(e);
      } finally {
        worker?.terminate();
        active = null;
        latest = null;
        await refresh();
        channel.postMessage({ type: "refresh" });
      }
    })
    .catch((e) => {
      dispatched.reject(e);
      error(e);
    });
  return ready;
}

async function pauseJob() {
  if (!active) return;
  const { jobId, runId, worker, done } = active;
  const snapshot = await db.updateJob(
    jobId,
    (job) => (job.state === "running" ? { state: "pausing" } : {}),
    runId,
  );
  if (snapshot.state === "pausing") worker.postMessage({ type: "pauseJob", jobId, runId });
  await render();
  await done;
}
const resumeJob = (id) => acquireRun(id);
const retryFailed = (id, target) => acquireRun(id, target);

function skipItem(key) {
  if (!active) return;
  active.worker.postMessage({ type: "skipItem", jobId: active.jobId, runId: active.runId, key });
}

async function deleteJob(id) {
  if (!confirm(t("tasks.confirm.delete"))) return;
  if (active) {
    await pauseJob();
    while (active) await new Promise((r) => setTimeout(r, 20));
  }
  await navigator.locks.request(EXECUTOR_LOCK, { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error(t("tasks.error.deleteLocked"));
    if ([...downloadUrls.values()].some((d) => d.jobId === id))
      throw new Error(t("tasks.error.deleteDownloading"));
    await clearWorkspace(id);
    await db.deleteJob(id);
    if (selected === id) selected = "";
  });
  await refresh();
  channel.postMessage({ type: "refresh" });
}

async function clearAllJobs() {
  const jobs = await db.listJobs();
  if (!jobs.length) return;
  if (active) throw new Error(t("tasks.error.clearBusy"));
  if (downloadUrls.size) throw new Error(t("tasks.error.clearDownloading"));
  if (!confirm(t("tasks.confirm.clear"))) return;
  await navigator.locks.request(EXECUTOR_LOCK, { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error(t("tasks.error.clearLocked"));
    for (const job of jobs) {
      await clearWorkspace(job.id);
      await db.deleteJob(job.id);
    }
    selected = "";
  });
  await refresh();
  channel.postMessage({ type: "refresh" });
}

async function downloadArtifact(job, artifact) {
  const store = await opfsStore(job.id),
    file = await store.getBlob(artifact.path);
  if (file.size !== artifact.bytes) throw new Error(t("tasks.error.artifactMissing"));
  const url = URL.createObjectURL(file);
  try {
    const id = await chrome.downloads.download({ url, filename: artifact.name, saveAs: true });
    downloadUrls.set(id, { url, jobId: job.id, artifact });
    const fresh = await db.getJob(job.id);
    await db.putItem(job.id, fresh.runId, {
      key: `download:${artifact.path}`,
      kind: "download",
      state: "in_progress",
      downloadId: id,
    });
    const [result] = await chrome.downloads.search({ id });
    if (result && result.state !== "in_progress")
      await downloadChanged({ id, state: { current: result.state } });
    await render();
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

async function downloadChanged(delta) {
  if (!delta.state) return;
  const own = downloadUrls.get(delta.id);
  if (own) {
    const job = await db.getJob(own.jobId);
    if (job)
      await db.putItem(job.id, job.runId, {
        key: `download:${own.artifact.path}`,
        kind: "download",
        downloadId: delta.id,
        state: delta.state.current,
      });
    if (delta.state.current !== "in_progress") {
      URL.revokeObjectURL(own.url);
      downloadUrls.delete(delta.id);
    }
    if (selected === own.jobId) await render();
  }
}
chrome.downloads.onChanged.addListener((delta) => {
  void downloadChanged(delta).catch(error);
});

async function reconcile() {
  await navigator.locks.request(EXECUTOR_LOCK, { ifAvailable: true }, async (lock) => {
    if (!lock) return;
    for (const job of await db.listJobs())
      if (["running", "pausing"].includes(job.state))
        await db.updateJob(job.id, { state: "interrupted" });
  });
  for (const job of await db.listJobs())
    for (const item of (await db.listItems(job.id)).filter(
      (i) => i.kind === "download" && i.state === "in_progress",
    )) {
      const [download] = await chrome.downloads.search({ id: item.downloadId });
      await db.putItem(job.id, job.runId, { ...item, state: download?.state || "interrupted" });
    }
}

async function locationChanged() {
  const params = new URLSearchParams(location.hash.slice(1));
  const id = params.get("jobId");
  if (id) selected = id;
  history.replaceState(null, "", id ? `#${new URLSearchParams({ jobId: id })}` : location.pathname);
  await refresh();
  if (params.get("start") && id && (await db.getJob(id))?.state === "queued")
    await acquireRun(id, null, true);
}

async function handleBroadcast(data) {
  if (data.type === "progress" && !active && data.jobId === selected) {
    const job = await db.getJob(selected);
    if (job?.runId === data.runId) paintProgress(data.progress);
  } else if (data.type === "refresh") await silentSync();
}
channel.onmessage = ({ data }) => {
  void handleBroadcast(data).catch(error);
};
window.addEventListener("hashchange", () => {
  void locationChanged().catch(error);
});
window.addEventListener("beforeunload", (e) => {
  if (active || downloadUrls.size) {
    e.preventDefault();
    e.returnValue = "";
  }
});
let syncing = null;
async function silentSync() {
  if (syncing) return syncing;
  syncing = (async () => {
    try {
      await reconcile();
      await refresh();
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

$("btn-clear-jobs")?.addEventListener("click", () => {
  void clearAllJobs().catch(error);
});
$("empty-open").addEventListener("click", async () => {
  try {
    error("");
    await chrome.action.openPopup();
  } catch {
    error(new Error(t("tasks.error.openPopup")));
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void silentSync().catch(error);
  }
});
window.addEventListener("focus", () => {
  void silentSync().catch(error);
});
/** Header chip: the version of the build that is actually running. */
function paintVersion() {
  $("app-version").textContent = t("common.version", {
    version: chrome.runtime.getManifest().version,
  });
}
// The switch is shared with the popup; either page can flip it and this one
// follows storage changes live.
let syncLangControl = null;
await initPageI18n({
  storage: chrome.storage.local,
  onChanged: chrome.storage.onChanged,
  titleKey: "tasks.title",
  onChange: () => {
    syncLangControl?.();
    paintVersion();
    void refresh().catch(error);
  },
});
paintVersion();
syncLangControl = bindLocaleSwitch({
  storage: chrome.storage.local,
  titleKey: "tasks.title",
  onChange: () => {
    paintVersion();
    void refresh().catch(error);
  },
});
try {
  await reconcile();
  await locationChanged();
} catch (e) {
  error(e);
}
