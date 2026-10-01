'use strict';

// 发布预检出现「时间无解」时的改选建议（只读）。
//
// 输入：
//   selectionList: [{ eventId, claimId }] —— 预检时逐事件被选主张
//   draftRevision: 预检时的草稿修订号
//
// 只允许在各事件「现有主张」之间改选；「先于」关系与主张日期区间均不变。
// 在全部可行组合中：
//   1. 改选（与被选主张不同）的事件数最少；
//   2. 平手时，取事件 ID 升序排列后主张 ID 序列字典序最小者。
//
// 时间可行性与发布求解器一致：拓扑序传播下界 lower[v]，要求 lower[v] <= 区间终点。
// 按拓扑序逐个指派事件时，某事件一旦下界超出区间，其后任何选择都无法挽回
// （DAG 中后续事件不会把下界传回前序事件），可安全剪枝。
//
// 本模块只读草稿，绝不修改草稿或发布版本。

const { getDb } = require('./db');
const { solve, claimToInterval } = require('./solver');
const { isoFromOrdinal } = require('./dates');
const { getDraftRevision } = require('./draft');

// 穷举节点预算：超过即放弃穷举（不会武断宣称「无解」）。实际年表规模下用不到。
const NODE_LIMIT = Number(process.env.RESELECT_NODE_LIMIT) || 2_000_000;

function httpError(status, body) {
  throw Object.assign({ status }, body);
}

// ---------- 主入口 ----------
function buildReselectSuggestion({ selectionList, draftRevision }) {
  const db = getDb();

  // 修订号在计算前后各核对一次；不一致绝不返回（可能已过期的）建议。
  const revisionStart = getDraftRevision();
  if (draftRevision !== revisionStart) {
    throwStale(draftRevision, revisionStart);
  }

  const events = db.prepare('SELECT id, title, description FROM events ORDER BY id').all();
  const claims = db.prepare('SELECT * FROM claims ORDER BY id').all();
  const relations = db
    .prepare('SELECT id, earlier_id AS earlierId, later_id AS laterId, source, note FROM relations ORDER BY id')
    .all();

  validateSelection(events, selectionList);

  // 事件没有任何主张：无从改选（优先于主张归属校验——该事件的选择项不可能合法）
  const claimsByEvent = new Map(events.map((e) => [e.id, []]));
  for (const c of claims) {
    if (claimsByEvent.has(c.event_id)) claimsByEvent.get(c.event_id).push(c);
  }
  const noClaimEvents = events.filter((e) => claimsByEvent.get(e.id).length === 0);
  if (noClaimEvents.length) {
    httpError(422, {
      code: 'NO_CLAIMS',
      message:
        `以下事件没有任何时间主张，无法靠改选解决：${noClaimEvents.map((e) => `「${e.title}」`).join('、')}。` +
        '请先为这些事件补录主张。',
      eventIds: noClaimEvents.map((e) => e.id),
    });
  }

  validateClaimOwnership(events, claims, selectionList);

  const baseline = new Map(selectionList.map((s) => [s.eventId, s.claimId]));
  const selectedIntervals = new Map();
  const claimsById = new Map(claims.map((c) => [c.id, c]));
  for (const [eventId, claimId] of baseline) {
    selectedIntervals.set(eventId, claimToInterval(claimsById.get(claimId)));
  }

  // 用发布求解器对当前被选主张做结构性检查：成环 / 关系失效无法靠改选解决
  const baseResult = solve(events, selectedIntervals, relations);
  if (!baseResult.ok) {
    const structural = baseResult.errors.find((e) => e.type === 'cycle' || e.type === 'broken_relation');
    if (structural) {
      httpError(422, {
        code: structural.type === 'cycle' ? 'CYCLE' : 'BROKEN_RELATION',
        message:
          (structural.type === 'cycle'
            ? '「先于」关系成环，改选主张不能消除环：'
            : '存在指向已删除事件的关系，改选主张不能修复：') + structural.message,
        errors: baseResult.errors,
      });
    }
    // 其余即时间无解 —— 进入改选搜索
  }

  let result;
  if (baseResult.ok) {
    // 当前选择本就可行：改选数 0，无需搜索（0 改选的组合唯一）
    result = {
      changedEventCount: 0,
      chosenClaimIds: new Map(events.map((e) => [e.id, baseline.get(e.id)])),
      lowers: baseResult.dates,
      nodesVisited: 0,
    };
  } else {
    result = searchBestReselection({ events, claimsByEvent, baseline, relations });
    if (!result) {
      httpError(422, {
        code: 'NO_FEASIBLE_COMBINATION',
        message: '在不改变「先于」关系与各主张日期区间的前提下，所有现有主张组合都时间无解，无法靠改选解决。请调整关系或补录新的时间主张。',
      });
    }
  }

  // 计算期间草稿若被增删改（修订号变化），不返回可能已过期的建议
  const revisionEnd = getDraftRevision();
  if (revisionEnd !== revisionStart) {
    throwStale(revisionStart, revisionEnd);
  }

  return formatResult({ events, claimsById, baseline, relations, result, draftRevision: revisionEnd });
}

function throwStale(sentRevision, currentRevision) {
  httpError(409, {
    code: 'SUGGESTION_STALE',
    message:
      `草稿在预检后已被修改（提交的修订号 ${sentRevision}，当前修订号 ${currentRevision}），` +
      '本次改选建议可能已过期，请重新执行发布预检后再查看建议。',
    sentDraftRevision: sentRevision,
    currentDraftRevision: currentRevision,
  });
}

// ---------- 选择合法性（缺失 / 重复 / 事件是否齐全） ----------
function validateSelection(events, selectionList) {
  if (!Array.isArray(selectionList)) {
    httpError(400, { code: 'INVALID_SELECTION', message: 'selection 必须是数组' });
  }
  if (events.length === 0) {
    httpError(400, { code: 'INVALID_SELECTION', message: '草稿中没有事件，无法给出改选建议' });
  }
  const eventIds = new Set(events.map((e) => e.id));
  const titles = new Map(events.map((e) => [e.id, e.title]));
  const seen = new Set();
  const duplicate = [];
  for (const item of selectionList) {
    if (!item || typeof item !== 'object') {
      httpError(400, { code: 'INVALID_SELECTION', message: 'selection 中每项必须是 {eventId, claimId}' });
    }
    if (seen.has(item.eventId)) duplicate.push(item.eventId);
    seen.add(item.eventId);
  }
  if (duplicate.length) {
    httpError(400, {
      code: 'DUPLICATE_SELECTION',
      message: `逐事件被选主张中出现重复事件（每个事件只能给一条主张）：事件 id ${duplicate.join(', ')}`,
      eventIds: duplicate,
    });
  }

  const missing = events.filter((e) => !seen.has(e.id)).map((e) => e.id);
  const unknown = [...seen].filter((id) => !eventIds.has(id));
  if (unknown.length) {
    httpError(400, {
      code: 'INVALID_SELECTION',
      message: `选择中包含草稿不存在的事件 id：${unknown.join(', ')}`,
      eventIds: unknown,
    });
  }
  if (missing.length) {
    httpError(400, {
      code: 'MISSING_SELECTION',
      message:
        '逐事件被选主张缺失（必须为草稿中每个事件各给一条主张）：' +
        missing.map((id) => `「${titles.get(id) || id}」`).join('、'),
      eventIds: missing,
    });
  }
}

// 主张必须存在且属于对应事件
function validateClaimOwnership(events, claims, selectionList) {
  const titles = new Map(events.map((e) => [e.id, e.title]));
  const claimsById = new Map(claims.map((c) => [c.id, c]));
  const bad = [];
  for (const item of selectionList) {
    const claim = claimsById.get(item.claimId);
    if (!claim || claim.event_id !== item.eventId) bad.push(item.eventId);
  }
  if (bad.length) {
    httpError(400, {
      code: 'BAD_SELECTION',
      message:
        '以下事件被选主张不存在或不属于该事件，请重新预检：' +
        bad.map((id) => `「${titles.get(id) || id}」`).join('、'),
      eventIds: bad,
    });
  }
}

// ---------- 分支限界搜索 ----------
function searchBestReselection({ events, claimsByEvent, baseline, relations }) {
  const ids = events.map((e) => e.id);

  // 关系图（solve 已保证无环）与拓扑序
  const adj = new Map(ids.map((id) => [id, []]));
  const incoming = new Map(ids.map((id) => [id, []]));
  const indeg = new Map(ids.map((id) => [id, 0]));
  for (const r of relations) {
    adj.get(r.earlierId).push(r.laterId);
    incoming.get(r.laterId).push(r.earlierId);
    indeg.set(r.laterId, indeg.get(r.laterId) + 1);
  }
  const queue = ids.filter((id) => indeg.get(id) === 0);
  const topo = [];
  while (queue.length) {
    const id = queue.shift();
    topo.push(id);
    for (const to of adj.get(id)) {
      indeg.set(to, indeg.get(to) - 1);
      if (indeg.get(to) === 0) queue.push(to);
    }
  }
  if (topo.length !== ids.length) return null; // 理论不会：solve 已排除环

  const posInTopo = new Map(topo.map((id, i) => [id, i]));
  const eventIdsAsc = [...ids].sort((a, b) => a - b); // 平手字典序按事件 id 升序

  // 每事件候选：被选主张在首位（改选成本 0 优先），其余按主张 id 升序；
  // 起止区间完全相同的主张在时间可行性上等价，只保留最小 id 一条（字典序占优）。
  const candidates = new Map();
  let totalCombinations = 1n;
  for (const ev of events) {
    const opts = claimsByEvent.get(ev.id).map(claimToInterval); // 查询已按 claim id 升序
    const baseId = baseline.get(ev.id);
    const base = opts.find((c) => c.claimId === baseId);
    const rest = [];
    const seenIntervals = new Set();
    for (const c of opts) {
      if (c.claimId === baseId) continue;
      const key = `${c.startOrd}:${c.endOrd}`;
      if (seenIntervals.has(key)) continue;
      seenIntervals.add(key);
      rest.push(c);
    }
    rest.sort((a, b) => a.claimId - b.claimId);
    candidates.set(ev.id, [base, ...rest]);
    totalCombinations *= BigInt(opts.length);
  }

  let best = null; // { cost, seq: Map(eventId->claimId), lowers: Map(eventId->ord) }
  let nodesVisited = 0;
  let aborted = false;
  const chosen = new Map();
  const lower = new Map();

  // 已固定前缀（事件 id 升序中、未指派最小 id 之前的位置）是否已严格劣于最优
  function prefixWorse(depth) {
    if (!best) return false;
    for (const id of eventIdsAsc) {
      if (posInTopo.get(id) >= depth) break; // 该事件尚未指派，其后位置都可能改变
      const cur = chosen.get(id);
      const old = best.seq.get(id);
      if (cur > old) return true;
      if (cur < old) return false;
    }
    return false;
  }

  function dfs(depth, cost) {
    if (++nodesVisited > NODE_LIMIT) { aborted = true; return; }
    if (best && cost > best.cost) return;
    if (prefixWorse(depth)) return;

    if (depth === topo.length) {
      if (!best || cost < best.cost) {
        best = { cost, seq: new Map(chosen), lowers: new Map(lower) };
      } else if (cost === best.cost) {
        // 平手：完整主张 id 序列字典序择小
        let smaller = false;
        for (const id of eventIdsAsc) {
          if (chosen.get(id) < best.seq.get(id)) { smaller = true; break; }
          if (chosen.get(id) > best.seq.get(id)) return;
        }
        if (smaller) best = { cost, seq: new Map(chosen), lowers: new Map(lower) };
      }
      return;
    }

    const id = topo[depth];
    const baseId = baseline.get(id);
    for (const c of candidates.get(id)) {
      let lo = c.startOrd;
      for (const u of incoming.get(id)) {
        const cand = lower.get(u) + 1; // 严格晚于：至少 +1 日
        if (cand > lo) lo = cand;
      }
      if (lo > c.endOrd) continue; // 拓扑前缀已矛盾，后续选择无法挽回
      lower.set(id, lo);
      chosen.set(id, c.claimId);
      dfs(depth + 1, cost + (c.claimId === baseId ? 0 : 1));
      lower.delete(id);
      chosen.delete(id);
      if (aborted) return;
    }
  }

  dfs(0, 0);
  if (aborted) {
    httpError(422, {
      code: 'SUGGESTION_TOO_COMPLEX',
      message: `改选搜索超出节点预算（${NODE_LIMIT}），未能判定是否存在可行组合；未返回任何建议。请缩小草稿规模或先调整部分关系后重试。`,
    });
  }
  if (!best) return null;

  return {
    changedEventCount: best.cost,
    chosenClaimIds: best.seq,
    lowers: best.lowers,
    nodesVisited,
    totalCombinations,
  };
}

// ---------- 响应组装 ----------
function formatResult({ events, claimsById, baseline, result, draftRevision }) {
  const changes = [];
  const selection = [];
  const resolvedDates = [];

  for (const ev of events) {
    const fromClaimId = baseline.get(ev.id);
    const toClaimId = result.chosenClaimIds.get(ev.id);
    selection.push({ eventId: ev.id, claimId: toClaimId });
    if (toClaimId !== fromClaimId) {
      changes.push({
        eventId: ev.id,
        title: ev.title,
        fromClaimId,
        toClaimId,
        fromClaim: claimSummary(claimsById.get(fromClaimId)),
        toClaim: claimSummary(claimsById.get(toClaimId)),
      });
    }
  }
  changes.sort((a, b) => a.eventId - b.eventId);

  for (const ev of events) {
    const claimId = result.chosenClaimIds.get(ev.id);
    resolvedDates.push({
      eventId: ev.id,
      title: ev.title,
      claimId,
      resolvedDate: isoFromOrdinal(result.lowers.get(ev.id)),
    });
  }
  // 与预检响应一致：按求解日期排列，同日按标题
  resolvedDates.sort((a, b) =>
    a.resolvedDate.localeCompare(b.resolvedDate) || a.title.localeCompare(b.title, 'zh-Hans-CN')
  );

  const body = {
    ok: true,
    draftRevision,
    changedEventCount: result.changedEventCount,
    changes,
    selection,
    resolvedDates,
    nodesVisited: result.nodesVisited || 0,
  };
  if (result.totalCombinations != null) {
    body.totalCombinations =
      result.totalCombinations <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(result.totalCombinations)
        : result.totalCombinations.toString();
  }
  return body;
}

function claimSummary(c) {
  return {
    claimId: c.id,
    precision: c.precision,
    dateLabel: c.date_label,
    intervalStart: c.interval_start,
    intervalEnd: c.interval_end,
    source: c.source,
  };
}

module.exports = { buildReselectSuggestion };
