// main.js
require('events').EventEmitter.defaultMaxListeners = 20;
const mineflayer = require('mineflayer');
const { loader: baritone } = require('@miner-org/mineflayer-baritone');
const { verifySpawnAndAlert } = require('./src/spawn-assessment');
const { startPhase1 } = require('./src/phases/phase-1');
const { runPhase2 } = require('./src/phases/phase-2');
const readline = require('readline');

async function showMenu() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║       Minecraft AI Bot Launcher      ║');
  console.log('╠══════════════════════════════════════╣');
  console.log('║  1) Speedrun  — shipwreck/ocean loot ║');
  console.log('║  2) Survival  — standard mining route║');
  console.log('╚══════════════════════════════════════╝');
  console.log('');
  return new Promise(resolve => {
    const ask = () => rl.question('Select mode [1/2]: ', answer => {
      const c = answer.trim();
      if (c === '1') { rl.close(); resolve('speedrun'); }
      else if (c === '2') { rl.close(); resolve('survival'); }
      else { console.log('Enter 1 or 2.'); ask(); }
    });
    ask();
  });
}

async function startBot(mode) {

  const bot = mineflayer.createBot({
    host: 'localhost', port: 25565,
    username: 'SpeedrunBot', version: '1.21.1', auth: 'offline',
  });
  bot.loadPlugin(baritone);

let isInitialized = false;
let chunksReceived = 0;

function waitForChunks(minChunks, timeoutMs = 20000) {
  return new Promise(resolve => {
    if (chunksReceived >= minChunks) return resolve(chunksReceived);
    const timer = setTimeout(() => { bot.world.off('chunkColumnLoad', check); resolve(chunksReceived); }, timeoutMs);
    function check() { if (chunksReceived >= minChunks) { clearTimeout(timer); bot.world.off('chunkColumnLoad', check); resolve(chunksReceived); } }
    bot.world.on('chunkColumnLoad', check);
  });
}

function isBotChunkLoaded() {
  try {
    const pos = bot.entity.position;
    return bot.blockAt(pos.floored()) !== null && bot.blockAt(pos.offset(0,-1,0).floored()) !== null;
  } catch { return false; }
}

function waitForBotChunk(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (isBotChunkLoaded()) return resolve();
    const timer = setTimeout(() => { bot.world.off('chunkColumnLoad', check); reject(new Error('Own chunk never loaded')); }, timeoutMs);
    function check() { if (isBotChunkLoaded()) { clearTimeout(timer); bot.world.off('chunkColumnLoad', check); resolve(); } }
    bot.world.on('chunkColumnLoad', check);
  });
}

bot.once('spawn', async () => {
  console.log('[Bot] Spawned at', bot.entity.position);
  bot.world.on('chunkColumnLoad', () => { chunksReceived++; });

  try { await waitForBotChunk(15000); console.log(`[Bot] Own chunk ready (${chunksReceived} columns)`); }
  catch (err) { console.error('[Bot] FATAL: Own chunk never loaded'); bot.end(); return; }

  console.log('[Bot] Waiting for 100 chunks...');
  const total = await waitForChunks(100, 20000);
  console.log(`[Bot] Have ${total} chunks — world ready.`);

  const below = bot.blockAt(bot.entity.position.offset(0,-1,0).floored());
  console.log(`[Bot] Block below: ${below?.name ?? 'null'}`);

  // Wait for bot to land if spawning mid-air (over sand, water, etc.)
  if (!bot.entity.onGround) {
    console.log('[Bot] Spawned in air — waiting to land...');
    await new Promise(resolve => {
      if (bot.entity.onGround) return resolve();
      const iv = setInterval(() => { if (bot.entity.onGround) { clearInterval(iv); resolve(); } }, 100);
      setTimeout(() => { clearInterval(iv); resolve(); }, 3000);
    });
    console.log(`[Bot] Landed at Y=${bot.entity.position.y.toFixed(1)}`);
  }

  if (bot.ashfinder) {
    bot.ashfinder.config.parkour        = false;
    bot.ashfinder.config.breakBlocks    = true;
    bot.ashfinder.config.placeBlocks    = false;
    bot.ashfinder.config.swimming       = true;
    bot.ashfinder.config.maxFallDist    = 3;
    bot.ashfinder.config.disposableBlocks = [
      'oak_leaves','spruce_leaves','birch_leaves','jungle_leaves',
      'acacia_leaves','dark_oak_leaves','mangrove_leaves',
      'vine','cave_vines','cave_vines_plant','glow_lichen',
      'bamboo','bamboo_sapling',
      'short_grass','tall_grass','fern','large_fern','dead_bush',
      'dirt','cobblestone','stone',
    ];
    bot.ashfinder.config.blocksToAvoid  = [
      'crafting_table','chest','furnace',
      'water','flowing_water',
    ];
    bot.ashfinder.config.thinkTimeout   = 10000;
    bot.ashfinder.config.maxWaterDist   = 256;
    bot.ashfinder.debug = false;
    bot.ashfinder.on('pathStarted', ({ path, status }) => console.log(`[Baritone] Path started: ${path.length} nodes (${status})`));
    bot.ashfinder.on('stopped', () => console.log('[Baritone] Stopped'));
    console.log('[Bot] Baritone configured');
  }

  isInitialized = true;

  // ── Spawn assessment ───────────────────────────────────────────────────────
  const spawnResult = verifySpawnAndAlert(bot);
  if (!spawnResult) {
    console.log('[Main] Spawn rejected — disconnecting.');
    bot.end();
    return;
  }

  let { tier, shipwreckPos, monumentPos, fallbackResources } = spawnResult;

  if (mode === 'survival') {
    console.log('[Main] SURVIVAL mode — using standard mining route.');
    tier = 'fallback'; shipwreckPos = null; monumentPos = null;
  }

  console.log(`[Main] Spawn tier: ${tier.toUpperCase()}`);
  if (tier === 'fallback') {
    console.log('[Main] FALLBACK spawn — standard overworld route');
  } else if (tier === 'shipwreck') {
    console.log(`[Main] SHIPWRECK spawn — pos: ${shipwreckPos}`);
  } else if (tier === 'ideal') {
    console.log(`[Main] IDEAL spawn — shipwreck: ${shipwreckPos}, monument: ${monumentPos}`);
  }

  try {
    // BUG FIX: was startPhase1(bot, spawnData) — passing the whole spawnData
    // object as shipwreckPos, which then got forwarded to navigateTo and broke
    // navigation. Now correctly passes shipwreckPos and a proper options object.
    const ok1 = await startPhase1(bot, shipwreckPos, {
      tier,
      monumentPos: monumentPos ?? null,
      fallbackResources: fallbackResources ?? null,
    });

    if (!ok1) {
      console.error('[Main] Phase 1 failed — aborting.');
      return;
    }

    console.log('[Phase2] ── Starting Phase 2 — Nether Portal ──────────────────');
    await runPhase2(bot);
  } catch (err) {
    console.error('[Main] FATAL error:', err);
  }
});

  bot.on('spawn', async () => {
    if (!isInitialized) return;
    console.log('[Bot] Respawned — waiting for chunks...');
    if (bot.ashfinder) bot.ashfinder.stop();
    await waitForChunks(50, 15000);
    console.log('[Bot] Chunks reloaded');
  });

  bot.on('chat', (username, message) => {
  if (username === bot.username) return;
  switch (message.toLowerCase().trim()) {
    case 'inv': case 'inventory': {
      const items = bot.inventory.items();
      if (!items.length) { bot.chat('Inventory empty.'); break; }
      const g = {};
      for (const i of items) g[i.name] = (g[i.name]||0)+i.count;
      const lines = Object.entries(g).sort((a,b) => b[1]-a[1]).map(([n,c]) => `${n}×${c}`).join(', ');
      bot.chat(lines.length <= 200 ? `[Inv] ${lines}` : `[Inv] ${lines.slice(0,200)}...`);
      break;
    }
    case 'pos':    bot.chat(`Pos: ${Math.floor(bot.entity.position.x)} ${Math.floor(bot.entity.position.y)} ${Math.floor(bot.entity.position.z)}`); break;
    case 'health': bot.chat(`Health: ${bot.health.toFixed(1)} | Food: ${bot.food}`); break;
    case 'stop':
      if (bot.ashfinder) bot.ashfinder.stop();
      ['sprint','forward','jump','sneak'].forEach(c => bot.setControlState(c, false));
      bot.chat('Stopped.');
      break;
    case 'chunks': bot.chat(`Chunks: ${chunksReceived}`); break;
  }
});

  bot.on('error', err => console.error('[Bot Error]', err));
  bot.on('kicked', reason => console.log('[Bot Kicked]', reason));
  bot.on('end', reason => console.log('[Bot Disconnected]', reason));
}

showMenu().then(mode => {
  console.log(`\n[Bot] Mode: ${mode.toUpperCase()} — connecting...\n`);
  startBot(mode);
});