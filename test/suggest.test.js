'use strict';

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
process.env.EDITOR_TOKEN = 'test-token';
const Database = require('better-sqlite3');

const mem = new Database(':memory:');
const { SCHEMA, setDb } = require('../src/db');
mem.exec(SCHEMA);
setDb(mem);

const { app } = require('../src/server');

const TOKEN = 'test-token';
let base;
let server;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  mem.close();
});

beforeEach(() => {
  mem.exec(`
    DELETE FROM version_relations;
    DELETE FROM version_events;
    DELETE FROM versions;
    DELETE FROM relations;
    DELETE FROM claims;
    DELETE FROM events;
    DELETE FROM sqlite_sequence;
    UPDATE draft_meta SET revision = 0 WHERE id = 1;
  `);
});

async function call(method, url, { token = TOKEN, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Editor-Token': token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function makeEvent(title) {
  const r = await call('POST', '/api/editor/events', { body: { title, description: '' } });
  assert.strictEqual(r.status, 201);
  return r.json.event.id;
}
async function makeClaim(eventId, payload) {
  const r = await call('POST', `/api/editor/events/${eventId}/claims`, { body: payload });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.claim.id;
}
async function makeRel(earlierId, laterId, source = '') {
  const r = await call('POST', '/api/editor/relations', { body: { earlierId, laterId, source } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.relation.id;
}
async function revision() {
  return (await call('GET', '/api/editor/state')).json.draftRevision;
}

const DAY = (year, month, day) => ({ precision: 'day', year, month, day, source: 's' });
const MONTH = (year, month) => ({ precision: 'month', year, month, source: 's' });
const YEAR = (year) => ({ precision: 'year', year, source: 's' });

test('时间无解：返回改选事件数最少的可行组合、逐项变更与求解日期', async () => {
  // e1 先于 e2。基线：e1=12月、e2=1月（同年）→ 无解；改选 e1 或 e2 任一即可。
  const e1 = await makeEvent('冬月会议');
  const e2 = await makeEvent('春月会议');
  const c1a = await makeClaim(e1, MONTH(1958, 12)); // 基线（12 月）
  const c1b = await makeClaim(e1, MONTH(1957, 12)); // 改选 e1 的出路
  const c2a = await makeClaim(e2, MONTH(1958, 1));  // 基线（1 月）
  const c2b = await makeClaim(e2, MONTH(1959, 1));  // 改选 e2 的出路
  await makeRel(e1, e2);

  // 预检确实时间无解
  const v = await call('POST', '/api/editor/validate', {
    body: { selection: [{ eventId: e1, claimId: c1a }, { eventId: e2, claimId: c2a }] },
  });
  assert.strictEqual(v.json.ok, false);
  assert.strictEqual(v.json.errors[0].type, 'temporal');
  const rev = v.json.draftRevision;

  const r = await call('POST', '/api/editor/suggestions/reselect', {
    body: {
      selection: [{ eventId: e1, claimId: c1a }, { eventId: e2, claimId: c2a }],
      draftRevision: rev,
    },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(r.json.changedEventCount, 1);
  assert.strictEqual(r.json.changes.length, 1);
  assert.strictEqual(r.json.draftRevision, rev);

  // 平手：改选 e1（主张 c1b）与改选 e2（主张 c2b）都只动 1 个事件。
  // 按事件 id 升序的主张 id 序列：[c1b,c2a] vs [c1a,c2b]；c1b>c1a、c1a<c1b → 第二项比较…
  // 序列比较：第一位 c1b(改e1方案)=3 vs c1a(改e2方案)=1 → 保留第一位更小者 = 改选 e2。
  const ch = r.json.changes[0];
  assert.strictEqual(ch.eventId, e2);
  assert.strictEqual(ch.fromClaimId, c2a);
  assert.strictEqual(ch.toClaimId, c2b);
  assert.strictEqual(ch.toClaim.dateLabel, '1959 年 01 月');

  // selection 包含全部事件
  assert.deepStrictEqual(
    r.json.selection.map((s) => [s.eventId, s.claimId]).sort(),
    [[e1, c1a], [e2, c2b]].sort()
  );

  // 求解日期严格先后
  const byEvent = Object.fromEntries(r.json.resolvedDates.map((d) => [d.eventId, d.resolvedDate]));
  assert.strictEqual(byEvent[e1], '1958-12-01');
  assert.strictEqual(byEvent[e2], '1959-01-01');
});

test('优先改选更少事件：1 改选可行时不选需要 2 改选的组合', async () => {
  const e1 = await makeEvent('A');
  const e2 = await makeEvent('B');
  const a1 = await makeClaim(e1, DAY(1958, 3, 10)); // e1 基线（晚）
  const a2 = await makeClaim(e1, DAY(1958, 1, 1));  // e1 改选（早）
  const b1 = await makeClaim(e2, DAY(1958, 3, 1));  // e2 基线（早）→ e1(3-10) 先于 e2(3-1) 无解
  const b2 = await makeClaim(e2, DAY(1958, 3, 11)); // e2 改选（晚）
  await makeRel(e1, e2);

  const r = await call('POST', '/api/editor/suggestions/reselect', {
    body: {
      selection: [{ eventId: e1, claimId: a1 }, { eventId: e2, claimId: b1 }],
      draftRevision: await revision(),
    },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.changedEventCount, 1);
  // 改 e1 到 1-1 或改 e2 到 3-11 都可行；平手字典序：事件 e1 位 a1 vs a2（a1 小）→ 改 e2
  assert.strictEqual(r.json.changes[0].eventId, e2);
  assert.strictEqual(r.json.changes[0].toClaimId, b2);
});

test('当前选择本就可行：0 改选，无需变更', async () => {
  const e1 = await makeEvent('甲');
  const e2 = await makeEvent('乙');
  const c1 = await makeClaim(e1, DAY(1958, 1, 1));
  const c2 = await makeClaim(e2, DAY(1958, 1, 2));
  await makeRel(e1, e2);

  const r = await call('POST', '/api/editor/suggestions/reselect', {
    body: {
      selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }],
      draftRevision: await revision(),
    },
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.changedEventCount, 0);
  assert.deepStrictEqual(r.json.changes, []);
  assert.strictEqual(r.json.resolvedDates[0].resolvedDate, '1958-01-01');
});

test('所有组合均无解：422 NO_FEASIBLE_COMBINATION（无主张可救）', async () => {
  const e1 = await makeEvent('先');
  const e2 = await makeEvent('后');
  // 两事件都只有同一条「同一天」的日精度主张：e1 必须严格早于 e2，任何选择都不可能
  const c1 = await makeClaim(e1, DAY(1958, 5, 5));
  const c2 = await makeClaim(e2, DAY(1958, 5, 5));
  await makeRel(e1, e2);

  const r = await call('POST', '/api/editor/suggestions/reselect', {
    body: {
      selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }],
      draftRevision: await revision(),
    },
  });
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.json.code, 'NO_FEASIBLE_COMBINATION');
});

test('关系成环：422 CYCLE，无法靠改选解决', async () => {
  const e1 = await makeEvent('A');
  const e2 = await makeEvent('B');
  const c1 = await makeClaim(e1, YEAR(1958));
  const c2 = await makeClaim(e2, YEAR(1958));
  await makeRel(e1, e2);
  await makeRel(e2, e1);

  const r = await call('POST', '/api/editor/suggestions/reselect', {
    body: {
      selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }],
      draftRevision: await revision(),
    },
  });
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.json.code, 'CYCLE');
  assert.ok(r.json.errors[0].eventIds.includes(e1));
});

test('事件没有主张：422 NO_CLAIMS', async () => {
  const e1 = await makeEvent('有主张');
  const e2 = await makeEvent('空事件');
  const c1 = await makeClaim(e1, YEAR(1958));
  // 客户端可能传不存在的 claimId；结构状况是 e2 无任何主张
  const r = await call('POST', '/api/editor/suggestions/reselect', {
    body: {
      selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: 9999 }],
      draftRevision: await revision(),
    },
  });
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.json.code, 'NO_CLAIMS');
  assert.deepStrictEqual(r.json.eventIds, [e2]);
});

test('选择缺失 / 重复 / 主张不属于事件：明确 400 拒绝', async () => {
  const e1 = await makeEvent('甲');
  const e2 = await makeEvent('乙');
  const c1 = await makeClaim(e1, YEAR(1958));
  const c2 = await makeClaim(e2, YEAR(1959));
  const rev = await revision();

  // 缺失：只给了 e1
  const miss = await call('POST', '/api/editor/suggestions/reselect', {
    body: { selection: [{ eventId: e1, claimId: c1 }], draftRevision: rev },
  });
  assert.strictEqual(miss.status, 400);
  assert.strictEqual(miss.json.code, 'MISSING_SELECTION');
  assert.deepStrictEqual(miss.json.eventIds, [e2]);

  // 重复：e1 给了两条
  const dup = await call('POST', '/api/editor/suggestions/reselect', {
    body: {
      selection: [
        { eventId: e1, claimId: c1 },
        { eventId: e1, claimId: c1 },
        { eventId: e2, claimId: c2 },
      ],
      draftRevision: rev,
    },
  });
  assert.strictEqual(dup.status, 400);
  assert.strictEqual(dup.json.code, 'DUPLICATE_SELECTION');
  assert.deepStrictEqual(dup.json.eventIds, [e1]);

  // 主张不属于该事件：把 c2 挂给 e1
  const wrong = await call('POST', '/api/editor/suggestions/reselect', {
    body: {
      selection: [{ eventId: e1, claimId: c2 }, { eventId: e2, claimId: c2 }],
      draftRevision: rev,
    },
  });
  assert.strictEqual(wrong.status, 400);
  assert.strictEqual(wrong.json.code, 'BAD_SELECTION');
  assert.deepStrictEqual(wrong.json.eventIds, [e1]);

  // 主张 id 不存在
  const ghost = await call('POST', '/api/editor/suggestions/reselect', {
    body: {
      selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: 99999 }],
      draftRevision: rev,
    },
  });
  assert.strictEqual(ghost.status, 400);
  assert.strictEqual(ghost.json.code, 'BAD_SELECTION');
});

test('草稿修订号缺失或非法：400', async () => {
  const e1 = await makeEvent('甲');
  const c1 = await makeClaim(e1, YEAR(1958));
  const r1 = await call('POST', '/api/editor/suggestions/reselect', {
    body: { selection: [{ eventId: e1, claimId: c1 }] },
  });
  assert.strictEqual(r1.status, 400);
  const r2 = await call('POST', '/api/editor/suggestions/reselect', {
    body: { selection: [{ eventId: e1, claimId: c1 }], draftRevision: -1 },
  });
  assert.strictEqual(r2.status, 400);
});

test('修订号过期（预检后草稿被改）：409 SUGGESTION_STALE，不返回建议', async () => {
  const e1 = await makeEvent('冬月');
  const e2 = await makeEvent('春月');
  const c1 = await makeClaim(e1, MONTH(1958, 12));
  const c2 = await makeClaim(e2, MONTH(1958, 1));
  await makeRel(e1, e2);

  const oldRev = await revision();
  // 预检后草稿被他人增删改（修订号推进）
  await makeEvent('闯入事件');
  const newRev = await revision();
  assert.notStrictEqual(oldRev, newRev);

  const r = await call('POST', '/api/editor/suggestions/reselect', {
    body: {
      selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }],
      draftRevision: oldRev,
    },
  });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.code, 'SUGGESTION_STALE');
  assert.strictEqual(r.json.sentDraftRevision, oldRev);
  assert.strictEqual(r.json.currentDraftRevision, newRev);
  assert.strictEqual(r.json.changes, undefined);
});

test('建议只读：不推进修订号、不改草稿、不产生版本', async () => {
  const e1 = await makeEvent('冬月');
  const e2 = await makeEvent('春月');
  const c1 = await makeClaim(e1, MONTH(1958, 12));
  await makeClaim(e1, MONTH(1957, 12));
  const c2 = await makeClaim(e2, MONTH(1958, 1));
  await makeClaim(e2, MONTH(1959, 1));
  await makeRel(e1, e2);
  const rev = await revision();

  const r = await call('POST', '/api/editor/suggestions/reselect', {
    body: {
      selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }],
      draftRevision: rev,
    },
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(await revision(), rev); // 修订号不变
  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.published, false); // 未发布任何版本
});

test('改选建议接口需要编辑者口令', async () => {
  const r = await call('POST', '/api/editor/suggestions/reselect', {
    token: null,
    body: { selection: [], draftRevision: 0 },
  });
  assert.strictEqual(r.status, 401);
});

test('三事件链平手：字典序按事件 ID 序列择小（改事件 3 而非事件 1）', async () => {
  // 链 e1 先于 e2 先于 e3。e2 用宽月区间：它的日期由 e1 的下界传播决定。
  // 基线 e1=10日、e2=整月、e3=10日（被下界推到 11 日仍同日，无解）。
  //   改 e1 到 1 日：e2=2日、e3=10日 → 可行；改 e3 到 12 日：e1=10日、e2=11日、e3=12日 → 可行。
  // 两种都是 1 改选；按事件 id 序列，[a1,b1,c2] 第一位 a1 < [a2,b1,c1] 第一位 a2 → 改 e3。
  const e1 = await makeEvent('E1');
  const e2 = await makeEvent('E2');
  const e3 = await makeEvent('E3');
  const a1 = await makeClaim(e1, DAY(1958, 1, 10));
  const a2 = await makeClaim(e1, DAY(1958, 1, 1));
  const b1 = await makeClaim(e2, MONTH(1958, 1));
  const c1 = await makeClaim(e3, DAY(1958, 1, 10));
  const c2 = await makeClaim(e3, DAY(1958, 1, 12));
  await makeRel(e1, e2);
  await makeRel(e2, e3);

  const r = await call('POST', '/api/editor/suggestions/reselect', {
    body: {
      selection: [{ eventId: e1, claimId: a1 }, { eventId: e2, claimId: b1 }, { eventId: e3, claimId: c1 }],
      draftRevision: await revision(),
    },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.changedEventCount, 1);
  assert.deepStrictEqual(
    r.json.selection.map((s) => s.claimId),
    [a1, b1, c2]
  );
  assert.strictEqual(r.json.changes[0].eventId, e3);

  // 建议组合下：e1=10日、e2 被下界推到 11日、e3 改选后为 12日，严格递增
  const byEvent = Object.fromEntries(r.json.resolvedDates.map((d) => [d.eventId, d.resolvedDate]));
  assert.deepStrictEqual([byEvent[e1], byEvent[e2], byEvent[e3]], [
    '1958-01-10',
    '1958-01-11',
    '1958-01-12',
  ]);
});

test('同区间替代主张不影响结果（去重等价类）', async () => {
  // e1 先于 e2；给 e2 加一条与基线同区间的重复主张（更大 id），不应被选中
  const e1 = await makeEvent('先');
  const e2 = await makeEvent('后');
  const c1 = await makeClaim(e1, DAY(1958, 5, 5));
  const c2 = await makeClaim(e2, DAY(1958, 5, 6));
  const r = await call('POST', '/api/editor/suggestions/reselect', {
    body: {
      selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }],
      draftRevision: await revision(),
    },
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.changedEventCount, 0);
});
