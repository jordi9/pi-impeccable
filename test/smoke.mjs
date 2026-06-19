import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import impeccableExtension, { parseCommandDescriptions, summarizeLiveStatus } from '../extensions/impeccable.ts';

const root = path.resolve(import.meta.dirname, '..');

function loadExtension() {
	const handlers = new Map();
	const commands = new Map();
	const tools = new Map();
	const messages = [];
	const pi = {
		on(name, handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerCommand(name, command) { commands.set(name, command); },
		registerTool(tool) { tools.set(tool.name, tool); },
		sendMessage(message, options) { messages.push({ message, options }); },
	};
	impeccableExtension(pi);
	return {
		handlers,
		commands,
		tools,
		messages,
		async emit(name, event = {}, ctx = makeContext(root)) {
			let result;
			for (const handler of handlers.get(name) ?? []) {
				const value = await handler(event, ctx);
				if (value !== undefined) result = value;
			}
			return result;
		},
	};
}

function makeContext(cwd, { idle = true, hasUI = true } = {}) {
	const notifications = [];
	const statuses = [];
	const ui = {
		notifications,
		statuses,
		theme: { fg: (_color, text) => text },
		notify(message, type) { notifications.push({ message, type }); },
		setStatus(key, value) { statuses.push({ key, value }); },
	};
	return { cwd, hasUI, ui, isIdle: () => idle, signal: undefined };
}

function makeProject(t, scripts = {}) {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-impeccable-'));
	const skillRoot = path.join(project, '.agents', 'skills', 'impeccable');
	fs.mkdirSync(path.join(project, '.git'));
	fs.mkdirSync(path.join(skillRoot, 'scripts'), { recursive: true });
	fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# fake impeccable\n');
	for (const [name, source] of Object.entries(scripts)) {
		fs.writeFileSync(path.join(skillRoot, 'scripts', name), source);
	}
	t.after(() => fs.rmSync(project, { recursive: true, force: true }));
	return { project, skillRoot };
}

async function waitFor(predicate, message, timeoutMs = 1_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await delay(10);
	}
	assert.fail(message);
}

test('package exposes the pi extension without vendoring Impeccable', () => {
	const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
	assert.deepEqual(pkg.pi.extensions, ['./extensions/impeccable.ts']);
	assert.equal(pkg.dependencies.impeccable, '*');
	assert.equal(fs.existsSync(path.join(root, 'vendor')), false);
});

test('loads through pi --extension and handles /impeccable help', () => {
	const pi = path.join(root, 'node_modules', '.bin', 'pi');
	const result = spawnSync(pi, [
		'-p',
		'--mode', 'json',
		'--offline',
		'--no-session',
		'--no-tools',
		'--no-skills',
		'--no-prompt-templates',
		'--no-context-files',
		'--no-extensions',
		'-e', './extensions/impeccable.ts',
		'/impeccable help',
	], { cwd: root, encoding: 'utf8' });

	assert.equal(result.status, 0, result.stderr || result.stdout);
	const events = result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
	const help = events.find((event) => event.type === 'message_end' && event.message?.customType === 'impeccable');
	assert.match(help?.message?.content ?? '', /Usage:\n\/impeccable <command>/);
});

test('resources_discover publishes an installed project skill path', async (t) => {
	const { project, skillRoot } = makeProject(t);
	const nested = path.join(project, 'src', 'pages');
	fs.mkdirSync(nested, { recursive: true });
	const harness = loadExtension();

	const result = await harness.emit('resources_discover', { cwd: nested });

	assert.deepEqual(result, { skillPaths: [skillRoot] });
});

test('argument completions use descriptions from the installed skill', async (t) => {
	const skillMarkdown = `
| Command | Category | Description | Reference |
|---|---|---|---|
| \`craft [feature]\` | Build | Shape, then build a feature end-to-end | [reference/craft.md](reference/craft.md) |
| \`live\` | Iterate | Visual variant mode: pick elements in the browser, generate alternatives | [reference/live.md](reference/live.md) |

**Pin** creates a standalone shortcut so \`$<command>\` invokes \`$impeccable <command>\` directly. **Unpin** removes it.
\`$impeccable hooks <on|off|status|ignore-rule|ignore-file|ignore-value|reset>\` manages the design detector hook for this project.
`;
	const descriptions = parseCommandDescriptions(skillMarkdown);
	assert.equal(descriptions.get('craft'), 'Shape, then build a feature end-to-end');
	assert.equal(descriptions.get('pin'), 'Pin creates a standalone shortcut so $<command> invokes $impeccable <command> directly.');
	assert.equal(descriptions.get('hooks'), 'Manages the design detector hook for this project.');

	const { project, skillRoot } = makeProject(t);
	fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), skillMarkdown);
	const harness = loadExtension();
	const ctx = makeContext(project);
	await harness.emit('session_start', {}, ctx);

	const completions = await harness.commands.get('impeccable').getArgumentCompletions('li');

	assert.deepEqual(completions, [{
		value: 'live',
		label: 'live',
		description: 'Visual variant mode: pick elements in the browser, generate alternatives',
	}]);

	assert.deepEqual(await harness.commands.get('impeccable').getArgumentCompletions('st'), [
		{ value: 'status', label: 'status', description: 'Show Impeccable live server/session status' },
		{ value: 'stop', label: 'stop', description: 'Stop Impeccable live mode and polling' },
	]);
	assert.deepEqual(await harness.commands.get('impeccable').getArgumentCompletions('up'), [
		{ value: 'update', label: 'update', description: 'Update installed Impeccable skill files' },
	]);
	assert.equal(
		(await harness.commands.get('impeccable').getArgumentCompletions('in')).find(({ value }) => value === 'install').description,
		'Install Impeccable skill files into this project',
	);
});

test('agent commands are queued as hidden extension messages', async (t) => {
	const { project, skillRoot } = makeProject(t);
	const harness = loadExtension();
	const ctx = makeContext(project, { idle: false });

	await harness.commands.get('impeccable').handler('audit src/App.tsx', ctx);

	assert.equal(harness.messages.length, 1);
	assert.equal(harness.messages[0].message.customType, 'impeccable-command');
	assert.equal(harness.messages[0].message.display, false);
	assert.equal(harness.messages[0].options.deliverAs, 'followUp');
	assert.match(harness.messages[0].message.content, /Handle this Impeccable invocation in Pi: \/impeccable audit src\/App\.tsx/);
	assert.match(harness.messages[0].message.content, new RegExp(escapeRegExp(skillRoot)));
	assert.ok(ctx.ui.statuses.some((status) => status.value === '✦ impeccable audit queued'));
	await harness.emit('session_shutdown', {}, ctx);
});

test('live status runs the installed script and summarizes JSON', async (t) => {
	const status = {
		liveServer: { pid: 123 },
		activeSessions: [
			{ phase: 'design_pass', sourceFile: 'src/App.tsx' },
			{ phase: 'review', pageUrl: 'http://localhost:3000' },
		],
	};
	const { project } = makeProject(t, {
		'live-status.mjs': `console.log(${JSON.stringify(JSON.stringify(status))});\n`,
	});
	const harness = loadExtension();
	const ctx = makeContext(project);

	await harness.commands.get('impeccable').handler('live status', ctx);

	assert.deepEqual(ctx.ui.notifications.at(-1), {
		message: 'Impeccable live: server running · design pass · src/App.tsx · +1 more',
		type: 'info',
	});
});

test('live mode sends browser events as hidden messages and does not foreground-poll', async (t) => {
	const event = { type: 'generate', id: 'evt-1', prompt: 'Make the hero sharper' };
	const { project } = makeProject(t, {
		'live.mjs': 'console.log(JSON.stringify({ ok: true }));\n',
		'live-poll.mjs': `console.log(${JSON.stringify(JSON.stringify(event))});\n`,
	});
	const harness = loadExtension();
	const ctx = makeContext(project, { idle: false });

	await harness.commands.get('impeccable').handler('live --delivery=followUp', ctx);
	await waitFor(
		() => harness.messages.some((entry) => entry.message.customType === 'impeccable-live'),
		'expected a hidden live event message',
	);
	await harness.emit('session_shutdown', {}, ctx);

	const liveMessage = harness.messages.find((entry) => entry.message.customType === 'impeccable-live');
	assert.equal(liveMessage.message.display, false);
	assert.equal(liveMessage.options.deliverAs, 'followUp');
	assert.match(liveMessage.message.content, /Impeccable live event arrived from the background poll/);
	assert.match(liveMessage.message.content, /call impeccable_live_reply with id "evt-1"/);
	assert.deepEqual(ctx.ui.notifications.find((note) => /live started/.test(note.message)), {
		message: 'Impeccable live started. Say stop live or /impeccable stop to stop.',
		type: 'info',
	});
});

test('foreground live-poll bash calls are blocked', async () => {
	const harness = loadExtension();
	const ctx = makeContext(root);

	const blocked = await harness.emit('tool_call', {
		toolName: 'bash',
		input: { command: 'node .agents/skills/impeccable/scripts/live-poll.mjs' },
	}, ctx);
	const reply = await harness.emit('tool_call', {
		toolName: 'bash',
		input: { command: 'node .agents/skills/impeccable/scripts/live-poll.mjs --reply evt done' },
	}, ctx);

	assert.equal(blocked.block, true);
	assert.match(blocked.reason, /managed by the pi-impeccable extension in the background/);
	assert.equal(reply, undefined);
});

test('reply and complete tools call upstream scripts with the expected args', async (t) => {
	const replyArgs = path.join(os.tmpdir(), `pi-impeccable-reply-${process.pid}.json`);
	const completeArgs = path.join(os.tmpdir(), `pi-impeccable-complete-${process.pid}.json`);
	t.after(() => {
		fs.rmSync(replyArgs, { force: true });
		fs.rmSync(completeArgs, { force: true });
	});
	const { project } = makeProject(t, {
		'live-poll.mjs': `
			import fs from 'node:fs';
			if (process.argv.includes('--reply')) fs.writeFileSync(${JSON.stringify(replyArgs)}, JSON.stringify(process.argv.slice(2)));
			else console.log(JSON.stringify({ type: 'exit' }));
		`,
		'live-complete.mjs': `
			import fs from 'node:fs';
			fs.writeFileSync(${JSON.stringify(completeArgs)}, JSON.stringify(process.argv.slice(2)));
		`,
	});
	const harness = loadExtension();
	const ctx = makeContext(project);

	const reply = await harness.tools.get('impeccable_live_reply').execute('reply-call', {
		id: 'evt-1',
		status: 'done',
		file: 'src/App.tsx',
		data: { ok: true },
		message: 'Looks good',
	}, undefined, undefined, ctx);
	const complete = await harness.tools.get('impeccable_live_complete').execute('complete-call', {
		id: 'session-1',
		discarded: true,
	}, undefined, undefined, ctx);
	await harness.emit('session_shutdown', {}, ctx);

	assert.match(reply.content[0].text, /resumed polling/);
	assert.match(complete.content[0].text, /resumed polling/);
	assert.deepEqual(JSON.parse(fs.readFileSync(replyArgs, 'utf8')), [
		'--reply', 'evt-1', 'done', '--file', 'src/App.tsx', '--data', '{"ok":true}', 'Looks good',
	]);
	assert.deepEqual(JSON.parse(fs.readFileSync(completeArgs, 'utf8')), ['--id', 'session-1', '--discarded']);
});

test('summarizeLiveStatus handles empty and non-JSON output', () => {
	assert.equal(summarizeLiveStatus(''), 'No Impeccable live status.');
	assert.equal(summarizeLiveStatus('plain text'), 'plain text');
});

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
