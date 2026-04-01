// src/phases/phase-1b.js — Streamlined with Baritone
const Vec3 = require('vec3');
const { scanBlocks, collectBlocks } = require('../utils/blocks');
const { craftIronTools } = require('../utils/crafting');
const { surfaceForAir, startDrowningMonitor, configureForLoot, configureForFlint, restoreDefaultConfig } = require('../utils/water');
const { navigateXZ, diveToPos, navigateToLookAt, navigateTo, manualSwimTo } = require('../utils/navigation');

async function runPhase1B(bot, shipwreckPos) {
  console.log('[Phase1B] Starting — shipwreck looting');

  // Skip if already have iron and food
  const inv = bot.inventory.items();
  const ironCount = inv.filter(i => i.name === 'iron_ingot' || i.name === 'raw_iron')
                       .reduce((s, i) => s + i.count, 0);
  const hasFood = inv.some(i =>
    ['carrot','potato','bread','apple','suspicious_stew'].some(f => i.name.includes(f)));
  const hasPick = inv.some(i => i.name === 'iron_pickaxe');

  if ((ironCount >= 3 || hasPick) && hasFood) {
    console.log('[Phase1B] Already have iron and food — skipping looting');
    if (!hasPick) await craftIronTools(bot);
    return true;
  }

  // Step 1: Navigate to shipwreck area (surface swimming)
  console.log(`[Phase1B] Swimming to shipwreck at (${shipwreckPos.x}, ${shipwreckPos.z})...`);
  try {
    await navigateXZ(bot, shipwreckPos.x, shipwreckPos.z, 120000);
  } catch (err) {
    console.log(`[Phase1B] Approach: ${err.message}`);
    if (bot.entity.position.distanceTo(shipwreckPos) > 30) {
      console.log('[Phase1B] Too far — aborting');
      bot.end();
      return false;
    }
  }

  // Step 2: Loot chests
  configureForLoot(bot);
  console.log('[Phase1B] Looting shipwreck...');
  const loot = await lootShipwreck(bot);
  restoreDefaultConfig(bot);

  const hasPickaxeMaterials = loot.iron >= 3 ||
    bot.inventory.items().some(i => i.name === 'iron_pickaxe');
  const hasLootFood = loot.food.length > 0 ||
    bot.inventory.items().some(i =>
      ['carrot','potato','bread','apple','suspicious_stew'].some(f => i.name.includes(f)));

  if (!hasPickaxeMaterials || !hasLootFood) {
    console.error('[Phase1B] Insufficient loot — aborting.');
    bot.end();
    return false;
  }

  // Step 3: Craft iron tools
  const hasPickNow = bot.inventory.items().some(i => i.name === 'iron_pickaxe');
  const hasAxe = bot.inventory.items().some(i => i.name === 'iron_axe');
  const hasBucket = bot.inventory.items().some(i => i.name === 'bucket');
  
  if (!hasPickNow || !hasAxe || !hasBucket) {
    console.log('[Phase1B] Crafting iron tools...');
    await craftIronTools(bot);
  }

  // Step 4: Collect flint
  const flintCount = bot.inventory.items().find(i => i.name === 'flint')?.count ?? 0;
  if (flintCount < 3) {
    console.log(`[Phase1B] Flint: ${flintCount}/3 — mining gravel...`);
    configureForFlint(bot);
    await collectFlint(bot, 3 - flintCount);
    restoreDefaultConfig(bot);
  }

  console.log('[Phase1B] Complete ✓');
  return true;
}

async function lootShipwreck(bot) {
  const monitor = startDrowningMonitor(bot);

  // Find all chests in wide area
  const chests = scanBlocks(bot, {
    centerPos: bot.entity.position,
    radiusXZ: 100,
    yMin: 40,
    yMax: 65,
    stepXZ: 1,
    stepY: 1,
    match: b => b.name === 'chest',
    limit: 10,
  });

  console.log(`[Loot] Found ${chests.length} chest(s)`);
  chests.forEach(p => console.log(`  chest at ${p}`));

  if (chests.length === 0) {
    monitor.stop();
    return { success: false, iron: 0, emeralds: 0, food: [] };
  }

  // Sort by distance
  const sorted = [...chests].sort((a, b) =>
    a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));

  let totalIron = 0, emeralds = 0, chestsLooted = 0, foodItems = [];
  let hasDied = false;
  const onDeath = () => { hasDied = true; console.log('[Loot] Bot died — aborting loot loop'); };
  bot.once('death', onDeath);

  for (const chestPos of sorted) {
    if (hasDied) break;
    try {
      await lootOneChest(bot, chestPos, monitor);
      chestsLooted++;

      // Update totals
      const inv = bot.inventory.items();
      const ingots = inv.filter(i => i.name === 'iron_ingot').reduce((s, i) => s + i.count, 0);
      const nuggets = inv.filter(i => i.name === 'iron_nugget').reduce((s, i) => s + i.count, 0);
      const raw = inv.filter(i => i.name === 'raw_iron').reduce((s, i) => s + i.count, 0);
      totalIron = ingots + raw + Math.floor(nuggets / 9);
      emeralds = inv.filter(i => i.name.includes('emerald')).reduce((s, i) => s + i.count, 0);
      foodItems = inv.filter(i =>
        ['carrot','potato','bread','apple','suspicious_stew'].some(f => i.name.includes(f)));
      
      console.log(`[Loot] Iron≈${totalIron}, emeralds=${emeralds}, food=${foodItems.length}`);
    } catch (err) {
      console.log(`[Loot] Chest ${chestPos} error: ${err.message}`);
    }
    
    await surfaceForAir(bot);
  }

  bot.off('death', onDeath);
  monitor.stop();
  await surfaceForAir(bot);
  console.log(`[Loot] Done — ${chestsLooted}/${chests.length} chests`);
  
  return {
    success: totalIron >= 3 && foodItems.length > 0,
    iron: totalIron,
    emeralds,
    food: foodItems
  };
}

async function lootOneChest(bot, chestPos, monitor) {
  console.log(`[Loot] Targeting chest at ${chestPos}...`);

  // Surface and hold at surface until oxygen fully recharged
  await surfaceForAir(bot);
  bot.setControlState('jump', true);  // hold at surface so oxygen recharges
  const oxyDeadline = Date.now() + 12000;
  while (Date.now() < oxyDeadline && bot.oxygenLevel < 280) {
    await bot.waitForTicks(5);
  }
  bot.setControlState('jump', false);
  console.log(`[Loot] Oxygen ready: ${bot.oxygenLevel}`);

  // Guard: if bot died and respawned far from chest, swim back first
  const pos = bot.entity.position;
  const xzDist = Math.sqrt((chestPos.x - pos.x) ** 2 + (chestPos.z - pos.z) ** 2);
  if (xzDist > 20) {
    console.log(`[Loot] Bot is ${xzDist.toFixed(0)} blocks away — swimming to chest area`);
    await manualSwimTo(bot, chestPos.x, chestPos.z, 60000);
    await surfaceForAir(bot);
    bot.setControlState('jump', true);
    const oxyDeadline2 = Date.now() + 12000;
    while (Date.now() < oxyDeadline2 && bot.oxygenLevel < 280) {
      await bot.waitForTicks(5);
    }
    bot.setControlState('jump', false);
    console.log(`[Loot] Oxygen ready after re-approach: ${bot.oxygenLevel}`);
  }

  // Pause drowning monitor so it doesn't interrupt intentional dive
  monitor.pause();

  // Dive with Baritone + block-breaking so it can punch through shipwreck hull.
  // Also abort early if oxygen drops below 60 (20% of 300) to avoid drowning.
  console.log(`[Loot] Diving to chest at ${chestPos}...`);
  const wasBreaking = bot.ashfinder.config.breakBlocks;
  bot.ashfinder.config.breakBlocks = true;
  bot.ashfinder.config.swimming    = true;
  // Add shipwreck wood to disposable so pathfinder routes through hull
  const extraDisposable = [
    'oak_planks','spruce_planks','oak_stairs','spruce_stairs',
    'oak_slab','spruce_slab','oak_log','spruce_log',
  ];
  const origDisposable = [...bot.ashfinder.config.disposableBlocks];
  for (const b of extraDisposable) {
    if (!bot.ashfinder.config.disposableBlocks.includes(b))
      bot.ashfinder.config.disposableBlocks.push(b);
  }

  // Oxygen watchdog — surface immediately if air gets critical
  let oxyAborted = false;
  const oxyWatch = setInterval(() => {
    if (bot.oxygenLevel < 60 && !oxyAborted) {
      oxyAborted = true;
      if (bot.ashfinder && !bot.ashfinder.stopped) bot.ashfinder.stop();
      console.log(`[Loot] Oxygen low (${bot.oxygenLevel}) — aborting dive`);
    }
  }, 300);

  let reached = false;
  try {
    const { GoalNear } = require('../goal');
    const result = await Promise.race([
      bot.ashfinder.goto(new GoalNear(chestPos, 3)),
      new Promise((_, r) => setTimeout(() => r(new Error('dive timeout')), 30000)),
      new Promise((_, r) => {
        const iv = setInterval(() => { if (oxyAborted) { clearInterval(iv); r(new Error('oxy abort')); } }, 200);
      }),
    ]);
    reached = result?.status === 'success';
  } catch (e) {
    console.log(`[Loot] Dive ended: ${e.message}`);
  } finally {
    clearInterval(oxyWatch);
    bot.ashfinder.config.breakBlocks    = wasBreaking;
    bot.ashfinder.config.disposableBlocks = origDisposable;
  }

  monitor.resume();

  if (!reached) {
    console.log('[Loot] Could not reach chest, skipping');
    return;
  }

  // Look at and open chest
  try {
    await navigateToLookAt(bot, chestPos, 4, 5000);
  } catch (e) {
    await bot.lookAt(chestPos.offset(0.5, 0.5, 0.5));
  }

  const chestBlock = bot.blockAt(chestPos);
  if (!chestBlock || chestBlock.name !== 'chest') {
    console.log('[Loot] Chest gone');
    return;
  }

  // Open container
  let container;
  try {
    container = await Promise.race([
      bot.openContainer(chestBlock),
      new Promise((_, r) => setTimeout(() => r(new Error('open timeout')), 5000)),
    ]);
  } catch (e) {
    console.log(`[Loot] Open failed: ${e.message}`);
    return;
  }

  // Loot everything
  const slots = container.containerItems();
  console.log(`[Loot] Contents: ${slots.map(s => `${s.name}×${s.count}`).join(', ') || 'empty'}`);
  
  for (const slot of [...slots]) {
    try {
      await container.withdraw(slot.type, null, slot.count);
      await bot.waitForTicks(2);
    } catch (e) {
      console.log(`[Loot] Withdraw ${slot.name}: ${e.message}`);
    }
  }
  
  await bot.closeWindow(container);
  console.log('[Loot] Chest looted ✓');
}

async function collectFlint(bot, needed) {
  const shovel = bot.inventory.items().find(i => i.name.includes('_shovel'));
  const gravel = await collectBlocks(bot, ['gravel'], needed * 3, shovel ? 'shovel' : 'fist', [], 64);
  console.log(`[Flint] Mined ${gravel.length} gravel`);
}

module.exports = { runPhase1B, lootShipwreck, collectFlint };