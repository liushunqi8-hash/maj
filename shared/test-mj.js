import {
  TILE_RED, tileName, suitOf, buildWall, analyzeWin, canDianPao, finalFan, tingInfo, fanToScore,
  MJGame, aiDiscard, GANG_SCORE, MAX_FAN,
} from "./mj-core.js";

let pass = 0;
function ok(c, msg) { if (!c) { console.error("FAIL:", msg); process.exit(1); } pass++; }

// 0. 算分 ladder: 2→5→10→20→40
{
  ok(fanToScore(0) === 2, "0番2分");
  ok(fanToScore(1) === 5, "1番5分（跳过4）");
  ok(fanToScore(2) === 10, "2番10分");
  ok(fanToScore(3) === 20, "3番20分");
  ok(fanToScore(4) === 40 && fanToScore(99) === 40, "4番+封顶40");
}
// 1. 牌
{
  const w = buildWall();
  ok(w.length === 112, "112张牌");
  ok(w.filter(t => t === TILE_RED).length === 4, "4张红中");
  ok(tileName(0) === "1万" && tileName(8) === "9万", "万命名");
  ok(tileName(9) === "1筒" && tileName(18) === "1条", "筒条命名");
  ok(tileName(TILE_RED) === "红中", "红中命名");
  ok(suitOf(0) === 0 && suitOf(9) === 1 && suitOf(18) === 2 && suitOf(TILE_RED) === 3, "花色");
}

// 2. 胡牌判定：平胡 123万456万789万 111筒+5万对
{
  const hand = [0,1,2, 3,4,5, 6,7,8, 9,9,9, 4,4]; // 123万 456万 789万 111筒 5万对
  const a = analyzeWin(hand, []); // 万+筒，缺条，可胡
  ok(a && a.pattern === "平胡" && a.fan === 0, "平胡0番=" + (a && a.fan));
  ok(!canDianPao(a), "平胡不能点炮");
  ok(a.wugui, "无红中=无鬼");
  const f = finalFan(a, { isSelf: true });
  ok(f.fan === 1 && f.score === 40, "平胡自摸1番5分，无鬼×8封顶40");
}
// 3. 大对子
{
  const hand = [0,0,0, 10,10,10, 20,20,20, 4,4,4, 7,7]; // 111万 222筒 333条 555万 88万对
  const a = analyzeWin(hand, []); // 缺筒？手里有筒 -> null
  ok(a === null, "留缺门不能胡");
  const b = analyzeWin(hand, []); // 缺条？有条 -> null
  ok(b === null, "留缺门不能胡2");
  const c = analyzeWin([0,0,0, 9,9,9, 18,18,18, 4,4,4, 7,7], [], 2); // 缺条但有条... 
  ok(c === null, "缺条留条不能胡");
  const d = analyzeWin([0,0,0, 9,9,9, 10,10,10, 4,4,4, 7,7], [], 2); // 万筒大对子缺条
  ok(d && d.pattern === "大对子" && d.fan === 2, "大对子2番");
  ok(canDianPao(d), "大对子可点炮");
}
// 4. 清一色
{
  const hand = [0,0,0, 1,2,3, 4,4,4, 5,6,7, 8,8]; // 全万
  const a = analyzeWin(hand, []);
  ok(a && a.qingyise && a.fan === 4, "清一色平胡4番");
  ok(canDianPao(a), "清一色可点炮");
}
// 5. 小七对 + 鬼牌
{
  const hand = [0,0, 1,1, 2,2, 3,3, 4,4, 5,5, 6,6]; // 7对万
  const a = analyzeWin(hand, []);
  ok(a && a.pattern === "小七对" && a.qingyise && a.fan === 8, "清一色小七对8番");
  // 鬼牌凑：6对+1红中
  const h2 = [0,0, 1,1, 2,2, 3,3, 4,4, 5,5, TILE_RED, 8];
  const b = analyzeWin(h2, []);
  ok(b && b.pattern === "小七对", "红中凑七对");
  // 鬼牌当任意牌：0,0+红中=111万刻子
  const h3 = [0,0, TILE_RED, 9,9,9, 10,10,10, 4,4,4, 7,7];
  const c = analyzeWin(h3, []);
  ok(c && c.pattern === "大对子", "红中替刻子");
  ok(c.gen === 1, "红中算1根");
  ok(c.fan === 3, "大对子+1根=3番");
}
// 6. 听牌
{
  const hand13 = [0,0,0, 1,1,1, 9,9,9, 10,10,10, 4]; // 缺条，单吊5万
  const ti = tingInfo(hand13, [], 2);
  ok(ti.ting && ti.tiles.includes(4), "下叫听5万");
  // 13张差一张七对
  const h2 = [0,0, 1,1, 2,2, 3,3, 4,4, 5,5, 6];
  const t2 = tingInfo(h2, [], 1);
  ok(t2.ting && t2.tiles.includes(6), "七对听单张");
}

// 7. 对局流程在下一节测
{
  const g = new MJGame(42, 0);
  ok(g.phase === "playing" && g.turn === 0, "换缺制：直接开打，庄家先");
}
// 重新测发牌数
{
  const g = new MJGame(42, 0);
  const total = g.players.reduce((s, p) => s + p.hand.length, 0);
  ok(total === 53 && g.wall.length === 112 - 53, "53张发出，墙剩" + g.wall.length);
  ok(g.players[0].hand.length === 14, "庄家14张");
  ok(g.startPlay() && g.phase === "playing" && g.turn === 0, "开打庄家先");
  // 摸牌
  const d = g.drawForTurn();
  ok(!d.wallEmpty && g.players[0].hand.length === 15, "摸牌后15张");
  // 红中可以打出
  g.players[0].hand.push(TILE_RED);
  const r = g.discard(0, TILE_RED);
  ok(!r.error, "红中可以打出");
  // 打出的红中无人能碰/杠/胡
  ok(!r.claim, "红中打出无claim");
  // 三门齐全不能胡（换缺制）
  const g2 = new MJGame(43, 0);
  g2.players[0].hand = [0,0,0, 9,9,9, 18,18,18, 1,1, 2,2, 3]; // 万筒条三门
  ok(!g2.canSelfHu(0), "三门齐全不能自摸");
  // 缺一门可胡
  g2.players[0].hand = [0,0,0, 9,9,9, 10,10,10, 1,1,1, 2,2]; // 只有万筒
  const f2 = g2.canSelfHu(0);
  ok(f2 && f2.fan >= 0, "缺一门可胡");
  // 无鬼：手牌无红中
  ok(f2.wugui, "无红中=无鬼");
  const ff = finalFan(f2, { isSelf: true });
  // 大对子2番→10分，自摸3番→20分，无鬼×8封顶40
  ok(ff.score === 40, "大对子自摸无鬼封顶40: " + ff.score);
}

// 8. 血战：三家胡结束
{
  const g = new MJGame(7, 0);
  g.startPlay();
  // 强制三家胡
  for (const s of [0, 1, 2]) {
    g.players[s].hand = [0,0,0, 1,2,3, 9,9,9, 10,10,10, 4,4];
    const f = g.canSelfHu(s);
    ok(f, s + "号能自摸");
    g.applyHu(s, { isSelf: true, fan: f });
  }
  ok(g.isRoundOver(), "三胡结束");
  const res = g.settle();
  ok(res.nextDealer === 0, "一胡坐庄");
  ok(g.players[0].score > 0 && g.players[3].score < 0, "比分结算");
}

// 9. 一炮多响
{
  const g = new MJGame(9, 0);
  g.startPlay();
  g.players[0].hand = [0,1,2, 3,4,5, 9,10,11, 12,13,14, 6, 8]; // 14张，待打8万
  g.players[1].hand = [0,0,0, 9,9,9, 10,10,10, 4,4, 8,8];
  g.players[2].hand = [2,2,2, 11,11,11, 13,13,13, 6,6, 8,8];
  g.players[3].hand = [0,1,2, 3,4,5, 6,7,8, 9,10,11, 12];
  g.turn = 0;
  const d = g.discard(0, 8);
  ok(!d.error, "打出8万：" + (d.error || "ok"));
  ok(d.claim && d.claim.options[1].includes("hu") && d.claim.options[2].includes("hu"), "两家可胡");
  const r = g.resolveClaim({ 1: "hu", 2: "hu" });
  ok(r.type === "hu" && r.seats.length === 2, "一炮双响");
  ok(g.players[0].score < 0 && g.players[1].hu && g.players[2].hu, "点炮人买单");
}

// 10. 流局查花猪
{
  const g = new MJGame(11, 0);
  g.startPlay();
  g.wall = []; // 墙空
  // 0号三门花色（花猪）；1/2/3号都下叫
  g.players[0].hand = [0, 9, 18, 1, 10, 19, 2, 11, 20, 3, 12, 21, 4];
  const tingHand = [0,0,0, 1,1,1, 9,9,9, 10,10,10, 4];
  g.players[1].hand = tingHand.slice();
  g.players[2].hand = tingHand.slice();
  g.players[3].hand = tingHand.slice();
  const res = g.settle();
  ok(res.liuju && res.huaZhu.includes(0), "查出花猪");
  ok(g.players[1].score === 40, "花猪赔封顶40");
}

// 11. AI
{
  const g = new MJGame(13, 0);
  const d = aiDiscard(g.players[0].hand.concat([5]));
  ok(d !== undefined, "AI出牌");
  // AI优先打最少花色
  const d2 = aiDiscard([0, 9,9,9, 18,18,18,18]);
  ok(suitOf(d2) === 0, "AI打最少花色(万)");
}

console.log(`全部通过（${pass}断言）`);
