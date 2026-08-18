#!/usr/bin/env node
'use strict';

const DENY_DRAFT =
  'AGENTS.md:57 — PRs are opened as drafts; only the repo owner marks them ready.';
const DENY_MERGE =
  'AGENTS.md:57 — Agents do not merge. Merging is the owner\'s call.';

function allow() {
  return { permission: 'allow' };
}

function deny(reason) {
  return {
    permission: 'deny',
    user_message: reason,
    agent_message: reason,
  };
}

function toolName(input) {
  return String(
    input.tool_name ||
      input.toolName ||
      input.tool ||
      (input.mcp && (input.mcp.toolName || input.mcp.tool)) ||
      ''
  );
}

function toolInput(input) {
  const raw = input.tool_input || input.arguments || input.input || input.params;
  if (raw && typeof raw === 'object') {
    return raw;
  }
  return {};
}

function isCreatePullRequestName(name) {
  return /create[_-]?pull[_-]?request/i.test(name) && !/list|get|search|read/i.test(name);
}

function isManagePullRequestName(name) {
  return /managepullrequest/i.test(name);
}

function isMergePullRequestName(name) {
  return /merge[_-]?pull[_-]?request/i.test(name);
}

function decideMcpOrTool(input) {
  const name = toolName(input);
  const args = toolInput(input);
  const action = String(args.action || '');

  if (isMergePullRequestName(name)) {
    return deny(DENY_MERGE);
  }

  if (isCreatePullRequestName(name) && args.draft !== true) {
    return deny(DENY_DRAFT + ' Re-call with draft: true.');
  }

  if (isManagePullRequestName(name)) {
    if (action === 'create_pr' && args.draft !== true) {
      return deny(DENY_DRAFT + ' Re-call ManagePullRequest create_pr with draft: true.');
    }
    if (action === 'update_pr' && args.draft === false) {
      return deny(DENY_DRAFT + ' Do not set draft: false. Only the owner marks a PR ready.');
    }
  }

  return allow();
}

function decideShell(command) {
  const cmd = String(command || '');
  if (!/\bgh\b/.test(cmd) || !/\bpr\b/.test(cmd)) {
    return allow();
  }
  if (/\bgh\s+pr\s+merge\b/.test(cmd)) {
    return deny(DENY_MERGE);
  }
  if (/\bgh\s+pr\s+ready\b/.test(cmd)) {
    return deny(DENY_DRAFT + ' Do not run gh pr ready.');
  }
  if (/\bgh\s+pr\s+create\b/.test(cmd) && !/(?:^|\s)--draft(?:\s|=|$)/.test(cmd)) {
    return deny(DENY_DRAFT + ' Re-run gh pr create with --draft.');
  }
  return allow();
}

function decide(input) {
  const command = input.command || input.shell_command || '';
  if (command) {
    return decideShell(command);
  }
  return decideMcpOrTool(input);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    process.stdin.on('error', reject);
  });
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(label + ': expected ' + expected + ', got ' + actual);
  }
}

function selfTest() {
  assertEqual(
    decide({
      tool_name: 'ManagePullRequest',
      tool_input: { action: 'create_pr', title: 'x', body: 'y', branch_name: 'z' },
    }).permission,
    'deny',
    'create_pr without draft'
  );
  assertEqual(
    decide({
      toolName: 'ManagePullRequest',
      arguments: { action: 'create_pr', draft: true, title: 'x', body: 'y', branch_name: 'z' },
    }).permission,
    'allow',
    'create_pr with draft true'
  );
  assertEqual(
    decide({
      tool_name: 'ManagePullRequest',
      tool_input: { action: 'update_pr', draft: false },
    }).permission,
    'deny',
    'update_pr marking ready'
  );
  assertEqual(
    decide({
      tool_name: 'ManagePullRequest',
      tool_input: { action: 'update_pr', title: 'x' },
    }).permission,
    'allow',
    'update_pr title only'
  );
  assertEqual(
    decide({
      tool_name: 'mcp__github__create_pull_request',
      tool_input: { title: 'x' },
    }).permission,
    'deny',
    'github MCP create without draft'
  );
  assertEqual(
    decide({
      tool_name: 'mcp__github__create_pull_request',
      tool_input: { title: 'x', draft: true },
    }).permission,
    'allow',
    'github MCP create with draft'
  );
  assertEqual(
    decide({ command: 'gh pr merge --squash 338' }).permission,
    'deny',
    'gh pr merge'
  );
  assertEqual(
    decide({ command: 'gh pr ready 338' }).permission,
    'deny',
    'gh pr ready'
  );
  assertEqual(
    decide({ command: 'gh pr create --title t --body b' }).permission,
    'deny',
    'gh pr create without --draft'
  );
  assertEqual(
    decide({ command: 'gh pr create --draft --title t --body b' }).permission,
    'allow',
    'gh pr create --draft'
  );
  assertEqual(
    decide({ command: 'gh pr view 338' }).permission,
    'allow',
    'gh pr view'
  );
  process.stdout.write('pr-gate self-test: ok\n');
}

if (process.argv.includes('--self-test')) {
  selfTest();
} else {
  readStdin()
    .then((input) => {
      process.stdout.write(JSON.stringify(decide(input)));
    })
    .catch(() => {
      process.stdout.write(
        JSON.stringify(deny('PR gate hook received invalid JSON.'))
      );
    });
}
