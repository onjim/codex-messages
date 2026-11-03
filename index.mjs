/**
 * codex-messages — 按 phase 归组折叠模型回答（服务端入口）
 *
 * 职责只有两件：
 *   只有一件：尽量给出权威的 phase 表：会话消息自带 phase（Responses 语义）时直接采用，
 *      否则按结构推断（有工具调用 = commentary）。前端拿不到时自己回落到 DOM 结构推断。
 */
import { definePlugin } from "./sdk/index.mjs";

const textOf = (block) => (block && block.type === "text" && typeof block.text === "string" ? block.text : "");
const isToolCall = (block) => Boolean(block && (block.type === "toolCall" || block.type === "tool_use"));

/**
 * 判定一条消息属于 commentary 还是 final_answer。
 *
 * 优先级：
 *   1. 消息自带 phase（Responses 语义，权威）：commentary / final_answer 直接采用。
 *   2. 结构推断：本轮还带工具调用 = 中间旁白；只剩正文没有工具 = 最终答案。
 *      对齐 Codex「commentary 吸收同轮 reasoning + function_call」的语义。
 *   没有任何可渲染内容的消息返回 null，交给前端按占位处理。
 */
export function classifyMessage(message) {
	if (!message || typeof message !== "object") return null;
	const rawPhase = typeof message.phase === "string" ? message.phase.trim().toLowerCase() : "";
	if (rawPhase === "commentary") return "commentary";
	if (rawPhase === "final_answer" || rawPhase === "final-answer") return "final_answer";

	const blocks = Array.isArray(message.content) ? message.content : [];
	const hasTool = blocks.some(isToolCall);
	const text = blocks.map(textOf).filter(Boolean).join("\n").trim();
	if (!text && !hasTool) return null;
	if (hasTool) return "commentary";
	return message.role === "assistant" ? "final_answer" : null;
}

/** 抽出归组需要的每条消息摘要，供前端按 data-msg-id 对齐。 */
export function extractTurns(snapshot) {
	const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
	const out = [];
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		if (message.role !== "assistant") continue;
		const id = String(message.id ?? "").trim();
		if (!id) continue;
		const blocks = Array.isArray(message.content) ? message.content : [];
		const phase = classifyMessage(message);
		if (!phase) continue;
		const ts = Number(message.timestamp);
		const durationMs = Number(message.durationMs);
		out.push({
			id,
			ts: Number.isFinite(ts) ? ts : 0,
			durationMs: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0,
			phase,
			explicitPhase: typeof message.phase === "string" && message.phase.trim() !== "",
			toolCalls: blocks.filter(isToolCall).length,
			thinking: blocks.some((block) => block && block.type === "thinking"),
			commentary: blocks.map(textOf).filter(Boolean).join("\n").trim().slice(0, 500),
		});
	}
	return out;
}

export default definePlugin({
	async activate(host) {
		const sendJson = (res, status, payload) => {
			res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
			res.end(JSON.stringify(payload));
		};

		const snapshotFor = async (conversationId) => {
			if (conversationId) {
				try {
					const direct = await host.conversations?.get?.(conversationId);
					if (direct && (Array.isArray(direct.messages) || Array.isArray(direct?.conversation?.messages))) return direct.messages ? direct : direct.conversation;
				} catch {}
			}
			return host.getActiveConversation?.({ fallback: "latest-non-subagent" }) ?? null;
		};

		const emitTurns = async (conversationId) => {
			try {
				const snapshot = await snapshotFor(conversationId);
				const turns = extractTurns(snapshot);
				host.broadcast({
					type: "cm:turns",
					conversationId: snapshot?.conversationId ?? snapshot?.id ?? null,
					turns,
					explicit: turns.some((t) => t.explicitPhase),
					streaming: Boolean(snapshot?.isStreaming),
				});
			} catch (err) {
				host.broadcast({ type: "cm:turns", conversationId: null, turns: [], error: err?.message || String(err) });
			}
		};

		// ── HTTP：全局 transform 不能依赖视图挂载，phase 表走路由 ──
		host.route("GET", "/turns", async (req, res) => {
			try {
				const conversationId = String(req?.query?.session || req?.query?.conversationId || "").trim();
				const snapshot = await snapshotFor(conversationId);
				const turns = extractTurns(snapshot);
				sendJson(res, 200, {
					ok: true,
					conversationId: snapshot?.conversationId ?? snapshot?.id ?? null,
					explicit: turns.some((t) => t.explicitPhase),
					streaming: Boolean(snapshot?.isStreaming),
					turns,
				});
			} catch (err) {
				sendJson(res, 500, { ok: false, error: err?.message || String(err), turns: [] });
			}
		});

		// ── 视图窄通道：设置面板用 ─────────────────────────────────────
		host.onMessage(async (msg) => {
			if (!msg || typeof msg !== "object") return;
			const action = String(msg.action || "");
			if (action === "cm:get-turns") await emitTurns(String(msg.session || ""));
		});

		const offConversation = host.onConversationChanged?.(() => emitTurns(""));
		if (typeof offConversation === "function") host.effect?.("conversation-changed", offConversation);

		host.log("info", "codex-messages 已激活（按 phase 归组折叠）");
	},
});
