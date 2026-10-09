// 泸州鬼麻将（血战到底）核心逻辑 —— 纯函数，可单测
// 牌编码: 0-8=一万..九万, 9-17=一筒..九筒, 18-26=一条..九条, 27=红中(鬼牌)

export const TILE_RED = 27;
export const SUIT_NAMES = ["万", "筒", "条"];
export const MAX_FAN = 40;

export function suitOf(t) { return t === TILE_RED ? 3 : Math.floor(t / 9); }
export function rankOf(t) { return t === TILE_RED ? 0 : (t % 9) + 1; }
export function tileName(t) {
  if (t === TILE_RED) return "红中";
  return rankOf(t) + SUIT_NAMES[suitOf(t)];
}
export function isRed(t) { return t === TILE_RED; }

export function buildWall() {
  const w = [];
  for (let t = 0; t < 27; t++) for (let k = 0; k < 4; k++) w.push(t);
  for (let k = 0; k < 4; k++) w.push(TILE_RED);
  return w; // 112张
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
export function sortHand(hand) {
  return hand.slice().sort((a, b) => a - b);
}
// 从手牌移除指定牌（每张只移除一张），成功返回新数组
export function removeTiles(hand, tiles) {
  const h = hand.slice();
  for (const t of tiles) {
    const i = h.indexOf(t);
    if (i < 0) return null;
    h.splice(i, 1);
  }
  return h;
}
export function countOf(hand, t) { return hand.filter(x => x === t).length; }

// ============ 胡牌判定（含鬼牌） ============
function checkSevenPairs(counts, wild) {
  let pairs = 0, singles = 0, luxury = false;
  for (let i = 0; i < 27; i++) {
    const c = counts[i];
    pairs += Math.floor(c / 2);
    if (c % 2 === 1) singles++;
    if (c === 4) luxury = true;
  }
  // 单张需1张鬼配对，剩余鬼两两配对
  if (singles > wild || (wild - singles) % 2 !== 0) return null;
  return { luxury, wildUsed: wild };
}

function checkMelds(counts, wild, need) {
  // counts可变数组；返回 {wildUsed, allPung} 或 null
  if (need === 0) return { wildUsed: 0, allPung: true };
  let i = -1;
  for (let k = 0; k < 27; k++) if (counts[k] > 0) { i = k; break; }
  if (i < 0) {
    return wild >= need * 3 ? { wildUsed: need * 3, allPung: true } : null;
  }
  let best = null;
  const rank = (i % 9) + 1;
  // 刻子
  {
    const have = Math.min(counts[i], 3), wneed = 3 - have;
    if (wneed <= wild) {
      counts[i] -= have;
      const sub = checkMelds(counts, wild - wneed, need - 1);
      counts[i] += have;
      if (sub) {
        const wu = sub.wildUsed + wneed;
        if (!best || wu < best.wildUsed) best = { wildUsed: wu, allPung: sub.allPung };
      }
    }
  }
  // 顺子
  if (rank <= 7) {
    const j = i + 1, k = i + 2;
    const wneed = (counts[j] > 0 ? 0 : 1) + (counts[k] > 0 ? 0 : 1);
    if (wneed <= wild) {
      const dj = counts[j] > 0 ? 1 : 0, dk = counts[k] > 0 ? 1 : 0;
      counts[i]--; counts[j] -= dj; counts[k] -= dk;
      const sub = checkMelds(counts, wild - wneed, need - 1);
      counts[i]++; counts[j] += dj; counts[k] += dk;
      if (sub) {
        const wu = sub.wildUsed + wneed;
        if (!best || wu < best.wildUsed) best = { wildUsed: wu, allPung: false };
      }
    }
  }
  return best;
}

function checkNormal(counts, wild) {
  let best = null;
  const consider = (cc, w, jiangWild) => {
    const r = checkMelds(cc, w, 4);
    if (r && (!best || r.wildUsed < best.wildUsed))
      best = { wildUsed: r.wildUsed, allPung: r.allPung, jiangWild };
  };
  for (let j = 0; j < 27; j++) {
    const c = counts[j];
    if (c >= 2) { const cc = counts.slice(); cc[j] -= 2; consider(cc, wild, false); }
    else if (c === 1 && wild >= 1) { const cc = counts.slice(); cc[j] -= 1; consider(cc, wild - 1, true); }
  }
  if (wild >= 2) consider(counts.slice(), wild - 2, true);
  return best;
}

// 分析14张牌（手牌，含红中）+ 副露，返回胡牌分析或 null
// 换缺制：胡牌时手牌必须缺至少一门（不能三门齐全），红中为鬼牌不计花色
export function analyzeWin(hand14, melds) {
  if (hand14.length !== 14) return null;
  const counts = new Array(27).fill(0);
  let wild = 0;
  let redCount = 0;
  const suits = new Set();
  for (const t of hand14) {
    if (t === TILE_RED) { wild++; redCount++; continue; }
    counts[t]++; suits.add(suitOf(t));
  }
  for (const m of melds) {
    suits.add(suitOf(m.tile));
    if (m.tile === TILE_RED) redCount += (m.type === "kong" ? 4 : 3);
  }
  if (suits.size >= 3) return null; // 三门齐全，不能胡（换缺制）
  const qingyise = suits.size === 1;

  let best = null;
  // 七对（不能有副露）
  if (melds.length === 0) {
    const qp = checkSevenPairs(counts, wild);
    if (qp) best = { pattern: qp.luxury ? "豪华七对" : "小七对", baseFan: qp.luxury ? 5 : 4 };
  }
  // 一般型
  const np = checkNormal(counts, wild);
  if (np) {
    const cand = np.allPung
      ? { pattern: "大对子", baseFan: 2 }
      : { pattern: "平胡", baseFan: 0 };
    if (!best || cand.baseFan > best.baseFan) best = cand;
  }
  if (!best) return null;

  let fan = best.baseFan;
  const tags = [best.pattern];
  if (qingyise) { fan += 4; tags.push("清一色"); }
  const gen = melds.filter(m => m.type !== "pong").length + wild; // 杠+红中=根
  if (gen > 0) { fan += gen; tags.push(`根×${gen}`); }
  fan = Math.min(fan, MAX_FAN);
  const wugui = redCount === 0; // 无鬼：胡牌时手牌+副露中无红中
  if (wugui) tags.push("无鬼");
  return { ok: true, pattern: best.pattern, qingyise, gen, fan, tags, wild, wugui, redCount };
}

// 点炮是否允许：平胡只能自摸，大牌（大对子/七对/清一色）可点炮
export function canDianPao(analysis) {
  return analysis.pattern !== "平胡" || analysis.qingyise;
}

// 番数→分数：2→5→10→20→40（翻倍跳过4，40封顶）
export function fanToScore(fan) {
  if (fan <= 0) return 2;
  if (fan === 1) return 5;
  if (fan === 2) return 10;
  if (fan === 3) return 20;
  return 40;
}

// 最终番数（含自摸/杠上花等修正），返回 {fan, score, tags}
export function finalFan(analysis, { isSelf = false, gangShang = false, gangPao = false, qiangGang = false } = {}) {
  let fan = analysis.fan;
  const tags = analysis.tags.slice();
  if (gangShang) { fan += 2; tags.push("杠上花"); }
  else if (isSelf) { fan += 1; tags.push("自摸"); }
  if (gangPao) { fan += 1; tags.push("杠上炮"); }
  if (qiangGang) { fan += 1; tags.push("抢杠"); }
  fan = Math.min(fan, MAX_FAN);
  let score = fanToScore(fan);
  if (analysis.wugui) score = Math.min(score * 8, 40); // 无鬼翻八倍，封顶40
  return { fan, score, tags, wugui: !!analysis.wugui };
}

// 听牌分析：13张手牌，返回 {tiles:[能胡的牌], maxFan}
export function tingInfo(hand13, melds) {
  const tiles = [];
  let maxFan = 0;
  for (let t = 0; t <= TILE_RED; t++) {
    const a = analyzeWin(hand13.concat([t]), melds);
    if (a) {
      const f = finalFan(a, { isSelf: true });
      tiles.push(t);
      if (f.fan > maxFan) maxFan = f.fan;
    }
  }
  return { tiles, maxFan, ting: tiles.length > 0 };
}

// ============ 对局流程 ============
export const GANG_SCORE = { direct: 4, added: 2, concealed: 0 }; // 直杠4(点杠者出)；补杠每家2；暗杠不下雨(0)，只计根

export class MJGame {
  constructor(seed, dealer = 0, names = ["东", "南", "西", "北"]) {
    this.seed = seed === undefined ? (Date.now() % 2147483647) : seed;
    this.rng = mulberry32(this.seed);
    this.dealer = dealer;
    this.turn = dealer;
    this.phase = "playing"; // playing -> roundOver（换缺制：不定缺）
    this.round = 1;
    this.wall = shuffle(buildWall(), this.rng);
    this.players = names.map((name, i) => ({
      name, seat: i, hand: [], melds: [], discards: [],
      hu: null, huOrder: 0, score: 0,
    }));
    // 发牌：每人13张，庄家14张
    for (let k = 0; k < 13; k++)
      for (let i = 0; i < 4; i++) this.players[i].hand.push(this.wall.pop());
    this.players[dealer].hand.push(this.wall.pop());
    this.players.forEach(p => { p.hand = sortHand(p.hand); });
    this.claim = null;       // {tile, from, options:{seat:[...]}, responses:{}}
    this.turnDraw = null;    // 本回合摸到的牌
    this.turnKongDraw = false; // 是否杠后摸牌（杠上花判定）
    this.lastDiscard = null; // {tile, from}
    this.huCount = 0;
    this.transactions = [];  // 杠分流水 {from, to, amount}
    this.log = [];
    this.result = null;
    this.firstTurn = true; // 庄家14张首回合直接打，不摸牌
  }

  pushLog(s) { this.log.push(s); if (this.log.length > 120) this.log.shift(); }
  aliveSeats() { const r = []; this.players.forEach((p, i) => { if (!p.hu) r.push(i); }); return r; }

  startPlay() {
    this.phase = "playing";
    this.turn = this.dealer;
    this.pushLog(`🎲 开局！${this.players[this.dealer].name} 坐庄先打`);
    return true;
  }

  // ---- 摸牌 ----
  // 回合开始摸牌，返回 {tile, canHu, kongs:[{type}], wallEmpty}
  drawForTurn() {
    if (this.phase !== "playing") return null;
    const p = this.players[this.turn];
    if (this.wall.length === 0) return { wallEmpty: true };
    const tile = this.wall.pop();
    p.hand.push(tile); p.hand = sortHand(p.hand);
    this.turnDraw = tile; this.turnKongDraw = false;
    const canHu = this.canSelfHu(this.turn);
    const kongs = this.selfKongs(this.turn);
    return { tile, canHu, kongs, wallEmpty: false };
  }
  // 杠后从牌墙尾摸牌
  kongDraw() {
    const p = this.players[this.turn];
    if (this.wall.length === 0) return { wallEmpty: true };
    const tile = this.wall.pop();
    p.hand.push(tile); p.hand = sortHand(p.hand);
    this.turnDraw = tile; this.turnKongDraw = true;
    const canHu = this.canSelfHu(this.turn, true);
    const kongs = this.selfKongs(this.turn);
    return { tile, canHu, kongs, wallEmpty: false };
  }

  hand14(seat) { return this.players[seat].hand; } // 摸牌后14张

  canSelfHu(seat, gangShang = false) {
    const p = this.players[seat];
    if (p.hand.length !== 14) return null;
    const a = analyzeWin(p.hand, p.melds);
    if (!a) return null;
    return finalFan(a, { isSelf: true, gangShang });
  }

  // 自己回合可杠：[{type:"concealed", tile}, {type:"added", tile}]
  selfKongs(seat) {
    const p = this.players[seat], out = [];
    for (let t = 0; t < 27; t++) {
      if (countOf(p.hand, t) === 4) out.push({ type: "concealed", tile: t });
    }
    for (const m of p.melds) {
      if (m.type === "pong" && p.hand.includes(m.tile)) out.push({ type: "added", tile: m.tile });
    }
    return out;
  }

  // ---- 打牌 ----
  // 打出一张牌：校验（不能打红中；有缺必须打缺），返回 claim 信息或 null（无事发生）
  discard(seat, tile) {
    const p = this.players[seat];
    if (this.phase !== "playing" || p.hu) return { error: "状态错误" };
    if (!p.hand.includes(tile)) return { error: "手里没这张牌" };
    p.hand = removeTiles(p.hand, [tile]);
    p.discards.push(tile);
    this.lastDiscard = { tile, from: seat };
    this.pushLog(`${p.name} 打出 ${tileName(tile)}`);
    // 红中打出后别人不能碰/杠/胡（只能过）
    if (tile === TILE_RED) return { claim: null };
    // 计算其他人的 claim 选项
    const options = {};
    for (const s of this.aliveSeats()) {
      if (s === seat) continue;
      const acts = [];
      const huA = this.canHuOnDiscard(s, tile);
      if (huA) acts.push("hu");
      if (this.canPong(s, tile)) acts.push("pong");
      if (this.canKongDirect(s, tile)) acts.push("kong");
      if (acts.length) options[s] = acts;
    }
    if (Object.keys(options).length === 0) return { claim: null };
    this.claim = { tile, from: seat, options, responses: {} };
    return { claim: this.claim };
  }

  canPong(seat, tile) {
    const p = this.players[seat];
    if (p.hu || tile === TILE_RED) return false;
    return countOf(p.hand, tile) >= 2;
  }
  canKongDirect(seat, tile) {
    const p = this.players[seat];
    if (p.hu || tile === TILE_RED) return false;
    return countOf(p.hand, tile) === 3;
  }
  // 别人打出的牌能否胡（点炮：大牌才能）
  canHuOnDiscard(seat, tile) {
    const p = this.players[seat];
    if (p.hu || tile === TILE_RED) return null;
    const a = analyzeWin(p.hand.concat([tile]), p.melds);
    if (!a || !canDianPao(a)) return null;
    return finalFan(a, { isSelf: false });
  }

  // ---- claim 结算 ----
  // responses: {seat: "hu"|"pong"|"kong"|"pass"}，缺席视为 pass
  resolveClaim(responses = {}) {
    const c = this.claim;
    if (!c) return null;
    this.claim = null;
    const huSeats = Object.keys(c.options)
      .map(Number)
      .filter(s => (responses[s] || "pass") === "hu" && c.options[s].includes("hu"));
    if (huSeats.length > 0) {
      // 一炮多响
      const results = [];
      for (const s of huSeats) {
        const f = this.canHuOnDiscard(s, c.tile);
        results.push(this.applyHu(s, { isSelf: false, from: c.from, fan: f }));
      }
      return { type: "hu", seats: huSeats, results };
    }
    // 碰/杠：按离点炮者最近的顺位
    const order = [1, 2, 3].map(k => (c.from + k) % 4).filter(s => this.aliveSeats().includes(s));
    for (const s of order) {
      const r = responses[s] || "pass";
      if (r === "kong" && c.options[s].includes("kong")) { this.applyKongDirect(s, c.tile, c.from); return { type: "kong", seat: s }; }
      if (r === "pong" && c.options[s].includes("pong")) { this.applyPong(s, c.tile, c.from); return { type: "pong", seat: s }; }
    }
    return { type: "none" };
  }

  applyPong(seat, tile, from) {
    const p = this.players[seat];
    p.hand = removeTiles(p.hand, [tile, tile]);
    p.melds.push({ type: "pong", tile, from });
    this.turn = seat;
    this.pushLog(`🀄 ${p.name} 碰 ${tileName(tile)}`);
  }
  applyKongDirect(seat, tile, from) {
    const p = this.players[seat];
    p.hand = removeTiles(p.hand, [tile, tile, tile]);
    p.melds.push({ type: "kongD", tile, from });
    this.scoreGang(seat, [from], GANG_SCORE.direct, "直杠");
    this.turn = seat;
    this.pushLog(`🀄 ${p.name} 直杠 ${tileName(tile)}`);
    return true; // 杠后需摸牌
  }
  // 补杠：返回可抢杠的人（先检查），调用方确认无人抢后再调 confirmKongAdded
  checkQiangGang(seat, tile) {
    const seats = [];
    for (const s of this.aliveSeats()) {
      if (s === seat) continue;
      const p = this.players[s];
      const a = analyzeWin(p.hand.concat([tile]), p.melds);
      if (a && canDianPao(a)) seats.push(s);
    }
    return seats;
  }
  confirmKongAdded(seat, tile) {
    const p = this.players[seat];
    p.hand = removeTiles(p.hand, [tile]);
    const m = p.melds.find(m => m.type === "pong" && m.tile === tile);
    if (m) m.type = "kongA";
    const others = this.aliveSeats().filter(s => s !== seat);
    this.scoreGang(seat, others, GANG_SCORE.added, "补杠");
    this.pushLog(`🀄 ${p.name} 补杠 ${tileName(tile)}`);
    return true;
  }
  applyKongConcealed(seat, tile) {
    const p = this.players[seat];
    p.hand = removeTiles(p.hand, [tile, tile, tile, tile]);
    p.melds.push({ type: "kongC", tile });
    // 泸州鬼麻：暗杠不下雨（无即时杠钱），只计1根，胡牌时结算
    this.pushLog(`🀄 ${p.name} 暗杠 ${tileName(tile)}（计1根）`);
    return true;
  }
  scoreGang(to, fromSeats, per, label) {
    for (const f of fromSeats) {
      this.players[f].score -= per;
      this.players[to].score += per;
      this.transactions.push({ from: f, to, amount: per, kind: "gang", label });
    }
    this.pushLog(`💰 ${this.players[to].name} ${label} +${per * fromSeats.length}`);
  }

  // ---- 胡牌 ----
  applyHu(seat, { isSelf, from = null, fan, gangShang = false, qiangGang = false, gangPao = false }) {
    const p = this.players[seat];
    p.hu = { fan: fan.fan, score: fan.score, tags: fan.tags, isSelf, from, gangShang, qiangGang, gangPao };
    p.huOrder = ++this.huCount;
    const payers = isSelf
      ? this.aliveSeats().filter(s => s !== seat)
      : [from];
    for (const s of payers) this.players[s].score -= fan.score;
    p.score += fan.score * payers.length;
    const how = gangShang ? "杠上花" : qiangGang ? "抢杠" : gangPao ? "杠上炮" : isSelf ? "自摸" : "点炮";
    this.pushLog(`🎉 ${p.name} ${["一", "二", "三"][p.huOrder - 1]}胡！${how} ${fan.tags.join("+")} = ${fan.fan}番 +${fan.score * payers.length}分`);
    return p.hu;
  }
  selfHu(seat, { gangShang = false } = {}) {
    const f = this.canSelfHu(seat, gangShang);
    if (!f) return null;
    return this.applyHu(seat, { isSelf: true, fan: f, gangShang });
  }

  nextAlive(from) {
    for (let k = 1; k <= 4; k++) {
      const s = (from + k) % 4;
      if (!this.players[s].hu) return s;
    }
    return from;
  }

  isRoundOver() {
    return this.huCount >= 3 || this.wall.length === 0;
  }

  // ---- 流局结算：查花猪、查叫、退杠钱 ----
  settle() {
    if (this.phase === "roundOver") return this.result;
    this.phase = "roundOver";
    const res = { liuju: this.huCount < 3, huaZhu: [], chaJiao: [], gangRefund: [] };
    if (res.liuju) {
      // 1. 查花猪
      for (let s = 0; s < 4; s++) {
        const p = this.players[s];
        if (p.hu) continue;
        const suits = new Set();
        for (const t of p.hand) if (t !== TILE_RED) suits.add(suitOf(t));
        for (const m of p.melds) suits.add(suitOf(m.tile));
        if (suits.size >= 3) {
          res.huaZhu.push(s);
          for (let o = 0; o < 4; o++) {
            if (o === s) continue;
            this.players[o].score += 40;
            this.players[s].score -= 40;
          }
          this.pushLog(`🐷 ${p.name} 花猪！赔每人 40 分`);
        }
      }
      // 2. 查叫
      const ting = [], noTing = [];
      for (let s = 0; s < 4; s++) {
        const p = this.players[s];
        if (p.hu || res.huaZhu.includes(s)) continue;
        const ti = tingInfo(p.hand, p.melds);
        p.tingInfo = ti;
        (ti.ting ? ting : noTing).push(s);
      }
      for (const s of noTing) {
        const p = this.players[s];
        const maxFan = p.tingInfo.maxFan;
        for (const t of ting) {
          const amt = maxFan * 2;
          this.players[t].score += amt;
          p.score -= amt;
        }
        res.chaJiao.push({ seat: s, maxFan, paidTo: ting });
        this.pushLog(`📢 ${p.name} 没下叫，赔下叫玩家 ${maxFan}番`);
      }
      // 3. 没叫的人退杠钱
      const refunded = new Set(noTing);
      for (const tr of this.transactions) {
        if (tr.kind === "gang" && refunded.has(tr.to)) {
          this.players[tr.from].score += tr.amount;
          this.players[tr.to].score -= tr.amount;
          res.gangRefund.push(tr);
        }
      }
      if (res.gangRefund.length) this.pushLog(`↩️ 没叫玩家退回杠分`);
    }
    // 下局庄家：一胡坐庄，流局连庄
    const firstHu = this.players.find(p => p.huOrder === 1);
    res.nextDealer = firstHu ? firstHu.seat : this.dealer;
    this.result = res;
    return res;
  }

  // 序列化（给服务器存档/广播）
  toJSON() {
    return {
      seed: this.seed, dealer: this.dealer, turn: this.turn, phase: this.phase, round: this.round,
      wall: this.wall, players: this.players, claim: this.claim, turnDraw: this.turnDraw,
      turnKongDraw: this.turnKongDraw, lastDiscard: this.lastDiscard, huCount: this.huCount,
      transactions: this.transactions, log: this.log.slice(-40), result: this.result,
    };
  }
  static fromJSON(d) {
    const g = Object.create(MJGame.prototype);
    Object.assign(g, d);
    g.rng = mulberry32(d.seed + d.round * 7919 + d.wall.length);
    return g;
  }
}

// ============ 简单 AI ============
// 打牌：先打缺；否则打孤张（邻张少、不靠对）
export function aiDiscard(hand) {
  // 换缺制：优先打出手牌数最少的花色，向"缺一门"靠拢；红中先留着当鬼牌
  const cnt = [0, 0, 0];
  for (const t of hand) if (t !== TILE_RED) cnt[suitOf(t)]++;
  // 找出数量最少且非零的花色（优先打光它）
  let target = -1, min = 99;
  for (let s = 0; s < 3; s++) if (cnt[s] > 0 && cnt[s] < min) { min = cnt[s]; target = s; }
  const noRed = hand.filter(t => t !== TILE_RED);
  const pool = target >= 0 ? noRed.filter(t => suitOf(t) === target) : noRed;
  const usePool = pool.length > 0 ? pool : noRed;
  const score = (t) => {
    let s = 0;
    const su = suitOf(t), r = rankOf(t);
    for (const o of hand) {
      if (o === TILE_RED || o === t) continue;
      if (suitOf(o) !== su) continue;
      const d = Math.abs(rankOf(o) - r);
      if (d === 0) s += 4;
      else if (d === 1) s += 2;
      else if (d === 2) s += 1;
    }
    if (r === 1 || r === 9) s -= 1; // 边张略减
    return s;
  };
  let bt = usePool[0], bs = Infinity;
  for (const t of usePool) { const s = score(t); if (s < bs) { bs = s; bt = t; } }
  return bt !== undefined ? bt : hand[0];
}
// 是否碰：非缺门就碰（七对倾向不碰：对子>=4时跳过）
export function aiWantPong(hand, melds, tile) {
  let pairs = 0;
  for (let t = 0; t < 27; t++) if (countOf(hand, t) >= 2) pairs++;
  if (pairs >= 4) return false; // 疑似七对，不碰
  return true;
}
