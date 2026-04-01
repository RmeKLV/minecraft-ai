// src/utils/crafting.js
const Vec3 = require('vec3');
const { navigateTo, navigateAdjacent, safeStop } = require('./navigation');

const LOG_TYPES = [
  'oak_log','spruce_log','birch_log','jungle_log',
  'acacia_log','dark_oak_log','mangrove_log','cherry_log',
];

async function craftItem(bot, itemName, amount, workbenchPos = null) {
  const mcData = require('minecraft-data')(bot.version);
  const item = mcData.itemsByName[itemName];
  if (!item) { console.log(`[Craft] Unknown: ${itemName}`); return false; }

  let workbenchBlock = null;
  if (workbenchPos) {
    workbenchBlock = bot.blockAt(workbenchPos);
    if (!workbenchBlock || workbenchBlock.name !== 'crafting_table') {
      console.log(`[Craft] No table at ${workbenchPos}`); return false;
    }
    if (bot.entity.position.distanceTo(workbenchPos) > 3)
      await navigateAdjacent(bot, workbenchPos, 15000).catch(e => console.log(`[Craft] Nav: ${e.message}`));
    workbenchBlock = bot.blockAt(workbenchPos);
    if (!workbenchBlock || workbenchBlock.name !== 'crafting_table') { console.log('[Craft] Table gone'); return false; }
  }

  const recipes = bot.recipesFor(item.id, null, 1, workbenchBlock);
  if (!recipes?.length) {
    const inv = bot.recipesFor(item.id, null, 1, null);
    if (!inv?.length) { console.log(`[Craft] No recipe: ${itemName}`); return false; }
    try { await bot.craft(inv[0], amount, null); console.log(`[Craft] Crafted ${amount}× ${itemName}`); return true; }
    catch (e) { console.log(`[Craft] Failed: ${e.message}`); return false; }
  }
  try { await bot.craft(recipes[0], amount, workbenchBlock); console.log(`[Craft] Crafted ${amount}× ${itemName}`); return true; }
  catch (e) { console.log(`[Craft] Failed: ${e.message}`); return false; }
}

async function retrieveTable(bot, tablePos) {
  const block = bot.blockAt(tablePos);
  if (!block || block.name !== 'crafting_table') return;
  try {
    if (bot.entity.position.distanceTo(tablePos) > 4)
      await navigateAdjacent(bot, tablePos, 10000).catch(() => {});
    await bot.dig(block);
    await bot.waitForTicks(20);
    console.log('[Craft] Table retrieved ✓');
  } catch (e) { console.log(`[Craft] Retrieve failed: ${e.message}`); }
}

async function getOrPlaceCraftingTable(bot) {
  // ── 1. Look for an existing placed table nearby ──────────────────────────
  const cx = Math.floor(bot.entity.position.x);
  const cy = Math.floor(bot.entity.position.y);
  const cz = Math.floor(bot.entity.position.z);
  let best = null, bestDist = Infinity;
  for (let dx = -30; dx <= 30; dx++) for (let dz = -30; dz <= 30; dz++) for (let dy = -4; dy <= 4; dy++) {
    const b = bot.blockAt(new Vec3(cx+dx, cy+dy, cz+dz));
    if (b?.name === 'crafting_table') {
      const d = bot.entity.position.distanceTo(b.position);
      if (d < bestDist) { best = b; bestDist = d; }
    }
  }
  if (best) {
    console.log(`[Craft] Found table at ${best.position} (${bestDist.toFixed(1)} blocks)`);
    if (bestDist > 3) await navigateAdjacent(bot, best.position, 15000).catch(() => {});
    return best.position;
  }

  const tableItem = bot.inventory.items().find(i => i.name === 'crafting_table');
  if (!tableItem) { console.log('[Craft] No crafting table in inventory!'); return null; }

  // ── 2. Scan adjacent positions for a ready placement spot ────────────────
  // Requires: solid floor, air at table level, air at head level.
  const botPos = bot.entity.position.floored();
  for (let r = 1; r <= 4; r++) {
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
      if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
      for (const dy of [0, -1, 1]) {
        const floorPos = botPos.offset(dx, dy - 1, dz);
        const placePos = floorPos.offset(0, 1, 0);
        const clearPos = placePos.offset(0, 1, 0);
        const floorBlk = bot.blockAt(floorPos);
        const placeBlk = bot.blockAt(placePos);
        const clearBlk = bot.blockAt(clearPos);
        if (
          floorBlk?.boundingBox === 'block' && !floorBlk.name.includes('leaves') &&
          (placeBlk?.name === 'air' || placeBlk?.boundingBox === 'empty') &&
          (clearBlk?.name === 'air' || clearBlk?.boundingBox === 'empty')
        ) {
          try {
            await bot.equip(tableItem, 'hand');
            await bot.waitForTicks(2);
            await bot.placeBlock(floorBlk, new Vec3(0, 1, 0));
            console.log(`[Craft] Placed table at ${placePos}`);
            return placePos;
          } catch (e) { /* try next spot */ }
        }
      }
    }
  }

  // ── 3. Fallback: DIG adjacent blocks to carve out a placement spot ────────
  // Handles mountainsides and tight caves where every adjacent tile is solid.
  // We try to dig a 1×2 niche (table + head clearance) to the side.
  console.log('[Craft] No open spot found — attempting to dig placement niche...');
  const DIGGABLE = b => b && b.name !== 'air' && b.boundingBox !== 'empty'
                     && b.name !== 'lava' && b.name !== 'water'
                     && b.name !== 'bedrock' && b.name !== 'obsidian';

  for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    const floorPos = botPos.offset(dx, -1, dz); // floor tile next to bot
    const placePos = floorPos.offset(0, 1, 0);  // table position
    const clearPos = placePos.offset(0, 1, 0);  // head clearance
    const floorBlk = bot.blockAt(floorPos);

    // Need a solid floor to place on
    if (!floorBlk || floorBlk.boundingBox !== 'block') continue;

    // Dig placePos if it's solid
    const placeBlk = bot.blockAt(placePos);
    if (DIGGABLE(placeBlk) && bot.canDigBlock(placeBlk)) {
      try { await bot.dig(placeBlk, true); await bot.waitForTicks(3); } catch (_) {}
    }

    // Dig clearPos if it's solid
    const clearBlk = bot.blockAt(clearPos);
    if (DIGGABLE(clearBlk) && bot.canDigBlock(clearBlk)) {
      try { await bot.dig(clearBlk, true); await bot.waitForTicks(3); } catch (_) {}
    }

    // Re-check conditions after digging
    const place2 = bot.blockAt(placePos);
    const clear2 = bot.blockAt(clearPos);
    const floor2 = bot.blockAt(floorPos);
    if (
      floor2?.boundingBox === 'block' &&
      (place2?.name === 'air' || place2?.boundingBox === 'empty') &&
      (clear2?.name === 'air' || clear2?.boundingBox === 'empty')
    ) {
      try {
        await bot.equip(tableItem, 'hand');
        await bot.waitForTicks(2);
        await bot.placeBlock(floor2, new Vec3(0, 1, 0));
        console.log(`[Craft] Placed table at ${placePos} (after digging niche)`);
        return placePos;
      } catch (_) {}
    }
  }

  console.log('[Craft] No placement spot found even after digging — cannot place crafting table');
  return null;
}

async function ensureTableInInventory(bot) {
  if (bot.inventory.items().some(i => i.name === 'crafting_table')) return true;
  const pos = bot.entity.position.floored();
  for (let dx = -20; dx <= 20; dx++) for (let dz = -20; dz <= 20; dz++) for (let dy = -4; dy <= 4; dy++) {
    const b = bot.blockAt(new Vec3(pos.x+dx, pos.y+dy, pos.z+dz));
    if (b?.name === 'crafting_table') {
      try {
        if (b.position.distanceTo(bot.entity.position) > 3)
          await navigateAdjacent(bot, b.position, 10000).catch(() => {});
        await bot.dig(b);
        await bot.waitForTicks(15);
        if (bot.inventory.items().some(i => i.name === 'crafting_table')) { console.log('[Craft] Picked up nearby table ✓'); return true; }
      } catch (_) {}
    }
  }
  const planks = bot.inventory.items().filter(i => i.name.includes('_planks')).reduce((s,i) => s+i.count, 0);
  if (planks >= 4) { const ok = await craftItem(bot, 'crafting_table', 1); if (ok) return true; }
  console.log('[Craft] Cannot get crafting table');
  return false;
}

// BUG FIX: now returns a boolean so callers can detect failure.
// Previously returned undefined (bare `return`) on tablePos=null, silently
// skipping all tool crafting with no error.
async function craftWoodenTools(bot) {
  const logCount = bot.inventory.items().filter(i => LOG_TYPES.includes(i.name)).reduce((s,i) => s+i.count, 0);
  console.log(`[Craft] Wooden tools — logs: ${logCount}`);
  for (const logItem of bot.inventory.items().filter(i => LOG_TYPES.includes(i.name))) {
    await craftItem(bot, logItem.name.replace('_log', '_planks'), logItem.count);
    await bot.waitForTicks(3);
  }
  const planks = bot.inventory.items().filter(i => i.name.includes('_planks')).reduce((s,i) => s+i.count, 0);
  console.log(`[Craft] Planks: ${planks}`);
  if (!bot.inventory.items().some(i => i.name === 'crafting_table')) {
    if (planks < 4) { console.log('[Craft] Not enough planks!'); return false; }
    await craftItem(bot, 'crafting_table', 1); await bot.waitForTicks(5);
  }
  const tablePos = await getOrPlaceCraftingTable(bot);
  if (!tablePos) {
    console.log('[Craft] craftWoodenTools: cannot place crafting table — tools not crafted');
    return false;
  }
  await craftItem(bot, 'stick', 1, null); await bot.waitForTicks(3);
  if (!bot.inventory.items().some(i => i.name.includes('_axe'))) {
    const ok = await craftItem(bot, 'wooden_axe', 1, tablePos);
    if (!ok) { await bot.waitForTicks(10); await craftItem(bot, 'wooden_axe', 1, tablePos); }
    await bot.waitForTicks(3);
  }
  if (!bot.inventory.items().some(i => i.name.includes('_pickaxe'))) {
    const ok = await craftItem(bot, 'wooden_pickaxe', 1, tablePos);
    if (!ok) { await bot.waitForTicks(10); await craftItem(bot, 'wooden_pickaxe', 1, tablePos); }
    await bot.waitForTicks(3);
  }
  await retrieveTable(bot, tablePos);
  // Return true only if we actually have the tools we tried to make
  const hasAxe  = bot.inventory.items().some(i => i.name.includes('_axe'));
  const hasPick = bot.inventory.items().some(i => i.name.includes('_pickaxe'));
  return hasAxe && hasPick;
}

async function craftStoneTools(bot) {
  const cobble = bot.inventory.items().filter(i => ['cobblestone','cobbled_deepslate'].includes(i.name)).reduce((s,i) => s+i.count, 0);
  console.log(`[Craft] Stone tools — cobblestone: ${cobble}`);
  if (cobble < 3) { console.log('[Craft] Not enough cobblestone'); return false; }
  await ensureTableInInventory(bot);
  const tablePos = await getOrPlaceCraftingTable(bot);
  if (!tablePos) return false;
  const sticks = bot.inventory.items().filter(i => i.name === 'stick').reduce((s,i) => s+i.count, 0);
  if (sticks < 2) { await craftItem(bot, 'stick', 1, null); await bot.waitForTicks(3); }
  let ok = false;
  if (!bot.inventory.items().some(i => ['stone_pickaxe','iron_pickaxe','diamond_pickaxe'].includes(i.name))) {
    ok = await craftItem(bot, 'stone_pickaxe', 1, tablePos);
    await bot.waitForTicks(3);
    if (ok) console.log('[Craft] Stone pickaxe ready ✓');
  } else { ok = true; }
  if (cobble >= 6 && !bot.inventory.items().some(i => ['stone_axe','iron_axe'].includes(i.name)))
    await craftItem(bot, 'stone_axe', 1, tablePos);
  await retrieveTable(bot, tablePos);
  return ok;
}

async function craftFurnace(bot) {
  const cobble = bot.inventory.items().filter(i => ['cobblestone','cobbled_deepslate'].includes(i.name)).reduce((s,i) => s+i.count, 0);
  if (cobble < 8) { console.log(`[Craft] Need 8 cobblestone (have ${cobble})`); return false; }
  await ensureTableInInventory(bot);
  const tablePos = await getOrPlaceCraftingTable(bot);
  if (!tablePos) return false;
  const ok = await craftItem(bot, 'furnace', 1, tablePos);
  await bot.waitForTicks(3);
  await retrieveTable(bot, tablePos);
  return ok;
}

async function craftBoatAndDoors(bot) {
  // BUG FIX: ensureTableInInventory checks planks then gives up — but the bot
  // often has logs that haven't been converted yet (e.g. oak_planks×2 + jungle_log×3).
  // Convert ALL logs to planks FIRST so ensureTableInInventory can craft a table.
  for (const logItem of bot.inventory.items().filter(i => LOG_TYPES.includes(i.name))) {
    await craftItem(bot, logItem.name.replace('_log', '_planks'), logItem.count);
    await bot.waitForTicks(3);
  }
  const planksAfterConvert = bot.inventory.items()
    .filter(i => i.name.includes('_planks')).reduce((s,i) => s+i.count, 0);
  console.log(`[Craft] craftBoatAndDoors: planks after log convert: ${planksAfterConvert}`);

  await ensureTableInInventory(bot);
  const tablePos = await getOrPlaceCraftingTable(bot);
  if (!tablePos) { console.log('[Craft] craftBoatAndDoors: no table'); return false; }
  if (bot.entity.position.distanceTo(tablePos) > 3)
    await navigateAdjacent(bot, tablePos, 10000).catch(() => {});
  const tableBlock = bot.blockAt(tablePos);
  if (!tableBlock || tableBlock.name !== 'crafting_table') { console.log('[Craft] Table gone!'); return false; }
  const plank = bot.inventory.items().find(i => i.name.includes('_planks'));
  const wood = plank ? plank.name.replace('_planks','') : 'oak';
  await craftItem(bot, `${wood}_boat`, 1, tablePos);  await bot.waitForTicks(3);
  await craftItem(bot, `${wood}_door`, 3, tablePos);  await bot.waitForTicks(3);
  await retrieveTable(bot, tablePos);
  return true;
}

async function craftIronTools(bot) {
  const iron = bot.inventory.items().filter(i => i.name === 'iron_ingot').reduce((s,i) => s+i.count, 0);
  console.log(`[Craft] Iron ingots: ${iron}`);
  await ensureTableInInventory(bot);
  const tablePos = await getOrPlaceCraftingTable(bot);
  if (!tablePos) return;
  if (bot.entity.position.distanceTo(tablePos) > 3)
    await navigateAdjacent(bot, tablePos, 10000).catch(() => {});
  if (iron >= 3)  await craftItem(bot, 'iron_pickaxe', 1, tablePos);
  if (iron >= 6)  await craftItem(bot, 'bucket', 1, tablePos);
  if (iron >= 9)  await craftItem(bot, 'iron_axe', 1, tablePos);
  if (iron >= 12) await craftItem(bot, 'iron_sword', 1, tablePos);
  await retrieveTable(bot, tablePos);
}

async function craftIronArmor(bot) {
  const iron = bot.inventory.items().filter(i => i.name === 'iron_ingot').reduce((s,i) => s+i.count, 0);
  console.log(`[Craft] Armor — iron ingots: ${iron}`);
  if (iron < 4) { console.log('[Craft] Not enough iron for armor'); return; }

  await ensureTableInInventory(bot);
  const tablePos = await getOrPlaceCraftingTable(bot);
  if (!tablePos) return;

  let remaining = iron;
  if (remaining >= 8 && !bot.inventory.items().some(i => i.name === 'iron_chestplate')) {
    await craftItem(bot, 'iron_chestplate', 1, tablePos); remaining -= 8; await bot.waitForTicks(3);
  }
  if (remaining >= 7 && !bot.inventory.items().some(i => i.name === 'iron_leggings')) {
    await craftItem(bot, 'iron_leggings', 1, tablePos); remaining -= 7; await bot.waitForTicks(3);
  }
  if (remaining >= 5 && !bot.inventory.items().some(i => i.name === 'iron_helmet')) {
    await craftItem(bot, 'iron_helmet', 1, tablePos); remaining -= 5; await bot.waitForTicks(3);
  }
  if (remaining >= 4 && !bot.inventory.items().some(i => i.name === 'iron_boots')) {
    await craftItem(bot, 'iron_boots', 1, tablePos); remaining -= 4; await bot.waitForTicks(3);
  }

  for (const [name, slot] of [['iron_helmet','head'],['iron_chestplate','torso'],['iron_leggings','legs'],['iron_boots','feet']]) {
    const piece = bot.inventory.items().find(i => i.name === name);
    if (piece) { try { await bot.equip(piece, slot); await bot.waitForTicks(2); } catch (_) {} }
  }
  console.log('[Craft] Armor equipped ✓');
  await retrieveTable(bot, tablePos);
}

async function craftFlintAndSteel(bot) {
  const flint = bot.inventory.items().filter(i => i.name === 'flint').reduce((s,i) => s+i.count, 0);
  const iron  = bot.inventory.items().filter(i => i.name === 'iron_ingot').reduce((s,i) => s+i.count, 0);
  if (flint < 1 || iron < 1) { console.log(`[Craft] Need flint(${flint}) + iron(${iron}) for flint&steel`); return false; }
  await ensureTableInInventory(bot);
  const tablePos = await getOrPlaceCraftingTable(bot);
  if (!tablePos) return false;
  const ok = await craftItem(bot, 'flint_and_steel', 1, tablePos);
  await retrieveTable(bot, tablePos);
  return ok;
}

module.exports = {
  craftItem,
  craftWoodenTools, craftStoneTools, craftFurnace,
  craftBoatAndDoors, craftIronTools, craftIronArmor, craftFlintAndSteel,
  ensureTableInInventory, getOrPlaceCraftingTable, retrieveTable,
};