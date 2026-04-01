// src/utils/navigation.js
const Vec3 = require('vec3');
const { GoalNear, GoalXZ, GoalLookAtBlock } = require('../goal');

// ─── Safe stop ────────────────────────────────────────────────────────────────

function safeStop(bot) {
  if (bot.ashfinder && !bot.ashfinder.stopped) {
    bot.ashfinder.stop();
  }
  bot.setControlState('sprint', false);
  bot.setControlState('forward', false);
  bot.setControlState('back', false);
  bot.setControlState('left', false);
  bot.setControlState('right', false);
  bot.setControlState('jump', false);
}

// ─── Direct navigation ────────────────────────────────────────────────────────

async function navigateTo(bot, pos, range = 2, timeoutMs = 15000) {
  if (!bot.ashfinder) throw new Error('Baritone not loaded');

  const distance = bot.entity.position.distanceTo(pos);
  console.log(`[Nav] Direct goto: ${distance.toFixed(1)} blocks to ${pos}`);

  safeStop(bot);
  await bot.waitForTicks(2);

  bot.setControlState('sprint', true);

  try {
    await Promise.race([
      bot.ashfinder.goto(new GoalNear(pos, range)),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`nav timeout ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
    console.log(`[Nav] Arrived at ${pos}`);
  } catch (err) {
    console.log(`[Nav] Failed: ${err.message}`);
    throw err;
  } finally {
    safeStop(bot);
  }
}

// ─── Smart navigation with fallback ──────────────────────────────────────────

async function navigateToSmart(bot, pos, range = 2, timeoutMs = 30000) {
  if (!bot.ashfinder) throw new Error('Baritone not loaded');

  const distance = bot.entity.position.distanceTo(pos);
  console.log(`[Nav] Smart nav: ${distance.toFixed(1)} blocks`);

  if (distance < 20) {
    return await navigateTo(bot, pos, range, timeoutMs);
  }

  safeStop(bot);
  await bot.waitForTicks(2);
  bot.setControlState('sprint', true);

  try {
    await Promise.race([
      bot.ashfinder.gotoSmart(new GoalNear(pos, range), {
        waypointThreshold: 50,
        forceAdaptive: true,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`smart nav timeout ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
    console.log(`[Nav] Arrived (smart)`);
  } catch (err) {
    console.log(`[Nav] Smart nav failed: ${err.message}, trying direct...`);
    safeStop(bot);
    return await navigateTo(bot, pos, range, timeoutMs);
  } finally {
    safeStop(bot);
  }
}

// ─── Surface navigation (ocean crossing) ─────────────────────────────────────
//
// Strategy:
//   • Split the journey into 50-block segments.
//   • For each segment, scan whether the midpoint is over water.
//     - WATER segment → manualSwimTo (holds jump, stays at Y surface, safe).
//     - LAND segment  → Baritone goto with a depth watchdog; if bot goes
//       below Y=60 (underwater), the watchdog kills Baritone and hands off
//       to manualSwimTo for the remainder.
//
// This prevents the pathfinder from ever routing through the ocean floor.

function isOverWater(bot, x, z) {
  // Scan downward from Y=70 to find the surface block at (x, z).
  for (let y = 70; y >= 40; y--) {
    const b = bot.blockAt(new Vec3(Math.round(x), y, Math.round(z)));
    if (!b) continue;
    if (b.name === 'water') return true;
    if (b.boundingBox === 'block') return false;
  }
  return false;
}

// Run Baritone toward `wp` but abort if bot drops below Y=60 (underwater).
// Returns true if reached, false if aborted.
async function baritoneToSurface(bot, wp, timeoutMs) {
  let depthAborted = false;
  const depthWatcher = setInterval(() => {
    if (bot.entity.position.y < 60) {
      depthAborted = true;
      safeStop(bot);
      console.log(`[Nav] Depth watchdog fired at Y=${bot.entity.position.y.toFixed(1)} — aborting Baritone`);
    }
  }, 500);

  bot.setControlState('sprint', true);
  try {
    await Promise.race([
      bot.ashfinder.goto(new GoalNear(wp, 5)),
      new Promise((_, r) => setTimeout(() => r(new Error('wp timeout')), timeoutMs)),
      new Promise((_, r) => {
        const iv = setInterval(() => { if (depthAborted) { clearInterval(iv); r(new Error('depth abort')); } }, 200);
      }),
    ]);
    clearInterval(depthWatcher);
    return !depthAborted;
  } catch (_) {
    clearInterval(depthWatcher);
    safeStop(bot);
    return false;
  }
}

async function navigateXZ(bot, x, z, timeoutMs = 90000) {
  if (!bot.ashfinder) throw new Error('Baritone not loaded');

  console.log(`[Nav] Surface travel to (${x}, ${z})`);
  safeStop(bot);
  await bot.waitForTicks(2);

  const startPos  = bot.entity.position.clone();
  const totalDx   = x - startPos.x;
  const totalDz   = z - startPos.z;
  const totalDist = Math.sqrt(totalDx * totalDx + totalDz * totalDz);
  const deadline  = Date.now() + timeoutMs;

  const SEGMENT = 50;
  const steps   = Math.max(1, Math.ceil(totalDist / SEGMENT));
  console.log(`[Nav] ${steps} surface segments (${totalDist.toFixed(1)} blocks)`);

  for (let i = 1; i <= steps; i++) {
    if (Date.now() >= deadline) break;

    const t    = i / steps;
    const wpX  = startPos.x + totalDx * t;
    const wpZ  = startPos.z + totalDz * t;
    const midX = startPos.x + totalDx * ((i - 0.5) / steps);
    const midZ = startPos.z + totalDz * ((i - 0.5) / steps);
    const wp   = new Vec3(wpX, 63, wpZ);

    const segTime    = Math.min(deadline - Date.now(), Math.max(15000, SEGMENT * 400));
    const waterSeg   = isOverWater(bot, midX, midZ);
    const segLabel   = waterSeg ? 'swim' : 'land';
    console.log(`→ Segment ${i}/${steps} [${segLabel}]: (${Math.round(wpX)}, ${Math.round(wpZ)})`);

    if (waterSeg) {
      // Water segment: manual surface swim — holds jump, guaranteed no drowning
      await manualSwimTo(bot, wpX, wpZ, segTime);
    } else {
      // Land segment: Baritone with depth watchdog fallback
      const reached = await baritoneToSurface(bot, wp, segTime);
      if (!reached) {
        console.log(`[Nav] Baritone aborted on segment ${i} — manual swim fallback`);
        const remaining = deadline - Date.now();
        if (remaining > 0) await manualSwimTo(bot, wpX, wpZ, Math.min(remaining, 20000));
      } else {
        console.log(`✓ Segment ${i} reached`);
      }
    }

    safeStop(bot);
    await bot.waitForTicks(2);
  }

  safeStop(bot);
  console.log(`[Nav] Surface travel complete`);
}

// ─── Boat travel (fastest water movement) ────────────────────────────────────

async function travelByBoat(bot, targetX, targetZ, timeoutMs = 120000) {
  const boatItem = bot.inventory.items().find(i => i.name.includes('_boat') || i.name === 'boat');

  if (!boatItem) {
    console.log('[Boat] No boat in inventory — falling back to manual surface swim');
    // BUG FIX: original fell back to navigateXZ which used the waypoint planner
    // and could route underwater. manualSwimTo stays on the surface.
    return await manualSwimTo(bot, targetX, targetZ, timeoutMs);
  }

  console.log(`[Boat] Starting boat travel to (${targetX}, ${targetZ})`);
  safeStop(bot);

  // ── Step 1: get to water surface ─────────────────────────────────────────
  if (!bot.entity.isInWater) {
    const waterPos = findNearbyWaterSurface(bot, 20);
    if (waterPos) {
      try { await navigateTo(bot, waterPos, 2, 10000); } catch (_) {}
    }
  }

  // ── Step 2: place boat ────────────────────────────────────────────────────
  let boatEntity = null;
  try {
    await bot.equip(boatItem, 'hand');
    await bot.waitForTicks(3);

    const placePos = findWaterPlaceTarget(bot);
    if (!placePos) throw new Error('No water surface to place boat on');

    await bot.lookAt(placePos.offset(0.5, 0, 0.5));
    await bot.waitForTicks(2);
    await bot.useItem();
    await bot.waitForTicks(10);

    boatEntity = findNearestBoat(bot, 8);
    if (!boatEntity) throw new Error('Boat entity not found after placement');

    console.log(`[Boat] Placed boat at ${boatEntity.position.toFixed(1)}`);
  } catch (err) {
    console.log(`[Boat] Placement failed: ${err.message} — manual swim`);
    return await manualSwimTo(bot, targetX, targetZ, timeoutMs);
  }

  // ── Step 3: mount boat ────────────────────────────────────────────────────
  try {
    await bot.lookAt(boatEntity.position);
    await bot.waitForTicks(3);
    await bot.mount(boatEntity);
    await bot.waitForTicks(10);
  } catch (err) {
    console.log(`[Boat] Mount failed: ${err.message} — manual swim`);
    return await manualSwimTo(bot, targetX, targetZ, timeoutMs);
  }

  if (!bot.vehicle) {
    console.log('[Boat] Not in boat after mount attempt — manual swim');
    return await manualSwimTo(bot, targetX, targetZ, timeoutMs);
  }

  console.log('[Boat] Mounted — navigating...');

  // ── Step 4: steer to destination ─────────────────────────────────────────
  try {
    await steerBoatTo(bot, targetX, targetZ, Date.now() + timeoutMs);
    console.log('[Boat] Reached destination');
  } catch (err) {
    console.log(`[Boat] Travel error: ${err.message}`);
  }

  // ── Step 5: dismount ──────────────────────────────────────────────────────
  try {
    await bot.dismount();
    await bot.waitForTicks(10);
    console.log('[Boat] Dismounted');
  } catch (_) {}

  safeStop(bot);
}

async function steerBoatTo(bot, targetX, targetZ, deadline) {
  const ARRIVAL_DIST = 6;

  while (Date.now() < deadline) {
    if (!bot.vehicle) { console.log('[Boat] Fell out of boat'); break; }

    const pos = bot.entity.position;
    const dx  = targetX - pos.x;
    const dz  = targetZ - pos.z;
    if (Math.sqrt(dx * dx + dz * dz) < ARRIVAL_DIST) {
      console.log(`[Boat] Arrived`);
      break;
    }

    await bot.lookAt(new Vec3(targetX, pos.y, targetZ), true);
    bot.setControlState('forward', true);
    bot.setControlState('sprint', true);
    await bot.waitForTicks(10);
  }

  bot.setControlState('forward', false);
  bot.setControlState('sprint', false);
}

function findWaterPlaceTarget(bot) {
  const pos = bot.entity.position.floored();
  for (let r = 1; r <= 5; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dy = -2; dy <= 1; dy++) {
          const check = pos.offset(dx, dy, dz);
          const b     = bot.blockAt(check);
          const above = bot.blockAt(check.offset(0, 1, 0));
          if (b?.name === 'water' && above?.name === 'air') return check;
        }
      }
    }
  }
  return null;
}

function findNearbyWaterSurface(bot, radius) {
  const pos = bot.entity.position.floored();
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dy = -3; dy <= 3; dy++) {
        const check = pos.offset(dx, dy, dz);
        const b     = bot.blockAt(check);
        const above = bot.blockAt(check.offset(0, 1, 0));
        if (b?.name === 'water' && above?.name === 'air') return check.offset(0, 1, 0);
      }
    }
  }
  return null;
}

function findNearestBoat(bot, radius) {
  let nearest = null, nearestDist = radius;
  for (const e of Object.values(bot.entities)) {
    if (!e.name?.toLowerCase().includes('boat')) continue;
    const dist = e.position.distanceTo(bot.entity.position);
    if (dist < nearestDist) { nearest = e; nearestDist = dist; }
  }
  return nearest;
}

// ─── Dive to underwater position ──────────────────────────────────────────────

async function diveToPos(bot, pos, range = 3, timeoutMs = 20000) {
  if (!bot.ashfinder) throw new Error('Baritone not loaded');

  console.log(`[Nav] Dive to ${pos}`);
  safeStop(bot);
  await bot.waitForTicks(2);

  const wasSwimming = bot.ashfinder.config.swimming;
  bot.ashfinder.config.swimming = true;
  bot.setControlState('sprint', true);

  try {
    const result = await Promise.race([
      bot.ashfinder.goto(new GoalNear(pos, range)),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`dive timeout ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
    if (result?.status !== 'success') {
      console.log(`[Nav] Dive stopped (status: ${result?.status})`);
      return false;
    }
    console.log(`[Nav] Dive complete`);
    return true;
  } catch (err) {
    console.log(`[Nav] Dive failed: ${err.message}`);
    return false;
  } finally {
    safeStop(bot);
    bot.ashfinder.config.swimming = wasSwimming;
  }
}

// ─── Navigate to look at a block ──────────────────────────────────────────────

async function navigateToLookAt(bot, pos, reach = 4, timeoutMs = 10000) {
  if (!bot.ashfinder) throw new Error('Baritone not loaded');

  safeStop(bot);
  await bot.waitForTicks(2);

  try {
    await Promise.race([
      bot.ashfinder.goto(new GoalLookAtBlock(pos, bot.world, { reach })),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`look timeout ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
  } catch (err) {
    await bot.lookAt(pos.offset(0.5, 0.5, 0.5));
  } finally {
    safeStop(bot);
  }
}

// ─── Navigate adjacent to a block ─────────────────────────────────────────────

async function navigateAdjacent(bot, pos, timeoutMs = 15000) {
  if (!bot.ashfinder) throw new Error('Baritone not loaded');

  safeStop(bot);
  await bot.waitForTicks(2);
  bot.setControlState('sprint', true);

  try {
    await Promise.race([
      bot.ashfinder.goto(new GoalNear(pos, 1.5)),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`adjacent timeout ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
    console.log(`[Nav] Adjacent nav complete`);
  } finally {
    safeStop(bot);
  }
}

// ─── Unstuck ──────────────────────────────────────────────────────────────────

async function unstuck(bot) {
  console.log('[Nav] Unstuck maneuver');
  safeStop(bot);

  bot.setControlState('jump', true);
  await bot.waitForTicks(8);
  bot.setControlState('jump', false);

  const dirs = ['forward', 'back', 'left', 'right'];
  const dir  = dirs[Math.floor(Math.random() * dirs.length)];
  bot.setControlState(dir, true);
  await bot.waitForTicks(8);
  bot.setControlState(dir, false);
}

// ─── Manual swim (open ocean surface — no pathfinder) ─────────────────────────
// Stays at the water surface by holding jump while in water. Safe from drowning.

async function manualSwimTo(bot, targetX, targetZ, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  safeStop(bot);

  while (Date.now() < deadline) {
    const pos = bot.entity.position;
    const dx  = targetX - pos.x;
    const dz  = targetZ - pos.z;
    if (Math.sqrt(dx * dx + dz * dz) < 5) break;

    await bot.lookAt(new Vec3(targetX, pos.y, targetZ), true);
    bot.setControlState('sprint', true);
    bot.setControlState('forward', true);
    // FIX: bot.entity.isOnGround doesn't exist in Mineflayer — it's bot.entity.onGround.
    // The original `isInWater || isOnGround` evaluated to undefined on land,
    // and setControlState('jump', undefined) sent a malformed packet → socketClosed.
    // Block-based check: only hold jump when body is in water, to stay at surface.
    const bodyBlock = bot.blockAt(bot.entity.position.floored());
    bot.setControlState('jump', bodyBlock?.name === 'water');
    await bot.waitForTicks(5);
  }

  safeStop(bot);
}

// ─── Break nearby leaves ──────────────────────────────────────────────────────

async function breakNearbyLeaves(bot, radius = 2) {
  const pos = bot.entity.position.floored();
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -1; dy <= 2; dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const block = bot.blockAt(pos.offset(dx, dy, dz));
        if (block?.name.includes('leaves')) {
          try {
            await bot.lookAt(pos.offset(dx, dy, dz).offset(0.5, 0.5, 0.5));
            await bot.dig(block, true);
            await bot.waitForTicks(2);
          } catch (_) {}
        }
      }
    }
  }
}

// ─── Config helpers ────────────────────────────────────────────────────────────

function configureForTrees(bot) {
  if (!bot.ashfinder) return;
  bot.ashfinder.config.parkour    = false;
  bot.ashfinder.config.breakBlocks = true;
  bot.ashfinder.config.placeBlocks = false;
  bot.ashfinder.config.swimming   = true;
}

function configureForWater(bot) {
  if (!bot.ashfinder) return;
  bot.ashfinder.config.parkour    = false;
  bot.ashfinder.config.breakBlocks = true;
  bot.ashfinder.config.placeBlocks = false;
  bot.ashfinder.config.swimming   = true;
}

function configureForLand(bot) {
  if (!bot.ashfinder) return;
  bot.ashfinder.config.parkour    = false;
  bot.ashfinder.config.breakBlocks = true;
  bot.ashfinder.config.placeBlocks = false;
  bot.ashfinder.config.swimming   = true;
}

module.exports = {
  navigateTo,
  navigateToSmart,
  navigateXZ,
  travelByBoat,
  manualSwimTo,
  diveToPos,
  navigateToLookAt,
  navigateAdjacent,
  unstuck,
  safeStop,
  breakNearbyLeaves,
  configureForTrees,
  configureForWater,
  configureForLand,
};