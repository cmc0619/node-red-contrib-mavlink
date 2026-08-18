'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = 'cmc0619/node-red-contrib-mavlink';
const STAMP = path.join(os.tmpdir(), 'cursor-mavlink-gh-events.stamp');
const TTL_MS = 3 * 60 * 1000;
const EVENT_LIMIT = 30;
const COMMENT_LIMIT = 100;

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function write(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function isSessionStart(input) {
  return (
    Object.prototype.hasOwnProperty.call(input, 'session_id') &&
    !Object.prototype.hasOwnProperty.call(input, 'tool_name')
  );
}

function stampFresh() {
  try {
    const age = Date.now() - Number(fs.readFileSync(STAMP, 'utf8'));
    return Number.isFinite(age) && age >= 0 && age < TTL_MS;
  } catch {
    return false;
  }
}

function touchStamp() {
  fs.writeFileSync(STAMP, String(Date.now()));
}

function flatten(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(text, limit) {
  const flat = flatten(text);
  if (flat.length <= limit) {
    return flat;
  }
  return `${flat.slice(0, limit - 1)}…`;
}

function subject(payload) {
  const item = payload.pull_request || payload.issue || {};
  const number = item.number || payload.number;
  const title = clip(item.title, 60);
  const parts = [];
  if (number != null) {
    parts.push(`#${number}`);
  }
  if (payload.action) {
    parts.push(payload.action);
  }
  if (title) {
    parts.push(title);
  }
  if (payload.review && payload.review.state) {
    parts.push(payload.review.state);
  }
  const comment = payload.comment || payload.review;
  if (comment && comment.body) {
    parts.push(clip(comment.body, COMMENT_LIMIT));
  }
  if (payload.ref) {
    parts.push(payload.ref);
  }
  if (Array.isArray(payload.commits)) {
    parts.push(`${payload.commits.length} commit(s)`);
  }
  return parts.join('  ');
}

function formatEvents(events) {
  const lines = [
    `GitHub events for ${REPO} (newest ${EVENT_LIMIT} from the repo Events API).`,
    'This is a poll at hook time, not a live webhook. A Cursor Automation is still what wakes a new agent.',
    '',
  ];
  for (const event of events) {
    const actor = event.actor && event.actor.login;
    const when = event.created_at || '';
    const type = event.type || '';
    const detail = subject(event.payload || {});
    lines.push([when, type, actor, detail].filter(Boolean).join('  '));
  }
  return lines.join('\n');
}

function fetchEvents() {
  const result = spawnSync(
    'gh',
    ['api', `repos/${REPO}/events?per_page=${EVENT_LIMIT}`],
    { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  if (result.status !== 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed.slice(0, EVENT_LIMIT) : null;
  } catch {
    return null;
  }
}

const input = readStdin();
if (!isSessionStart(input) && stampFresh()) {
  write({});
  process.exit(0);
}

const events = fetchEvents();
if (!events) {
  write({});
  process.exit(0);
}

touchStamp();
const context = formatEvents(events);
if (isSessionStart(input)) {
  write({ additional_context: context, continue: true });
} else {
  write({ additional_context: context });
}
process.exit(0);
