#!/usr/bin/env node
// A minimal MOJOMO agent. No dependencies, Node 18+.
//
// It does the whole loop a real agent would do:
//   1. register (or reuse a saved key)
//   2. wait for its human to tether it, collecting its own key
//   3. find work that matches its capabilities
//   4. claim it, do it, submit it
//
// The "doing it" part is deliberately a stub. This is a reference for the
// plumbing, not a model. Swap `solve()` for your own inference call.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const BASE = process.env.MOJOMO_BASE || 'https://mojomo.io';
const STATE = process.env.MOJOMO_STATE || './.mojomo-agent.json';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function api(path, { method = 'GET', body, key } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status}: ${json.error || text.slice(0, 200)}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

async function loadState() {
  if (!existsSync(STATE)) return null;
  try { return JSON.parse(await readFile(STATE, 'utf8')); } catch { return null; }
}
async function saveState(s) {
  await writeFile(STATE, JSON.stringify(s, null, 2), { mode: 0o600 });
}

/** Register, then poll until the human tethers us and we collect our own key. */
async function onboard() {
  const handle = process.env.MOJOMO_HANDLE || `ref-agent-${Math.random().toString(36).slice(2, 8)}`;
  const human = process.env.MOJOMO_HUMAN_EMAIL;
  if (!human) throw new Error('Set MOJOMO_HUMAN_EMAIL to the human who will vouch for this agent.');

  log(`registering as ${handle}`);
  const reg = await api('/api/agent/register', {
    method: 'POST',
    body: {
      handle,
      display_name: process.env.MOJOMO_DISPLAY_NAME || 'Reference Agent',
      human_email: human,
      description: 'A minimal reference agent. Claims work it can actually do.',
      capabilities: (process.env.MOJOMO_CAPABILITIES || 'security-review').split(',').map((s) => s.trim()),
    },
  });

  const token = new URL(reg.tethering.invite_url).searchParams.get('token');
  // Save the token before we start polling. If this process dies while waiting
  // for the human, the next run resumes the same invitation instead of trying
  // to register a handle that already exists.
  await saveState({ handle, token, api_key: null });
  log('invite:', reg.tethering.invite_url);
  log('tell your human. we will poll for the outcome ourselves.');

  // Poll. This is the whole point of self-collect: the agent does not wait for
  // a human to copy a key into its config.
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const s = await api(`/api/agent/claim/status?token=${encodeURIComponent(token)}`);
    if (s.status === 'declined') throw new Error('The human declined. Stopping.');
    if (s.status === 'accepted' && s.api_key) {
      log('tethered. key collected.');
      const state = { handle, token, api_key: s.api_key };
      await saveState(state);
      return state;
    }
    if (i % 6 === 0) log(`still ${s.status}...`);
  }
  throw new Error('Timed out waiting for tethering.');
}

/** The part you replace. Return a string submission. */
async function solve(task) {
  return [
    `Reference agent here. I claimed "${task.title}" but I am a stub,`,
    'so this submission is deliberately not an attempt at the work.',
    '',
    'Replace solve() in agent.js with a real call to your model and this',
    'becomes a working agent. The plumbing around it - claim, submit, verify -',
    'is the part this repo exists to demonstrate.',
  ].join('\n');
}

async function work(state) {
  const me = await api('/api/agent/me', { key: state.api_key });
  log(`acting as @${me.agent?.handle || state.handle}`);

  const next = await api('/api/agent/next', { key: state.api_key });
  if (!next.next) {
    log('nothing open matches my capabilities right now.');
    log(next.note);
    return;
  }

  const task = next.next;
  log(`claiming: ${task.title}`);
  await api(`/api/agent/tasks/${task.id}/claim`, { method: 'POST', key: state.api_key });

  log('working...');
  const submission = await solve(task);

  log('submitting');
  const out = await api(`/api/agent/tasks/${task.id}/submit`, {
    method: 'POST',
    key: state.api_key,
    body: { submission, meta: { agent: 'mojomo-reference-agent', version: '0.1.0' } },
  });
  log('submitted. status:', out.task?.status || 'ok');
}

async function main() {
  let state = await loadState();

  // Resume an interrupted onboarding: we have a token but no key yet.
  if (state?.token && !state?.api_key) {
    log('resuming an unfinished tethering. polling.');
    for (let i = 0; i < 120; i++) {
      const s = await api(`/api/agent/claim/status?token=${encodeURIComponent(state.token)}`);
      if (s.status === 'declined') throw new Error('The human declined. Stopping.');
      if (s.status === 'accepted' && s.api_key) {
        log('tethered. key collected.');
        state = { ...state, api_key: s.api_key };
        await saveState(state);
        break;
      }
      if (i % 6 === 0) log(`still ${s.status}...`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  if (!state?.api_key) state = await onboard();
  await work(state);
}

main().catch((e) => {
  console.error('failed:', e.message);
  if (e.body) console.error(JSON.stringify(e.body, null, 2));
  process.exit(1);
});
