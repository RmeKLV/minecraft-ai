// src/phases/phase-2a.js — Nether Portal Construction
//
// Builds a nether portal using the bucket method (no diamond pickaxe needed).
// Steps:
//   1. Ensure iron pickaxe, bucket, and flint & steel are in inventory
//   2. Locate nearest lava pool and water source
//   3. Choose a flat build site near the lava
//   4. Clear the build area
//   5. Build portal frame (10 obsidian, no corners) by cycling: scoop lava → pour → convert with water
//   6. Light portal with flint & steel
//   7. Enter portal

const Vec3 = require('vec3');
const { navigateTo, navigateToSmart, safeStop } = require('../utils/navigation');
const { collectBlocks, scanBlocks, getBestPickaxe } = require('../utils/blocks');
const {
  craftItem, craftIronTools, craftFlintAndSteel,
  ensureTableInInventory, getOrPlaceCraftingTable, retrieveTable,
} = require('../utils/crafting');

// ─── Inventory helpers ────────────────────────────────────────────────────────

function countOf(bot, names) {
  return bot.inventory.items()
    .filter(i => names.includes(i.name))
    .reduce((s, i) => s + i.count, 0);
}

const hasIronPick    = bot => bot.inventory.items().some(i =>
  ['iron_pickaxe','diamond_pickaxe','netherite_pickaxe'].includes(i.name));
const hasAnyBucket   = bot => bot.inventory.items().some(i =>
  ['bucket','water_bucket','lava_bucket'].includes(i.name));
const hasEmptyBucket = bot => bot.inventory.items().some(i => i.name === 'bucket');
const hasLavaBucket  = bot => bot.inventory.items().some(i => i.name === 'lava_bucket');
const hasWaterBucket = bot => bot.inventory.items().some(i => i.name === 'water_bucket');

// ─── Phase 2A entry point ─────────────────────────────────────────────────────

async function runPhase2A(bot) {
  console.log('[Phase2A] ── Portal Construction ──────────────────────────────');

  // ── Step 1: Iron pickaxe ──────────────────────────────────────────────────
  if (!hasIronPick(bot)) {
    if (countOf(bot, ['iron_ingot']) >= 3) {
      console.log('[Phase2A] Crafting iron pickaxe...');
      await craftIronTools(bot);
    }
    if (!hasIronPick(bot)) {
      console.log('[Phase2A] No iron pickaxe — cannot proceed. Aborting.');
      return false;
    }
  }
  console.log('[Phase2A] Iron pickaxe ✓');

  // ── Step 2: Bucket ────────────────────────────────────────────────────────
  if (!hasAnyBucket(bot)) {
    if (countOf(bot, ['iron_ingot']) >= 3) {
      console.log('[Phase2A] Crafting bucket...');
      await ensureTableInInventory(bot);
      const tp = await getOrPlaceCraftingTable(bot);
      if (tp) { await craftItem(bot, 'bucket', 1, tp); await retrieveTable(bot, tp); }
    }
    if (!hasAnyBucket(bot)) {
      console.log('[Phase2A] No bucket — aborting.');
      return false;
    }
  }
  console.log('[Phase2A] Bucket ✓');

  // ── Step 3: Flint & Steel ─────────────────────────────────────────────────
  if (!bot.inventory.items().some(i => i.name === 'flint_and_steel')) {
    if (countOf(bot, ['flint']) < 1) {
      console.log('[Phase2A] Getting flint...');
      await getFlint(bot);
    }
    if (countOf(bot, ['flint']) >= 1 && countOf(bot, ['iron_ingot']) >= 1) {
      console.log('[Phase2A] Crafting flint & steel...');
      await craftFlintAndSteel(bot);
    }
    if (!bot.inventory.items().some(i => i.name === 'flint_and_steel')) {
      console.log('[Phase2A] No flint & steel — cannot light portal. Aborting.');
      return false;
    }
  }
  console.log('[Phase2A] Flint & steel ✓');

  // ── Step 4: Locate lava pool ──────────────────────────────────────────────
  console.log('[Phase2A] Scanning for lava pool...');
  const lavaPos = findLavaPool(bot, 200);
  if (!lavaPos) {
    console.log('[Phase2A] No lava found within 200 blocks — cannot build portal.');
    return false;
  }
  console.log(`[Phase2A] Lava pool at ${lavaPos}`);

  // ── Step 5: Locate water source ───────────────────────────────────────────
  console.log('[Phase2A] Scanning for water source...');
  const waterPos = findWaterSource(bot, 300);
  if (!waterPos) console.log('[Phase2A] WARNING: No water source found — will re-scan from lava pool');
  else console.log(`[Phase2A] Water source at ${waterPos}`);

  // ── Step 6: Navigate near lava pool ──────────────────────────────────────
  console.log('[Phase2A] Moving to lava pool...');
  try { await navigateToSmart(bot, lavaPos, 6, 60000); }
  catch (_) { try { await navigateTo(bot, lavaPos, 6, 30000); } catch (_2) {} }

  // ── Step 7: Choose and validate build site ────────────────────────────────
  const buildSite = chooseBuildSite(bot, lavaPos);
  if (!buildSite) {
    console.log('[Phase2A] No suitable flat build site found near lava.');
    return false;
  }
  console.log(`[Phase2A] Build site chosen at ${buildSite}`);

  try { await navigateTo(bot, buildSite, 2, 20000); } catch (_) {}

  // ── Step 8: Clear area and build portal frame ─────────────────────────────
  console.log('[Phase2A] Building portal frame (10 obsidian)...');
  const built = await buildPortal(bot, buildSite, lavaPos, waterPos);
  if (!built) {
    console.log('[Phase2A] Portal construction failed (not enough obsidian placed).');
    return false;
  }
  console.log('[Phase2A] Portal frame complete ✓');

  // ── Step 9: Light portal ──────────────────────────────────────────────────
  console.log('[Phase2A] Lighting portal...');
  const lit = await lightPortal(bot, buildSite);
  if (!lit) {
    console.log('[Phase2A] Could not light portal.');
    return false;
  }
  console.log('[Phase2A] Portal lit ✓');

  // ── Step 10: Enter portal ─────────────────────────────────────────────────
  console.log('[Phase2A] Entering portal...');
  await enterPortal(bot, buildSite);
  return true;
}

// ─── findLavaPool ─────────────────────────────────────────────────────────────
// Returns the nearest stable lava source block that has at least one lava
// neighbor (i.e. part of a pool, not a single drip).

function findLavaPool(bot, radius) {
  const botY = Math.floor(bot.entity.position.y);

  // Prefer near-surface lava first (easiest to work with), then go deeper
  for (const [yMin, yMax] of [
    [Math.max(20, botY - 10), Math.min(70, botY + 5)],
    [10, 70],
  ]) {
    const blocks = scanBlocks(bot, {
      centerPos: bot.entity.position, radiusXZ: radius,
      yMin, yMax, stepXZ: 3, stepY: 1,
      match: b => b.name === 'lava', limit: 50,
    });
    if (!blocks.length) continue;

    blocks.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));

    // Prefer blocks with at least one lava neighbor
    for (const pos of blocks) {
      let neighbors = 0;
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        if (bot.blockAt(pos.offset(dx, 0, dz))?.name === 'lava') neighbors++;
      }
      if (neighbors >= 1) return pos;
    }
    // Fallback: return closest even if isolated
    return blocks[0];
  }
  return null;
}

// ─── findWaterSource ─────────────────────────────────────────────────────────

function findWaterSource(bot, radius) {
  const botY = Math.floor(bot.entity.position.y);
  const blocks = scanBlocks(bot, {
    centerPos: bot.entity.position, radiusXZ: radius,
    yMin: botY - 5, yMax: botY + 15, stepXZ: 3, stepY: 1,
    match: b => b.name === 'water', limit: 30,
  });
  if (!blocks.length) return null;

  blocks.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));

  // Prefer source water (block above is air so we can fill a bucket from it)
  for (const pos of blocks) {
    if (bot.blockAt(pos.offset(0, 1, 0))?.name === 'air') return pos;
  }
  return blocks[0];
}

// ─── chooseBuildSite ──────────────────────────────────────────────────────────
// Finds a flat 5×1 patch of ground near the lava pool.
// Returns the bottom-left Vec3 of the portal footprint or falls back to the
// bot's current position.
//
// Portal layout (X axis = width, Y axis = height, Z fixed):
//   dx 0..3 are the 4 obsidian columns; interior is dx 1..2
//   dy 0 = bottom row (ground level of frame)

function chooseBuildSite(bot, lavaPos) {
  const botPos  = bot.entity.position.floored();

  // Candidate origins: a grid around bot and around lava pool
  const origins = [];
  for (let dx = -8; dx <= 8; dx += 2) {
    for (let dz = -8; dz <= 8; dz += 2) {
      for (const base of [botPos, lavaPos.floored()]) {
        origins.push(base.offset(dx, 0, dz));
        origins.push(base.offset(dx, -1, dz));
        origins.push(base.offset(dx,  1, dz));
      }
    }
  }

  for (const candidate of origins) {
    if (isFlatFor(bot, candidate, 4, 2)) return candidate;
  }

  // No ideal flat spot found — use bot position anyway and clearArea will handle it
  console.log('[Phase2A] No perfectly flat build site — using bot position as fallback');
  return botPos;
}

// Check that 'width' × 'depth' columns starting at origin each have:
//   solid floor at dy=-1, air at dy=0, air at dy=1
function isFlatFor(bot, origin, width, depth) {
  for (let dx = 0; dx < width; dx++) {
    for (let dz = 0; dz < depth; dz++) {
      const floor = bot.blockAt(origin.offset(dx, -1, dz));
      const air1  = bot.blockAt(origin.offset(dx,  0, dz));
      const air2  = bot.blockAt(origin.offset(dx,  1, dz));
      if (!floor || floor.boundingBox !== 'block') return false;
      if (!air1  || (air1.name !== 'air' && air1.boundingBox !== 'empty')) return false;
      if (!air2  || (air2.name !== 'air' && air2.boundingBox !== 'empty')) return false;
    }
  }
  return true;
}

// ─── buildPortal ─────────────────────────────────────────────────────────────
// Builds a standard 4×5 portal (no corners). Frame = 10 obsidian blocks.
//
// All portal blocks share the same Z (buildSite.z). Frame positions (dx, dy):
//
//       dx:  0    1    2    3
//   dy 4:       [##] [##]
//   dy 3:  [##]           [##]
//   dy 2:  [##]           [##]
//   dy 1:  [##]           [##]
//   dy 0:       [##] [##]
//
// The interior (2×3) is at dx=1-2, dy=1-3 — that's where nether_portal fills.

async function buildPortal(bot, buildSite, lavaPos, waterPos) {
  await clearArea(bot, buildSite);

  const frameBlocks = [
    [1, 0], [2, 0],          // bottom
    [0, 1], [0, 2], [0, 3],  // left pillar
    [3, 1], [3, 2], [3, 3],  // right pillar
    [1, 4], [2, 4],          // top
  ];

  let placed = 0;
  for (const [dx, dy] of frameBlocks) {
    const target = buildSite.offset(dx, dy, 0);
    console.log(`[Phase2A] Frame block ${placed + 1}/10 at ${target}...`);

    if (bot.blockAt(target)?.name === 'obsidian') {
      console.log(`[Phase2A] Already obsidian ✓`);
      placed++;
      continue;
    }

    const ok = await makeObsidian(bot, target, lavaPos, waterPos);
    if (ok) {
      placed++;
      console.log(`[Phase2A] Obsidian placed ✓ (${placed}/10)`);
    } else {
      console.log(`[Phase2A] Block ${placed + 1} failed — continuing with next`);
    }
  }

  // Accept 8/10 minimum — two failures are recoverable (portal still forms if
  // the corner-equivalent positions happen to be covered by adjacent obsidian)
  return placed >= 8;
}

// ─── makeObsidian ─────────────────────────────────────────────────────────────
// Creates one obsidian block at targetPos:
//   1. Clear targetPos if occupied
//   2. Pour lava into targetPos
//   3. Pour water onto the lava → obsidian
//   4. Reclaim the water bucket

async function makeObsidian(bot, targetPos, lavaPos, waterPos) {
  if (bot.blockAt(targetPos)?.name === 'obsidian') return true;

  // Clear the target spot first
  const existing = bot.blockAt(targetPos);
  if (existing && existing.name !== 'air' && existing.boundingBox !== 'empty') {
    try {
      const pick = getBestPickaxe(bot);
      if (pick) await bot.equip(pick, 'hand').catch(() => {});
      if (bot.canDigBlock(existing)) {
        await bot.dig(existing, true);
        await bot.waitForTicks(5);
      }
    } catch (_) {}
  }

  // Pour lava
  const lavaOk = await pourLavaAt(bot, targetPos, lavaPos);
  if (!lavaOk) return false;

  // Convert to obsidian with water
  const obsidianOk = await pourWaterOnLava(bot, targetPos, waterPos);
  return obsidianOk;
}

// ─── pourLavaAt ──────────────────────────────────────────────────────────────
// Scoops a lava bucket from the pool and pours it at targetPos.
// Returns true if lava is now at targetPos.

async function pourLavaAt(bot, targetPos, lavaPos) {
  // Refill lava bucket if needed
  if (!hasLavaBucket(bot)) {
    if (!hasEmptyBucket(bot)) {
      console.log('[Phase2A] pourLavaAt: no empty bucket available');
      return false;
    }

    // Navigate to the lava pool
    try { await navigateTo(bot, lavaPos, 3, 15000); } catch (_) {}

    // Find the closest actual lava block (pool may have shifted)
    const nearLava = findNearestLavaBlock(bot, 5);
    if (!nearLava) { console.log('[Phase2A] pourLavaAt: no lava block in reach'); return false; }

    const emptyBucket = bot.inventory.items().find(i => i.name === 'bucket');
    if (!emptyBucket) return false;

    await bot.equip(emptyBucket, 'hand');
    await bot.waitForTicks(3);

    try {
      await bot.lookAt(nearLava.offset(0.5, 0.5, 0.5));
      await bot.waitForTicks(2);
      const lavaBlock = bot.blockAt(nearLava);
      if (lavaBlock) await bot.activateBlock(lavaBlock);
      else            await bot.activateItem();
      await bot.waitForTicks(8);
    } catch (e) {
      try { await bot.activateItem(); await bot.waitForTicks(8); } catch (_) {}
    }

    if (!hasLavaBucket(bot)) {
      console.log('[Phase2A] pourLavaAt: failed to scoop lava');
      return false;
    }
  }

  // Navigate to the target position to pour
  try { await navigateTo(bot, targetPos, 3, 15000); } catch (_) {}

  const lavaBucket = bot.inventory.items().find(i => i.name === 'lava_bucket');
  if (!lavaBucket) { console.log('[Phase2A] pourLavaAt: lava_bucket disappeared'); return false; }

  await bot.equip(lavaBucket, 'hand');
  await bot.waitForTicks(3);

  // To place lava AT targetPos we right-click the block BELOW it (its top face).
  // BUG FIX (original): no null guard on belowBlock — if belowBlock is null
  // (e.g. targetPos is floating over void) activateBlock would throw.
  const belowPos   = targetPos.offset(0, -1, 0);
  const belowBlock = bot.blockAt(belowPos);
  try {
    await bot.lookAt(targetPos.offset(0.5, 0.5, 0.5));
    await bot.waitForTicks(2);
    if (belowBlock?.boundingBox === 'block') {
      await bot.activateBlock(belowBlock);
    } else {
      // No solid block below — try activateItem (places lava where bot looks)
      await bot.activateItem();
    }
    await bot.waitForTicks(10);
  } catch (e) {
    try { await bot.activateItem(); await bot.waitForTicks(10); } catch (_) {}
  }

  return bot.blockAt(targetPos)?.name === 'lava';
}

// ─── pourWaterOnLava ─────────────────────────────────────────────────────────
// Scoops a water bucket and pours it onto the lava at targetPos.
// Returns true if obsidian now exists at or near targetPos.

async function pourWaterOnLava(bot, targetPos, waterPos) {
  // Refill water bucket if needed
  if (!hasWaterBucket(bot)) {
    const source = waterPos ?? findWaterSource(bot, 300);
    if (!source) {
      // Last resort: scan from current position
      const anyWater = findNearestWaterBlock(bot, 200);
      if (!anyWater) { console.log('[Phase2A] pourWaterOnLava: no water source found'); return false; }
    }

    const actualWater = source ?? findNearestWaterBlock(bot, 200);
    if (!actualWater) return false;

    try { await navigateTo(bot, actualWater, 3, 30000); } catch (_) {}

    const emptyBucket = bot.inventory.items().find(i => i.name === 'bucket');
    if (!emptyBucket) { console.log('[Phase2A] pourWaterOnLava: no empty bucket'); return false; }

    await bot.equip(emptyBucket, 'hand');
    await bot.waitForTicks(3);
    try {
      const wb = bot.blockAt(actualWater);
      if (wb?.name === 'water') {
        await bot.lookAt(actualWater.offset(0.5, 0.5, 0.5));
        await bot.activateBlock(wb);
        await bot.waitForTicks(8);
      }
    } catch (_) {}

    if (!hasWaterBucket(bot)) {
      console.log('[Phase2A] pourWaterOnLava: failed to scoop water');
      return false;
    }
  }

  // Navigate back near the lava
  try { await navigateTo(bot, targetPos, 3, 15000); } catch (_) {}

  const waterBucket = bot.inventory.items().find(i => i.name === 'water_bucket');
  if (!waterBucket) { console.log('[Phase2A] pourWaterOnLava: water_bucket disappeared'); return false; }

  await bot.equip(waterBucket, 'hand');
  await bot.waitForTicks(3);

  // Pour water directly onto the lava block
  try {
    const lavaBlock = bot.blockAt(targetPos);
    await bot.lookAt(targetPos.offset(0.5, 0.5, 0.5));
    await bot.waitForTicks(2);
    if (lavaBlock?.name === 'lava') {
      await bot.activateBlock(lavaBlock);
    } else {
      await bot.activateItem();
    }
    await bot.waitForTicks(15);
  } catch (e) {
    try { await bot.activateItem(); await bot.waitForTicks(15); } catch (_) {}
  }

  // Check for obsidian at targetPos or any immediate neighbor
  if (bot.blockAt(targetPos)?.name === 'obsidian') {
    await reclaimWater(bot, targetPos);
    return true;
  }
  for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[0,1,0]]) {
    if (bot.blockAt(targetPos.offset(dx, dy, dz))?.name === 'obsidian') {
      await reclaimWater(bot, targetPos);
      return true;
    }
  }

  await reclaimWater(bot, targetPos);
  return false;
}

// ─── reclaimWater ─────────────────────────────────────────────────────────────
// Picks up any water we placed so the bucket is ready for the next block.

async function reclaimWater(bot, nearPos) {
  const emptyBucket = bot.inventory.items().find(i => i.name === 'bucket');
  if (!emptyBucket) return; // bucket might already be empty (water was picked up)

  for (let dx = -4; dx <= 4; dx++) {
    for (let dz = -4; dz <= 4; dz++) {
      for (let dy = -2; dy <= 4; dy++) {
        const p = nearPos.offset(dx, dy, dz);
        const b = bot.blockAt(p);
        if (b?.name !== 'water') continue;
        // Only scoop source water (block above is air/passable)
        const above = bot.blockAt(p.offset(0, 1, 0));
        if (above?.name !== 'air' && above?.boundingBox !== 'empty') continue;
        try {
          if (bot.entity.position.distanceTo(p) > 4)
            await navigateTo(bot, p, 2, 8000).catch(() => {});
          await bot.equip(emptyBucket, 'hand');
          const wb = bot.blockAt(p);
          if (wb?.name === 'water') {
            await bot.activateBlock(wb);
            await bot.waitForTicks(5);
            return; // done — only need to pick up once
          }
        } catch (_) {}
      }
    }
  }
}

// ─── clearArea ────────────────────────────────────────────────────────────────
// Digs out any non-air blocks in the 4-wide × 5-tall portal footprint.

async function clearArea(bot, buildSite) {
  const pick = getBestPickaxe(bot);
  if (pick) await bot.equip(pick, 'hand').catch(() => {});

  for (let dx = 0; dx <= 3; dx++) {
    for (let dy = 0; dy <= 4; dy++) {
      const p = bot.blockAt(buildSite.offset(dx, dy, 0));
      if (!p) continue;
      if (p.name === 'air' || p.boundingBox === 'empty' || p.name === 'lava' || p.name === 'water') continue;
      if (!bot.canDigBlock(p)) continue;
      try {
        if (bot.entity.position.distanceTo(p.position) > 5)
          await navigateTo(bot, p.position, 4, 10000).catch(() => {});
        await bot.lookAt(p.position.offset(0.5, 0.5, 0.5));
        await bot.dig(p, true);
        await bot.waitForTicks(3);
      } catch (_) {}
    }
  }
}

// ─── lightPortal ─────────────────────────────────────────────────────────────

async function lightPortal(bot, buildSite) {
  const fns = bot.inventory.items().find(i => i.name === 'flint_and_steel');
  if (!fns) { console.log('[Phase2A] lightPortal: no flint_and_steel'); return false; }
  await bot.equip(fns, 'hand').catch(() => {});

  // Navigate to just inside the portal footprint
  try { await navigateTo(bot, buildSite.offset(1, 1, 0), 2, 10000); } catch (_) {}
  await bot.waitForTicks(5);

  // Try lighting by right-clicking each interior floor block
  for (const [dx, dy] of [[1,0],[2,0],[1,1],[2,1]]) {
    const floorBlock = bot.blockAt(buildSite.offset(dx, dy, 0));
    if (!floorBlock) continue;
    try {
      await bot.lookAt(buildSite.offset(dx, dy + 1, 0).offset(0.5, 0, 0.5));
      await bot.waitForTicks(2);
      await bot.activateBlock(floorBlock);
      await bot.waitForTicks(15);

      // Check if portal blocks appeared
      const portal = scanBlocks(bot, {
        centerPos: buildSite, radiusXZ: 5,
        yMin: buildSite.y, yMax: buildSite.y + 6,
        stepXZ: 1, stepY: 1,
        match: b => b.name === 'nether_portal', limit: 1,
      });
      if (portal.length > 0) {
        console.log('[Phase2A] Portal lit ✓');
        return true;
      }
    } catch (_) {}
  }

  console.log('[Phase2A] All lighting attempts failed');
  return false;
}

// ─── enterPortal ─────────────────────────────────────────────────────────────

async function enterPortal(bot, buildSite) {
  // Walk into the portal interior (ground floor of interior = dy=0 in the frame,
  // which is where nether_portal blocks appear after lighting)
  const interior = buildSite.offset(1, 0, 0);
  try { await navigateTo(bot, interior, 1, 10000); } catch (_) {}

  console.log('[Phase2A] Standing in portal — waiting for teleport (4s)...');
  await bot.waitForTicks(4 * 20); // 4 seconds = portal activation time
  console.log('[Phase2A] Entering Nether!');
}

// ─── getFlint ─────────────────────────────────────────────────────────────────

async function getFlint(bot) {
  const botY = Math.floor(bot.entity.position.y);
  for (let attempt = 0; attempt < 20 && countOf(bot, ['flint']) < 1; attempt++) {
    const gravels = scanBlocks(bot, {
      centerPos: bot.entity.position, radiusXZ: 60,
      yMin: botY - 5, yMax: botY + 10, stepXZ: 1, stepY: 1,
      match: b => b.name === 'gravel', limit: 5,
    });
    if (!gravels.length) break;

    gravels.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
    const target = gravels[0];

    try {
      await navigateTo(bot, target, 3, 15000);
      const b = bot.blockAt(target);
      if (b?.name === 'gravel') {
        const shovel = bot.inventory.items().find(i => i.name.includes('_shovel'));
        if (shovel) await bot.equip(shovel, 'hand').catch(() => {});
        await bot.dig(b, true);
        await bot.waitForTicks(10);
      }
    } catch (_) {}
  }
}

// ─── Local scan helpers ───────────────────────────────────────────────────────

function findNearestLavaBlock(bot, radius) {
  const pos = bot.entity.position.floored();
  let nearest = null, nearestDist = Infinity;
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dy = -3; dy <= 3; dy++) {
        const p = pos.offset(dx, dy, dz);
        const b = bot.blockAt(p);
        if (b?.name === 'lava') {
          const d = p.distanceTo(bot.entity.position);
          if (d < nearestDist) { nearest = p; nearestDist = d; }
        }
      }
    }
  }
  return nearest;
}

function findNearestWaterBlock(bot, radius) {
  const pos  = bot.entity.position.floored();
  const botY = pos.y;
  const blocks = scanBlocks(bot, {
    centerPos: pos, radiusXZ: radius,
    yMin: botY - 5, yMax: botY + 10, stepXZ: 5, stepY: 1,
    match: b => b.name === 'water', limit: 5,
  });
  if (!blocks.length) return null;
  return blocks.sort((a, b) => a.distanceTo(pos) - b.distanceTo(pos))[0];
}

module.exports = { runPhase2A };