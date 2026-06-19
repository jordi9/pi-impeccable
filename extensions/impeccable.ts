import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

type Delivery = "steer" | "followUp";

type LiveState = {
	active: boolean;
	cwd?: string;
	skillRoot?: string;
	delivery: Delivery;
	poll?: ChildProcessWithoutNullStreams;
	pausedFor?: string;
	lastEvent?: unknown;
};

const agentReplyEvents = new Set(["generate", "steer", "manual_edit_apply"]);
const agentCommands = [
	"init", "document", "craft", "shape", "critique", "audit", "polish", "bolder", "quieter", "distill", "harden",
	"onboard", "animate", "colorize", "typeset", "layout", "delight", "overdrive", "clarify", "adapt", "optimize",
	"extract", "pin", "unpin", "hooks",
] as const;

let transientStatusTimer: ReturnType<typeof setTimeout> | undefined;

function clearTransientStatus(ctx?: ExtensionContext) {
	if (transientStatusTimer) clearTimeout(transientStatusTimer);
	transientStatusTimer = undefined;
	ctx?.ui.setStatus("impeccable-transient", undefined);
}

function showTransientStatus(ctx: ExtensionContext, text: string) {
	if (!ctx.hasUI) return;
	clearTransientStatus(ctx);
	ctx.ui.setStatus("impeccable-transient", ctx.ui.theme.fg("syntaxNumber", `✦ impeccable ${text}`));
	transientStatusTimer = setTimeout(() => {
		transientStatusTimer = undefined;
		ctx.ui.setStatus("impeccable-transient", undefined);
	}, 3500);
	transientStatusTimer.unref?.();
}

export default function impeccableExtension(pi: ExtensionAPI) {
	let ctxRef: ExtensionContext | undefined;
	const live: LiveState = { active: false, delivery: "steer" };

	pi.on("resources_discover", (event) => {
		const skillRoot = locateSkill(event.cwd);
		return skillRoot ? { skillPaths: [skillRoot] } : undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		ctxRef = ctx;
		if (live.active) startIndicator(live, ctx);
	});

	pi.on("session_shutdown", () => {
		clearTransientStatus(ctxRef);
		stopIndicator(live, ctxRef);
		killPoll(live);
		ctxRef = undefined;
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		if (!/^\s*(stop|exit)\s+(impeccable\s+)?live(\s+mode)?\s*$/i.test(event.text)) {
			return { action: "continue" };
		}
		await stopLive(pi, live, ctx);
		return { action: "handled" };
	});

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "bash") return;
		const command = String((event.input as { command?: unknown })?.command ?? "");
		if (!isForegroundLivePoll(command)) return;

		const skillRoot = locateSkill(ctx.cwd);
		if (skillRoot) {
			live.active = true;
			live.cwd = ctx.cwd;
			live.skillRoot = skillRoot;
			startPoll(pi, live, ctxRef ?? ctx);
			ctx.ui.notify("Moved Impeccable live polling to the background.", "info");
		}

		return {
			block: true,
			reason: "Impeccable live polling is managed by the pi-impeccable extension in the background. Do not run live-poll.mjs as a foreground bash tool.",
		};
	});

	pi.registerCommand("impeccable", {
		description: "Run Impeccable design commands; live mode runs in the background",
		getArgumentCompletions: (prefix) => completions(prefix),
		handler: async (args, ctx) => {
			ctxRef = ctx;
			const tokens = tokenize(args);
			const head = tokens[0] ?? "";

			if (!head || head === "help" || args.trim() === "--help") return display(pi, helpText());
			if (head === "install") return installOrUpdate(pi, live, ctx, "install");
			if (head === "update") return installOrUpdate(pi, live, ctx, "update");

			if (head === "live") {
				const sub = tokens[1] ?? "";
				if (sub === "stop") return stopLive(pi, live, ctx);
				if (sub === "status") return showLiveStatus(pi, live, ctx);
				return startLive(pi, live, ctx, tokens.slice(1));
			}
			if (head === "stop") return stopLive(pi, live, ctx);
			if (head === "status") return showLiveStatus(pi, live, ctx);

			if (!isAgentCommand(head)) return notifyOrDisplay(pi, ctx, unknownCommandText(head), "warning");
			showTransientStatus(ctx, `${head} queued`);
			const skillRoot = await ensureSkill(pi, ctx);
			if (!skillRoot) return;
			sendExtensionPrompt(pi, ctx, commandPrompt(args, skillRoot), "followUp");
		},
	});

	pi.registerTool({
		name: "impeccable_live_reply",
		label: "Impeccable Live Reply",
		description: "Reply to an Impeccable live event after handling generate, steer, or manual Apply work.",
		promptSnippet: "Reply to the current Impeccable live browser event and resume background polling.",
		promptGuidelines: [
			"Use impeccable_live_reply after handling an Impeccable live generate, steer, or manual_edit_apply event; do not reply with bash.",
		],
		parameters: Type.Object({
			id: Type.String({ description: "Live event id." }),
			status: StringEnum(["done", "partial", "steer_done", "error"] as const),
			file: Type.Optional(Type.String({ description: "Changed file path, relative to project root." })),
			message: Type.Optional(Type.String({ description: "Short browser/user-facing note or error reason." })),
			data: Type.Optional(Type.Any({ description: "Manual Apply JSON payload." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const skillRoot = live.skillRoot ?? locateSkill(ctx.cwd);
			if (!skillRoot) throw new Error("Impeccable skill is not installed. Run /impeccable install first.");
			const argv = ["--reply", params.id, params.status];
			if (params.file) argv.push("--file", params.file);
			if (params.data !== undefined) argv.push("--data", JSON.stringify(params.data));
			if (params.message) argv.push(params.message);

			const result = await runNode(script(skillRoot, "live-poll.mjs"), argv, ctx.cwd, signal, 30_000);
			if (result.code !== 0) throw new Error(result.stderr || result.stdout || "live reply failed");

			live.active = true;
			live.cwd = ctx.cwd;
			live.skillRoot = skillRoot;
			live.pausedFor = undefined;
			startPoll(pi, live, ctxRef ?? ctx);
			return { content: [{ type: "text", text: "Replied to Impeccable live and resumed polling." }], details: result };
		},
	});

	pi.registerTool({
		name: "impeccable_live_complete",
		label: "Impeccable Live Complete",
		description: "Mark Impeccable live accept/carbonize cleanup complete and resume background polling.",
		promptSnippet: "Mark Impeccable live cleanup complete after carbonize cleanup.",
		promptGuidelines: [
			"Use impeccable_live_complete after cleaning an Impeccable live carbonize accept block; do not poll again before completing it.",
		],
		parameters: Type.Object({
			id: Type.String({ description: "Live event/session id." }),
			discarded: Type.Optional(Type.Boolean({ description: "Set only for discard completion recovery." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const skillRoot = live.skillRoot ?? locateSkill(ctx.cwd);
			if (!skillRoot) throw new Error("Impeccable skill is not installed. Run /impeccable install first.");
			const argv = ["--id", params.id];
			if (params.discarded) argv.push("--discarded");
			const result = await runNode(script(skillRoot, "live-complete.mjs"), argv, ctx.cwd, signal, 30_000);
			if (result.code !== 0) throw new Error(result.stderr || result.stdout || "live complete failed");

			live.active = true;
			live.cwd = ctx.cwd;
			live.skillRoot = skillRoot;
			live.pausedFor = undefined;
			startPoll(pi, live, ctxRef ?? ctx);
			return { content: [{ type: "text", text: "Completed Impeccable live cleanup and resumed polling." }], details: result };
		},
	});
}

async function startLive(pi: ExtensionAPI, live: LiveState, ctx: ExtensionContext, tokens: string[]) {
	if (live.poll) return ctx.ui.notify("Impeccable live is already polling.", "info");
	showTransientStatus(ctx, "live starting");

	const skillRoot = await ensureSkill(pi, ctx);
	if (!skillRoot) return;

	live.delivery = readDelivery(tokens) ?? "steer";
	live.cwd = ctx.cwd;
	live.skillRoot = skillRoot;
	const boot = await runNode(script(skillRoot, "live.mjs"), [], ctx.cwd, undefined, 25_000);
	if (boot.code !== 0) return display(pi, `Impeccable live failed:\n\n${boot.stderr || boot.stdout}`);

	const parsed = parseJson(boot.stdout);
	if (!parsed?.ok) {
		display(pi, `Impeccable live needs setup:\n\n${JSON.stringify(parsed ?? boot.stdout, null, 2)}`);
		showTransientStatus(ctx, "live setup queued");
		sendExtensionPrompt(pi, ctx, commandPrompt("live", skillRoot), "followUp");
		return;
	}

	live.active = true;
	live.pausedFor = undefined;
	clearTransientStatus(ctx);
	startIndicator(live, ctx);
	ctx.ui.notify("Impeccable live started. Say stop live or /impeccable stop to stop.", "info");
	startPoll(pi, live, ctx);
}

async function stopLive(pi: ExtensionAPI, live: LiveState, ctx: ExtensionContext) {
	showTransientStatus(ctx, "live stopping");
	killPoll(live);
	live.active = false;
	live.pausedFor = undefined;
	const skillRoot = live.skillRoot ?? locateSkill(ctx.cwd);
	if (!skillRoot) {
		stopIndicator(live, ctx);
		return notifyOrDisplay(pi, ctx, "Impeccable skill is not installed.", "warning");
	}
	const stopped = await runNode(script(skillRoot, "live-server.mjs"), ["stop"], ctx.cwd, undefined, 30_000);
	clearTransientStatus(ctx);
	stopIndicator(live, ctx);
	if (stopped.code === 0) {
		notifyOrDisplay(pi, ctx, "Impeccable live stopped.", "info");
	} else {
		display(pi, `Impeccable stop failed:\n\n${stopped.stderr || stopped.stdout}`);
	}
}

async function showLiveStatus(pi: ExtensionAPI, live: LiveState, ctx: ExtensionContext) {
	const skillRoot = locateSkill(ctx.cwd);
	if (!skillRoot) return notifyOrDisplay(pi, ctx, "Impeccable skill is not installed. Run /impeccable install.", "warning");
	const status = await runNode(script(skillRoot, "live-status.mjs"), [], ctx.cwd, undefined, 15_000);
	const output = status.stdout.trim() || status.stderr.trim();
	const message = status.code === 0 ? summarizeLiveStatus(output) : output || "No Impeccable live status.";
	notifyOrDisplay(pi, ctx, message, status.code === 0 ? "info" : "warning");
	if (live.active) renderIndicator(live, ctx);
}

async function installOrUpdate(pi: ExtensionAPI, live: LiveState, ctx: ExtensionContext, action: "install" | "update") {
	showTransientStatus(ctx, `${action} started`);
	const args = action === "install"
		? ["install", "--providers=codex", "--scope=project", "-y", "--no-hooks"]
		: ["update", "-y", "--no-hooks"];
	const result = await runImpeccable(args, ctx.cwd, undefined, 120_000);
	clearTransientStatus(ctx);
	if (live.active) renderIndicator(live, ctx);
	else stopIndicator(live, ctx);
	if (result.code !== 0) return notifyOrDisplay(pi, ctx, result.stderr || result.stdout || `impeccable ${action} failed`, "error");
	notifyOrDisplay(pi, ctx, `Impeccable ${action} complete.`, "info");
}

async function ensureSkill(pi: ExtensionAPI, ctx: ExtensionContext) {
	const existing = locateSkill(ctx.cwd);
	if (existing) return existing;
	display(pi, "Impeccable is not installed for this project. Installing latest .agents skill now...");
	const result = await runImpeccable(["install", "--providers=codex", "--scope=project", "-y", "--no-hooks"], ctx.cwd, undefined, 120_000);
	if (result.code !== 0) {
		display(pi, `Impeccable install failed:\n\n${result.stderr || result.stdout}`);
		return null;
	}
	const installed = locateSkill(ctx.cwd);
	if (!installed) {
		display(pi, `Impeccable install ran, but .agents/skills/impeccable was not found. Output:\n\n${result.stdout}`);
		return null;
	}
	return installed;
}

function startPoll(pi: ExtensionAPI, live: LiveState, ctx: ExtensionContext) {
	if (!live.active || !live.skillRoot) return;
	startIndicator(live, ctx);
	if (live.poll) return;
	const cwd = live.cwd ?? ctx.cwd;
	const child = spawn(process.execPath, [script(live.skillRoot, "live-poll.mjs")], { cwd, stdio: ["ignore", "pipe", "pipe"] });
	live.poll = child;
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => (stdout += String(chunk)));
	child.stderr.on("data", (chunk) => (stderr += String(chunk)));
	child.on("close", (code) => {
		if (live.poll === child) live.poll = undefined;
		if (!live.active) return;
		if (code !== 0) {
			live.pausedFor = "poll-error";
			renderIndicator(live, ctx);
			display(pi, `Impeccable live poll failed:\n\n${stderr || stdout}`);
			ctx.ui.notify("Impeccable live poll failed; run /impeccable live to resume.", "warning");
			return;
		}
		const event = parseJson(stdout);
		if (!event) {
			live.pausedFor = "parse-error";
			renderIndicator(live, ctx);
			display(pi, `Could not parse Impeccable live event:\n\n${stdout}\n${stderr}`);
			return;
		}
		handleLiveEvent(pi, live, ctx, event, stderr);
	});
}

function handleLiveEvent(pi: ExtensionAPI, live: LiveState, ctx: ExtensionContext, event: any, stderr: string) {
	live.lastEvent = event;
	if (event.type === "timeout") return startPoll(pi, live, ctx);
	if (event.type === "exit") {
		live.active = false;
		stopIndicator(live, ctx);
		ctx.ui.notify("Impeccable live exited.", "info");
		return;
	}
	if (event.type === "prefetch") return startPoll(pi, live, ctx);

	const needsAgent = agentReplyEvents.has(event.type) || event?._acceptResult?.carbonize === true || event?._completionAck?.ok === false;
	if (!needsAgent) {
		ctx.ui.notify(`Impeccable live: ${event.type}`, "info");
		return startPoll(pi, live, ctx);
	}

	live.pausedFor = event.id ?? event.type;
	sendLiveEvent(pi, ctx, liveEventPrompt(event, stderr, live.skillRoot!), event, live.delivery);
}

function liveEventPrompt(event: any, stderr: string, skillRoot: string) {
	const isCarbonize = event?._acceptResult?.carbonize === true || event?._completionAck?.ok === false;
	const next = isCarbonize
		? `After cleanup, call impeccable_live_complete with id ${JSON.stringify(event.id)}. Do not poll manually.`
		: `After handling the event, call impeccable_live_reply with id ${JSON.stringify(event.id)} and the correct status. Do not reply with bash.`;
	return [
		"Impeccable live event arrived from the background poll.",
		pathContract(skillRoot),
		`Read the live reference if it is not already loaded: ${join(skillRoot, "reference", "live.md")}`,
		stderr.trim() ? `Poll stderr:\n${stderr.trim()}` : "",
		"Event JSON:",
		"```json\n" + JSON.stringify(event, null, 2) + "\n```",
		next,
	].filter(Boolean).join("\n\n");
}

function commandPrompt(args: string, skillRoot: string) {
	return [
		`Handle this Impeccable invocation in Pi: /impeccable ${args.trim()}`,
		pathContract(skillRoot),
		`Start by reading ${join(skillRoot, "SKILL.md")}.`,
		"If a sub-command is invoked, read the matching reference file from that skill root before acting.",
	].join("\n\n");
}

function pathContract(skillRoot: string) {
	return [
		"Use the Impeccable files installed by the upstream Impeccable package, not vendored extension files.",
		`Skill root: ${skillRoot}`,
		`Scripts: ${join(skillRoot, "scripts")}`,
		"Whenever Impeccable docs mention `node .agents/skills/impeccable/scripts/...`, run the matching script from `Scripts` instead.",
	].join("\n");
}

function locateSkill(cwd: string) {
	const root = projectRoot(cwd);
	const candidates = [
		join(root, ".agents", "skills", "impeccable"),
		join(cwd, ".agents", "skills", "impeccable"),
		join(homedir(), ".agents", "skills", "impeccable"),
	];
	return candidates.find((dir) => existsSync(join(dir, "SKILL.md")) && existsSync(join(dir, "scripts")));
}

function projectRoot(cwd: string) {
	let dir = resolve(cwd);
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, ".git"))) return dir;
		dir = dirname(dir);
	}
	return resolve(cwd);
}

function script(skillRoot: string, name: string) {
	return join(skillRoot, "scripts", name);
}

function resolveImpeccableCli() {
	try {
		let current = dirname(require.resolve("impeccable"));
		while (current !== dirname(current)) {
			const candidate = join(current, "package.json");
			if (existsSync(candidate)) {
				const cli = join(current, "cli", "bin", "cli.js");
				if (existsSync(cli)) return cli;
			}
			current = dirname(current);
		}
	} catch { /* dependency absent in local dev; use npx */ }
	return null;
}

function runImpeccable(args: string[], cwd: string, signal?: AbortSignal, timeoutMs = 120_000) {
	const cli = resolveImpeccableCli();
	return cli
		? runProcess(process.execPath, [cli, ...args], cwd, signal, timeoutMs)
		: runProcess("npx", ["-y", "impeccable@latest", ...args], cwd, signal, timeoutMs);
}

function sendExtensionPrompt(pi: ExtensionAPI, ctx: ExtensionContext | undefined, text: string, delivery: Delivery) {
	const options = ctx?.isIdle() ? { triggerTurn: true } : { triggerTurn: true, deliverAs: delivery };
	pi.sendMessage({ customType: "impeccable-command", content: text, display: false }, options);
}

function sendLiveEvent(pi: ExtensionAPI, ctx: ExtensionContext | undefined, text: string, event: any, delivery: Delivery) {
	ctx?.ui.notify(`Impeccable live: ${event.type}${event.action ? ` ${event.action}` : ""}`, "info");
	const options = ctx?.isIdle() ? { triggerTurn: true } : { triggerTurn: true, deliverAs: delivery };
	pi.sendMessage({ customType: "impeccable-live", content: text, display: false }, options);
}

function notifyOrDisplay(pi: ExtensionAPI, ctx: ExtensionContext, content: string, type: "info" | "warning" | "error" = "info") {
	if (ctx.hasUI) ctx.ui.notify(content, type);
	else display(pi, content);
}

function display(pi: ExtensionAPI, content: string) {
	pi.sendMessage({ customType: "impeccable", content, display: true });
}

function killPoll(live: LiveState) {
	if (!live.poll) return;
	live.poll.kill("SIGTERM");
	live.poll = undefined;
}

function startIndicator(live: LiveState, ctx: ExtensionContext) {
	renderIndicator(live, ctx);
}

function stopIndicator(_live: LiveState, ctx?: ExtensionContext) {
	ctx?.ui.setStatus("impeccable", undefined);
}

function renderIndicator(live: LiveState, ctx: ExtensionContext) {
	if (!ctx.hasUI) return;
	if (!live.active) return stopIndicator(live, ctx);
	const label = (state: "live" | "event" | "error") => {
		const color = state === "live" ? "syntaxNumber" : state === "event" ? "warning" : "error";
		return ctx.ui.theme.fg(color, `✦ impeccable ${state}`);
	};
	if (live.pausedFor === "poll-error" || live.pausedFor === "parse-error") {
		ctx.ui.setStatus("impeccable", label("error"));
		return;
	}
	if (live.pausedFor) {
		ctx.ui.setStatus("impeccable", label("event"));
		return;
	}
	ctx.ui.setStatus("impeccable", label("live"));
}

function isForegroundLivePoll(command: string) {
	if (command.includes("--reply")) return false;
	return /live-poll\.mjs\b/.test(command) || /\b(?:npx\s+[^\n;]*\s+)?impeccable\s+poll\b/.test(command);
}

function readDelivery(tokens: string[]): Delivery | undefined {
	const value = option(tokens, "delivery");
	if (value === "followUp" || value === "followup") return "followUp";
	if (value === "steer") return "steer";
	if (tokens.includes("--follow-up")) return "followUp";
	return undefined;
}

function option(tokens: string[], name: string) {
	const prefix = `--${name}=`;
	const inline = tokens.find((token) => token.startsWith(prefix));
	if (inline) return inline.slice(prefix.length);
	const idx = tokens.indexOf(`--${name}`);
	return idx >= 0 ? tokens[idx + 1] : undefined;
}

function tokenize(input: string) {
	return (input.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) => token.replace(/^("|')(.*)\1$/, "$2"));
}

export function summarizeLiveStatus(output: string) {
	const status = parseJson(output);
	if (!status || typeof status !== "object") return output || "No Impeccable live status.";
	const liveServer = (status as { liveServer?: unknown }).liveServer;
	const sessions = Array.isArray((status as { activeSessions?: unknown }).activeSessions)
		? (status as { activeSessions: Array<{ phase?: unknown; pageUrl?: unknown; sourceFile?: unknown }> }).activeSessions
		: [];
	const server = liveServer ? "server running" : "server stopped";
	if (sessions.length === 0) return `Impeccable live: ${server} · no active sessions`;
	const first = sessions[0];
	const phase = typeof first?.phase === "string" ? first.phase.replace(/_/g, " ") : "active";
	const target = typeof first?.sourceFile === "string" ? first.sourceFile : typeof first?.pageUrl === "string" ? first.pageUrl : "session";
	const more = sessions.length > 1 ? ` · +${sessions.length - 1} more` : "";
	return `Impeccable live: ${server} · ${phase} · ${target}${more}`;
}

function parseJson(output: string) {
	const text = output.trim();
	if (!text) return null;
	try { return JSON.parse(text); } catch { /* try extracting a JSON object below */ }
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start !== -1 && end > start) {
		try { return JSON.parse(text.slice(start, end + 1)); } catch { /* not a JSON object */ }
	}
	const lines = text.split(/\r?\n/).filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i--) {
		try { return JSON.parse(lines[i]); } catch { /* try previous line */ }
	}
	return null;
}

function runNode(scriptPath: string, args: string[], cwd: string, signal?: AbortSignal, timeoutMs = 30_000) {
	return runProcess(process.execPath, [scriptPath, ...args], cwd, signal, timeoutMs);
}

function runProcess(command: string, args: string[], cwd: string, signal?: AbortSignal, timeoutMs = 30_000) {
	return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolvePromise) => {
		const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
		const abort = () => child.kill("SIGTERM");
		signal?.addEventListener("abort", abort, { once: true });
		child.stdout.on("data", (chunk) => (stdout += String(chunk)));
		child.stderr.on("data", (chunk) => (stderr += String(chunk)));
		child.on("error", (error) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			resolvePromise({ stdout, stderr: stderr || error.message, code: 1 });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			resolvePromise({ stdout, stderr, code });
		});
	});
}

function isAgentCommand(command: string) {
	return (agentCommands as readonly string[]).includes(command);
}

function completions(prefix: string) {
	const trimmedStart = prefix.trimStart();
	if (/\s/.test(trimmedStart)) return null;
	const commands = ["live", "status", "stop", "install", "update", ...agentCommands];
	const matches = commands.filter((command) => command.startsWith(trimmedStart));
	return matches.length ? matches.map((value) => ({ value, label: value })) : null;
}

function unknownCommandText(command: string) {
	return `Unknown Impeccable command: ${command}. Try /impeccable live.`;
}

function helpText() {
	return `Usage:
/impeccable <command> [target]
/impeccable install
/impeccable update
/impeccable live [--delivery=steer|followUp]
/impeccable live status
/impeccable live stop

This extension does not vendor Impeccable. It uses the upstream impeccable package to install/update .agents/skills/impeccable in your project, then wraps live mode so the poller runs in the background.`;
}
