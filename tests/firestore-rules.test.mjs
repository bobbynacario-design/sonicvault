// Firestore rules test for the shared ruleset (firestore.rules), against the
// local emulator only. No dependencies: plain fetch to the emulator's REST
// API, with unsigned test tokens (the emulator reads their claims without
// checking a signature) and "Bearer owner" to seed data past the rules.
//
//   npm run test:rules
//   (= firebase emulators:exec --only firestore --project demo-shared-rules "node tests/firestore-rules.test.mjs")
//
// The project id starts with "demo-", so nothing can reach production.

const HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const PROJECT = process.env.GCLOUD_PROJECT || 'demo-shared-rules';
const BASE = 'http://' + HOST + '/v1/projects/' + PROJECT + '/databases/(default)/documents';

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
function token(uid, email, verified, provider) {
  const now = Math.floor(Date.now() / 1000);
  return b64({ alg: 'none', typ: 'JWT' }) + '.' + b64({
    iss: 'https://securetoken.google.com/' + PROJECT, aud: PROJECT, iat: now, exp: now + 3600, auth_time: now,
    sub: uid, user_id: uid, email, email_verified: verified,
    firebase: { identities: {}, sign_in_provider: provider || 'google.com' },
  }) + '.';
}
const USERS = {
  bob: token('bob-uid', 'bobbynacario@gmail.com', true),
  bobUnverified: token('fake-bob-uid', 'bobbynacario@gmail.com', false, 'password'),
  alice: token('alice-uid', 'alice@example.com', true, 'password'),
  aliceUnverified: token('alice-uid', 'alice@example.com', false, 'password'),
  eve: token('eve-uid', 'eve@example.com', true),
};

const toFields = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) =>
  [k, typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? { integerValue: String(v) } : { stringValue: String(v) }]));

async function call(method, path, who, body, query) {
  const res = await fetch(BASE + '/' + path + (query ? '?' + query : ''), {
    method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (who === 'admin' ? 'owner' : USERS[who]) },
    body: body ? JSON.stringify({ fields: toFields(body) }) : undefined,
  });
  return res.status;
}
const read = (who, path) => call('GET', path, who);
const create = (who, path, body) => call('PATCH', path, who, body, 'currentDocument.exists=false');
const update = (who, path, body) => call('PATCH', path, who, body, 'currentDocument.exists=true');
const remove = (who, path) => call('DELETE', path, who);
// The app's list queries: where('uid','==',uid) on a collection.
async function queryOwn(who, collectionId, uid) {
  const res = await fetch(BASE + ':runQuery', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + USERS[who] },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId }], where: { fieldFilter: { field: { fieldPath: 'uid' }, op: 'EQUAL', value: { stringValue: uid } } } } }),
  });
  return res.status;
}

let failures = 0, passes = 0;
async function expect(label, promise, allowed) {
  const status = await promise;
  const ok = allowed ? status === 200 : status === 403;
  if (ok) passes++; else { failures++; console.log('FAIL  ' + label + ': got ' + status + ', expected ' + (allowed ? 'allowed' : 'denied')); }
}

async function main() {
  // Seed, past the rules.
  await call('DELETE', '', 'admin').catch(() => {});
  await create('admin', 'daybook-invites/bobbynacario@gmail.com', { email: 'bobbynacario@gmail.com', role: 'owner', name: 'Bob', invitedAt: '2026-09-30T08:28:49Z', invitedBy: 'bobbynacario@gmail.com' });
  await create('admin', 'daybook-invites/alice@example.com', { email: 'alice@example.com', role: 'member', name: 'Alice', invitedAt: '2026-09-30T09:00:00Z', invitedBy: 'bobbynacario@gmail.com' });
  await create('admin', 'briefings-bob/radar', { summary: 'shared feed, no uid' });
  await create('admin', 'briefings-bob/llm-usage', { summary: 'the owner\'s AI spend, no uid' });
  await create('admin', 'briefings-bob/Wednesday--September-30--2026', { uid: 'bob-uid', data: '{}' });
  await create('admin', 'briefings-bob/usage-alice-uid', { uid: 'alice-uid', kind: 'usage' });
  await create('admin', 'reports-bob/r1', { uid: 'bob-uid', topic: 'x' });
  await create('admin', 'journal-bob/j1', { uid: 'bob-uid', title: 'x' });
  await create('admin', 'pokerhq-bob/state', { v: 1 });
  await create('admin', 'sonicvault-bob/vault', { v: 1 });

  // Daybook: Bob reads everything he should, and needs no invite document to do it.
  await expect('Bob reads a shared feed', read('bob', 'briefings-bob/radar'), true);
  await expect('Bob reads his briefing', read('bob', 'briefings-bob/Wednesday--September-30--2026'), true);
  await expect('Bob saves a briefing', create('bob', 'briefings-bob/Thursday--October-1--2026', { uid: 'bob-uid', data: '{}' }), true);
  await expect('Bob reads his report', read('bob', 'reports-bob/r1'), true);
  await expect('Bob reads his journal', read('bob', 'journal-bob/j1'), true);

  // An invited, verified member.
  await expect('Alice reads a shared feed', read('alice', 'briefings-bob/radar'), true);
  await expect('Alice reads her own document', read('alice', 'briefings-bob/usage-alice-uid'), true);
  await expect('Alice creates her own document', create('alice', 'briefings-bob/goals-alice-uid', { uid: 'alice-uid', kind: 'goals' }), true);
  await expect('Alice cannot read Bob\'s briefing', read('alice', 'briefings-bob/Wednesday--September-30--2026'), false);
  await expect('Alice cannot read Bob\'s journal', read('alice', 'journal-bob/j1'), false);
  await expect('Alice cannot create a document as Bob', create('alice', 'briefings-bob/goals-bob-uid', { uid: 'bob-uid', kind: 'goals' }), false);

  // The AI cost ledger is Bob's spend: of the shared documents, only he reads it.
  await expect('Bob reads the AI cost ledger', read('bob', 'briefings-bob/llm-usage'), true);
  await expect('Alice cannot read the AI cost ledger', read('alice', 'briefings-bob/llm-usage'), false);
  // ...and the app's own-uid list queries still work for both.
  await expect('Alice lists her own briefings', queryOwn('alice', 'briefings-bob', 'alice-uid'), true);
  await expect('Bob lists his own briefings', queryOwn('bob', 'briefings-bob', 'bob-uid'), true);
  await expect('Alice cannot list Bob\'s briefings', queryOwn('alice', 'briefings-bob', 'bob-uid'), false);

  // The shared feeds are written only by the jobs: nobody takes one over or deletes one.
  await expect('Alice cannot take over a shared feed', update('alice', 'briefings-bob/radar', { uid: 'alice-uid', summary: 'mine now' }), false);
  await expect('Alice cannot delete a shared feed', remove('alice', 'briefings-bob/radar'), false);
  await expect('Bob cannot delete a shared feed from the page either', remove('bob', 'briefings-bob/radar'), false);

  // Not invited, or not verified.
  await expect('An uninvited account cannot read a shared feed', read('eve', 'briefings-bob/radar'), false);
  await expect('An uninvited account cannot save a document', create('eve', 'briefings-bob/goals-eve-uid', { uid: 'eve-uid', kind: 'goals' }), false);
  await expect('An unverified invitee cannot read', read('aliceUnverified', 'briefings-bob/radar'), false);
  await expect('An unverified account using Bob\'s email cannot read Daybook', read('bobUnverified', 'briefings-bob/radar'), false);

  // The invite list.
  await expect('Alice reads her own invite', read('alice', 'daybook-invites/alice@example.com'), true);
  await expect('Alice cannot read Bob\'s invite', read('alice', 'daybook-invites/bobbynacario@gmail.com'), false);
  // Allowed to look, and told there is none (404, not 403): the page then says "No invite found".
  const absent = await read('eve', 'daybook-invites/eve@example.com');
  if (absent === 404) passes++; else { failures++; console.log('FAIL  Eve looks up her own absent invite: got ' + absent + ', expected 404'); }
  await expect('Alice cannot list the invites', read('alice', 'daybook-invites'), false);
  await expect('Bob lists the invites', read('bob', 'daybook-invites'), true);
  await expect('Bob invites a member', create('bob', 'daybook-invites/carol@example.com', { email: 'carol@example.com', role: 'member', name: 'Carol', invitedAt: '2026-09-30T10:00:00Z', invitedBy: 'bobbynacario@gmail.com' }), true);
  await expect('Bob cannot make another owner', create('bob', 'daybook-invites/dan@example.com', { email: 'dan@example.com', role: 'owner', name: 'Dan', invitedAt: '2026-09-30T10:00:00Z', invitedBy: 'bobbynacario@gmail.com' }), false);
  await expect('An invite id must be the lowercase email', create('bob', 'daybook-invites/Dan@Example.com', { email: 'Dan@Example.com', role: 'member', name: 'Dan', invitedAt: '2026-09-30T10:00:00Z', invitedBy: 'bobbynacario@gmail.com' }), false);
  await expect('An invite carries only its own fields', create('bob', 'daybook-invites/erin@example.com', { email: 'erin@example.com', role: 'member', name: 'Erin', invitedAt: '2026-09-30T10:00:00Z', invitedBy: 'bobbynacario@gmail.com', isAdmin: true }), false);
  await expect('Alice cannot invite anyone', create('alice', 'daybook-invites/frank@example.com', { email: 'frank@example.com', role: 'member', name: 'Frank', invitedAt: '2026-09-30T10:00:00Z', invitedBy: 'alice@example.com' }), false);
  await expect('Bob removes a member', remove('bob', 'daybook-invites/carol@example.com'), true);
  await expect('Bob\'s own owner invite cannot be deleted', remove('bob', 'daybook-invites/bobbynacario@gmail.com'), false);
  await expect('A removed member loses access at once', (async () => { await remove('bob', 'daybook-invites/alice@example.com'); return read('alice', 'briefings-bob/radar'); })(), false);

  // The other apps are unchanged for Bob, and closed to everyone else.
  await expect('PokerHQ: Bob reads', read('bob', 'pokerhq-bob/state'), true);
  await expect('PokerHQ: others cannot', read('eve', 'pokerhq-bob/state'), false);
  await expect('SonicVault: Bob reads', read('bob', 'sonicvault-bob/vault'), true);
  await expect('SonicVault: an unverified account using Bob\'s email cannot', read('bobUnverified', 'sonicvault-bob/vault'), false);

  console.log(passes + ' passed, ' + failures + ' failed');
  if (failures) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
