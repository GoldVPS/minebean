import OpenAI from "openai";
import { ethers } from "ethers";
import EventSource from "eventsource";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import fs from "fs";
dotenv.config();

const CONFIG = {
  RPC_URL: process.env.RPC_URL,
  PRIVATE_KEY: process.env.PRIVATE_KEY,
  WALLET_ADDRESS: process.env.WALLET_ADDRESS,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
};

const GRID_MINING_ABI = [
  "function deploy(uint8[] calldata blockIds) payable",
  "function claimETH()",
  "function claimBEAN()",
];

const API_BASE = "https://api.minebean.com";
const MEMORY_FILE = "./memory.json";
const SETTINGS_FILE = "./settings.json";

const openai = new OpenAI({ apiKey: CONFIG.OPENAI_API_KEY });
const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
const wallet = new ethers.Wallet(CONFIG.PRIVATE_KEY, provider);
const gridMining = new ethers.Contract(
  "0x9632495bDb93FD6B0740Ab69cc6c71C9c01da4f0",
  GRID_MINING_ABI,
  wallet
);
const bot = new TelegramBot(CONFIG.TELEGRAM_TOKEN, { polling: true });

let isDeployedThisRound = false;
let agentRunning = true;
let lastDeployedBlocks = [];
let lastRoundId = null;
let waitingForInput = null;

// ─── Default Settings ─────────────────────────────────────────────────────────
function defaultSettings() {
  return {
    // Tier thresholds
    tier1Max: 20,
    tier2Max: 40,
    // Blocks per tier
    tier1Blocks: 4,
    tier2Blocks: 6,
    tier3Blocks: 8,
    // ETH per tier
    tier1ETH: "0.000015",
    tier2ETH: "0.000020",
    tier3ETH: "0.000030",
    // General
    deployDelaySec: 45,
    autoClaimThreshold: "0.001",
    skipLowEV: false,
  };
}

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const s = JSON.parse(fs.readFileSync(SETTINGS_FILE));
      return { ...defaultSettings(), ...s };
    }
  } catch (e) {}
  return defaultSettings();
}

function saveSettings(s) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}

// ─── Memory ───────────────────────────────────────────────────────────────────
function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) return JSON.parse(fs.readFileSync(MEMORY_FILE));
  } catch (e) {}
  return {
    rounds: [],
    stats: { totalRounds: 0, totalWins: 0, blockWins: Array(25).fill(0), blockDeploys: Array(25).fill(0) },
  };
}

function saveMemory(mem) { fs.writeFileSync(MEMORY_FILE, JSON.stringify(mem, null, 2)); }

function recordRound(mem, roundId, deployedBlocks, winningBlock, won) {
  mem.rounds.push({ roundId, deployedBlocks, winningBlock, won, timestamp: Date.now() });
  if (mem.rounds.length > 500) mem.rounds = mem.rounds.slice(-500);
  mem.stats.totalRounds++;
  if (won) mem.stats.totalWins++;
  mem.stats.blockWins[winningBlock]++;
  deployedBlocks.forEach((b) => mem.stats.blockDeploys[b]++);
  saveMemory(mem);
}

// ─── Tier Logic ───────────────────────────────────────────────────────────────
function getTier(beanpotSize, settings) {
  if (beanpotSize < settings.tier1Max) {
    return { tier: 1, blocks: settings.tier1Blocks, eth: settings.tier1ETH, emoji: "🟢", label: "Normal" };
  } else if (beanpotSize < settings.tier2Max) {
    return { tier: 2, blocks: settings.tier2Blocks, eth: settings.tier2ETH, emoji: "🟡", label: "Medium" };
  } else {
    return { tier: 3, blocks: settings.tier3Blocks, eth: settings.tier3ETH, emoji: "🔥", label: "Aggressive" };
  }
}

// ─── Hot Blocks ───────────────────────────────────────────────────────────────
async function getHotBlocks(limit = 50) {
  try {
    const data = await fetchAPI("/api/rounds?limit=" + limit + "&settled=true");
    const rounds = data.rounds || data.data || data || [];
    const blockWinCount = Array(25).fill(0);
    const recent = Array(25).fill(0);
    rounds.forEach((round, idx) => {
      if (round.winningBlock !== undefined && round.winningBlock !== null) {
        blockWinCount[round.winningBlock]++;
        if (idx < 10) recent[round.winningBlock] += 2;
      }
    });
    const scores = blockWinCount.map((w, i) => ({ block: i, wins: w, recentBonus: recent[i], score: w + recent[i] }));
    const hot = [...scores].sort((a, b) => b.score - a.score).slice(0, 8).map((b) => b.block);
    return { hot, scores };
  } catch (e) {
    return { hot: [], scores: [] };
  }
}

// ─── EV Calculator ────────────────────────────────────────────────────────────
async function calculateEV(roundData, priceData, ethPerRound) {
  const beanpot = parseFloat(roundData.beanpotPoolFormatted || "0");
  const beanPrice = parseFloat(priceData?.bean?.priceNative || "0");
  const eth = parseFloat(ethPerRound);
  const beanEV = 1.0 * beanPrice;
  const beanpotEV = (1 / 777) * beanpot * beanPrice;
  const houseEdge = eth * 0.11;
  const netEV = beanEV + beanpotEV - houseEdge;
  return { netEV: netEV.toFixed(6), isPositive: netEV > 0 };
}

// ─── AI ───────────────────────────────────────────────────────────────────────
async function askAI(roundData, memory, hotBlocks, numBlocks) {
  const recentRounds = memory.rounds.slice(-10);
  const prompt =
    "You are a BEAN game agent on Base blockchain. Pick exactly " + numBlocks + " block IDs (0-24).\n\n" +
    "RULES:\n" +
    "- All 25 blocks have EQUAL 1/25 win probability (Chainlink VRF, truly random)\n" +
    "- Best strategy: combine HOT blocks + LEAST crowded blocks (lowest ETH deployed)\n" +
    "- Avoid blocks with too many miners (more than 40)\n\n" +
    "CURRENT GRID:\n" +
    roundData.blocks.map((b) => "Block " + b.id + ": " + b.deployedFormatted + " ETH, " + b.minerCount + " miners").join("\n") +
    "\n\nHOT BLOCKS (most wins last 50 rounds): " + hotBlocks.hot.slice(0, 5).join(", ") +
    "\n\nMY RECENT HISTORY:\n" +
    recentRounds.map((r) => "Round " + r.roundId + ": [" + r.deployedBlocks.join(",") + "], winner=" + r.winningBlock + ", won=" + r.won).join("\n") +
    "\n\nReply ONLY valid JSON: {\"blockIds\": [3, 7, 14], \"reason\": \"brief reason\", \"confidence\": \"high/medium/low\"}";

  const res = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
  });
  return JSON.parse(res.choices[0].message.content);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function log(msg) { console.log("[" + new Date().toLocaleTimeString() + "] " + msg); }

async function tg(msg) {
  try { await bot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, msg, { parse_mode: "HTML" }); }
  catch (e) { log("TG error: " + e.message); }
}

async function tgButtons(msg, buttons) {
  try {
    await bot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, msg, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buttons },
    });
  } catch (e) { log("TG error: " + e.message); }
}

async function fetchAPI(path) {
  const res = await fetch(API_BASE + path);
  return res.json();
}

// ─── Deploy ───────────────────────────────────────────────────────────────────
async function deployThisRound() {
  if (isDeployedThisRound || !agentRunning) return;
  const memory = loadMemory();
  const settings = loadSettings();

  try {
    const [roundData, priceData, hotBlocks] = await Promise.all([
      fetchAPI("/api/round/current?user=" + CONFIG.WALLET_ADDRESS),
      fetchAPI("/api/price").catch(() => null),
      getHotBlocks(50),
    ]);

    if (roundData.settled) return;
    if (lastRoundId === roundData.roundId) { isDeployedThisRound = true; return; }

    const timeRemaining = roundData.endTime - Math.floor(Date.now() / 1000);
    if (timeRemaining < 10) { log("Too late (" + timeRemaining + "s left)"); return; }

    const beanpotSize = parseFloat(roundData.beanpotPoolFormatted || "0");
    const tierInfo = getTier(beanpotSize, settings);
    const totalETH = ethers.parseEther(tierInfo.eth);

    const ev = await calculateEV(roundData, priceData, tierInfo.eth);

    if (settings.skipLowEV && !ev.isPositive) {
      log("Skipping round - EV negative: " + ev.netEV);
      await tg("⏭ Skip ronde #" + roundData.roundId + " (EV negatif: " + ev.netEV + ")");
      return;
    }

    const balance = await provider.getBalance(wallet.address);
    if (balance < totalETH) {
      await tg(
        "⚠️ <b>Balance Habis!</b>\n" +
        "Sisa: " + ethers.formatEther(balance) + " ETH\n" +
        "Top up ke:\n<code>" + CONFIG.WALLET_ADDRESS + "</code>"
      );
      agentRunning = false;
      return;
    }

    const decision = await askAI(roundData, memory, hotBlocks, tierInfo.blocks);
    const blockIds = decision.blockIds.map(Number).filter((id) => id >= 0 && id <= 24).slice(0, tierInfo.blocks);

    log("Round #" + roundData.roundId + " | Tier " + tierInfo.tier + " | Beanpot: " + beanpotSize + " | Blocks: " + blockIds.join(","));

    const tx = await gridMining.deploy(blockIds, { value: totalETH });
    await tx.wait();

    isDeployedThisRound = true;
    lastDeployedBlocks = blockIds;
    lastRoundId = roundData.roundId;

    const detikKe = Math.floor(Date.now() / 1000) - roundData.startTime;

    await tg(
      tierInfo.emoji + " <b>Deploy Berhasil! [Tier " + tierInfo.tier + " - " + tierInfo.label + "]</b>\n\n" +
      "📦 Round: <b>#" + roundData.roundId + "</b>\n" +
      "🎯 Blocks: [" + blockIds.join(", ") + "] (" + tierInfo.blocks + " blok)\n" +
      "💸 ETH: " + tierInfo.eth + "\n" +
      "💡 " + decision.reason + "\n\n" +
      "💰 Pool: " + roundData.totalDeployedFormatted + " ETH\n" +
      "🎰 Beanpot: " + beanpotSize + " BEAN\n" +
      (ev.isPositive ? "📈" : "📉") + " EV: " + ev.netEV + " ETH\n" +
      "🎲 Confidence: " + decision.confidence + "\n" +
      "⏰ Detik ke-" + detikKe + " dari ronde"
    );

    // Auto claim check
    await autoClaimCheck(settings);

  } catch (err) {
    if (err.message?.includes("AlreadyDeployedThisRound")) {
      isDeployedThisRound = true;
    } else {
      log("Error: " + err.message);
      await tg("❌ <b>Error:</b> " + err.message);
    }
  }
}

// ─── Auto Claim ───────────────────────────────────────────────────────────────
async function autoClaimCheck(settings) {
  try {
    const rewards = await fetchAPI("/api/user/" + CONFIG.WALLET_ADDRESS + "/rewards");
    const pendingETH = BigInt(rewards.pendingETH || "0");
    const threshold = ethers.parseEther(settings.autoClaimThreshold);
    if (pendingETH >= threshold) {
      log("Auto claiming " + rewards.pendingETHFormatted + " ETH...");
      const tx = await gridMining.claimETH();
      await tx.wait();
      await tg("💰 <b>Auto Claim!</b>\n✅ " + rewards.pendingETHFormatted + " ETH masuk wallet!");
    }
  } catch (err) {
    log("Auto claim error: " + err.message);
  }
}

async function checkAndClaim() {
  try {
    const rewards = await fetchAPI("/api/user/" + CONFIG.WALLET_ADDRESS + "/rewards");
    const pendingETH = BigInt(rewards.pendingETH || "0");
    if (pendingETH > 0n) {
      const tx = await gridMining.claimETH();
      await tx.wait();
      await tg("💰 <b>ETH Claimed!</b>\n✅ " + rewards.pendingETHFormatted + " ETH masuk wallet!");
    } else {
      await tg("ℹ️ Belum ada pending ETH.");
    }
  } catch (err) {
    await tg("❌ Claim error: " + err.message);
  }
}

// ─── Status ───────────────────────────────────────────────────────────────────
async function sendStatus() {
  const memory = loadMemory();
  const settings = loadSettings();
  const balance = await provider.getBalance(wallet.address);
  const rewards = await fetchAPI("/api/user/" + CONFIG.WALLET_ADDRESS + "/rewards");
  const roundData = await fetchAPI("/api/round/current");
  const beanpotSize = parseFloat(roundData.beanpotPoolFormatted || "0");
  const tierInfo = getTier(beanpotSize, settings);
  const winRate = memory.stats.totalRounds > 0
    ? ((memory.stats.totalWins / memory.stats.totalRounds) * 100).toFixed(1) : "0";
  const topBlocks = [...memory.stats.blockWins]
    .map((w, i) => ({ block: i, wins: w }))
    .sort((a, b) => b.wins - a.wins).slice(0, 3)
    .map((b) => "Blok " + b.block + "(" + b.wins + "x)").join(", ");
  const roundsLeft = Math.floor(parseFloat(ethers.formatEther(balance)) / parseFloat(settings.tier1ETH));

  await tgButtons(
    "📊 <b>Status Agent BEAN v5.0</b>\n\n" +
    "👛 <code>" + CONFIG.WALLET_ADDRESS.slice(0, 6) + "..." + CONFIG.WALLET_ADDRESS.slice(-4) + "</code>\n" +
    "💎 Balance: <b>" + parseFloat(ethers.formatEther(balance)).toFixed(6) + " ETH</b>\n" +
    "💰 Pending ETH: " + rewards.pendingETHFormatted + " ETH\n" +
    "🫘 Pending BEAN: " + (rewards.pendingBEAN?.netFormatted || "0") + " BEAN\n\n" +
    "🎮 Total Rounds: " + memory.stats.totalRounds + "\n" +
    "🏆 Total Wins: " + memory.stats.totalWins + "\n" +
    "📈 Win Rate: " + winRate + "%\n" +
    "🏅 Top Blocks: " + (topBlocks || "-") + "\n\n" +
    "🎰 Beanpot: " + beanpotSize + " BEAN\n" +
    "📍 Mode sekarang: " + tierInfo.emoji + " Tier " + tierInfo.tier + " (" + tierInfo.label + ")\n\n" +
    "🔋 Sisa ronde: ~" + roundsLeft + "\n" +
    "🤖 Agent: " + (agentRunning ? "✅ Running" : "⏸ Stopped"),
    [
      [
        { text: agentRunning ? "⏸ Stop" : "▶️ Start", callback_data: "toggle" },
        { text: "💰 Claim ETH", callback_data: "claim" },
      ],
      [
        { text: "🔄 Refresh", callback_data: "status" },
        { text: "⚙️ Settings", callback_data: "settings" },
      ],
      [
        { text: "🔥 Hot Blocks", callback_data: "hotblocks" },
        { text: "🗑 Reset Stats", callback_data: "reset" },
      ],
    ]
  );
}

// ─── Settings Menu ────────────────────────────────────────────────────────────
async function sendSettings() {
  const s = loadSettings();
  await tgButtons(
    "⚙️ <b>Settings Agent v5.0</b>\n\n" +
    "🟢 <b>Tier 1</b> (Beanpot &lt; " + s.tier1Max + " BEAN)\n" +
    "   Blok: " + s.tier1Blocks + " | ETH: " + s.tier1ETH + "\n\n" +
    "🟡 <b>Tier 2</b> (" + s.tier1Max + " - " + s.tier2Max + " BEAN)\n" +
    "   Blok: " + s.tier2Blocks + " | ETH: " + s.tier2ETH + "\n\n" +
    "🔥 <b>Tier 3</b> (Beanpot &gt;= " + s.tier2Max + " BEAN)\n" +
    "   Blok: " + s.tier3Blocks + " | ETH: " + s.tier3ETH + "\n\n" +
    "⏰ Deploy timing: detik ke-" + s.deployDelaySec + "\n" +
    "💰 Auto claim: " + s.autoClaimThreshold + " ETH\n" +
    "⏭ Skip low EV: " + (s.skipLowEV ? "✅ ON" : "❌ OFF"),
    [
      [
        { text: "🟢 Tier 1 Blok: " + s.tier1Blocks, callback_data: "set_t1_blocks" },
        { text: "💸 Tier 1 ETH: " + s.tier1ETH, callback_data: "set_t1_eth" },
      ],
      [
        { text: "🟡 Tier 2 Blok: " + s.tier2Blocks, callback_data: "set_t2_blocks" },
        { text: "💸 Tier 2 ETH: " + s.tier2ETH, callback_data: "set_t2_eth" },
      ],
      [
        { text: "🔥 Tier 3 Blok: " + s.tier3Blocks, callback_data: "set_t3_blocks" },
        { text: "💸 Tier 3 ETH: " + s.tier3ETH, callback_data: "set_t3_eth" },
      ],
      [
        { text: "🎰 T1 Max: " + s.tier1Max + " BEAN", callback_data: "set_t1_max" },
        { text: "🎰 T2 Max: " + s.tier2Max + " BEAN", callback_data: "set_t2_max" },
      ],
      [
        { text: "⏰ Deploy detik ke-" + s.deployDelaySec, callback_data: "set_delay" },
        { text: "💰 Auto claim: " + s.autoClaimThreshold, callback_data: "set_claim" },
      ],
      [
        { text: "⏭ Skip EV: " + (s.skipLowEV ? "ON" : "OFF"), callback_data: "toggle_ev" },
      ],
      [{ text: "🔙 Back", callback_data: "status" }],
    ]
  );
}

async function sendHotBlocks() {
  const hotBlocks = await getHotBlocks(50);
  const scores = [...hotBlocks.scores]
    .sort((a, b) => b.score - a.score).slice(0, 10)
    .map((b, i) => (i + 1) + ". Blok " + b.block + ": " + b.wins + " wins (+" + b.recentBonus + " recent)")
    .join("\n");
  await tg("🔥 <b>Hot Blocks (50 ronde terakhir)</b>\n\n" + scores);
}

// ─── Input Prompts ────────────────────────────────────────────────────────────
const inputPrompts = {
  set_t1_blocks: "🟢 <b>Tier 1 Blocks</b>\nKetik jumlah blok Tier 1 (1-25):\nContoh: <code>4</code>",
  set_t2_blocks: "🟡 <b>Tier 2 Blocks</b>\nKetik jumlah blok Tier 2 (1-25):\nContoh: <code>6</code>",
  set_t3_blocks: "🔥 <b>Tier 3 Blocks</b>\nKetik jumlah blok Tier 3 (1-25):\nContoh: <code>8</code>",
  set_t1_eth: "🟢 <b>Tier 1 ETH</b>\nKetik ETH per ronde Tier 1:\nContoh: <code>0.000015</code>",
  set_t2_eth: "🟡 <b>Tier 2 ETH</b>\nKetik ETH per ronde Tier 2:\nContoh: <code>0.000020</code>",
  set_t3_eth: "🔥 <b>Tier 3 ETH</b>\nKetik ETH per ronde Tier 3:\nContoh: <code>0.000030</code>",
  set_t1_max: "🎰 <b>Tier 1 Max BEAN</b>\nKetik batas atas Tier 1 (BEAN):\nContoh: <code>20</code>",
  set_t2_max: "🎰 <b>Tier 2 Max BEAN</b>\nKetik batas atas Tier 2 (BEAN):\nContoh: <code>40</code>",
  set_delay: "⏰ <b>Deploy Timing</b>\nKetik detik ke berapa deploy (10-55):\nContoh: <code>45</code>",
  set_claim: "💰 <b>Auto Claim Threshold</b>\nKetik minimum ETH untuk auto claim:\nContoh: <code>0.001</code>",
};

// ─── Telegram Handlers ────────────────────────────────────────────────────────
function isMe(msg) { return msg.chat.id.toString() === CONFIG.TELEGRAM_CHAT_ID; }

bot.onText(/\/start/, async (msg) => { if (!isMe(msg)) return; await sendStatus(); });
bot.onText(/\/status/, async (msg) => { if (!isMe(msg)) return; await sendStatus(); });
bot.onText(/\/settings/, async (msg) => { if (!isMe(msg)) return; await sendSettings(); });
bot.onText(/\/hot/, async (msg) => { if (!isMe(msg)) return; await sendHotBlocks(); });
bot.onText(/\/stop/, async (msg) => {
  if (!isMe(msg)) return;
  agentRunning = false;
  await tg("⏸ <b>Agent dihentikan!</b>\nKetik /start untuk mulai lagi.");
});
bot.onText(/\/claim/, async (msg) => { if (!isMe(msg)) return; await checkAndClaim(); });

bot.on("message", async (msg) => {
  if (!isMe(msg)) return;
  if (!waitingForInput) return;
  if (msg.text?.startsWith("/")) { waitingForInput = null; return; }

  const input = msg.text?.trim();
  const s = loadSettings();

  if (["set_t1_blocks", "set_t2_blocks", "set_t3_blocks"].includes(waitingForInput)) {
    const val = parseInt(input);
    if (isNaN(val) || val < 1 || val > 25) { await tg("❌ Harus angka 1-25!"); return; }
    if (waitingForInput === "set_t1_blocks") s.tier1Blocks = val;
    else if (waitingForInput === "set_t2_blocks") s.tier2Blocks = val;
    else if (waitingForInput === "set_t3_blocks") s.tier3Blocks = val;
    saveSettings(s);
    waitingForInput = null;
    await tg("✅ Tersimpan: <b>" + val + " blok</b>!");
    await sendSettings();

  } else if (["set_t1_eth", "set_t2_eth", "set_t3_eth", "set_claim"].includes(waitingForInput)) {
    const val = parseFloat(input);
    if (isNaN(val) || val <= 0) { await tg("❌ Masukkan angka ETH yang valid!\nContoh: <code>0.000015</code>"); return; }
    const formatted = val.toFixed(8).replace(/\.?0+$/, "") || "0";
    if (waitingForInput === "set_t1_eth") s.tier1ETH = formatted;
    else if (waitingForInput === "set_t2_eth") s.tier2ETH = formatted;
    else if (waitingForInput === "set_t3_eth") s.tier3ETH = formatted;
    else if (waitingForInput === "set_claim") s.autoClaimThreshold = formatted;
    saveSettings(s);
    waitingForInput = null;
    await tg("✅ Tersimpan: <b>" + formatted + " ETH</b>!");
    await sendSettings();

  } else if (["set_t1_max", "set_t2_max"].includes(waitingForInput)) {
    const val = parseInt(input);
    if (isNaN(val) || val < 1) { await tg("❌ Masukkan angka BEAN yang valid!"); return; }
    if (waitingForInput === "set_t1_max") s.tier1Max = val;
    else if (waitingForInput === "set_t2_max") s.tier2Max = val;
    saveSettings(s);
    waitingForInput = null;
    await tg("✅ Tersimpan: <b>" + val + " BEAN</b>!");
    await sendSettings();

  } else if (waitingForInput === "set_delay") {
    const val = parseInt(input);
    if (isNaN(val) || val < 10 || val > 55) { await tg("❌ Harus antara 10-55 detik!"); return; }
    s.deployDelaySec = val;
    saveSettings(s);
    waitingForInput = null;
    await tg("✅ Deploy timing: detik ke-<b>" + val + "</b>!");
    await sendSettings();
  }
});

bot.on("callback_query", async (query) => {
  if (query.message.chat.id.toString() !== CONFIG.TELEGRAM_CHAT_ID) return;

  const data = query.data;

  if (data === "toggle") {
    agentRunning = !agentRunning;
    await bot.answerCallbackQuery(query.id, { text: agentRunning ? "▶️ Started!" : "⏸ Stopped!" });
    await sendStatus();
  } else if (data === "claim") {
    await bot.answerCallbackQuery(query.id, { text: "💰 Claiming..." });
    await checkAndClaim();
  } else if (data === "status") {
    await bot.answerCallbackQuery(query.id, { text: "🔄 Refreshing..." });
    await sendStatus();
  } else if (data === "settings") {
    await bot.answerCallbackQuery(query.id, { text: "⚙️ Opening settings..." });
    await sendSettings();
  } else if (data === "hotblocks") {
    await bot.answerCallbackQuery(query.id, { text: "🔥 Loading..." });
    await sendHotBlocks();
  } else if (data === "reset") {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify({
      rounds: [],
      stats: { totalRounds: 0, totalWins: 0, blockWins: Array(25).fill(0), blockDeploys: Array(25).fill(0) },
    }, null, 2));
    await bot.answerCallbackQuery(query.id, { text: "🗑 Reset!" });
    await tg("🗑 Stats berhasil di-reset!");
  } else if (data === "toggle_ev") {
    const s = loadSettings();
    s.skipLowEV = !s.skipLowEV;
    saveSettings(s);
    await bot.answerCallbackQuery(query.id, { text: s.skipLowEV ? "✅ Skip EV ON" : "❌ Skip EV OFF" });
    await sendSettings();
  } else if (inputPrompts[data]) {
    waitingForInput = data;
    await bot.answerCallbackQuery(query.id, { text: "Ketik nilai baru..." });
    await tg(inputPrompts[data]);
  }
});

// ─── SSE ──────────────────────────────────────────────────────────────────────
function connectSSE() {
  log("Connecting to SSE...");
  const es = new EventSource(API_BASE + "/api/events/rounds");

  es.addEventListener("roundTransition", async (event) => {
    try {
      const { settled, newRound } = JSON.parse(event.data);
      const memory = loadMemory();
      const settings = loadSettings();

      if (settled && settled.winningBlock !== undefined) {
        const winningBlock = parseInt(settled.winningBlock);
        const iWon = lastDeployedBlocks.includes(winningBlock);
        recordRound(memory, settled.roundId, lastDeployedBlocks, winningBlock, iWon);

        if (iWon) {
          const reward = ethers.formatEther(settled.topMinerReward || "0");
          const winRate = ((memory.stats.totalWins / memory.stats.totalRounds) * 100).toFixed(1);
          log("MENANG! Block " + winningBlock + " | Reward: " + reward + " ETH");
          await tg(
            "🎉 <b>MENANG!</b>\n\n" +
            "🏆 Round #" + settled.roundId + "\n" +
            "🎯 Winning Block: " + winningBlock + "\n" +
            "💰 Reward: " + reward + " ETH\n" +
            "📊 Win Rate: " + winRate + "% (" + memory.stats.totalWins + "/" + memory.stats.totalRounds + ")"
          );
        } else {
          log("Round #" + settled.roundId + " -> Block " + winningBlock + " (I had: [" + lastDeployedBlocks.join(",") + "])");
        }
      }

      isDeployedThisRound = false;
      log("New Round #" + newRound.roundId + " | Beanpot: " + newRound.beanpotPoolFormatted + " BEAN | Deploy in " + settings.deployDelaySec + "s...");
      setTimeout(deployThisRound, settings.deployDelaySec * 1000);
    } catch (e) {
      log("SSE error: " + e.message);
    }
  });

  es.onerror = () => {
    log("SSE disconnected, retry in 5s...");
    es.close();
    setTimeout(connectSSE, 5000);
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`
╔══════════════════════════════════════════╗
║   🫘 BEAN Mining Agent v5.0 + TG Bot     ║
║   Full Settings via Telegram             ║
╚══════════════════════════════════════════╝`);

  if (!CONFIG.PRIVATE_KEY || !CONFIG.RPC_URL || !CONFIG.OPENAI_API_KEY) {
    log("Missing config!"); process.exit(1);
  }

  const settings = loadSettings();
  const balance = await provider.getBalance(wallet.address);
  log("Wallet: " + wallet.address);
  log("Balance: " + ethers.formatEther(balance) + " ETH");

  await tg(
    "🚀 <b>BEAN Agent v5.0 Started!</b>\n\n" +
    "👛 <code>" + CONFIG.WALLET_ADDRESS.slice(0, 6) + "..." + CONFIG.WALLET_ADDRESS.slice(-4) + "</code>\n" +
    "💎 Balance: " + ethers.formatEther(balance) + " ETH\n\n" +
    "✨ <b>Settings aktif:</b>\n" +
    "🟢 Tier 1 (&lt;" + settings.tier1Max + " BEAN): " + settings.tier1Blocks + " blok, " + settings.tier1ETH + " ETH\n" +
    "🟡 Tier 2 (" + settings.tier1Max + " - " + settings.tier2Max + " BEAN): " + settings.tier2Blocks + " blok, " + settings.tier2ETH + " ETH\n" +
    "🔥 Tier 3 (&gt;" + settings.tier2Max + " BEAN): " + settings.tier3Blocks + " blok, " + settings.tier3ETH + " ETH\n" +
    "⏰ Deploy detik ke-" + settings.deployDelaySec + "\n" +
    "💰 Auto claim: " + settings.autoClaimThreshold + " ETH\n\n" +
    "Ketik /settings untuk ubah!\n" +
    "Ketik /status untuk info lengkap!"
  );

  const settings2 = loadSettings();
  setTimeout(deployThisRound, settings2.deployDelaySec * 1000);
  connectSSE();
  log("Agent v5.0 running!");
}

main().catch((err) => { log("Fatal: " + err.message); process.exit(1); });
