// 麻将 Worker：DO 房间 + WebSocket，服务器仲裁
/*__MJ_CORE__*/

const AVATAR_IDS = ["astro", "fox", "panda", "robot"];

function publicRoom(room) {
  const g = room.game ? MJGame.fromJSON(room.game) : null;
  return {
    code: room.code, phase: room.phase,
    players: room.players.map(p => ({ name: p.name, avatar: p.avatar, seat: p.seat, connected: !!p.connected, isAI: !!p.isAI })),
    game: room.game ? publicGame(room, g) : null,
    totals: room.totals || [0, 0, 0, 0],
    round: room.round || 1,
  };
}
// 每个玩家只能看到自己的手牌
function publicGame(room, g) {
  const me = room.viewSeat;
  return {
    dealer: g.dealer, turn: g.turn, phase: g.phase, round: g.round,
    wallCount: g.wall.length, huCount: g.huCount,
    players: g.players.map((p, i) => ({
      name: p.name, seat: i, handCount: p.hand.length,
      hand: i === me ? p.hand : null,
      melds: p.melds, discards: p.discards.slice(-12),
      hu: p.hu, score: p.score,
    })),
    claim: room.claim ? { ...room.claim, deadline: room.claim.deadline } : null,
    turnInfo: room.turnInfo && g.turn === me ? room.turnInfo : null,
    qianggang: room.qianggang && room.qianggang.seat === me ? { tile: room.qianggang.tile } : null,
    lastDiscard: g.lastDiscard,
    log: g.log.slice(-30),
    result: g.result,
  };
}

export class GameRoom {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }

  async _load() {
    const d = await this.ctx.storage.get("room");
    return d || null;
  }
  async _save(room) { await this.ctx.storage.put("room", room); }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
      const pid = url.searchParams.get("pid") || ("p" + Math.random().toString(36).slice(2, 10));
      const name = (url.searchParams.get("name") || "牌友").slice(0, 12);
      let avatar = url.searchParams.get("avatar") || "🐲";
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      await this._join(pid, name, avatar, server);
      if (!this._joinOk) return new Response(this._joinErr || "加入失败", { status: 403 });
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ pid });
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("majiang", { status: 200 });
  }

  async webSocketMessage(ws, message) {
    const att = ws.deserializeAttachment() || {};
    let msg;
    try { msg = JSON.parse(message); } catch (e) { return; }
    if (msg.t === "ping") { try { ws.send(JSON.stringify({ t: "pong" })); } catch (e) {} return; }
    const room = await this._load();
    if (!room) return;
    const me = room.players.find(p => p.id === att.pid);
    if (!me || me.isAI) return;
    room.lastActionAt = Date.now();
    const err = (m) => { try { ws.send(JSON.stringify({ t: "error", msg: m })); } catch (e) {} };
    await this._handleMessage(room, me, msg, ws, err);
  }

  async webSocketClose(ws, code, reason, wasClean) {
    const att = ws.deserializeAttachment() || {};
    const room = await this._load();
    if (!room) return;
    const me = room.players.find(p => p.id === att.pid);
    if (me) { me.connected = false; await this._save(room); this._broadcast(room); }
  }
  async webSocketError(ws, error) { /* ignore */ }

  async _join(pid, name, avatar, server) {
    this._joinOk = false;
    let room = await this._load();
    if (!room) {
      room = { code: "", phase: "lobby", players: [], game: null, totals: [0, 0, 0, 0], round: 1,
        claim: null, turnInfo: null, qianggang: null, viewSeat: 0, lastActionAt: Date.now() };
    }
    let me = room.players.find(p => p.id === pid);
    if (!me) {
      if (room.phase !== "lobby") { this._joinErr = "游戏已开始，无法加入"; return; }
      if (room.players.length >= 4) {
        const aiIdx = room.players.map((p, i) => p.isAI ? i : -1).filter(i => i >= 0).pop();
        if (aiIdx === undefined) { this._joinErr = "房间已满"; return; }
        me = { id: pid, name, avatar, seat: room.players[aiIdx].seat, connected: true };
        room.players[aiIdx] = me;
      } else {
        me = { id: pid, name, avatar, seat: room.players.length, connected: true };
        room.players.push(me);
      }
    } else {
      me.connected = true; me.name = name; me.avatar = avatar;
    }
    await this._save(room);
    this._joinOk = true;
    this._broadcast(room);
  }

  _broadcast(room, viewSeat = null) {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment?.() || {};
      const pl = room.players.find(p => p.id === att.pid);
      if (!pl) continue;
      try {
        room.viewSeat = pl.seat;
        const pr = publicRoom(room);
        pr.you = pl.seat;
        ws.send(JSON.stringify({ t: "state", room: pr }));
      } catch (e) { /* ignore */ }
    }
    // 闹钟：claim超时 / 断线托管（20秒检查）
    try {
      if (room.claim) this.ctx.storage.setAlarm(room.claim.deadline + 500).catch(() => {});
      else if (room.phase === "playing") this.ctx.storage.setAlarm(Date.now() + 20000).catch(() => {});
      else this.ctx.storage.deleteAlarm().catch(() => {});
    } catch (e) {}
  }

  async alarm() {
    const room = await this._load();
    if (!room) return;
    // 1. claim 超时
    if (room.claim && Date.now() >= room.claim.deadline) {
      const g = MJGame.fromJSON(room.game);
      if (room.qianggang) {
        const { seat, tile } = room.qianggang;
        room.qianggang = null; room.claim = null;
        g.confirmKongAdded(seat, tile);
        await this._afterKong(room, g, seat);
        return;
      }
      const responses = {};
      for (const s of Object.keys(room.claim.options)) responses[s] = room.claim.responses[s] || "pass";
      room.claim = null;
      await this._resolveClaim(room, g, responses);
      return;
    }
    if (!room.game) return;
    const g = MJGame.fromJSON(room.game);
    // 3. 对局中断线托管
    if (g.phase === "playing" && !room.claim && !room.qianggang && !g.isRoundOver()) {
      const seat = g.turn;
      const pl = room.players[seat];
      if (pl && !pl.isAI && !pl.connected && !g.players[seat].hu) {
        if (Date.now() - (room.lastActionAt || 0) < 15000) return;
        g.pushLog(`🤖 ${pl.name} 断线，自动托管`);
        room.lastActionAt = Date.now();
        return this._autoHumanTurn(room, g, seat);
      }
    }
  }

  // 断线人类托管：首回合/碰后直接打，否则走 AI 整回合
  async _autoHumanTurn(room, g, seat) {
    const gp = g.players[seat];
    if (g.firstTurn || room.turnInfo?.ponged) {
      g.firstTurn = false; room.turnInfo = null;
      const t = aiDiscard(gp.hand);
      room.game = g.toJSON();
      await this._save(room);
      return this._aiDiscard(room, g, seat, t);
    }
    return this._aiTurn(room, g, seat);
  }

  async _handleMessage(room, me, msg, ws, err) {
    const g = room.game ? MJGame.fromJSON(room.game) : null;

    if (msg.t === "leave") {
      me.connected = false;
      if (room.phase === "lobby") {
        room.players = room.players.filter(p => p.id !== me.id);
        room.players.forEach((p, i) => { p.seat = i; });
      }
      // 对局中离开：不断线，AI 托管继续（不断局）
      await this._save(room);
      try { ws.close(1000, "left"); } catch (e) {}
      return this._broadcast(room);
    }

    if (room.phase === "lobby") {
      if (msg.t === "add_ai" || msg.t === "remove_ai") {
        if (me.seat !== 0) return err("只有房主可以操作");
        if (msg.t === "add_ai") {
          if (room.players.length >= 4) return err("已满4人");
          const n = room.players.filter(p => p.isAI).length;
          room.players.push({ id: "ai-" + Date.now() + n, name: "🤖电脑" + (n + 1), avatar: "robot",
            seat: room.players.length, connected: true, isAI: true });
        } else {
          const idx = room.players.map((p, i) => p.isAI ? i : -1).filter(i => i >= 0).pop();
          if (idx === undefined) return err("没有电脑可移除");
          room.players.splice(idx, 1);
          room.players.forEach((p, i) => { p.seat = i; });
        }
        await this._save(room);
        return this._broadcast(room);
      }
      if (msg.t === "single") {
        // 单机：加3电脑直接开
        while (room.players.length < 4) {
          const n = room.players.filter(p => p.isAI).length;
          room.players.push({ id: "ai-s" + Date.now() + n, name: "🤖电脑" + (n + 1), avatar: "robot",
            seat: room.players.length, connected: true, isAI: true });
        }
        await this._save(room);
        return this._startRound(room, me);
      }
      if (msg.t === "start") {
        if (me.seat !== 0) return err("只有房主可以开始");
        if (room.players.length < 4) return err("需要4人（可加电脑）");
        return this._startRound(room, me);
      }
      return;
    }

    if (!g) return;
    const seat = me.seat;

    if (g.phase !== "playing") {
      if (msg.t === "next_round" && me.seat === 0) return this._startRound(room, me);
      return;
    }

    // ---- 出牌 ----
    if (msg.t === "discard") {
      if (g.turn !== seat || g.players[seat].hu) return err("没轮到你");
      if (room.claim || room.qianggang) return err("等待他人表态");
      const r = g.discard(seat, msg.tile);
      if (r.error) return err(r.error);
      room.game = g.toJSON(); room.turnInfo = null;
      if (r.claim) {
        room.claim = { ...r.claim, responses: {}, deadline: Date.now() + 15000, kind: "discard" };
        // AI 秒回
        for (const s of Object.keys(r.claim.options)) {
          const si = +s, pl = room.players[si];
          if (!pl.isAI) continue;
          const acts = r.claim.options[s];
          const gp = g.players[si];
          if (acts.includes("hu")) room.claim.responses[s] = "hu";
          else if (acts.includes("kong")) room.claim.responses[s] = "kong";
          else if (acts.includes("pong") && aiWantPong(gp.hand, gp.melds, r.claim.tile)) room.claim.responses[s] = "pong";
          else room.claim.responses[s] = "pass";
        }
        await this._save(room);
        this._broadcast(room);
        return this._maybeResolveClaim(room);
      }
      await this._save(room);
      return this._advanceTurn(room, g);
    }

    // ---- 自摸胡 ----
    if (msg.t === "hu_self") {
      if (g.turn !== seat || g.players[seat].hu) return err("不能胡");
      const f = g.canSelfHu(seat, !!room.turnInfo?.gangShang);
      if (!f) return err("胡不了");
      g.applyHu(seat, { isSelf: true, fan: f, gangShang: !!room.turnInfo?.gangShang });
      room.game = g.toJSON(); room.turnInfo = null;
      await this._save(room);
      return this._afterHu(room, g);
    }

    // ---- 杠 ----
    if (msg.t === "kong") {
      if (g.turn !== seat || g.players[seat].hu) return err("不能杠");
      if (room.claim || room.qianggang) return err("等待他人表态");
      const avail = g.selfKongs(seat).find(k => k.type === msg.ktype && k.tile === msg.tile);
      if (!avail) return err("杠不了");
      if (msg.ktype === "concealed") {
        g.applyKongConcealed(seat, msg.tile);
        room.game = g.toJSON();
        await this._save(room);
        return this._afterKong(room, g, seat);
      } else {
        // 补杠：先检查抢杠
        const qg = g.checkQiangGang(seat, msg.tile);
        if (qg.length) {
          room.qianggang = { seat, tile: msg.tile };
          const options = {};
          qg.forEach(s => { options[s] = ["hu"]; });
          room.claim = { tile: msg.tile, from: seat, options, responses: {}, deadline: Date.now() + 15000, kind: "qianggang" };
          // AI：能抢就抢
          qg.forEach(s => { if (room.players[s].isAI) room.claim.responses[s] = "hu"; });
          room.game = g.toJSON();
          await this._save(room);
          this._broadcast(room);
          return this._maybeResolveClaim(room);
        }
        g.confirmKongAdded(seat, msg.tile);
        room.game = g.toJSON();
        await this._save(room);
        return this._afterKong(room, g, seat);
      }
    }

    // ---- claim 表态 ----
    if (msg.t === "claim") {
      if (!room.claim || !room.claim.options[seat]) return err("不用表态");
      const acts = room.claim.options[seat];
      if (!acts.includes(msg.action) && msg.action !== "pass") return err("无效操作");
      room.claim.responses[seat] = msg.action;
      await this._save(room);
      this._broadcast(room);
      return this._maybeResolveClaim(room);
    }
  }

  async _maybeResolveClaim(room) {
    if (!room.claim) return;
    const g = MJGame.fromJSON(room.game);
    // 是否所有人类都表态（AI已秒回）
    for (const s of Object.keys(room.claim.options)) {
      const si = +s;
      if (room.players[si].isAI) continue;
      if (!room.claim.responses[s]) return; // 等人
    }
    if (room.qianggang) {
      const { seat, tile } = room.qianggang;
      const huSeats = Object.keys(room.claim.options).map(Number)
        .filter(s => (room.claim.responses[s] || "pass") === "hu");
      room.qianggang = null; room.claim = null;
      if (huSeats.length) {
        for (const s of huSeats) {
          const p = g.players[s];
          const a = g.canHuOnDiscard(s, tile); // 已校验过
          g.applyHu(s, { isSelf: false, from: seat, fan: a, qiangGang: true });
        }
        room.game = g.toJSON();
        await this._save(room);
        return this._afterHu(room, g);
      }
      g.confirmKongAdded(seat, tile);
      room.game = g.toJSON();
      await this._save(room);
      return this._afterKong(room, g, seat);
    }
    const responses = {};
    for (const s of Object.keys(room.claim.options)) responses[s] = room.claim.responses[s] || "pass";
    room.claim = null;
    await this._resolveClaim(room, g, responses);
  }

  async _resolveClaim(room, g, responses) {
    const r = g.resolveClaim(responses);
    room.game = g.toJSON();
    if (!r) { await this._save(room); return this._broadcast(room); }
    if (r.type === "hu") {
      await this._save(room);
      return this._afterHu(room, g);
    }
    if (r.type === "kong") {
      await this._save(room);
      return this._afterKong(room, g, r.seat);
    }
    if (r.type === "pong") {
      // 碰后直接打牌（不摸），也可能杠
      room.turnInfo = { ponged: true, kongs: g.selfKongs(r.seat) };
      await this._save(room);
      return this._pumpAI(room, g);
    }
    // none：下家摸牌
    await this._save(room);
    return this._advanceTurn(room, g);
  }

  // 杠后摸牌（杠上花判定）
  async _afterKong(room, g, seat) {
    if (g.isRoundOver()) { g.settle(); return this._finishRound(room, g); }
    const kd = g.kongDraw();
    if (kd.wallEmpty) { g.settle(); room.game = g.toJSON(); return this._finishRound(room, g); }
    const pl = room.players[seat];
    if (pl.isAI) {
      if (kd.canHu) { g.selfHu(seat, { gangShang: true }); room.game = g.toJSON(); await this._save(room); return this._afterHu(room, g); }
      // AI 杠后继续：可能连杠
      const kongs = g.selfKongs(seat);
      if (kongs.length) {
        const k = kongs[0];
        if (k.type === "concealed") g.applyKongConcealed(seat, k.tile);
        else {
          const qg = g.checkQiangGang(seat, k.tile);
          if (!qg.length) g.confirmKongAdded(seat, k.tile);
          else { /* AI补杠被抢概率低，简化：直接补杠 */ g.confirmKongAdded(seat, k.tile); }
        }
        room.game = g.toJSON();
        await this._save(room);
        return this._afterKong(room, g, seat);
      }
      const t = aiDiscard(g.players[seat].hand);
      return this._aiDiscard(room, g, seat, t);
    }
    room.turnInfo = { canHu: kd.canHu, kongs: kd.kongs, gangShang: true };
    room.game = g.toJSON();
    await this._save(room);
    this._broadcast(room);
  }

  // AI 打出一张牌（走完整 discard+claim 流程）
  async _aiDiscard(room, g, seat, tile) {
    await new Promise(r => setTimeout(r, 1000)); // AI出牌间隔1秒
    const r = g.discard(seat, tile);
    room.game = g.toJSON(); room.turnInfo = null;
    if (r.error) { // 极少见：换一张
      const p = g.players[seat];
      const alt = p.hand.find(t => t !== TILE_RED);
      if (alt === undefined) return;
      return this._aiDiscard(room, g, seat, alt);
    }
    if (r.claim) {
      room.claim = { ...r.claim, responses: {}, deadline: Date.now() + 15000, kind: "discard" };
      for (const s of Object.keys(r.claim.options)) {
        const si = +s, pl = room.players[si];
        if (!pl.isAI) continue;
        const acts = r.claim.options[s];
        const gp = g.players[si];
        if (acts.includes("hu")) room.claim.responses[s] = "hu";
        else if (acts.includes("kong")) room.claim.responses[s] = "kong";
        else if (acts.includes("pong") && aiWantPong(gp.hand, gp.melds, r.claim.tile)) room.claim.responses[s] = "pong";
        else room.claim.responses[s] = "pass";
      }
      await this._save(room);
      this._broadcast(room);
      return this._maybeResolveClaim(room);
    }
    await this._save(room);
    return this._advanceTurn(room, g);
  }

  // 回合推进：下家摸牌；AI 则自动打完
  async _advanceTurn(room, g) {
    if (g.isRoundOver()) { g.settle(); return this._finishRound(room, g); }
    g.turn = g.nextAlive(g.turn);
    return this._beginTurn(room, g);
  }
  async _beginTurn(room, g) {
    const seat = g.turn;
    const pl = room.players[seat];
    // 庄家首回合：14张直接打，不摸牌
    if (g.firstTurn) {
      g.firstTurn = false;
      room.game = g.toJSON();
      if (pl.isAI) {
        const gp = g.players[seat];
        const t = aiDiscard(gp.hand);
        await this._save(room);
        return this._aiDiscard(room, g, seat, t);
      }
      room.turnInfo = { dealerFirst: true };
      await this._save(room);
      return this._broadcast(room);
    }
    if (pl.isAI) return this._aiTurn(room, g, seat);
    const d = g.drawForTurn();
    if (d.wallEmpty) { g.settle(); room.game = g.toJSON(); return this._finishRound(room, g); }
    room.turnInfo = { canHu: d.canHu, kongs: d.kongs };
    room.game = g.toJSON();
    await this._save(room);
    this._broadcast(room);
  }
  // AI 完整一回合
  async _aiTurn(room, g, seat) {
    let guard = 0;
    while (guard++ < 8) {
      if (g.players[seat].hu || g.isRoundOver()) break;
      const d = g.drawForTurn();
      if (d.wallEmpty) break;
      if (d.canHu) { g.selfHu(seat); break; }
      if (d.kongs.length) {
        const k = d.kongs[0];
        if (k.type === "concealed") g.applyKongConcealed(seat, k.tile);
        else {
          const qg = g.checkQiangGang(seat, k.tile);
          if (qg.length) {
            // 简化：AI补杠若有人能抢，让其抢
            const s = qg[0];
            const a = g.canHuOnDiscard(s, k.tile);
            g.applyHu(s, { isSelf: false, from: seat, fan: a, qiangGang: true });
            break;
          }
          g.confirmKongAdded(seat, k.tile);
        }
        const kd = g.kongDraw();
        if (kd.wallEmpty) break;
        if (kd.canHu) { g.selfHu(seat, { gangShang: true }); break; }
        break; // 杠后摸牌，直接打牌（简化：不连杠）
      }
      break;
    }
    if (!g.players[seat].hu && !g.isRoundOver()) {
      const gp = g.players[seat];
      // 若还没打牌（没胡没杠），打一张
      if (gp.hand.length % 3 === 2) {
        const t = aiDiscard(gp.hand);
        room.game = g.toJSON();
        await this._save(room);
        return this._aiDiscard(room, g, seat, t);
      }
    }
    room.game = g.toJSON();
    await this._save(room);
    return this._afterHu(room, g);
  }
  // AI pump：碰/杠后或回合轮到 AI 时连打
  async _pumpAI(room, g) {
    const seat = g.turn;
    const pl = room.players[seat];
    if (pl && pl.isAI && !g.players[seat].hu && !g.isRoundOver()) {
      // 碰后：直接打牌
      if (room.turnInfo?.ponged) {
        room.turnInfo = null;
        const gp = g.players[seat];
        const t = aiDiscard(gp.hand);
        return this._aiDiscard(room, g, seat, t);
      }
      return this._aiTurn(room, g, seat);
    }
    await this._save(room);
    this._broadcast(room);
  }

  async _afterHu(room, g) {
    if (g.isRoundOver()) { g.settle(); return this._finishRound(room, g); }
    // 血战：继续，未胡的人打
    g.turn = g.nextAlive(g.turn);
    room.game = g.toJSON();
    await this._save(room);
    return this._beginTurn(room, g);
  }

  async _finishRound(room, g) {
    room.game = g.toJSON();
    // 累计总分
    room.totals = room.totals || [0, 0, 0, 0];
    g.players.forEach((p, i) => { room.totals[i] += p.score; });
    room.round = (room.round || 1) + 1;
    await this._save(room);
    this._broadcast(room);
  }

  async _startRound(room, me) {
    const names = room.players.map(p => p.name);
    const dealer = room.game ? MJGame.fromJSON(room.game).result?.nextDealer ?? 0 : Math.floor(Math.random() * 4);
    // AI 坐庄也行；若庄家是AI也没关系
    const g = new MJGame(undefined, dealer, names);
    g.round = room.round || 1;
    room.game = g.toJSON();
    room.phase = "playing";
    room.claim = null; room.turnInfo = null; room.qianggang = null;
    room.game = g.toJSON();
    await this._save(room);
    await this._broadcast(room);
    return this._beginTurn(room, g);
  }

}
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const code = (url.searchParams.get("room") || "").toUpperCase();
      if (!/^[A-Z0-9]{4}$/.test(code)) return new Response("bad room code", { status: 400 });
      const id = env.ROOMS.idFromName("mj-" + code);
      return env.ROOMS.get(id).fetch(req);
    }
    // 首页：返回客户端
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(CLIENT_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    return new Response("not found", { status: 404 });
  },
};
const CLIENT_HTML = "__CLIENT_HTML_JSON__";
