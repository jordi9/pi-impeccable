import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  ExtensionAPI,
  ExtensionContext,
  RegisteredCommand,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, onTestFinished, test } from 'vitest';

import impeccableExtension, {
  parseCommandMetadata,
  summarizeLiveStatus,
} from '../extensions/impeccable.ts';

const root = path.resolve(import.meta.dirname, '..');

describe('impeccable extension', () => {
  test('package exposes the pi extension without vendoring Impeccable', () => {
    const pkg = readPackageJson();

    expect(pkg.pi.extensions).toEqual(['./extensions/impeccable.ts']);
    expect(pkg.dependencies.impeccable).toBe('*');
    expect(fs.existsSync(path.join(root, 'vendor'))).toBe(false);
  });

  test('loads through pi --extension and handles /impeccable help', () => {
    const pi = path.join(root, 'node_modules', '.bin', 'pi');
    const result = spawnSync(
      pi,
      [
        '-p',
        '--mode',
        'json',
        '--offline',
        '--no-session',
        '--no-tools',
        '--no-skills',
        '--no-prompt-templates',
        '--no-context-files',
        '--no-extensions',
        '-e',
        './extensions/impeccable.ts',
        '/impeccable help',
      ],
      { cwd: root, encoding: 'utf8' },
    );

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const help = parsePiEvents(result.stdout).find(
      (event) =>
        event.type === 'message_end' &&
        event.message?.customType === 'impeccable',
    );

    expect(help?.message?.content ?? '').toMatch(
      /Usage:\n\/impeccable <command>/,
    );
  });

  test('resources_discover publishes an installed project skill path', async () => {
    const { project, skillRoot } = makeProject();
    const nested = path.join(project, 'src', 'pages');
    fs.mkdirSync(nested, { recursive: true });
    const harness = loadExtension();

    const result = await harness.emit<ResourcesDiscoverResult>(
      'resources_discover',
      { cwd: nested },
    );

    expect(result).toEqual({ skillPaths: [skillRoot] });
  });

  test('argument completions prefer installed command metadata', async () => {
    const { project, skillRoot } = makeProject();
    fs.writeFileSync(
      path.join(skillRoot, 'SKILL.md'),
      `
| Command | Category | Description | Reference |
|---|---|---|---|
| \`craft [feature]\` | Build | Short table description | [reference/craft.md](reference/craft.md) |
`,
    );
    fs.writeFileSync(
      path.join(skillRoot, 'scripts', 'command-metadata.json'),
      JSON.stringify({
        craft: {
          description:
            'Full metadata description with `code` and **emphasis**.',
        },
      }),
    );

    const descriptions = parseCommandMetadata(
      fs.readFileSync(
        path.join(skillRoot, 'scripts', 'command-metadata.json'),
        'utf8',
      ),
    );
    expect(descriptions.get('craft')).toBe(
      'Full metadata description with code and emphasis.',
    );

    const harness = loadExtension();
    await harness.emit('session_start', {}, makeContext(project));

    const [craft] = await argumentCompletions(harness, 'cr');

    expect(craft?.description).toBe(
      'Full metadata description with code and emphasis.',
    );
  });

  test('argument completions include fallback descriptions before skill install', async () => {
    const project = fs.mkdtempSync(
      path.join(os.tmpdir(), 'pi-impeccable-no-skill-'),
    );
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-impeccable-home-'));
    const oldHome = process.env.HOME;
    fs.mkdirSync(path.join(project, '.git'));
    process.env.HOME = home;
    onTestFinished(() => {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      fs.rmSync(project, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    });

    const harness = loadExtension();
    await harness.emit('session_start', {}, makeContext(project));

    const craft = (await argumentCompletions(harness, 'cr')).find(
      ({ value }) => value === 'craft',
    );
    const hooks = (await argumentCompletions(harness, 'ho')).find(
      ({ value }) => value === 'hooks',
    );

    expect(craft?.description).toMatch(/confirmed-brief-then-build/);
    expect(hooks?.description).toMatch(/design detector hook/);
  });

  test('agent commands are queued as hidden extension messages', async () => {
    const { project, skillRoot } = makeProject();
    const harness = loadExtension();
    const ctx = makeContext(project, { idle: false });

    await runCommand(harness, 'audit src/App.tsx', ctx);

    const [entry] = harness.messages;
    expect(harness.messages).toHaveLength(1);
    expect(entry?.message.customType).toBe('impeccable-command');
    expect(entry?.message.display).toBe(false);
    expect(entry?.options?.deliverAs).toBe('followUp');
    expect(entry?.message.content).toMatch(
      /Handle this Impeccable invocation in Pi: \/impeccable audit src\/App\.tsx/,
    );
    expect(entry?.message.content).toMatch(new RegExp(escapeRegExp(skillRoot)));
    expect(
      ctx.ui.statuses.some(
        (status) => status.value === '✦ impeccable audit queued',
      ),
    ).toBe(true);
    await harness.emit('session_shutdown', {}, ctx);
  });

  test('live status runs the installed script and summarizes JSON', async () => {
    const status: LiveStatus = {
      liveServer: { pid: 123 },
      activeSessions: [
        { phase: 'design_pass', sourceFile: 'src/App.tsx' },
        { phase: 'review', pageUrl: 'http://localhost:3000' },
      ],
    };
    const { project } = makeProject({
      'live-status.mjs': `console.log(${JSON.stringify(JSON.stringify(status))});\n`,
    });
    const harness = loadExtension();
    const ctx = makeContext(project);

    await runCommand(harness, 'live status', ctx);

    expect(ctx.ui.notifications.at(-1)).toEqual({
      message:
        'Impeccable live: server running · design pass · src/App.tsx · +1 more',
      type: 'info',
    });
  });

  test('live mode sends browser events as hidden messages and does not foreground-poll', async () => {
    const event: LiveEvent = {
      type: 'generate',
      id: 'evt-1',
      prompt: 'Make the hero sharper',
    };
    const { project } = makeProject({
      'live.mjs': 'console.log(JSON.stringify({ ok: true }));\n',
      'live-poll.mjs': `console.log(${JSON.stringify(JSON.stringify(event))});\n`,
    });
    const harness = loadExtension();
    const ctx = makeContext(project, { idle: false });

    await runCommand(harness, 'live --delivery=followUp', ctx);
    await waitFor(
      () =>
        harness.messages.some(
          (entry) => entry.message.customType === 'impeccable-live',
        ),
      'expected a hidden live event message',
    );
    await harness.emit('session_shutdown', {}, ctx);

    const liveMessage = harness.messages.find(
      (entry) => entry.message.customType === 'impeccable-live',
    );
    expect(liveMessage?.message.display).toBe(false);
    expect(liveMessage?.options?.deliverAs).toBe('followUp');
    expect(liveMessage?.message.content).toMatch(
      /Impeccable live event arrived from the background poll/,
    );
    expect(liveMessage?.message.content).toMatch(
      /call impeccable_live_reply with id "evt-1"/,
    );
    expect(
      ctx.ui.notifications.find((note) => /live started/.test(note.message)),
    ).toEqual({
      message:
        'Impeccable live started. Say stop live or /impeccable stop to stop.',
      type: 'info',
    });
  });

  test('session shutdown stops live server and ignores killed polls', async () => {
    const stopArgs = path.join(
      os.tmpdir(),
      `pi-impeccable-stop-${process.pid}.json`,
    );
    onTestFinished(() => fs.rmSync(stopArgs, { force: true }));
    const { project } = makeProject({
      'live.mjs': 'console.log(JSON.stringify({ ok: true }));\n',
      'live-poll.mjs': `setTimeout(() => console.log(JSON.stringify({ type: 'generate', id: 'late' })), 5000);\n`,
      'live-server.mjs': `
        import fs from 'node:fs';
        if (process.argv.includes('stop')) fs.writeFileSync(${JSON.stringify(stopArgs)}, JSON.stringify(process.argv.slice(2)));
      `,
    });
    const harness = loadExtension();
    const ctx = makeContext(project);

    await runCommand(harness, 'live', ctx);
    await harness.emit('session_shutdown', {}, ctx);
    await delay(50);

    expect(JSON.parse(fs.readFileSync(stopArgs, 'utf8'))).toEqual(['stop']);
    expect(harness.messages).toEqual([]);
    expect(
      ctx.ui.notifications.some((note) => /poll failed/.test(note.message)),
    ).toBe(false);
  });

  test('foreground live-poll bash calls are blocked', async () => {
    const harness = loadExtension();
    const ctx = makeContext(root);

    const blocked = await harness.emit<ToolCallResult>(
      'tool_call',
      {
        toolName: 'bash',
        input: {
          command: 'node .agents/skills/impeccable/scripts/live-poll.mjs',
        },
      },
      ctx,
    );
    const reply = await harness.emit<ToolCallResult>(
      'tool_call',
      {
        toolName: 'bash',
        input: {
          command:
            'node .agents/skills/impeccable/scripts/live-poll.mjs --reply evt done',
        },
      },
      ctx,
    );

    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toMatch(
      /managed by the pi-impeccable extension in the background/,
    );
    expect(reply).toBeUndefined();
  });

  test('reply and complete tools call upstream scripts with the expected args', async () => {
    const replyArgs = path.join(
      os.tmpdir(),
      `pi-impeccable-reply-${process.pid}.json`,
    );
    const completeArgs = path.join(
      os.tmpdir(),
      `pi-impeccable-complete-${process.pid}.json`,
    );
    onTestFinished(() => {
      fs.rmSync(replyArgs, { force: true });
      fs.rmSync(completeArgs, { force: true });
    });
    const { project } = makeProject({
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

    const reply = await executeTool(
      harness,
      'impeccable_live_reply',
      'reply-call',
      {
        id: 'evt-1',
        status: 'done',
        file: 'src/App.tsx',
        data: { ok: true },
        message: 'Looks good',
      },
      ctx,
    );
    const complete = await executeTool(
      harness,
      'impeccable_live_complete',
      'complete-call',
      {
        id: 'session-1',
        discarded: true,
      },
      ctx,
    );
    await harness.emit('session_shutdown', {}, ctx);

    expect(reply.content[0]?.text).toMatch(/resumed polling/);
    expect(complete.content[0]?.text).toMatch(/resumed polling/);
    expect(JSON.parse(fs.readFileSync(replyArgs, 'utf8'))).toEqual([
      '--reply',
      'evt-1',
      'done',
      '--file',
      'src/App.tsx',
      '--data',
      '{"ok":true}',
      'Looks good',
    ]);
    expect(JSON.parse(fs.readFileSync(completeArgs, 'utf8'))).toEqual([
      '--id',
      'session-1',
      '--discarded',
    ]);
  });

  test('summarizeLiveStatus handles empty and non-JSON output', () => {
    expect(summarizeLiveStatus('')).toBe('No Impeccable live status.');
    expect(summarizeLiveStatus('plain text')).toBe('plain text');
  });
});

type Completion = {
  value: string;
  description?: string;
};

type EventHandler = (
  event: unknown,
  ctx: TestContext,
) => unknown | Promise<unknown>;

type Harness = {
  handlers: Map<string, EventHandler[]>;
  commands: Map<string, TestCommand>;
  tools: Map<string, ToolDefinition>;
  messages: SentMessage[];
  emit<T = unknown>(
    name: string,
    event?: unknown,
    ctx?: TestContext,
  ): Promise<T | undefined>;
};

type LiveEvent = {
  type: string;
  id: string;
  prompt: string;
};

type LiveStatus = {
  liveServer: { pid: number };
  activeSessions: Array<{
    phase: string;
    sourceFile?: string;
    pageUrl?: string;
  }>;
};

type PackageJson = {
  pi: { extensions: string[] };
  dependencies: Record<string, string>;
};

type PiJsonEvent = {
  type?: string;
  message?: {
    customType?: string;
    content?: string;
  };
};

type ProjectFixture = {
  project: string;
  skillRoot: string;
};

type ResourcesDiscoverResult = {
  skillPaths: string[];
};

type SentMessage = {
  message: Parameters<ExtensionAPI['sendMessage']>[0];
  options: Parameters<ExtensionAPI['sendMessage']>[1];
};

type TestCommand = Omit<
  RegisteredCommand,
  'name' | 'sourceInfo' | 'handler' | 'getArgumentCompletions'
> & {
  getArgumentCompletions?: (
    argumentPrefix: string,
  ) => Completion[] | null | Promise<Completion[] | null>;
  handler: (args: string, ctx: TestContext) => Promise<void> | void;
};

type TestContext = {
  cwd: string;
  hasUI: boolean;
  ui: TestUI;
  isIdle: () => boolean;
  signal: AbortSignal | undefined;
};

type TestUI = {
  notifications: Array<{
    message: string;
    type?: 'info' | 'warning' | 'error';
  }>;
  statuses: Array<{ key: string; value: string | undefined }>;
  theme: { fg: (color: string, text: string) => string };
  notify: (message: string, type?: 'info' | 'warning' | 'error') => void;
  setStatus: (key: string, value: string | undefined) => void;
};

type ToolCallResult = {
  block?: boolean;
  reason?: string;
};

type ToolTextResult = {
  content: Array<{ type: 'text'; text: string }>;
};

async function argumentCompletions(
  harness: Harness,
  prefix: string,
): Promise<Completion[]> {
  return (
    (await impeccableCommand(harness).getArgumentCompletions?.(prefix)) ?? []
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function executeTool(
  harness: Harness,
  name: string,
  toolCallId: string,
  params: unknown,
  ctx: TestContext,
): Promise<ToolTextResult> {
  const found = harness.tools.get(name);
  if (!found) throw new Error(`${name} tool was not registered`);
  return found.execute(
    toolCallId,
    params,
    undefined,
    undefined,
    ctx as unknown as ExtensionContext,
  ) as Promise<ToolTextResult>;
}

function impeccableCommand(harness: Harness): TestCommand {
  const command = harness.commands.get('impeccable');
  if (!command) throw new Error('impeccable command was not registered');
  return command;
}

function loadExtension(): Harness {
  const handlers = new Map<string, EventHandler[]>();
  const commands = new Map<string, TestCommand>();
  const tools = new Map<string, ToolDefinition>();
  const messages: SentMessage[] = [];
  const pi = {
    on(name: string, handler: EventHandler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerCommand(name: string, command: TestCommand) {
      commands.set(name, command);
    },
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    sendMessage(
      message: SentMessage['message'],
      options: SentMessage['options'],
    ) {
      messages.push({ message, options });
    },
  };
  impeccableExtension(pi as unknown as ExtensionAPI);

  return {
    handlers,
    commands,
    tools,
    messages,
    async emit<T = unknown>(
      name: string,
      event: unknown = {},
      ctx: TestContext = makeContext(root),
    ) {
      let result: unknown;
      for (const handler of handlers.get(name) ?? []) {
        const value = await handler(event, ctx);
        if (value !== undefined) result = value;
      }
      return result as T | undefined;
    },
  };
}

function makeContext(
  cwd: string,
  { idle = true, hasUI = true }: { idle?: boolean; hasUI?: boolean } = {},
): TestContext {
  const notifications: TestUI['notifications'] = [];
  const statuses: TestUI['statuses'] = [];
  const ui: TestUI = {
    notifications,
    statuses,
    theme: { fg: (_color, text) => text },
    notify(message, type) {
      notifications.push({ message, type });
    },
    setStatus(key, value) {
      statuses.push({ key, value });
    },
  };
  return { cwd, hasUI, ui, isIdle: () => idle, signal: undefined };
}

function makeProject(scripts: Record<string, string> = {}): ProjectFixture {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-impeccable-'));
  const skillRoot = path.join(project, '.agents', 'skills', 'impeccable');
  fs.mkdirSync(path.join(project, '.git'));
  fs.mkdirSync(path.join(skillRoot, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# fake impeccable\n');
  for (const [name, source] of Object.entries(scripts)) {
    fs.writeFileSync(path.join(skillRoot, 'scripts', name), source);
  }
  onTestFinished(() => fs.rmSync(project, { recursive: true, force: true }));
  return { project, skillRoot };
}

function parsePiEvents(stdout: string): PiJsonEvent[] {
  return stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PiJsonEvent);
}

function readPackageJson(): PackageJson {
  return JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
  ) as PackageJson;
}

async function runCommand(
  harness: Harness,
  args: string,
  ctx: TestContext,
): Promise<void> {
  await impeccableCommand(harness).handler(args, ctx);
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error(message);
}
