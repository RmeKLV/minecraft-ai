// src/phases/phase-1b-fallback.js
// Milestones:
//   M1 — stone/iron pickaxe
//   M2 — crafting_table + furnace in inventory
//   M3 — 9+ iron (raw + ingot combined)
//   M4 — 4+ coal/charcoal
//   M5 — surface, smelt raw iron
//   M6 — craft iron pickaxe + bucket
//   M7 — craft iron armor

const Vec3 = require('vec3');
const { navigateTo, navigateToSmart, safeStop } = require('../utils/navigation');
const { collectBlocks, scanBlocks, getBestPickaxe } = require('../utils/blocks');
const {
  craftItem, craftStoneTools, craftFurnace, craftIronTools, craftIronArmor,
  ensureTableInInventory, getOrPlaceCraftingTable, retrieveTable,
} = require('../utils/crafting');

const IRON_GOAL = 9;
const STONE_NAMES = ['stone','cobblestone','cobbled_deepslate','granite','diorite','andesite','tuff'];
const IRON_NAMES  = ['iron_ore','deepslate_iron_ore'];
const COAL_NAMES  = ['coal_ore','deepslate_coal_ore'];

function countOf(bot, names) { return bot.inventory.items().filter(i => names.includes(i.name)).reduce((s,i) => s+i.count, 0); }
const countCobble    = bot => countOf(bot, ['cobblestone','cobbled_deepslate']);
const countCoal      = bot => countOf(bot, ['coal','charcoal']);
const countRawIron   = bot => countOf(bot, ['raw_iron']);
const countIronIngot = bot => countOf(bot, ['iron_ingot']);
const countIronTotal = bot => countRawIron(bot) + countIronIngot(bot);
const hasStonePick   = bot => bot.inventory.items().some(i =>
  ['stone_pickaxe','iron_pickaxe','diamond_pickaxe','netherite_pickaxe'].includes(i.name));
const hasAnyPickaxe  = bot => bot.inventory.items().some(i => i.name.includes('_pickaxe'));

function logState(bot, label) {
  const items = {};
  for (const i of bot.inventory.items()) items[i.name] = (items[i.name]||0)+i.count;
  console.log(`[Fallback] ${label}: ${Object.entries(items).map(([n,c]) => `${n}×${c}`).join(', ') || 'empty'}`);
}

async function ensurePickaxe(bot) {
  const pick = getBestPickaxe(bot);
  const broken = !pick || (pick.durabilityUsed != null && pick.maxDurability != null &&
    (pick.maxDurability - pick.durabilityUsed) <= 10);
  if (broken) {
    console.log('[Fallback] Pickaxe broken/missing — crafting replacement...');
    await ensureTableInInventory(bot);
    if (countCobble(bot) >= 3) {
      await craftStoneTools(bot);
    } else {
      const planks = bot.inventory.items().filter(i => i.name.includes('_planks')).reduce((s,i) => s+i.count, 0);
      if (planks >= 5) {
        const tablePos = await getOrPlaceCraftingTable(bot);
        if (tablePos) {
          await craftItem(bot, 'stick', 1, null);
          await craftItem(bot, 'wooden_pickaxe', 1, tablePos);
          await retrieveTable(bot, tablePos);
        }
      }
    }
  }
  if (!hasStonePick(bot) && countCobble(bot) >= 3) {
    console.log('[Fallback] Upgrading to stone pickaxe...');
    await craftStoneTools(bot);
  }
}

// ─── surfaceBot ───────────────────────────────────────────────────────────────

async function surfaceBot(bot) {
  if (bot.entity.position.y >= 60) { console.log('[Fallback] Already near surface'); return; }
  console.log(`[Fallback] Surfacing from Y=${Math.floor(bot.entity.position.y)}...`);

  const bx = Math.floor(bot.entity.position.x);
  const bz = Math.floor(bot.entity.position.z);
  for (let y = 80; y >= 62; y--) {
    const b = bot.blockAt(new Vec3(bx, y, bz));
    if (b && b.name === 'air') {
      try {
        await navigateTo(bot, new Vec3(bx, y, bz), 3, 60000);
        if (bot.entity.position.y >= 60) { console.log(`[Fallback] Surfaced at Y=${Math.floor(bot.entity.position.y)}`); return; }
      } catch (_) {}
      break;
    }
  }

  for (const [dx, dz] of [[0,0],[5,0],[-5,0],[0,5],[0,-5],[10,0],[-10,0]]) {
    const surfaceTarget = new Vec3(bx + dx, 64, bz + dz);
    try {
      await navigateTo(bot, surfaceTarget, 5, 45000);
      if (bot.entity.position.y >= 60) { console.log(`[Fallback] Surfaced at Y=${Math.floor(bot.entity.position.y)}`); return; }
    } catch (_) {}
  }

  console.log('[Fallback] Digging up to surface...');
  await ensurePickaxe(bot);
  for (let attempt = 0; attempt < 60 && bot.entity.position.y < 60; attempt++) {
    const bp = bot.entity.position.floored();
    for (const dy of [1, 2]) {
      const b = bot.blockAt(bp.offset(0, dy, 0));
      if (b && b.name !== 'air' && b.boundingBox !== 'empty' && b.name !== 'lava' && b.name !== 'water') {
        try { if (bot.canDigBlock(b)) await bot.dig(b, true); } catch (_) {}
      }
    }
    bot.setControlState('jump', true);
    await bot.waitForTicks(4);
    bot.setControlState('jump', false);
    await bot.waitForTicks(4);
  }
  safeStop(bot);
  console.log(`[Fallback] At Y=${Math.floor(bot.entity.position.y)} after surfacing`);
}

// ─── placeFurnaceOnSurface ────────────────────────────────────────────────────

async function placeFurnaceOnSurface(bot) {
  const furnaceItem = bot.inventory.items().find(i => i.name === 'furnace');
  if (!furnaceItem) return null;

  const botPos = bot.entity.position.floored();
  for (let r = 0; r <= 5; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (r > 0 && Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
        const floorPos = botPos.offset(dx, -1, dz);
        const placePos = floorPos.offset(0, 1, 0);
        const clearPos = placePos.offset(0, 1, 0);
        const floor = bot.blockAt(floorPos);
        const place = bot.blockAt(placePos);
        const clear = bot.blockAt(clearPos);
        if (
          floor?.boundingBox === 'block' && floor.name !== 'lava' && floor.name !== 'water' &&
          (place?.name === 'air' || place?.boundingBox === 'empty') &&
          (clear?.name === 'air' || clear?.boundingBox === 'empty')
        ) {
          try {
            await bot.equip(furnaceItem, 'hand');
            await bot.waitForTicks(2);
            await bot.placeBlock(floor, new Vec3(0, 1, 0));
            const placed = floorPos.offset(0, 1, 0);
            console.log(`[Fallback] Furnace placed at ${placed}`);
            return placed;
          } catch (_) {}
        }
      }
    }
  }
  console.log('[Fallback] Could not place furnace on surface');
  return null;
}

// ─── smeltItems ───────────────────────────────────────────────────────────────

async function smeltItems(bot, furnacePos, rawCount) {
  try { await navigateTo(bot, furnacePos, 2, 15000); } catch (_) {}
  const furnaceBlock = bot.blockAt(furnacePos);
  if (!furnaceBlock || furnaceBlock.name !== 'furnace') {
    console.log('[Fallback] Furnace not at expected position — scanning nearby...');
    const pos = bot.entity.position.floored();
    let found = null;
    for (let dx = -5; dx <= 5 && !found; dx++)
      for (let dz = -5; dz <= 5 && !found; dz++)
        for (let dy = -2; dy <= 2 && !found; dy++) {
          const b = bot.blockAt(pos.offset(dx,dy,dz));
          if (b?.name === 'furnace') found = b.position;
        }
    if (!found) { console.log('[Fallback] Furnace lost — cannot smelt'); return; }
    furnacePos = found;
  }
  try {
    const block = bot.blockAt(furnacePos);
    const furnace = await bot.openFurnace(block);
    await bot.waitForTicks(10);
    const fuel = bot.inventory.items().find(i => i.name === 'coal')
      || bot.inventory.items().find(i => i.name === 'charcoal')
      || bot.inventory.items().find(i => i.name.includes('_planks'))
      || bot.inventory.items().find(i => i.name.includes('_log'));
    if (!fuel) { console.log('[Fallback] No fuel!'); await furnace.close(); return; }
    await furnace.putFuel(fuel.type, null, Math.min(fuel.count, rawCount + 2));
    await bot.waitForTicks(5);
    const rawItem = bot.inventory.items().find(i => i.name === 'raw_iron');
    if (rawItem) { await furnace.putInput(rawItem.type, null, rawItem.count); await bot.waitForTicks(5); }
    // BUG FIX: was rawCount * 210. One iron smelts in 200 ticks (10 s).
    const smeltTicks = Math.min(1800, rawCount * 200 + 40);
    console.log(`[Fallback] Smelting ${rawCount} iron (~${(smeltTicks/20).toFixed(0)}s)...`);
    await bot.waitForTicks(smeltTicks);
    for (let i = 0; i < 10; i++) {
      if (!furnace.outputItem()) break;
      try { await furnace.takeOutput(); await bot.waitForTicks(3); } catch (_) { break; }
    }
    await furnace.close();
    console.log(`[Fallback] Smelt done. Ingots: ${countIronIngot(bot)}`);
    const fblock = bot.blockAt(furnacePos);
    if (fblock?.name === 'furnace') {
      try { await bot.dig(fblock); await bot.waitForTicks(15); console.log('[Fallback] Furnace picked up'); }
      catch (_) {}
    }
  } catch (err) { console.log(`[Fallback] Smelt error: ${err.message}`); }
}

// ─── Main phase ───────────────────────────────────────────────────────────────

async function runPhase1BFallback(bot, fallbackResources) {
  console.log('[Phase1B-Fallback] Starting...');
  logState(bot, 'Start');

  // If bot dies mid-phase, abort immediately. Continuing from the new respawn
  // position with stale coordinates causes the bot to wander far off course.
  let phaseDied = false;
  const onDeath = () => {
    phaseDied = true;
    console.log('[Fallback] Bot died — phase will abort after current step');
  };
  bot.once('death', onDeath);

  // Helper to check after each major step
  const checkDead = () => {
    if (phaseDied) { console.log('[Fallback] Aborting phase due to death'); return true; }
    return false;
  };

  const resources = fallbackResources?.resources ?? [];
  const ironOre = resources.find(r => r.type === 'iron_ore');
  const ravine  = resources.find(r => r.type === 'ravine');

  // ── M1: stone pickaxe ─────────────────────────────────────────────────────
  if (!hasStonePick(bot)) {
    console.log('[Fallback] M1: Getting stone pickaxe...');

    if (countCobble(bot) < 3) {
      // BUG FIX: was hardcoded tool='pickaxe'. If no pickaxe exists yet
      // (craftWoodenTools failed earlier) this would be mining with a ghost tool.
      // Now uses whatever the bot actually has.
      const tool = hasAnyPickaxe(bot) ? 'pickaxe' : 'fist';
      await collectBlocks(bot, STONE_NAMES, 3 - countCobble(bot), tool, [], 20);
      await bot.waitForTicks(10);
    }

    if (countCobble(bot) >= 3) {
      await craftStoneTools(bot);
    }

    // BUG FIX: was always printing "Continuing with wooden pickaxe" regardless
    // of whether a wooden pickaxe actually existed in inventory. Now there are
    // three distinct outcomes with accurate messages.
    if (hasStonePick(bot)) {
      console.log('[Fallback] M1: Stone pickaxe ✓');
    } else if (hasAnyPickaxe(bot)) {
      console.log('[Fallback] M1: No stone pick — continuing with wooden pickaxe');
    } else {
      // Truly no pickaxe at all — attempt emergency wooden pickaxe from planks
      console.log('[Fallback] M1: No pickaxe at all — crafting emergency wooden pickaxe...');
      const planks = bot.inventory.items().filter(i => i.name.includes('_planks')).reduce((s,i) => s+i.count, 0);
      if (planks >= 5) {
        await ensureTableInInventory(bot);
        const tablePos = await getOrPlaceCraftingTable(bot);
        if (tablePos) {
          await craftItem(bot, 'stick', 1, null);
          await craftItem(bot, 'wooden_pickaxe', 1, tablePos);
          await retrieveTable(bot, tablePos);
        }
      }
      if (hasAnyPickaxe(bot)) {
        console.log('[Fallback] M1: Emergency wooden pickaxe ready ✓');
      } else {
        console.warn('[Fallback] M1: Could not craft any pickaxe — mining will be very slow');
      }
    }
  } else { console.log('[Fallback] M1: Stone pickaxe ✓'); }

  if (checkDead()) { bot.off('death', onDeath); return false; }

  // ── M2: crafting_table + furnace in inventory ──────────────────────────────
  console.log('[Fallback] M2: Emergency kit...');
  await ensureTableInInventory(bot);
  if (!bot.inventory.items().some(i => i.name === 'furnace')) {
    if (countCobble(bot) < 8) {
      const need = 8 - countCobble(bot);
      console.log(`[Fallback] Mining ${need} cobblestone for furnace...`);
      const tool = hasAnyPickaxe(bot) ? 'pickaxe' : 'fist';
      await collectBlocks(bot, STONE_NAMES, need, tool, [], 25);
      await bot.waitForTicks(10);
      await ensurePickaxe(bot);
    }
    if (countCobble(bot) >= 8) { await craftFurnace(bot); console.log('[Fallback] M2: Furnace crafted ✓'); }
    else console.log('[Fallback] M2: Not enough cobble for furnace');
  } else { console.log('[Fallback] M2: Emergency kit ✓'); }

  // ── Navigate toward known iron/ravine ─────────────────────────────────────
  const dest = ironOre?.pos ?? ravine?.pos ?? null;
  if (dest && countIronTotal(bot) < IRON_GOAL) {
    const destVec = new Vec3(dest.x, dest.y, dest.z);
    const dist = bot.entity.position.distanceTo(destVec);
    console.log(`[Fallback] Heading to ${ironOre ? 'iron ore' : 'ravine'} at ${destVec} (${dist.toFixed(0)} blocks)`);
    try { await navigateToSmart(bot, destVec, 5, Math.max(90000, dist * 600)); }
    catch (err) { console.log(`[Fallback] Nav partial: ${err.message}`); }
    await ensurePickaxe(bot);
  }

  // ── M3: mine iron ore ─────────────────────────────────────────────────────
  if (countIronTotal(bot) < IRON_GOAL) {
    console.log(`[Fallback] M3: Mining iron (have ${countIronTotal(bot)}/${IRON_GOAL})...`);
    for (let pass = 0; pass < 3 && countIronTotal(bot) < IRON_GOAL; pass++) {
      await ensurePickaxe(bot);
      const tool = hasAnyPickaxe(bot) ? 'pickaxe' : 'fist';
      await collectBlocks(bot, IRON_NAMES, IRON_GOAL - countIronTotal(bot), tool, [], pass === 2 ? 100 : 60);
      await bot.waitForTicks(10);
      console.log(`[Fallback] Iron total: ${countIronTotal(bot)}`);
    }
  } else { console.log(`[Fallback] M3: Iron ✓ (${countIronTotal(bot)})`); }

  if (checkDead()) { bot.off('death', onDeath); return false; }

  await ensurePickaxe(bot);

  // ── M4: coal ──────────────────────────────────────────────────────────────
  if (countCoal(bot) < 4) {
    console.log('[Fallback] M4: Getting coal...');
    const tool = hasAnyPickaxe(bot) ? 'pickaxe' : 'fist';
    await collectBlocks(bot, COAL_NAMES, 4 - countCoal(bot), tool, [], 50);
    await bot.waitForTicks(10);
    if (countCoal(bot) < 2) console.log('[Fallback] M4: No coal — will use wood as fuel');
    else console.log(`[Fallback] M4: Coal ✓ (${countCoal(bot)})`);
  } else { console.log(`[Fallback] M4: Fuel ✓ (${countCoal(bot)})`); }

  // ── M5: surface, then smelt ───────────────────────────────────────────────
  const rawIron = countRawIron(bot);
  if (rawIron > 0) {
    console.log('[Fallback] M5: Surfacing to smelt...');
    await surfaceBot(bot);
    await bot.waitForTicks(10);

    let furnacePos = null;
    const pos = bot.entity.position.floored();
    for (let dx = -20; dx <= 20 && !furnacePos; dx++)
      for (let dz = -20; dz <= 20 && !furnacePos; dz++) {
        const b = bot.blockAt(pos.offset(dx, 0, dz)) ?? bot.blockAt(pos.offset(dx, -1, dz));
        if (b?.name === 'furnace') furnacePos = b.position;
      }

    if (!furnacePos) {
      const fi = bot.inventory.items().find(i => i.name === 'furnace');
      if (fi) {
        furnacePos = await placeFurnaceOnSurface(bot);
      } else if (countCobble(bot) >= 8) {
        await craftFurnace(bot);
        furnacePos = await placeFurnaceOnSurface(bot);
      }
    }

    if (furnacePos) {
      console.log(`[Fallback] M5: Smelting ${rawIron} raw iron at ${furnacePos}...`);
      await smeltItems(bot, furnacePos, rawIron);
    } else {
      console.log('[Fallback] M5: Could not place furnace — skipping smelt');
    }
  } else { console.log('[Fallback] M5: No raw iron to smelt'); }

  // ── M6: iron tools ────────────────────────────────────────────────────────
  if (bot.entity.position.y < 55) await surfaceBot(bot);

  const ironForTools = countIronIngot(bot);
  console.log(`[Fallback] M6: Iron ingots: ${ironForTools}`);
  if (ironForTools >= 3) {
    await craftIronTools(bot);
    console.log('[Fallback] M6: Iron tools ✓');
  } else {
    console.log('[Fallback] M6: Not enough iron ingots — continuing with stone');
  }

  // ── M7: iron armor ────────────────────────────────────────────────────────
  const ironForArmor = countIronIngot(bot);
  console.log(`[Fallback] M7: Iron for armor: ${ironForArmor}`);
  if (ironForArmor >= 4) {
    await craftIronArmor(bot);
    console.log('[Fallback] M7: Armor ✓');
  } else {
    console.log('[Fallback] M7: Not enough iron for armor');
  }

  // ── Gravel for flint ──────────────────────────────────────────────────────
  if (countOf(bot, ['flint']) < 1) {
    console.log('[Fallback] Getting flint from gravel...');
    const gravel = scanBlocks(bot, {
      centerPos: bot.entity.position, radiusXZ: 60,
      yMin: Math.max(0, Math.floor(bot.entity.position.y) - 5),
      yMax: Math.floor(bot.entity.position.y) + 5,
      stepXZ: 1, stepY: 1, match: b => b.name === 'gravel', limit: 10,
    });
    let attempts = 0;
    while (countOf(bot, ['flint']) < 1 && attempts < 15 && gravel.length > 0) {
      attempts++;
      const target = gravel.shift();
      try {
        await navigateTo(bot, target, 3, 15000);
        const b = bot.blockAt(target);
        if (b?.name === 'gravel') {
          const shovel = bot.inventory.items().find(i => i.name.includes('_shovel'));
          if (shovel) await bot.equip(shovel, 'hand').catch(() => {});
          await bot.dig(b, true);
          await bot.waitForTicks(10);
          if (countOf(bot, ['flint']) >= 1) console.log('[Fallback] Flint obtained ✓');
        }
      } catch (_) {}
    }
    if (countOf(bot, ['flint']) < 1) console.log('[Fallback] No flint — phase 2 will search for gravel');
  }

  logState(bot, 'Final');
  console.log('[Phase1B-Fallback] Complete ✓');
  bot.off('death', onDeath);
  return hasAnyPickaxe(bot);
}

module.exports = { runPhase1BFallback };