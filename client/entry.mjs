/**
 * codex-messages — 前端折叠渲染
 *
 * 归组模型（对齐 Codex 客户端）：一条 turn 的输出 = reasoning + commentary + function_call + 最终答案。
 * 非最终答案的部分收进一个可展开分组，折叠头只显示状态：生成中标「工作中」，完成后显示「工作 N 秒」。
 *
 * 宿主约束（已实测确认）：
 *   - 宿主无消息渲染钩子（messageWidgets 只作用于 role:"custom"），所以只能做 DOM 层归组。
 *   - .messages 的直接子节点多为无 class 的懒渲染外壳（data-lazy-id），真正的 .msg 在里面；
 *     更早的历史是 .msg-lazy-ph 占位。归组必须以「直接子节点」为单位、收起时隐整个外壳，
 *     这样绝不搬动 React 拥有的节点，也不会出现 insertBefore 参照失效。
 *   - 宿主自己已把中间步骤聚成 .turn-tools-trail，整条 trail 直接当一个分组成员。
 */
import { hostApi } from "./sdk/client-utils.mjs";

const TURNS_URL = "/plugins-api/codex-messages/turns";
const STORE_KEY = "codex-messages:collapsed";

const state = {
	/** 服务端 phase：msgId -> { phase, commentary, toolCalls, thinking } */
	phases: new Map(),
	phasesVersion: 0,
	streaming: false,
	/** 会话 id -> { groupKey -> collapsed } */
	overrides: new Map(),
	timer: 0,
	liveSince: new Map(),
	streamTimer: 0,
	turnsSession: "",
	/** container -> 上次布局签名，签名没变就完全不碰 DOM */
	signatures: new WeakMap(),
};

/* ── 折叠状态持久化（按会话记住用户手动展开/收起的选择） ─────────────── */

function readOverrides() {
	if (state.overrides.size > 0) return;
	try {
		const raw = localStorage.getItem(STORE_KEY);
		if (!raw) return;
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return;
		for (const [session, map] of Object.entries(parsed)) {
			if (map && typeof map === "object") state.overrides.set(session, { ...map });
		}
	} catch {}
}

function writeOverrides() {
	try {
		const out = {};
		for (const [session, map] of state.overrides) out[session] = map;
		localStorage.setItem(STORE_KEY, JSON.stringify(out));
	} catch {}
}

function currentSession() {
	const match = /[#&]s=([0-9a-fA-F-]{8,})/.exec(String(location.hash || ""));
	return match ? match[1] : "";
}

function overridesFor(session) {
	let map = state.overrides.get(session);
	if (!map) {
		map = {};
		state.overrides.set(session, map);
	}
	return map;
}

/* ── 样式：注入一次；选择器只用自有 data-cm-*，不受 React 改写 class 影响 ── */

function ensureStyle() {
	if (document.getElementById("codex-messages-style")) return;
	const style = document.createElement("style");
	style.id = "codex-messages-style";
	style.textContent = `
[data-cm-group-head]{
	display:flex; align-items:flex-start; gap:8px; width:100%;
	margin:2px 0 4px; padding:7px 10px; text-align:left; cursor:pointer;
	background:var(--bg-elev, rgba(255,255,255,.035));
	border:1px solid var(--border-subtle, rgba(255,255,255,.08));
	border-radius:8px; color:var(--text-dim,#a1a1aa);
	font:12.5px/1.5 inherit; font-family:inherit;
}
[data-cm-group-head]:hover{ border-color:var(--border,rgba(255,255,255,.16)); color:var(--text,#e4e4e7); }
[data-cm-group-head] .cm-caret{ flex:0 0 auto; width:12px; margin-top:2px; opacity:.7; transition:transform .15s ease; }
[data-cm-group-head][aria-expanded="true"] .cm-caret{ transform:rotate(90deg); }
[data-cm-group-head] .cm-head-text{ min-width:0; flex:0 1 auto; }
[data-cm-group-head] .cm-head-text[data-cm-live]{ color:#4ade80; animation:cm-pulse 1.4s ease-in-out infinite; }
@keyframes cm-pulse{ 0%,100%{ opacity:.55; } 50%{ opacity:1; } }
[data-cm-member-open]{
	border-left:2px solid var(--border-subtle,rgba(255,255,255,.09));
	padding-left:10px; margin-left:4px;
}
`;
	(document.head || document.documentElement).appendChild(style);
}

/* ── 直接子节点 → 可归组的单元 ─────────────────────────────────────── */

/** 把懒渲染外壳解包成真正的消息节点；占位符与压缩卡保持原样识别。 */
function resolveUnit(node) {
	if (node.nodeType !== 1) return null;
	if (node.hasAttribute("data-cm-group-head")) return { kind: "head", node };
	if (node.classList.contains("msg-lazy-ph")) return { kind: "placeholder", node };
	if (node.classList.contains("turn-tools-trail")) return { kind: "trail", node };

	const msg = node.matches?.(".msg") ? node : node.querySelector?.(":scope > * > .msg, :scope > .msg");
	if (!msg) return { kind: "other", node };
	if (msg.classList.contains("msg-compactionSummary")) return { kind: "boundary", node };
	if (msg.classList.contains("msg-user") || msg.classList.contains("msg-system")) return { kind: "boundary", node };
	if (msg.classList.contains("msg-assistant")) return { kind: "assistant", node, msg };
	return { kind: "boundary", node };
}

/** 宿主本轮是否在跑（它自己渲染的停止按钮）。比服务端轮询更即时。 */
function hostIsRunning() {
	return Boolean(document.querySelector(".btn.stop, button.btn.stop"));
}

const hasToolCard = (el) => Boolean(el.querySelector?.(".toolcall, .tool-call, [data-toolcall-id]"));
const hasThinking = (el) => Boolean(el.querySelector?.(".thinking, [data-thinking]"));

/** 单元里真正可见的正文（旁白或最终答案）。 */
function visibleTextOf(el) {
	return Array.from(el.querySelectorAll(".msg-text-main, .msg-text"))
		.map((node) => (node.textContent || "").trim())
		.filter(Boolean)
		.join("\n");
}

function msgIdOf(unit) {
	if (unit.kind === "trail") return unit.node.getAttribute("data-cluster-id") || "";
	return unit.msg?.getAttribute("data-msg-id") || unit.node.getAttribute("data-msg-id") || "";
}

/**
 * 单元归类：commentary（中间步骤）/ final_answer（最终回复）/ boundary（打断归组）。
 *
 * 服务端 phase 优先；拿不到时按结构推断：带工具调用 = 本轮还没干完 = commentary，
 * 只剩正文没有工具卡 = final_answer。与「commentary 吸收同轮 reasoning + function_call」一致。
 */
function classifyUnit(unit) {
	if (unit.kind === "trail") return "commentary";
	if (unit.kind !== "assistant") return "boundary";

	const id = msgIdOf(unit);
	const serverEntry = id ? state.phases.get(id) : null;
	if (serverEntry) return serverEntry.phase === "commentary" ? "commentary" : "final_answer";

	if (hasToolCard(unit.node)) return "commentary";
	if (!visibleTextOf(unit.node) && hasThinking(unit.node)) return "commentary";
	return "final_answer";
}

/** 把连续的 commentary 单元切成若干组。 */
function collectRuns(container) {
	const units = Array.from(container.children)
		.map((child) => resolveUnit(child))
		.filter((unit) => unit && unit.kind !== "head");

	const runs = [];
	let open = null;
	for (const unit of units) {
		const kind = classifyUnit(unit);
		if (kind !== "commentary") {
			if (open) runs.push(open);
			open = null;
			continue;
		}
		// message 粒度：每条中间消息单独成组（宿主已聚成 trail 的，拆到里面每条）。
		if (!open) open = { members: [] };
		open.members.push(unit);
	}
	if (open) runs.push(open);
	const filled = runs.filter((run) => run.members.length > 0);

	// 吸收「紧随其后的最终答案」自带的思考块：本轮 reasoning 属于这一轮，
	// 折叠时跟分组一起收起，只留答案正文，避免分组下面又孤零零露出一段思考。
	for (const run of filled) {
		run.attached = attachedThinking(container, run.members[run.members.length - 1].node);
	}

	// 标记「活跃分组」：本轮还在跑，且它是渲染出来的最后一段。
	// 流式期间保持展开，用户能看到 agent 正在干活；最终答案落地后它不再是尾段，自动折叠。
	// 必须用「在跑」把关，否则历史会话里恰好排在末尾的分组会永远展开。
	for (let i = 0; i < filled.length; i += 1) {
		const lastMember = filled[i].members[filled[i].members.length - 1].node;
		const running = state.streaming || hostIsRunning();
		filled[i].live = running && i === filled.length - 1 && lastMember === container.lastElementChild;
	}
	return filled;
}

/* ── 状态 ──────────────────────────────────────────────────────────── */

/**
 * message 粒度用：把宿主聚类的 trail 拆成内部每条消息。
 * 分组头插到 trail 内部，成员只靠内联 display 收起，绝不搬动宿主节点。
 */
function splitTrail(unit) {
	const inner = Array.from(unit.node.children).filter((child) => child.querySelector?.(".msg, .toolcall, .thinking"));
	if (inner.length <= 1) return [unit];
	return inner.map((node) => ({ kind: "trailItem", node, msg: node.querySelector?.(".msg") || node }));
}

/**
 * 从分组最后一个成员往下找紧跟着的最终答案消息，取出它的思考块。
 * 中途遇到用户消息或另一个分组就放弃（说明已换轮）。
 */
function attachedThinking(container, lastMemberNode) {
	const found = [];
	let node = lastMemberNode ? lastMemberNode.nextElementSibling : null;
	while (node) {
		const unit = resolveUnit(node);
		if (!unit) {
			node = node.nextElementSibling;
			continue;
		}
		if (unit.kind !== "assistant") break;
		if (classifyUnit(unit) !== "final_answer") break;
		for (const block of unit.msg ? unit.msg.querySelectorAll(".msg-body > .thinking, .msg-body > [data-thinking]") : []) {
			found.push(block);
		}
		break;
	}
	return found;
}

function groupSummary(members) {
	let steps = 0;
	for (const unit of members) steps += unit.node.querySelectorAll(".toolcall, .tool-call").length;
	return { steps };
}

/* ── 布局：只增删自有节点 + 内联 display，绝不搬动宿主节点 ────────────── */

/**
 * 分组耗时：优先用服务端给的每条 durationMs 累加；
 * 拿不到就用消息 id 里嵌的毫秒时间戳做首尾差；再不行用本地观测到的折叠时刻。
 */
function formatDuration(ms) {
	if (!Number.isFinite(ms) || ms <= 0) return "";
	const sec = ms / 1000;
	if (sec < 60) return sec < 10 ? sec.toFixed(1) + " 秒" : Math.round(sec) + " 秒";
	const min = Math.floor(sec / 60);
	const rest = Math.round(sec % 60);
	if (min < 60) return rest ? min + " 分 " + rest + " 秒" : min + " 分钟";
	const hr = Math.floor(min / 60);
	return hr + " 小时 " + (min % 60) + " 分";
}

/** 从一个 id 里抠出毫秒时间戳（消息 id 与宿主 cluster id 都形如 xxx-<ms>-n）。 */
function stampOf(id) {
	const m = /-(\d{12,})-/.exec(String(id || ""));
	if (m) return Number(m[1]);
	return 0;
}

/**
 * 分组耗时。优先累加服务端给的 durationMs；
 * 否则用组内所有消息（含 trail 里嵌套的）与最终答案的时间戳做首尾差，
 * 再补上最后一条消息自己的生成时间；最后兜底用本地观测到的开始时刻。
 */
function groupElapsed(run, startedAt) {
	const members = run.members || [];
	let sum = 0;
	let lastDur = 0;
	const stamps = [];

	const consider = (id) => {
		if (!id) return;
		const entry = state.phases.get(id);
		if (entry) {
			if (entry.durationMs > 0) {
				sum += entry.durationMs;
				lastDur = Math.max(lastDur, entry.durationMs);
			}
			if (entry.ts > 0) stamps.push(entry.ts);
		}
		const embedded = stampOf(id);
		if (embedded > 0) stamps.push(embedded);
	};

	for (const unit of members) {
		consider(msgIdOf(unit));
		for (const el of unit.node.querySelectorAll("[data-msg-id]")) consider(el.getAttribute("data-msg-id"));
	}
	for (const block of run.attached || []) {
		const owner = block.closest("[data-msg-id]");
		if (owner) consider(owner.getAttribute("data-msg-id"));
	}

	if (sum > 0) return sum;
	if (stamps.length >= 2) {
		const span = Math.max(...stamps) - Math.min(...stamps);
		if (span > 0) return span + Math.max(lastDur, 1200);
	}
	if (startedAt) return Date.now() - startedAt;
	return 0;
}

function clearMarks(container) {
	for (const head of Array.from(container.querySelectorAll("[data-cm-group-head]"))) head.remove();
	for (const attached of Array.from(container.querySelectorAll("[data-cm-attached]"))) {
		attached.removeAttribute("data-cm-attached");
		attached.style.removeProperty("display");
	}
	for (const member of Array.from(container.querySelectorAll("[data-cm-member]"))) {
		member.removeAttribute("data-cm-member");
		member.removeAttribute("data-cm-key");
		member.removeAttribute("data-cm-member-open");
		member.style.removeProperty("display");
	}
	state.signatures.delete(container);
}

function headLabel(live, elapsedMs, steps) {
	if (live) return "工作中";
	const text = formatDuration(elapsedMs);
	return text ? "工作 " + text : "已完成";
}

function buildHead(key, collapsed, live, elapsedMs, steps) {
	const head = document.createElement("button");
	head.type = "button";
	head.setAttribute("data-cm-group-head", key);
	head.setAttribute("aria-expanded", collapsed ? "false" : "true");
	head.setAttribute("aria-label", (collapsed ? "展开" : "收起") + "中间步骤" + (steps ? "（" + steps + " 步）" : ""));

	const caret = document.createElement("span");
	caret.className = "cm-caret";
	caret.textContent = "▶";

	const textEl = document.createElement("span");
	textEl.className = "cm-head-text";
	textEl.textContent = headLabel(live, elapsedMs, steps);
	if (live) textEl.setAttribute("data-cm-live", "");

	head.append(caret, textEl);
	return head;
}

function setCollapsed(container, key, collapsed) {
	for (const attached of Array.from(container.querySelectorAll(`[data-cm-attached="${CSS.escape(key)}"]`))) {
		if (collapsed) attached.style.setProperty("display", "none");
		else attached.style.removeProperty("display");
	}
	for (const member of Array.from(container.querySelectorAll(`[data-cm-key="${CSS.escape(key)}"]`))) {
		if (collapsed) {
			member.style.setProperty("display", "none");
			member.removeAttribute("data-cm-member-open");
		} else {
			member.style.removeProperty("display");
			member.setAttribute("data-cm-member-open", "");
		}
	}
}

/** 我们自己的分组头与成员是否都还在原位。 */
function marksIntact(container, expectedKeys) {
	const heads = Array.from(container.querySelectorAll("[data-cm-group-head]"));
	if (heads.length !== expectedKeys.length) return false;
	const headKeys = new Set(heads.map((head) => head.getAttribute("data-cm-group-head")));
	for (const key of expectedKeys) {
		if (!headKeys.has(key)) return false;
		if (!container.querySelector(`[data-cm-member][data-cm-key="${CSS.escape(key)}"]`)) return false;
	}
	return true;
}

function layout(container) {
	const runs = collectRuns(container);
	const session = currentSession();
	const overrides = session ? overridesFor(session) : {};

	// 签名 = 分组结构 + 折叠选择 + 影响外观的配置。没变就一次 DOM 都不碰，
	// 避免与宿主流式渲染抢布局、也避免点开的内容被下一帧重新收起。
	const signature = JSON.stringify([
		session,
		state.phasesVersion,
		hostIsRunning(),
		runs.map((run) => JSON.stringify([run.members.map((unit) => msgIdOf(unit) || unit.kind), run.live, (run.attached || []).length])),
		runs.map((run) => {
			const key = groupKey(run);
			return Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : null;
		}),
	]);
	// 签名相同不代表我们的痕迹还在：分组头可能插在宿主自有容器内，被 React 重渲染时丢掉。
	// 因此除了签名，还要核对 DOM 里的头/成员数量与键是否对得上，对不上就重建。
	const expectedKeys = runs.map((run) => groupKey(run));
	if (state.signatures.get(container) === signature && marksIntact(container, expectedKeys)) return;

	clearMarks(container);

	for (const run of runs) {
		const members = run.members;
		const key = groupKey(run);
		const { steps } = groupSummary(members);

		const stored = Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : null;
		// 用户手动切换过就一直尊重；否则活跃分组展开、已收尾分组按偏好折叠。
		const collapsed = stored !== null ? stored === true : !run.live;

		// 记住本轮开始时间，供服务端没给 durationMs 时兜底算耗时。
		if (run.live && !state.liveSince.has(key)) state.liveSince.set(key, Date.now());
		const elapsedMs = run.live ? 0 : groupElapsed(run, state.liveSince.get(key));

		const head = buildHead(key, collapsed, run.live, elapsedMs, steps);
		head.addEventListener("click", () => {
			const next = head.getAttribute("aria-expanded") !== "false";
			head.setAttribute("aria-expanded", next ? "false" : "true");
			setCollapsed(container, key, next);
			if (session) {
				overridesFor(session)[key] = next;
				writeOverrides();
			}
			state.signatures.delete(container);
		});

		const anchorParent = members[0].node.parentElement || container;
		anchorParent.insertBefore(head, members[0].node);
		for (const block of run.attached || []) {
			block.setAttribute("data-cm-attached", key);
			if (collapsed) block.style.setProperty("display", "none");
			else block.style.removeProperty("display");
		}
		for (const unit of members) {
			unit.node.setAttribute("data-cm-member", "1");
			unit.node.setAttribute("data-cm-key", key);
			if (collapsed) unit.node.style.setProperty("display", "none");
			else unit.node.setAttribute("data-cm-member-open", "");
		}
	}

	state.signatures.set(container, signature);
}

/** 分组键：宿主聚类 id 优先（稳定），否则用首成员消息 id + 组大小。 */
function groupKey(run) {
	const first = run.members[0];
	const stable = msgIdOf(first) || first.kind;
	return stable;
}

function messageContainers() {
	return Array.from(document.querySelectorAll(".messages"));
}

let layoutRunning = false;

function runAll() {
	if (layoutRunning) return;
	layoutRunning = true;
	try {
		ensureStyle();
		for (const container of messageContainers()) layout(container);
	} finally {
		layoutRunning = false;
	}
}

/** 节流：宿主流式渲染高频改 DOM，攒到下一帧统一算一次。 */
function scheduleRun() {
	if (state.timer) return;
	state.timer = requestAnimationFrame(() => {
		state.timer = 0;
		runAll();
	});
}

/* ── 配置与 phase 表同步 ───────────────────────────────────────────── */

function adoptPhases(turns, streaming) {
	if (typeof streaming === "boolean") state.streaming = streaming;
	const next = new Map();
	for (const turn of Array.isArray(turns) ? turns : []) {
		if (turn && typeof turn.id === "string") next.set(turn.id, turn);
	}
	state.phases = next;
	state.phasesVersion += 1;
}

async function fetchTurns(force = false) {
	const session = currentSession();
	if (!force && session === state.turnsSession && state.phases.size > 0) return;
	state.turnsSession = session;
	try {
		const res = await fetch(`${TURNS_URL}?session=${encodeURIComponent(session)}`, { cache: "no-store" });
		if (!res.ok) return;
		const data = await res.json();
		if (!data?.ok || !Array.isArray(data.turns)) return;
		adoptPhases(data.turns, data.streaming === true);
		scheduleRun();
		scheduleStreamPoll();
	} catch {}
}

/** 流式期间每 2 秒跟一次 phase（收尾后自动停，不空转）。 */
function scheduleStreamPoll() {
	if (state.streamTimer) return;
	if (!state.streaming && !hostIsRunning()) return;
	state.streamTimer = setTimeout(() => {
		state.streamTimer = 0;
		fetchTurns(true);
	}, 2000);
}

/* ── 全局启动：bundle 导入即生效，不需要打开设置页 ───────────────────── */

let globalStarted = false;

function startGlobal() {
	if (globalStarted) return;
	globalStarted = true;
	readOverrides();
	fetchTurns(true);

	const observer = new MutationObserver(() => scheduleRun());
	observer.observe(document.documentElement, { childList: true, subtree: true });

	const onHashChange = () => {
		state.turnsSession = "";
		fetchTurns(true);
		scheduleRun();
	};
	window.addEventListener("hashchange", onHashChange);

	// 设置页把服务端广播转发到 window，实现 phase 热更新。
	const onBridge = (event) => {
		const payload = event?.detail;
		if (!payload || typeof payload !== "object") return;
		if (payload.type === "cm:turns" && Array.isArray(payload.turns)) {
			adoptPhases(payload.turns, payload.streaming === true);
			scheduleRun();
		}
	};
	window.addEventListener("codex-messages:bridge", onBridge);

	hostApi()?.__registerCleanup?.(() => {
		observer.disconnect();
		window.removeEventListener("hashchange", onHashChange);
		window.removeEventListener("codex-messages:bridge", onBridge);
	});

	scheduleRun();
}

function bootWhenReady(attempt = 0) {
	if (typeof document === "undefined") return;
	if (hostApi() || document.querySelector(".messages")) {
		startGlobal();
		return;
	}
	if (attempt > 150) {
		startGlobal();
		return;
	}
	setTimeout(() => bootWhenReady(attempt + 1), 100);
}

bootWhenReady();

/* ── 插件页：归组统计与 phase 来源诊断 ─────────────────────────── */

const VIEW_CSS = `
.cm-view{ max-width:720px; margin:0 auto; padding:24px 16px; color:var(--text,#e4e4e7); font:13px/1.5 system-ui,-apple-system,sans-serif; }
.cm-head{ display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:18px; padding-bottom:14px; border-bottom:1px solid var(--border-subtle,rgba(255,255,255,.08)); }
.cm-title{ margin:0; font-size:19px; font-weight:600; display:flex; align-items:center; gap:8px; }
.cm-sub{ margin-top:3px; font-size:12.5px; color:var(--text-dim,#a1a1aa); }
.cm-card{ background:var(--bg-elev,rgba(255,255,255,.03)); border:1px solid var(--border-subtle,rgba(255,255,255,.08)); border-radius:10px; padding:16px; margin-bottom:16px; }
.cm-label{ font-size:13px; }
.cm-desc{ margin-top:2px; font-size:11.5px; color:var(--text-dim,#71717a); }
.cm-stats{ display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:10px; margin-top:4px; }
.cm-stat{ background:rgba(0,0,0,.22); border:1px solid var(--border-subtle,#3f3f46); border-radius:8px; padding:10px 12px; }
.cm-stat b{ display:block; font-size:18px; font-weight:600; }
.cm-stat span{ font-size:11px; color:var(--text-dim,#71717a); }
.cm-note{ font-size:12px; color:var(--text-dim,#a1a1aa); background:rgba(0,0,0,.22); border-radius:8px; padding:11px 13px; line-height:1.6; }
.cm-chips{ display:flex; gap:6px; flex-wrap:wrap; margin-top:10px; }
.cm-tag{ font-size:11px; padding:2px 7px; border-radius:5px; background:rgba(255,255,255,.07); border:1px solid var(--border-subtle,rgba(255,255,255,.08)); }
.cm-tag[data-kind="explicit"]{ background:rgba(34,197,94,.14); border-color:rgba(34,197,94,.32); color:#4ade80; }
.cm-tag[data-kind="inferred"]{ background:rgba(234,179,8,.13); border-color:rgba(234,179,8,.3); color:#eab308; }
`;

export default {
	mount(el, ctx) {
		el.innerHTML = `
			<div class="cm-view">
				<div class="cm-head">
					<div>
						<h2 class="cm-title"><span>✂️</span> Codex 折叠渲染</h2>
						<div class="cm-sub">按 phase 归组：中间旁白、思考与工具调用收进一个可展开分组，只留最终答案平铺。</div>
					</div>
				</div>
				<div class="cm-card">
					<div class="cm-label" style="font-weight:600">当前会话归组</div>
					<div class="cm-stats">
						<div class="cm-stat"><b id="cm-stat-groups">0</b><span>折叠分组</span></div>
						<div class="cm-stat"><b id="cm-stat-steps">0</b><span>吸收的步骤</span></div>
						<div class="cm-stat"><b id="cm-stat-final">0</b><span>最终答案</span></div>
					</div>
					<div class="cm-chips" id="cm-phase-chips"></div>
				</div>
				<div class="cm-note" id="cm-diag">正在读取会话 phase 数据…</div>
			</div>
		`;

		const root = el.querySelector(".cm-view");
		if (!root.querySelector("#codex-messages-view-style")) {
			const style = document.createElement("style");
			style.id = "codex-messages-view-style";
			style.textContent = VIEW_CSS;
			root.prepend(style);
		}

		function paintStats() {
			let groups = 0;
			let steps = 0;
			let finals = 0;
			for (const container of messageContainers()) {
				groups += container.querySelectorAll(":scope > [data-cm-group-head]").length;
				for (const member of container.querySelectorAll("[data-cm-member]")) {
					steps += member.querySelectorAll(".toolcall, .tool-call").length;
				}
				for (const child of container.children) {
					const unit = resolveUnit(child);
					if (unit?.kind === "assistant" && !child.hasAttribute("data-cm-member") && visibleTextOf(unit.node)) finals += 1;
				}
			}
			const set = (id, value) => {
				const node = el.querySelector(id);
				if (node) node.textContent = String(value);
			};
			set("#cm-stat-groups", groups);
			set("#cm-stat-steps", steps);
			set("#cm-stat-final", finals);
		}

		function paintDiag(explicit) {
			const diag = el.querySelector("#cm-diag");
			const chips = el.querySelector("#cm-phase-chips");
			if (!diag || !chips) return;
			chips.replaceChildren();
			const total = state.phases.size;
			if (!total) {
				diag.textContent = "服务端未在消息上标注 phase，已按结构推断归组：带工具调用的消息算中间旁白，只剩正文的算最终答案。";
				return;
			}
			diag.textContent = explicit
				? "服务端已在消息上标注 phase，归组以 phase 为准。"
				: "服务端消息未标注 phase，已用结构推断补齐（有工具调用 = commentary）。";
			const explicitCount = Array.from(state.phases.values()).filter((turn) => turn.explicitPhase).length;
			const tag = (kind, text) => {
				const node = document.createElement("span");
				node.className = "cm-tag";
				node.dataset.kind = kind;
				node.textContent = text;
				return node;
			};
			chips.append(
				tag("explicit", `显式 phase ${explicitCount}/${total}`),
				tag("inferred", `结构推断 ${total - explicitCount}`),
			);
		}

		const offData = ctx.onData?.((msg) => {
			if (!msg || typeof msg !== "object") return;
			if (msg.type === "cm:turns" && Array.isArray(msg.turns)) {
				adoptPhases(msg.turns, msg.streaming === true);
				paintDiag(msg.explicit === true);
			}
			for (const container of messageContainers()) state.signatures.delete(container);
			scheduleRun();
			paintStats();
			// 转发给已在页面上的全局 transform（本视图与它同页，共享 state，这里只补热更新）。
			window.dispatchEvent(new CustomEvent("codex-messages:bridge", { detail: msg }));
		});

		ctx.send({ action: "cm:get-turns", session: currentSession() });
		paintStats();
		const timer = setInterval(paintStats, 1500);

		return () => {
			clearInterval(timer);
			if (typeof offData === "function") offData();
		};
	},
};
