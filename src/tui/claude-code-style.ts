/**
 * Claude Code display style (`displayStyle: "claude-code"`, the default).
 *
 * Draws the subagent tool row, the chat notices, and the async widget the way
 * Claude Code draws its Agent tool and background tasks:
 *
 *   ⏺ scout(Find the auth handlers)
 *     ⎿  Read(src/auth.ts)
 *        Search(pattern: "login")
 *        +4 more tool uses (ctrl+o to expand)
 *   ⏺ Running 3 agents… (ctrl+o to expand)
 *      ├─ scout (Map the repo) · 3 tool uses · 8.1k tokens
 *      │  ⎿  Read(README.md)
 *      └─ worker (Fix the bug)
 *         ⎿  Waiting…
 *
 * Rendering only: execution, result content, and everything the model reads
 * stay the same as in the classic style.
 */
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { DisplayStyle } from "../shared/types.ts";

export function resolveDisplayStyle(value: unknown): DisplayStyle {
	return value === "classic" ? "classic" : "claude-code";
}

export interface CcTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

// CC figures.ts: BLACK_CIRCLE = darwin ? '⏺' : '●'.
export const BLACK_CIRCLE = process.platform === "darwin" ? "⏺" : "●";

const RESULT_LEAD = "  ⎿  ";
const RESULT_INDENT = "     ";
const BODY_INDENT = "       ";
const COLLAPSED_TOOL_ROWS = 3;
const COLLAPSED_TEXT_ROWS = 3;
const EXPANDED_TEXT_ROWS = 400;
const REDACTED = "[prompt redacted]";

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * One logical row. `lead` prefixes the first visual line and `cont` each wrapped
 * continuation. With `wrap`, `text` is wrapped to the width; otherwise truncated.
 */
export interface Row {
	lead: string;
	cont?: string;
	text: string;
	wrap?: boolean;
}

export function renderRows(rows: Row[], width: number): string[] {
	const out: string[] = [];
	for (const row of rows) {
		if (!row.wrap) {
			out.push(truncateToWidth(`${row.lead}${row.text}`, width, "…"));
			continue;
		}
		const leadWidth = visibleWidth(row.lead);
		const chunks = wrapTextWithAnsi(row.text, Math.max(10, width - leadWidth));
		chunks.forEach((chunk, i) => {
			const prefix = i === 0 ? row.lead : (row.cont ?? " ".repeat(leadWidth));
			out.push(truncateToWidth(`${prefix}${chunk}`, width, "…"));
		});
		if (chunks.length === 0) out.push(truncateToWidth(row.lead, width, "…"));
	}
	return out;
}

/** A Component whose rows are read again on each render. */
export function rowsComponent(build: () => Row[]): Component {
	return { render: (width: number) => renderRows(build(), width), invalidate() {} };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function ccTokens(n: number): string {
	if (n < 1000) return String(Math.round(n));
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export function ccDuration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** "12 tool uses · 34.5k tokens · 1m 3s"; zero parts are dropped. */
export function ccStats(c: { toolCount: number; tokens: number; durationMs: number }, withDuration = true): string {
	const parts: string[] = [];
	if (c.toolCount > 0) parts.push(plural(c.toolCount, "tool use"));
	if (c.tokens > 0) parts.push(`${ccTokens(c.tokens)} tokens`);
	if (withDuration && c.durationMs >= 1000) parts.push(ccDuration(c.durationMs));
	return parts.join(" · ");
}

export function oneLine(text: unknown, max = Infinity): string {
	const flat = String(text ?? "")
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return flat.length > max ? `${flat.slice(0, Math.max(1, max - 1))}…` : flat;
}

const TOOL_NAMES = new Map<string, string>([
	["read", "Read"],
	["bash", "Bash"],
	["edit", "Update"],
	["write", "Write"],
	["grep", "Search"],
	["find", "Search"],
	["ls", "List"],
	["web_search", "Web Search"],
	["fetch_content", "Fetch"],
	["subagent", "Agent"],
]);

export function ccToolName(name: string): string {
	return TOOL_NAMES.get(name) ?? TOOL_NAMES.get(name.toLowerCase()) ?? name;
}

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

export type ChildState = "pending" | "running" | "completed" | "failed" | "stopped" | "paused" | "detached";

export interface ToolUse {
	name: string;
	detail: string;
}

export interface ChildView {
	agent: string;
	desc?: string;
	state: ChildState;
	toolCount: number;
	tokens: number;
	durationMs: number;
	/** Latest finished tool uses, oldest first. */
	recentTools: ToolUse[];
	/** Every tool use the transcript exposes (expanded view). */
	allTools: ToolUse[];
	current?: ToolUse;
	prompt?: string;
	output?: string;
	error?: string;
	note?: string;
}

export type ViewKind = "single" | "multi" | "background" | "management" | "text";

export interface SubagentView {
	kind: ViewKind;
	name: string;
	detail: string;
	/** Parallel fan-out: the header counts agents instead of naming one. */
	fanout: boolean;
	children: ChildView[];
	failed: boolean;
	runId?: string;
	text?: string;
}

type Loose = Record<string, unknown>;

function rec(value: unknown): Loose {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Loose : {};
}

function arr(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** CC-style `(detail)` for a child tool call from its raw arguments. */
export function toolDetailFromArgs(name: string, args: unknown): string {
	if (typeof args === "string") return oneLine(args, 160);
	const a = rec(args);
	const pick = (...keys: string[]) => keys.map((key) => str(a[key])).find(Boolean);
	if (name === "bash") return oneLine(pick("command"), 160);
	if (name === "grep" || name === "find") {
		const pattern = pick("pattern", "query");
		const where = pick("path", "glob");
		return oneLine(pattern ? `pattern: "${pattern}"${where ? `, path: "${where}"` : ""}` : where, 160);
	}
	const value = pick("path", "file_path", "filePath", "command", "pattern", "query", "url", "agent", "task", "action");
	if (value) return oneLine(value, 160);
	const queries = arr(a.queries).map(str).filter(Boolean);
	return queries.length ? oneLine(queries.join(", "), 160) : "";
}

function toolFromPreview(tool: unknown, args: unknown): ToolUse {
	return { name: ccToolName(str(tool) ?? "tool"), detail: oneLine(args, 160) };
}

function toolsFromMessages(messages: unknown): ToolUse[] {
	const out: ToolUse[] = [];
	for (const message of arr(messages).map(rec)) {
		if (message.role !== "assistant") continue;
		for (const part of arr(message.content).map(rec)) {
			if (part.type !== "toolCall") continue;
			const name = str(part.name) ?? "tool";
			out.push({ name: ccToolName(name), detail: toolDetailFromArgs(name, part.arguments) });
		}
	}
	return out;
}

/** pi-subagents tool call summaries read "name: preview" or "name preview". */
function toolsFromSummaries(toolCalls: unknown): ToolUse[] {
	return arr(toolCalls).map(rec).map((call) => {
		const text = oneLine(call.text, 200);
		const match = /^([\w.-]+)[:\s]\s*(.*)$/.exec(text);
		return match ? { name: ccToolName(match[1]!), detail: match[2]! } : { name: text, detail: "" };
	});
}

function lastAssistantText(messages: unknown): string | undefined {
	const list = arr(messages).map(rec);
	for (let i = list.length - 1; i >= 0; i--) {
		const message = list[i]!;
		if (message.role !== "assistant") continue;
		const text = arr(message.content).map(rec).filter((part) => part.type === "text").map((part) => String(part.text ?? "")).join("\n").trim();
		if (text) return text;
	}
	return undefined;
}

function contentText(result: unknown): string {
	const content = rec(result).content;
	if (typeof content === "string") return content;
	return arr(content).map(rec).filter((block) => block.type === "text").map((block) => String(block.text ?? "")).join("\n");
}

interface Planned {
	agent: string;
	task?: string;
}

function plannedFrom(list: unknown): Planned[] {
	const out: Planned[] = [];
	for (const item of arr(list).map(rec)) {
		if (Array.isArray(item.parallel)) out.push(...plannedFrom(item.parallel));
		else out.push({ agent: str(item.agent) ?? "agent", task: str(item.task) });
	}
	return out;
}

export interface CallPlan {
	kind: "single" | "parallel" | "chain" | "workflow" | "management";
	planned: Planned[];
	name: string;
	detail: string;
}

export function describeCall(args: unknown): CallPlan {
	const a = rec(args);
	const action = str(a.action);
	if (action) {
		const id = str(a.id) ?? str(a.runId);
		const target = id ? id.slice(0, 8) : (str(a.agent) ?? str(a.topic) ?? "");
		return { kind: "management", planned: [], name: "Subagent", detail: target ? `${action} ${target}` : action };
	}
	if (Array.isArray(a.chain)) {
		const names = a.chain.map(rec).map((step) => Array.isArray(step.parallel)
			? `[${step.parallel.map((item) => str(rec(item).agent) ?? "?").join(", ")}]`
			: (str(step.agent) ?? "?"));
		return { kind: "chain", planned: plannedFrom(a.chain), name: "Chain", detail: names.join(" → ") };
	}
	const tasks = Array.isArray(a.tasks) ? a.tasks : a.workflow === "parallel" ? rec(a.args).tasks : undefined;
	if (Array.isArray(tasks)) return { kind: "parallel", planned: plannedFrom(tasks), name: "Agents", detail: "" };
	if (a.workflow !== undefined && a.workflow !== false) {
		const label = a.workflow === true || a.workflow === "true" ? "script" : String(a.workflow);
		return { kind: "workflow", planned: [], name: "Workflow", detail: label };
	}
	const agent = str(a.agent) ?? "Agent";
	return { kind: "single", planned: [{ agent, task: str(a.task) }], name: agent, detail: oneLine(a.task ?? "", 80) };
}

function stateOf(result: Loose, progressStatus: unknown, partial: boolean): ChildState {
	if (result.detached) return "detached";
	if (result.stopped) return "stopped";
	if (result.interrupted) return "paused";
	if (progressStatus === "running") return "running";
	if (progressStatus === "pending") return "pending";
	if (progressStatus === "failed") return "failed";
	if (progressStatus === "detached") return "detached";
	if (typeof result.exitCode === "number") return result.exitCode === 0 ? "completed" : "failed";
	if (progressStatus === "completed") return "completed";
	return partial ? "running" : "completed";
}

const WORKFLOW_STATES = new Map<string, ChildState>([
	["pending", "pending"],
	["queued", "pending"],
	["running", "running"],
	["completed", "completed"],
	["complete", "completed"],
	["failed", "failed"],
	["rejected", "failed"],
	["partial", "failed"],
	["paused", "paused"],
	["stopped", "stopped"],
	["detached", "detached"],
]);

function emptyChild(agent: string, task: string | undefined, state: ChildState): ChildView {
	return { agent, desc: task ? oneLine(task, 80) : undefined, state, toolCount: 0, tokens: 0, durationMs: 0, recentTools: [], allTools: [], prompt: task };
}

function childFromResult(result: Loose, progressInput: unknown, plannedTask: string | undefined, partial: boolean): ChildView {
	const progress = rec(result.progress ?? progressInput ?? result.progressSummary);
	const state = stateOf(result, progress.status, partial);
	const usage = rec(result.usage);
	const fromMessages = toolsFromMessages(result.messages);
	const allTools = fromMessages.length ? fromMessages : toolsFromSummaries(result.toolCalls);
	const recent = arr(progress.recentTools).map(rec).map((tool) => toolFromPreview(tool.tool, tool.args));
	const task = [result.task, progress.task, plannedTask].map(str).find((value) => value && value !== REDACTED);
	let note: string | undefined;
	if (state === "detached") note = str(result.detachedReason) ? `Detached: ${String(result.detachedReason)}` : "Detached";
	else if (state === "stopped") note = "Stopped";
	else if (state === "paused") note = "Paused";
	return {
		agent: str(result.agent) ?? str(progress.agent) ?? "agent",
		desc: task ? oneLine(task, 80) : (str(result.sessionName) ?? str(progress.sessionName)),
		state,
		toolCount: num(progress.toolCount) || allTools.length,
		tokens: num(progress.tokens) || num(usage.input) + num(usage.output),
		durationMs: num(progress.durationMs),
		recentTools: recent.length ? recent : allTools.slice(-COLLAPSED_TOOL_ROWS),
		allTools: allTools.length ? allTools : recent,
		current: str(progress.currentTool) && state === "running" ? toolFromPreview(progress.currentTool, progress.currentToolArgs) : undefined,
		prompt: task,
		output: str(result.finalOutput) ?? lastAssistantText(result.messages),
		error: str(result.error) ?? str(progress.error),
		note,
	};
}

function childrenFromDetails(details: Loose, call: CallPlan, partial: boolean): ChildView[] {
	const results = arr(details.results).map(rec);
	const progress = arr(details.progress).map(rec);
	const children: ChildView[] = [];
	const seen = new Set<number>();
	results.forEach((result, i) => {
		const index = typeof result.index === "number" ? result.index : i;
		seen.add(index);
		children.push(childFromResult(result, result.progress ?? progress.find((entry) => entry.index === index), call.planned[index]?.task, partial));
	});
	for (const entry of progress) {
		const index = typeof entry.index === "number" ? entry.index : -1;
		if (seen.has(index)) continue;
		seen.add(index);
		children.push(childFromResult({}, entry, call.planned[index]?.task, partial));
	}
	// Workflow projection rows the results do not cover yet, in launch order.
	const covered = new Set(results.map((result) => str(result.workflowKey) ?? str(result.runId)).filter(Boolean));
	arr(rec(details.workflowChildren).children).map(rec).forEach((row, i) => {
		if (covered.has(str(row.childId)) || covered.has(str(row.runId))) return;
		const activity = rec(row.activity);
		const state = WORKFLOW_STATES.get(String(row.state)) ?? "pending";
		const planned = call.planned[i];
		const task = planned && (!str(row.agent) || planned.agent === row.agent) ? planned.task : undefined;
		children.push({
			...emptyChild(str(row.agent) ?? str(row.childId) ?? "agent", task, state),
			desc: task ? oneLine(task, 80) : (str(row.sessionName) ?? (row.childId !== row.agent ? str(row.childId) : undefined)),
			toolCount: num(activity.toolCount),
			tokens: num(activity.tokens),
			durationMs: num(activity.durationMs),
			current: str(activity.currentTool) && state === "running" ? { name: ccToolName(String(activity.currentTool)), detail: "" } : undefined,
		});
	});
	if (children.length === 0 && (call.kind === "parallel" || call.kind === "chain")) {
		for (const planned of call.planned) children.push(emptyChild(planned.agent, planned.task, partial ? "pending" : "completed"));
	}
	return children;
}

export interface BuildViewInput {
	args: unknown;
	result?: unknown;
	isPartial: boolean;
	isError: boolean;
}

export function buildSubagentView(input: BuildViewInput): SubagentView {
	const call = describeCall(input.args);
	const details = rec(rec(input.result).details);
	const hasDetails = Object.keys(details).length > 0;
	const text = contentText(input.result);
	const runId = str(details.asyncId) ?? str(details.runId);
	const base = { name: call.name, detail: call.detail, fanout: call.kind === "parallel", failed: input.isError, runId: runId?.slice(0, 8) };

	if (call.kind === "management" || details.mode === "management") return { ...base, kind: "management", children: [], text };

	const children = childrenFromDetails(details, call, input.isPartial);
	const backgrounded = Boolean(details.asyncId || details.background) && !input.isPartial && arr(details.results).length === 0;
	if (backgrounded) {
		return { ...base, kind: "background", children: call.planned.map((planned) => emptyChild(planned.agent, planned.task, "running")), text };
	}
	if (!hasDetails || (children.length === 0 && call.kind !== "single")) return { ...base, kind: "text", children: [], text };

	const multi = call.kind !== "single" || children.length > 1 || details.mode === "parallel" || details.mode === "chain";
	if (multi) return { ...base, kind: "multi", children, failed: input.isError || children.some((child) => child.state === "failed") };

	const child = children[0] ?? emptyChild(call.name, call.planned[0]?.task, input.isPartial ? "running" : "completed");
	if (!child.output && !input.isPartial && text && child.state !== "failed") child.output = text;
	if (input.isError && child.state !== "failed") {
		child.state = "failed";
		child.error ??= oneLine(text, 200) || "Failed";
	}
	return { ...base, kind: "single", children: [child] };
}

// ---------------------------------------------------------------------------
// Tool row
// ---------------------------------------------------------------------------

export interface RowFlags {
	expanded: boolean;
	isPartial: boolean;
	isError: boolean;
	executionStarted: boolean;
	blinkOn: boolean;
	/** Configured key for app.tools.expand. */
	expandKey: string;
}

function hint(theme: CcTheme, flags: { expandKey: string }): string {
	return theme.fg("dim", `(${flags.expandKey || "ctrl+o"} to expand)`);
}

function toolLabel(tool: ToolUse): string {
	return tool.detail ? `${tool.name}(${tool.detail})` : tool.name;
}

function textLines(text: string | undefined): string[] {
	if (!text) return [];
	const lines = text.replace(/\r/g, "").split("\n");
	while (lines.length && !lines[0]!.trim()) lines.shift();
	while (lines.length && !lines.at(-1)!.trim()) lines.pop();
	return lines;
}

export function ccStatusDot(theme: CcTheme, flags: Pick<RowFlags, "isPartial" | "isError" | "executionStarted" | "blinkOn">, failed = false): string {
	if (flags.isError || (!flags.isPartial && failed)) return theme.fg("error", BLACK_CIRCLE);
	if (flags.isPartial) return flags.executionStarted && !flags.blinkOn ? " " : theme.fg("dim", BLACK_CIRCLE);
	return theme.fg("success", BLACK_CIRCLE);
}

function isTree(view: SubagentView): boolean {
	return view.kind === "multi" || (view.kind === "background" && (view.fanout || view.children.length > 1));
}

export function subagentHeaderRows(view: SubagentView, theme: CcTheme, flags: RowFlags): Row[] {
	const dot = ccStatusDot(theme, flags, view.failed);
	const tree = isTree(view);
	let tail = view.kind === "background" && tree && view.runId ? theme.fg("dim", ` · ${view.runId}`) : "";
	if (tree && !flags.expanded && view.children.length > 0) tail += ` ${hint(theme, flags)}`;
	if (view.fanout) {
		const n = view.children.length;
		let title: string;
		if (view.kind === "background") title = theme.bold(`Launched ${n} background ${n === 1 ? "agent" : "agents"}`);
		else if (flags.isPartial) title = theme.bold(`Running ${plural(n, "agent")}…`);
		else {
			const failed = view.children.filter((child) => child.state === "failed").length;
			title = `${theme.bold(`${plural(n, "agent")} finished`)}${failed ? theme.fg("error", ` (${failed} failed)`) : ""}`;
		}
		return [{ lead: `${dot} `, text: `${title}${tail}` }];
	}
	const body = view.detail ? `${theme.bold(view.name)}(${view.detail})` : theme.bold(view.name);
	return [{ lead: `${dot} `, text: `${body}${tail}` }];
}

interface Gutter {
	lead: string;
	cont: string;
	body: string;
	/** Tree branches already show stats in their title row. */
	stats: boolean;
}

const SINGLE_GUTTER: Gutter = { lead: RESULT_LEAD, cont: RESULT_INDENT, body: BODY_INDENT, stats: true };

function finalStatus(theme: CcTheme, child: ChildView, withStats: boolean): string {
	switch (child.state) {
		case "failed":
			return theme.fg("error", `Error: ${child.error ?? "failed"}`);
		case "stopped":
		case "paused":
		case "detached":
			return theme.fg("warning", child.note ?? child.state);
		case "pending":
			return theme.fg("dim", "Not started");
		default: {
			const stats = withStats ? ccStats(child) : "";
			return stats ? `Done ${theme.fg("dim", `(${stats})`)}` : "Done";
		}
	}
}

function textBlock(theme: CcTheme, gutter: Gutter, title: string, text: string | undefined): Row[] {
	const lines = textLines(text);
	if (!lines.length) return [];
	const shown = lines.slice(0, EXPANDED_TEXT_ROWS);
	const body = theme.fg("dim", gutter.body);
	const rows: Row[] = [{ lead: theme.fg("dim", gutter.lead), text: theme.bold(title) }];
	for (const line of shown) rows.push({ lead: body, cont: body, text: line, wrap: true });
	if (lines.length > shown.length) rows.push({ lead: body, text: theme.fg("dim", `… +${lines.length - shown.length} lines`) });
	return rows;
}

function toolRows(theme: CcTheme, gutter: Gutter, tools: ToolUse[]): Row[] {
	return tools.map((tool, i) => ({ lead: theme.fg("dim", i === 0 ? gutter.lead : gutter.cont), text: toolLabel(tool) }));
}

function childBody(theme: CcTheme, child: ChildView, flags: RowFlags, gutter: Gutter): Row[] {
	const lead = theme.fg("dim", gutter.lead);
	const running = child.state === "running";
	if (!flags.expanded) {
		if (child.state === "pending") return [{ lead, text: theme.fg("dim", "Waiting…") }];
		if (!running) return [{ lead, text: finalStatus(theme, child, gutter.stats) }];
		const tools = [...child.recentTools, ...(child.current ? [child.current] : [])].slice(-COLLAPSED_TOOL_ROWS);
		if (!tools.length) return [{ lead, text: theme.fg("dim", "Initializing…") }];
		const rows = toolRows(theme, gutter, tools);
		// toolCount is bumped when a tool starts, so it already counts `current`.
		const more = child.toolCount - tools.length;
		if (more > 0) rows.push({ lead: theme.fg("dim", gutter.cont), text: `${theme.fg("dim", `+${plural(more, "more tool use")}`)} ${hint(theme, flags)}` });
		return rows;
	}
	const rows: Row[] = [...textBlock(theme, gutter, "Prompt:", child.prompt)];
	const tools = child.allTools.length ? [...child.allTools] : [...child.recentTools];
	if (child.current) tools.push(child.current);
	rows.push(...toolRows(theme, gutter, tools));
	if (running) {
		const stats = ccStats(child);
		rows.push({ lead, text: theme.fg("dim", stats ? `Running… (${stats})` : "Running…") });
	} else if (child.state === "pending") {
		rows.push({ lead, text: theme.fg("dim", "Waiting…") });
	} else {
		rows.push(...textBlock(theme, gutter, "Response:", child.output));
		rows.push({ lead, text: finalStatus(theme, child, gutter.stats) });
	}
	return rows;
}

function childTitle(theme: CcTheme, child: ChildView): string {
	const name = child.state === "pending" ? theme.fg("dim", theme.bold(child.agent)) : theme.bold(child.agent);
	const desc = child.desc && child.desc !== child.agent ? ` ${theme.fg("dim", `(${child.desc})`)}` : "";
	const stats = ccStats(child, false);
	return `${name}${desc}${stats ? theme.fg("dim", ` · ${stats}`) : ""}`;
}

function treeRows(theme: CcTheme, children: ChildView[], expanded: boolean, body: (child: ChildView, gutter: Gutter) => Row[]): Row[] {
	const rows: Row[] = [];
	children.forEach((child, i) => {
		const last = i === children.length - 1;
		const pipe = last ? "      " : "   │  ";
		rows.push({ lead: theme.fg("dim", last ? "   └─ " : "   ├─ "), text: childTitle(theme, child) });
		rows.push(...body(child, { lead: `${pipe}⎿  `, cont: `${pipe}   `, body: `${pipe}     `, stats: false }));
		if (expanded && !last) rows.push({ lead: theme.fg("dim", "   │"), text: "" });
	});
	return rows;
}

function plainTextRows(theme: CcTheme, text: string | undefined, flags: RowFlags, isError: boolean): Row[] {
	const lines = textLines(text);
	if (!lines.length) return [{ lead: theme.fg("dim", RESULT_LEAD), text: theme.fg("dim", isError ? "Failed" : "(No output)") }];
	const shown = lines.slice(0, flags.expanded ? EXPANDED_TEXT_ROWS : COLLAPSED_TEXT_ROWS);
	const style = (line: string) => isError ? theme.fg("error", line) : line;
	const rows: Row[] = shown.map((line, i) => ({
		lead: theme.fg("dim", i === 0 ? RESULT_LEAD : RESULT_INDENT),
		cont: theme.fg("dim", RESULT_INDENT),
		text: style(line),
		wrap: flags.expanded,
	}));
	if (lines.length > shown.length) {
		rows.push({ lead: theme.fg("dim", RESULT_INDENT), text: `${theme.fg("dim", `… +${lines.length - shown.length} lines`)} ${hint(theme, flags)}` });
	}
	return rows;
}

export function subagentBodyRows(view: SubagentView, theme: CcTheme, flags: RowFlags): Row[] {
	switch (view.kind) {
		case "management":
		case "text":
			return plainTextRows(theme, view.text, flags, flags.isError);
		case "single":
			return view.children[0] ? childBody(theme, view.children[0], flags, SINGLE_GUTTER) : [];
		case "multi":
			return treeRows(theme, view.children, flags.expanded, (child, gutter) => childBody(theme, child, flags, gutter));
		case "background": {
			if (!isTree(view)) {
				const what = view.name === "Workflow" || view.name === "Chain" ? "workflow" : "agent";
				const rows: Row[] = [{ lead: theme.fg("dim", RESULT_LEAD), text: `Backgrounded ${what}${view.runId ? theme.fg("dim", ` · ${view.runId}`) : ""}` }];
				if (flags.expanded) {
					rows.push(...textBlock(theme, SINGLE_GUTTER, "Prompt:", view.children[0]?.prompt));
					rows.push(...plainTextRows(theme, view.text, flags, false));
				}
				return rows;
			}
			return treeRows(theme, view.children, flags.expanded, (child, gutter) => [
				...(flags.expanded ? textBlock(theme, gutter, "Prompt:", child.prompt) : []),
				{ lead: theme.fg("dim", gutter.lead), text: theme.fg("dim", "Running in background") },
			]);
		}
	}
}

// ---------------------------------------------------------------------------
// Running-dot blink (CC useBlink: 600ms on/off)
// ---------------------------------------------------------------------------

const BLINK_MS = 600;
const blinkRows = new Map<string, () => void>();
let blinkOn = true;
let blinkTimer: ReturnType<typeof setInterval> | undefined;

export function blinkPhase(): boolean {
	return blinkOn;
}

/** Keeps a running row's dot blinking until it settles or `resetBlink` runs. */
export function armBlink(id: string, invalidate: () => void): void {
	blinkRows.set(id, invalidate);
	if (blinkTimer) return;
	blinkTimer = setInterval(() => {
		blinkOn = !blinkOn;
		for (const rowInvalidate of [...blinkRows.values()]) {
			try {
				rowInvalidate();
			} catch {
				// A dead row must not stop the others.
			}
		}
	}, BLINK_MS);
	blinkTimer.unref?.();
}

export function disarmBlink(id: string): void {
	blinkRows.delete(id);
	if (blinkRows.size > 0 || !blinkTimer) return;
	clearInterval(blinkTimer);
	blinkTimer = undefined;
	blinkOn = true;
}

export function resetBlink(): void {
	blinkRows.clear();
	if (blinkTimer) clearInterval(blinkTimer);
	blinkTimer = undefined;
	blinkOn = true;
}

// ---------------------------------------------------------------------------
// Tool renderers
// ---------------------------------------------------------------------------

/** The renderer-context fields these renderers read. */
export interface CcRenderContext {
	args?: unknown;
	toolCallId?: string;
	state?: unknown;
	invalidate?: () => void;
	isPartial?: boolean;
	isError?: boolean;
	executionStarted?: boolean;
	expanded?: boolean;
	keyText?: (keybinding: string) => string;
}

interface RowState {
	ccView?: SubagentView;
}

function rowFlags(context: CcRenderContext, expanded: boolean, isPartial: boolean): RowFlags {
	let expandKey = "";
	try {
		expandKey = context.keyText?.("app.tools.expand") ?? "";
	} catch {
		expandKey = "";
	}
	return {
		expanded,
		isPartial,
		isError: context.isError === true,
		executionStarted: context.executionStarted === true,
		blinkOn: blinkPhase(),
		expandKey: expandKey || "ctrl+o",
	};
}

/**
 * Header row. It reads the view the result renderer stored, at render time, so
 * the header follows the result (agent count, background, failure) in one pass.
 */
export function renderCcSubagentCall(args: unknown, theme: CcTheme, context: CcRenderContext, note?: string): Component {
	const state = rec(context.state) as RowState;
	const running = context.isPartial !== false;
	if (context.toolCallId) {
		if (running && context.executionStarted && context.invalidate) armBlink(context.toolCallId, context.invalidate);
		else disarmBlink(context.toolCallId);
	}
	return rowsComponent(() => {
		const view = state.ccView ?? buildSubagentView({ args, isPartial: running, isError: context.isError === true });
		const rows = subagentHeaderRows(view, theme, rowFlags(context, context.expanded === true, running));
		if (note && rows[0]) rows[0] = { ...rows[0], text: `${rows[0].text}${theme.fg("dim", ` · ${note}`)}` };
		return rows;
	});
}

export function renderCcSubagentResult(result: unknown, options: { expanded: boolean; isPartial: boolean }, theme: CcTheme, context: CcRenderContext): Component {
	const view = buildSubagentView({ args: context.args, result, isPartial: options.isPartial, isError: context.isError === true });
	if (context.state && typeof context.state === "object") (context.state as RowState).ccView = view;
	const rows = subagentBodyRows(view, theme, rowFlags(context, options.expanded, options.isPartial));
	return rowsComponent(() => rows);
}

// ---------------------------------------------------------------------------
// Async widget
// ---------------------------------------------------------------------------

/** A background run (or one of its children) as the widget draws it. */
export interface WidgetEntry {
	name: string;
	desc?: string;
	state: ChildState;
	toolCount: number;
	tokens: number;
	durationMs: number;
	activity?: ToolUse;
	error?: string;
	children: WidgetEntry[];
}

function widgetDot(theme: CcTheme, state: ChildState, blink: boolean): string {
	switch (state) {
		case "running":
			return blink ? theme.fg("dim", BLACK_CIRCLE) : " ";
		case "pending":
			return theme.fg("dim", BLACK_CIRCLE);
		case "failed":
			return theme.fg("error", BLACK_CIRCLE);
		case "completed":
			return theme.fg("success", BLACK_CIRCLE);
		default:
			return theme.fg("warning", BLACK_CIRCLE);
	}
}

function widgetActivity(theme: CcTheme, entry: WidgetEntry): string {
	switch (entry.state) {
		case "running":
			return entry.activity ? toolLabel(entry.activity) : theme.fg("dim", "Thinking…");
		case "pending":
			return theme.fg("dim", "Waiting…");
		case "failed":
			return theme.fg("error", `Error: ${entry.error ?? "failed"}`);
		case "completed":
			return "Done";
		default:
			return theme.fg("warning", entry.state[0]!.toUpperCase() + entry.state.slice(1));
	}
}

function widgetTitle(theme: CcTheme, entry: WidgetEntry): string {
	const desc = entry.desc && entry.desc !== entry.name ? `(${oneLine(entry.desc, 80)})` : "";
	const stats = ccStats(entry);
	return `${theme.bold(entry.name)}${desc}${stats ? theme.fg("dim", ` · ${stats}`) : ""}`;
}

/**
 * Unfolded widget: one `⏺ name(task) · stats` row per run with its current
 * tool under `⎿`, and a `├─` tree for workflow/parallel children. Collapsed
 * (Pi's expand toggle off) shows each child on one line.
 */
export function ccWidgetLines(entries: WidgetEntry[], theme: CcTheme, expanded: boolean, blink: boolean, maxRuns: number): string[] {
	const lines: string[] = [];
	const shown = entries.slice(0, maxRuns);
	for (const entry of shown) {
		lines.push(`${widgetDot(theme, entry.state, blink)} ${widgetTitle(theme, entry)}`);
		if (!entry.children.length) {
			lines.push(`${theme.fg("dim", RESULT_LEAD)}${widgetActivity(theme, entry)}`);
			continue;
		}
		entry.children.forEach((child, i) => {
			const last = i === entry.children.length - 1;
			const branch = theme.fg("dim", last ? "   └─ " : "   ├─ ");
			if (!expanded) {
				lines.push(`${branch}${widgetDot(theme, child.state, blink)} ${theme.bold(child.name)} ${theme.fg("dim", "·")} ${widgetActivity(theme, child)}`);
				return;
			}
			lines.push(`${branch}${widgetDot(theme, child.state, blink)} ${widgetTitle(theme, child)}`);
			lines.push(`${theme.fg("dim", `${last ? "      " : "   │  "}⎿  `)}${widgetActivity(theme, child)}`);
		});
	}
	const hidden = entries.length - shown.length;
	if (hidden > 0) lines.push(theme.fg("dim", `+${plural(hidden, "more background run")}`));
	return lines;
}

/** Folded widget: a single summary row. */
export function ccWidgetFoldedLine(entries: WidgetEntry[], theme: CcTheme, blink: boolean): string {
	const running = entries.filter((entry) => entry.state === "running").length;
	const pending = entries.filter((entry) => entry.state === "pending").length;
	const failed = entries.filter((entry) => entry.state === "failed").length;
	const state: ChildState = running ? "running" : pending ? "pending" : failed ? "failed" : "completed";
	const parts = [
		running ? `${running} running` : "",
		pending ? `${pending} queued` : "",
		failed ? theme.fg("error", `${failed} failed`) : "",
		!running && !pending && !failed ? "done" : "",
	].filter(Boolean);
	return `${widgetDot(theme, state, blink)} ${theme.bold(plural(entries.length, "background agent"))} ${theme.fg("dim", "·")} ${parts.join(theme.fg("dim", " · "))}`;
}
