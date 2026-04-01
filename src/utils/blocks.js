// src/utils/blocks.js
const Vec3 = require('vec3');
const { navigateTo, safeStop, unstuck } = require('./navigation');

// ─── scanBlocks ───────────────────────────────────────────────────────────────

function scanBlocks(bot, { centerPos, radiusXZ, yMin, yMax, stepXZ = 1, stepY = 1, match, limit = 9999 }) {
  const results = [];
  const cx = Math.floor(centerPos.x);
  const cz = Math.floor(centerPos.z);
  outer:
  for (let dx = -radiusXZ; dx <= radiusXZ; dx += stepXZ) {
    for (let dz = -radiusXZ; dz <= radiusXZ; dz += stepXZ) {
      for (let y = yMin; y <= yMax; y += stepY) {
        const pos = new Vec3(cx + dx, y, cz + dz);
        const block = bot.blockAt(pos);
        if (block && match(block)) {
          results.push(pos);
          if (results.length >= limit) break outer;
        }
      }
    }
  }
  return results;
}

// ─── findAdjacentStandablePosition ───────────────────────────────────────────

function findAdjacentStandablePosition(bot, blockPos) {
  const cardinalOffsets = [
    new Vec3(1,0,0), new Vec3(-1,0,0),
    new Vec3(0,0,1), new Vec3(0,0,-1),
  ];
  for (const yOff of [0, -1, 1]) {
    for (const offset of cardinalOffsets) {
      const standPos = blockPos.clone().add(offset).offset(0, yOff, 0);
      const below = bot.blockAt(standPos.offset(0,-1,0));
      const at    = bot.blockAt(standPos);
      if (below?.boundingBox === 'block' &&
          (at?.name === 'air' || at?.boundingBox === 'empty' || at?.name.includes('leaves')))
        return standPos;
    }
  }
  return null;
}

// ─── findGroundY ──────────────────────────────────────────────────────────────
// Scan downward from startY to find the Y the bot would stand on.

function findGroundY(bot, x, z, startY) {
  for (let y = startY; y >= 20; y--) {
    const b     = bot.blockAt(new Vec3(x, y, z));
    const above = bot.blockAt(new Vec3(x, y+1, z));
    if (b?.boundingBox === 'block' && b.name !== 'lava' && above?.name === 'air')
      return y + 1;
  }
  return startY;
}

// ─── isOnSameTrunk ────────────────────────────────────────────────────────────

function isOnSameTrunk(bot, target) {
  const bp = bot.entity.position.floored();
  return Math.abs(target.x - bp.x) <= 1 &&
         Math.abs(target.z - bp.z) <= 1 &&
         target.y > bp.y;
}

// ─── descendToGround ─────────────────────────────────────────────────────────

async function descendToGround(bot) {
  for (let i = 0; i < 60; i++) {
    if (bot.entity.onGround) return;
    await bot.waitForTicks(2);
  }
  await bot.waitForTicks(10);
}

// ─── digUpTrunk ───────────────────────────────────────────────────────────────

async function digUpTrunk(bot, target, tool) {
  await equipTool(bot, tool);
  for (let climbs = 0; climbs < 30; climbs++) {
    const block = bot.blockAt(target);
    if (!block || (!block.name.includes('_log') && !block.name.includes('_wood'))) return true;

    const heightDiff = target.y - Math.floor(bot.entity.position.y);
    if (heightDiff <= 4 && heightDiff >= -1) {
      await bot.lookAt(target.offset(0.5, 0.5, 0.5));
      await bot.waitForTicks(2);
      try {
        if (bot.canDigBlock(block)) { await bot.dig(block, true); return true; }
      } catch (err) { console.log(`[Collect] Trunk dig: ${err.message}`); return false; }
    }

    // Clear head space then jump
    const bp = bot.entity.position.floored();
    for (const dy of [1, 2]) {
      const above = bot.blockAt(bp.offset(0, dy, 0));
      if (above && above.name !== 'air' && above.boundingBox !== 'empty') {
        try { if (bot.canDigBlock(above)) await bot.dig(above, true); } catch (_) {}
      }
    }
    bot.setControlState('jump', true);
    await bot.waitForTicks(4);
    bot.setControlState('jump', false);
    await bot.waitForTicks(4);
  }
  console.log('[Collect] digUpTrunk: gave up');
  return false;
}

// ─── getBestPickaxe ───────────────────────────────────────────────────────────

function getBestPickaxe(bot) {
  const tier = { iron: 0, diamond: 0, netherite: 0, stone: 1, wooden: 2, golden: 2 };
  return bot.inventory.items()
    .filter(i => i.name.includes('_pickaxe'))
    .filter(i => {
      if (i.durabilityUsed != null && i.maxDurability != null)
        return (i.maxDurability - i.durabilityUsed) > 5;
      return true;
    })
    .sort((a, b) => (tier[a.name.split('_')[0]] ?? 9) - (tier[b.name.split('_')[0]] ?? 9))[0] || null;
}

// ─── equipTool ────────────────────────────────────────────────────────────────

async function equipTool(bot, tool) {
  let item;
  if      (tool === 'axe')     item = bot.inventory.items().find(i => i.name.includes('_axe'));
  else if (tool === 'shovel')  item = bot.inventory.items().find(i => i.name.includes('_shovel'));
  else if (tool === 'pickaxe') item = getBestPickaxe(bot);
  if (item) { try { await bot.equip(item, 'hand'); await bot.waitForTicks(2); } catch (_) {} }
}

// ─── collectNearbyItems ───────────────────────────────────────────────────────

async function collectNearbyItems(bot, radius = 10, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let noItemRounds = 0;
  while (Date.now() < deadline) {
    const items = Object.values(bot.entities)
      .filter(e => e.name === 'item' && e.position &&
                   e.position.distanceTo(bot.entity.position) < radius)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) -
                      b.position.distanceTo(bot.entity.position));
    if (items.length === 0) {
      if (++noItemRounds >= 3) break;
      await bot.waitForTicks(5);
      continue;
    }
    noItemRounds = 0;
    const nearest = items[0];
    const dist = nearest.position.distanceTo(bot.entity.position);
    if (dist > 1.5) {
      try {
        await bot.lookAt(nearest.position);
        bot.setControlState('forward', true);
        bot.setControlState('sprint', dist > 3);
        await bot.waitForTicks(4);
        bot.setControlState('forward', false);
        bot.setControlState('sprint', false);
      } catch (_) {}
    } else {
      await bot.waitForTicks(5);
    }
  }
  safeStop(bot);
}

// ─── collectBlocks ────────────────────────────────────────────────────────────

function hasFallingBlockAbove(bot, pos) {
  const FALLING = ['sand','red_sand','gravel','suspicious_sand','suspicious_gravel'];
  for (let dy = 1; dy <= 5; dy++) {
    const b = bot.blockAt(pos.offset(0, dy, 0));
    if (!b) break;
    if (FALLING.includes(b.name)) return true;
    if (b.boundingBox === 'block') break;
  }
  return false;
}

async function collectBlocks(bot, blockNames, count, tool = 'fist', excludePositions = [], maxDistance = 64) {
  const collected = [];
  const excludedSet = new Set(excludePositions.map(p =>
    `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`));
  const triedTreeBases = new Set();

  let botDied = false;
  const onDeath = () => { botDied = true; };
  bot.once('death', onDeath);

  console.log(`[Collect] Need ${count} of [${blockNames.join(',')}]`);

  while (collected.length < count) {
    if (botDied) { console.log('[Collect] Bot died — aborting collect loop'); break; }

    const target = findNearestBlock(bot, blockNames, excludedSet, maxDistance);
    if (!target) { console.log('[Collect] No more blocks found'); break; }

    if (hasFallingBlockAbove(bot, target)) {
      console.log(`[Collect] Skipping — falling block above ${target}`);
      excludedSet.add(`${target.x},${target.y},${target.z}`);
      continue;
    }

    const bp          = bot.entity.position;
    const heightAbove = target.y - bp.y;
    const isLog       = blockNames.some(n => n.includes('_log') || n.includes('_wood'));
    const block       = bot.blockAt(target);

    console.log(`[Collect] Target: ${block?.name} at ${target}, dist: ${bp.distanceTo(target).toFixed(1)}, Δy=${Math.floor(heightAbove)}`);

    // Skip underwater logs
    if (isLog && target.y < 62) {
      excludedSet.add(`${target.x},${target.y},${target.z}`); continue;
    }

    // ── Case 1: trunk log directly above us — climb and dig ──────────────
    if (isLog && isOnSameTrunk(bot, target)) {
      console.log(`[Collect] Trunk log Δy=${Math.floor(heightAbove)} — climbing`);
      await equipTool(bot, tool);
      const dug = await digUpTrunk(bot, target, tool);
      if (dug) {
        collected.push(target);
        excludedSet.add(`${target.x},${target.y},${target.z}`);
        console.log(`[Collect] Mined trunk log! (${collected.length}/${count})`);
        await descendToGround(bot);
        await bot.waitForTicks(20);
        await collectNearbyItems(bot, 12, 2000);
      } else {
        excludedSet.add(`${target.x},${target.y},${target.z}`);
      }
      continue;
    }

    // ── Case 2: high log — navigate to the trunk base first ──────────────
    if (isLog && heightAbove > 5) {
      const baseKey = `${target.x},${target.z}`;
      if (triedTreeBases.has(baseKey)) {
        excludedSet.add(`${target.x},${target.y},${target.z}`); continue;
      }
      const groundY = findGroundY(bot, target.x, target.z, target.y - 1);
      const treeBase = new Vec3(target.x, groundY, target.z);
      const baseDist = treeBase.distanceTo(bp);
      console.log(`[Collect] High log — nav to tree base at ${treeBase} (${baseDist.toFixed(1)} blocks)`);
      triedTreeBases.add(baseKey);
      try {
        await navigateTo(bot, treeBase, 3, Math.min(45000, Math.max(20000, baseDist * 500)));
      } catch (err) {
        console.log(`[Collect] Tree base nav failed: ${err.message}`);
        await unstuck(bot);
        excludedSet.add(`${target.x},${target.y},${target.z}`);
      }
      continue;
    }

    // ── Case 3: normal block — navigate then dig ──────────────────────────
    const dist       = bp.distanceTo(target);
    const navTimeout = Math.min(60000, Math.max(20000, dist * 500));

    try {
      const standPos = findAdjacentStandablePosition(bot, target);
      if (standPos && standPos.distanceTo(bp) > 2)
        await navigateTo(bot, standPos, 1, navTimeout);
      else if (dist > 4)
        await navigateTo(bot, target, 3, navTimeout);
    } catch (err) {
      console.log(`[Collect] Nav failed: ${err.message}`);
      excludedSet.add(`${target.x},${target.y},${target.z}`);
      await unstuck(bot);
      continue;
    }

    // After arriving, maybe it's now a trunk log we can climb
    if (isLog && isOnSameTrunk(bot, target) && target.y > bot.entity.position.y) {
      const dug = await digUpTrunk(bot, target, tool);
      if (dug) {
        collected.push(target);
        excludedSet.add(`${target.x},${target.y},${target.z}`);
        console.log(`[Collect] Mined! (${collected.length}/${count})`);
        await descendToGround(bot);
        await bot.waitForTicks(20);
        await collectNearbyItems(bot, 12, 2000);
      } else {
        excludedSet.add(`${target.x},${target.y},${target.z}`);
      }
      continue;
    }

    // Standard dig
    const currentBlock = bot.blockAt(target);
    if (!currentBlock || !blockNames.includes(currentBlock.name)) {
      excludedSet.add(`${target.x},${target.y},${target.z}`); continue;
    }
    await equipTool(bot, tool);
    let dug = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await bot.lookAt(target.offset(0.5, 0.5, 0.5));
        await bot.waitForTicks(2);
        if (!bot.canDigBlock(currentBlock)) break;
        await bot.dig(currentBlock, true);
        dug = true; break;
      } catch (err) {
        console.log(`[Collect] Dig attempt ${attempt+1} failed: ${err.message}`);
        await bot.waitForTicks(5);
      }
    }
    if (!dug) { excludedSet.add(`${target.x},${target.y},${target.z}`); continue; }
    collected.push(target);
    excludedSet.add(`${target.x},${target.y},${target.z}`);
    console.log(`[Collect] Mined! (${collected.length}/${count})`);
    await bot.waitForTicks(3);
    await collectNearbyItems(bot, 10, 1500);
  }
  bot.off('death', onDeath);
  return collected;
}

// ─── findNearestBlock ─────────────────────────────────────────────────────────

function isNearWater(bot, pos) {
  for (let dx = -2; dx <= 2; dx++)
    for (let dz = -2; dz <= 2; dz++)
      for (let dy = -1; dy <= 2; dy++) {
        const b = bot.blockAt(pos.offset(dx, dy, dz));
        if (b?.name === 'water' || b?.name === 'flowing_water') return true;
      }
  return false;
}

function findNearestBlock(bot, blockNames, excludedSet, maxDistance) {
  const cx   = Math.floor(bot.entity.position.x);
  const cz   = Math.floor(bot.entity.position.z);
  const botY = Math.floor(bot.entity.position.y);

  let nearest = null, nearestDist = Infinity;
  for (let dx = -maxDistance; dx <= maxDistance; dx++) {
    for (let dz = -maxDistance; dz <= maxDistance; dz++) {
      for (let y = Math.max(0, botY - 30); y <= botY + 40; y++) {
        const pos = new Vec3(cx+dx, y, cz+dz);
        if (excludedSet.has(`${pos.x},${pos.y},${pos.z}`)) continue;
        const block = bot.blockAt(pos);
        if (block && blockNames.includes(block.name)) {
          if (isNearWater(bot, pos)) {
            excludedSet.add(`${pos.x},${pos.y},${pos.z}`);
            continue;
          }
          const dist = pos.distanceTo(bot.entity.position);
          const adj  = dist + Math.abs(y - botY) * 0.3;
          if (adj < nearestDist) { nearest = pos; nearestDist = adj; }
        }
      }
    }
  }
  return nearest;
}

module.exports = {
  scanBlocks,
  findAdjacentStandablePosition,
  collectBlocks,
  getBestPickaxe,
};