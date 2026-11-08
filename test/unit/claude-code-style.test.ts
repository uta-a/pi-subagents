import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
	buildSubagentView,
	ccDuration,
	ccTokens,
	ccWidgetFoldedLine,
	ccWidgetLines,
	describeCall,
	renderCcSubagentCall,
	renderCcSubagentResult,
	renderRows,
	resetBlink,
	resolveDisplayStyle,
	subagentBodyRows,
	subagentHeaderRows,
	type RowFlags,
	type WidgetEntry,
} from "../../src/tui/claude-code-style.ts";
import { renderSubagentMessage } from "../../src/tui/subagent-messages.ts";
import { renderWidget } from "../../src/tui/render.ts";
import type { AsyncJobState } from "../../src/shared/types.ts";

// Message bodies read Pi's markdown theme.
initTheme("dark");

const plainTheme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text };
const ansiTheme = { fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`, bg: (_color: string, text: string) => text, bold: (text: string) => `\x1b[1m${text}\x1b[22m` };
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const usage = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 });

function flags(over: Partial<RowFlags> = {}): RowFlags {
	return { expanded: false, isPartial: false, isError: false, executionStarted: true, blinkOn: true, expandKey: "ctrl+o", ...over };
}

interface Fixture {
	args: unknown;
	result?: unknown;
	isPartial: boolean;
	isError?: boolean;
}

const singleTask = "Find where the auth handlers are registered";

const fixtures: Record<string, Fixture> = {
	starting: { args: { agent: "scout", task: singleTask }, isPartial: true, result: { content: [], details: { mode: "single", results: [] } } },
	running: {
		args: { agent: "scout", task: singleTask },
		isPartial: true,
		result: {
			content: [],
			details: {
				mode: "single",
				results: [{
					index: 0, agent: "scout", task: singleTask, exitCode: 0, usage: usage(0, 0),
					progress: {
						index: 0, agent: "scout", status: "running", task: singleTask,
						currentTool: "grep", currentToolArgs: 'pattern: "registerAuth"',
						recentTools: [{ tool: "read", args: "src/server.ts", endMs: 1 }, { tool: "bash", args: "rg -n auth src", endMs: 2 }, { tool: "read", args: "src/auth/index.ts", endMs: 3 }],
						recentOutput: [], toolCount: 8, tokens: 12_345, durationMs: 23_000,
					},
				}],
			},
		},
	},
	done: {
		args: { agent: "scout", task: singleTask },
		isPartial: false,
		result: {
			content: [{ type: "text", text: "summary" }],
			details: {
				mode: "single",
				results: [{
					index: 0, agent: "scout", task: singleTask, exitCode: 0, usage: usage(30_000, 4_500),
					finalOutput: "## Summary\nHandlers live in `src/auth/index.ts`.",
					messages: [
						{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "src/server.ts" } }] },
						{ role: "assistant", content: [{ type: "toolCall", name: "grep", arguments: { pattern: "registerAuth", path: "src" } }] },
					],
					progressSummary: { toolCount: 12, tokens: 34_500, durationMs: 63_000 },
				}],
			},
		},
	},
	failed: {
		args: { agent: "worker", task: "Fix the failing test" },
		isPartial: false,
		isError: true,
		result: {
			content: [{ type: "text", text: "worker failed" }],
			details: { mode: "single", results: [{ index: 0, agent: "worker", task: "Fix the failing test", exitCode: 1, error: "model quota exceeded", usage: usage(1, 1) }] },
		},
	},
	parallelRunning: {
		args: { workflow: "parallel", args: { tasks: [{ agent: "scout", task: "Map the repository layout" }, { agent: "researcher", task: "Find TUI docs" }, { agent: "worker", task: "Fix the flaky test" }] } },
		isPartial: true,
		result: {
			content: [],
			details: {
				mode: "workflow",
				results: [{ index: 0, workflowKey: "task-1", agent: "scout", task: "Map the repository layout", exitCode: 0, usage: usage(1, 1), progressSummary: { status: "completed", toolCount: 5, tokens: 9_000, durationMs: 21_000 } }],
				workflowChildren: {
					version: 1, parentToolCallId: "call", workflowRunId: "wf", inventoryComplete: false, workflowState: "running",
					children: [
						{ childId: "task-1", agent: "scout", state: "completed" },
						{ childId: "task-2", agent: "researcher", state: "running", activity: { currentTool: "web_search", toolCount: 3, tokens: 4_200 } },
						{ childId: "task-3", agent: "worker", state: "pending" },
					],
				},
			},
		},
	},
	parallelDone: {
		args: { workflow: "parallel", args: { tasks: [{ agent: "scout", task: "Map" }, { agent: "worker", task: "Fix" }] } },
		isPartial: false,
		result: {
			content: [{ type: "text", text: "ok" }],
			details: {
				mode: "workflow",
				results: [
					{ index: 0, workflowKey: "task-1", agent: "scout", task: "Map", exitCode: 0, usage: usage(1, 1), finalOutput: "Layout", progressSummary: { toolCount: 5, tokens: 9_000, durationMs: 21_000 } },
					{ index: 1, workflowKey: "task-2", agent: "worker", task: "Fix", exitCode: 1, error: "tests still failing", usage: usage(1, 1), progressSummary: { toolCount: 14, tokens: 23_000, durationMs: 95_000 } },
				],
			},
		},
	},
	asyncSingle: {
		args: { agent: "worker", task: "Refactor the config loader", async: true },
		isPartial: false,
		result: { content: [{ type: "text", text: "Async: worker [191e55a3-258d-45b0]\n\nDetached." }], details: { mode: "single", asyncId: "191e55a3-258d-45b0", results: [] } },
	},
	asyncParallel: {
		args: { workflow: "parallel", async: true, args: { tasks: [{ agent: "delegate", task: "Say hello" }, { agent: "scout", task: "Read settings" }] } },
		isPartial: false,
		result: { content: [{ type: "text", text: "Async workflow" }], details: { mode: "workflow", asyncId: "a3edc011-731d", results: [] } },
	},
	status: {
		args: { action: "status", id: "191e55a3-258d-45b0" },
		isPartial: false,
		result: { content: [{ type: "text", text: "Status target: run 191e55a3\nSpawn budget: unlimited\nState: complete\nProcess terminal: observed\nOutput: /tmp/out.md" }], details: { mode: "single", results: [] } },
	},
};

function draw(name: string, expanded = false, width = 100, theme = plainTheme): string[] {
	const fixture = fixtures[name]!;
	const view = buildSubagentView({ args: fixture.args, result: fixture.result, isPartial: fixture.isPartial, isError: fixture.isError ?? false });
	const rowFlags = flags({ expanded, isPartial: fixture.isPartial, isError: fixture.isError ?? false });
	return renderRows([...subagentHeaderRows(view, theme, rowFlags), ...subagentBodyRows(view, theme, rowFlags)], width);
}

describe("claude-code display style", () => {
	it("defaults to claude-code", () => {
		assert.equal(resolveDisplayStyle(undefined), "claude-code");
		assert.equal(resolveDisplayStyle("classic"), "classic");
	});

	it("keeps every tool row line inside the width, including CJK text", () => {
		const cjk: Fixture = { args: { agent: "scout", task: "認証ハンドラーがどこで登録されているかを調べて、流れを要約してください" }, isPartial: true };
		fixtures.cjk = cjk;
		for (const name of Object.keys(fixtures)) {
			for (const expanded of [false, true]) {
				for (const width of [30, 60, 120]) {
					for (const line of draw(name, expanded, width, ansiTheme)) assert.ok(visibleWidth(line) <= width, `${name} @${width}: ${strip(line)}`);
				}
			}
		}
		delete fixtures.cjk;
	});

	it("shows a running child's tool tail and the remaining tool uses", () => {
		assert.deepEqual(draw("starting"), ["⏺ scout(Find where the auth handlers are registered)", "  ⎿  Initializing…"]);
		assert.deepEqual(draw("running"), [
			"⏺ scout(Find where the auth handlers are registered)",
			"  ⎿  Bash(rg -n auth src)",
			"     Read(src/auth/index.ts)",
			'     Search(pattern: "registerAuth")',
			"     +5 more tool uses (ctrl+o to expand)",
		]);
	});

	it("collapses a finished child to a Done stat row and expands to prompt, tools, and response", () => {
		assert.deepEqual(draw("done"), ["⏺ scout(Find where the auth handlers are registered)", "  ⎿  Done (12 tool uses · 34.5k tokens · 1m 3s)"]);
		const expanded = draw("done", true).join("\n");
		assert.match(expanded, /⎿ {2}Prompt:\n {7}Find where/);
		assert.match(expanded, /⎿ {2}Read\(src\/server\.ts\)\n {5}Search\(pattern: "registerAuth", path: "src"\)/);
		assert.match(expanded, /⎿ {2}Response:\n {7}## Summary/);
	});

	it("shows failures as error rows", () => {
		assert.deepEqual(draw("failed"), ["⏺ worker(Fix the failing test)", "  ⎿  Error: model quota exceeded"]);
		assert.equal(draw("parallelDone")[0], "⏺ 2 agents finished (1 failed) (ctrl+o to expand)");
		assert.match(draw("parallelDone").join("\n"), /└─ worker \(Fix\) · 14 tool uses · 23\.0k tokens\n {6}⎿ {2}Error: tests still failing/);
	});

	it("draws a parallel fan-out as an agent tree with planned tasks", () => {
		assert.deepEqual(draw("parallelRunning"), [
			"⏺ Running 3 agents… (ctrl+o to expand)",
			"   ├─ scout (Map the repository layout) · 5 tool uses · 9.0k tokens",
			"   │  ⎿  Done",
			"   ├─ researcher (Find TUI docs) · 3 tool uses · 4.2k tokens",
			"   │  ⎿  Web Search",
			"   │     +2 more tool uses (ctrl+o to expand)",
			"   └─ worker (Fix the flaky test)",
			"      ⎿  Waiting…",
		]);
	});

	it("shows background launches and management actions", () => {
		assert.deepEqual(draw("asyncSingle"), ["⏺ worker(Refactor the config loader)", "  ⎿  Backgrounded agent · 191e55a3"]);
		const multi = draw("asyncParallel");
		assert.equal(multi[0], "⏺ Launched 2 background agents · a3edc011 (ctrl+o to expand)");
		assert.equal(multi.filter((line) => line.endsWith("⎿  Running in background")).length, 2);
		const status = draw("status");
		assert.equal(status[0], "⏺ Subagent(status 191e55a3)");
		assert.equal(status.at(-1), "     … +2 lines (ctrl+o to expand)");
		assert.equal(draw("status", true).length, 6);
	});

	it("describes chain and workflow calls", () => {
		assert.equal(describeCall({ chain: [{ agent: "a", task: "x" }, { parallel: [{ agent: "b" }, { agent: "c" }] }] }).detail, "a → [b, c]");
		assert.equal(describeCall({ workflow: true }).detail, "script");
		assert.equal(describeCall({ tasks: [{ agent: "a" }] }).kind, "parallel");
		assert.equal(describeCall({}).name, "Agent");
	});

	it("tolerates partial args and results without details", () => {
		for (const args of [undefined, null, {}, { agent: "x" }, { workflow: "parallel" }, { chain: "bad" }]) {
			const view = buildSubagentView({ args, isPartial: true, isError: false });
			renderRows([...subagentHeaderRows(view, plainTheme, flags({ isPartial: true })), ...subagentBodyRows(view, plainTheme, flags({ isPartial: true }))], 60);
		}
		const error = buildSubagentView({ args: { agent: "x", task: "y" }, result: { content: [{ type: "text", text: "boom" }] }, isPartial: false, isError: true });
		assert.match(renderRows(subagentBodyRows(error, plainTheme, flags({ isError: true })), 60).join("\n"), /boom/);
	});

	it("lets the header follow the stored result view and blinks while running", () => {
		const state = {};
		let invalidations = 0;
		const context = { state, toolCallId: "blink", isPartial: true, executionStarted: true, invalidate: () => { invalidations++; } };
		const header = renderCcSubagentCall(fixtures.parallelRunning!.args, plainTheme, context);
		renderCcSubagentResult(fixtures.parallelRunning!.result, { expanded: false, isPartial: true }, plainTheme, { ...context, args: fixtures.parallelRunning!.args });
		assert.equal(header.render(100)[0], "⏺ Running 3 agents… (ctrl+o to expand)");
		resetBlink();
		assert.equal(invalidations, 0);
	});

	it("formats tokens and durations like Claude Code", () => {
		assert.equal(ccTokens(950), "950");
		assert.equal(ccTokens(34_500), "34.5k");
		assert.equal(ccTokens(1_250_000), "1.3M");
		assert.equal(ccDuration(9_400), "9s");
		assert.equal(ccDuration(63_000), "1m 3s");
		assert.equal(ccDuration(3_720_000), "1h 2m");
	});
});

describe("claude-code chat notices", () => {
	const notice = { customType: "subagent-notify", content: "Background task completed: **scout**\n\nFound the handlers.", details: { runs: [{ agent: "scout", status: "completed" }] } };

	it("draws a dot headline row without the classic [subagent] block", () => {
		const lines = renderSubagentMessage(notice, { expanded: false }, plainTheme as never, "claude-code")!.render(80).map((line) => line.trimEnd());
		assert.deepEqual(lines, ["", "⏺ scout completed (click to expand)"]);
	});

	it("puts the expanded body under ⎿", () => {
		const lines = renderSubagentMessage(notice, { expanded: true }, plainTheme as never, "claude-code")!.render(80).map((line) => strip(line).trimEnd());
		assert.equal(lines[1], "⏺ scout completed");
		assert.match(lines[2]!, /^ {2}⎿ {2}Background task completed: scout/);
		assert.ok(lines.slice(3).every((line) => line === "" || line.startsWith("     ")));
	});

	it("keeps the classic block when asked", () => {
		const lines = renderSubagentMessage(notice, { expanded: false }, plainTheme as never)!.render(80).map((line) => line.trimEnd());
		assert.ok(lines.some((line) => line.startsWith(" [subagent] scout completed")));
	});
});

describe("claude-code async widget", () => {
	const entries: WidgetEntry[] = [
		{ name: "scout", desc: "Find auth", state: "running", toolCount: 3, tokens: 12_100, durationMs: 41_000, activity: { name: "Read", detail: "src/a.ts" }, children: [] },
		{
			name: "Workflow", state: "running", toolCount: 0, tokens: 0, durationMs: 0, children: [
				{ name: "worker", state: "completed", toolCount: 2, tokens: 0, durationMs: 0, children: [] },
				{ name: "reviewer", state: "pending", toolCount: 0, tokens: 0, durationMs: 0, children: [] },
			],
		},
	];

	it("draws one row per run with its current tool, and child trees", () => {
		assert.deepEqual(ccWidgetLines(entries, plainTheme, false, true, 4), [
			"⏺ scout(Find auth) · 3 tool uses · 12.1k tokens · 41s",
			"  ⎿  Read(src/a.ts)",
			"⏺ Workflow",
			"   ├─ ⏺ worker · Done",
			"   └─ ⏺ reviewer · Waiting…",
		]);
		assert.equal(ccWidgetLines(entries, plainTheme, false, true, 1).at(-1), "+1 more background run");
	});

	it("folds to one summary row", () => {
		assert.equal(ccWidgetFoldedLine(entries, plainTheme, true), "⏺ 2 background agents · 2 running");
	});

	it("mounts below the editor unless placed above", () => {
		const placements: unknown[] = [];
		const ctx = { hasUI: true, mode: "tui", ui: { getToolsExpanded: () => false, setWidget: (_key: string, factory: unknown, options?: { placement?: string }) => { if (factory) placements.push(options?.placement); } } };
		const jobs: AsyncJobState[] = [{ asyncId: "run-p", asyncDir: "/tmp/run-p", status: "running", mode: "single", agents: ["scout"] }];
		renderWidget(ctx as never, []);
		renderWidget(ctx as never, jobs, false, "adaptive", "claude-code");
		renderWidget(ctx as never, []);
		renderWidget(ctx as never, jobs, false, "adaptive", "claude-code", "aboveEditor");
		renderWidget(ctx as never, []);
		assert.deepEqual(placements, ["belowEditor", "aboveEditor"]);
	});

	it("mounts through renderWidget in the claude-code style", () => {
		let widget: { render(width: number): string[] } | undefined;
		const ctx = {
			hasUI: true, mode: "tui",
			ui: { getToolsExpanded: () => false, setWidget: (_key: string, factory: ((tui: unknown, theme: unknown) => typeof widget) | undefined) => { widget = factory?.({ requestRender() {} }, plainTheme); } },
		};
		const jobs: AsyncJobState[] = [{ asyncId: "run-1", asyncDir: "/tmp/run-1", status: "running", mode: "single", agents: ["scout"], description: "Find auth", currentTool: "read", currentPath: "/tmp/a.ts", toolCount: 2 }];
		renderWidget(ctx as never, []);
		renderWidget(ctx as never, jobs, false, "adaptive", "claude-code");
		const lines = widget!.render(100).map((line) => line.trim());
		assert.match(lines[0]!, /^(⏺ )?scout\(Find auth\) · 2 tool uses/);
		assert.match(lines[1]!, /^⎿ {2}Read\(/);
		renderWidget(ctx as never, []);
	});
});
