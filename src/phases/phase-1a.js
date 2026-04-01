// src/phases/phase-1a.js
const Vec3 = require('vec3');
const { collectBlocks, scanBlocks } = require('../utils/blocks');
const { craftWoodenTools, craftBoatAndDoors } = require('../utils/crafting');
const { navigateTo } = require('../utils/navigation');

const LOG_TYPES = [
  'oak_log','spruce_log','birch_log','jungle_log',
  'acacia_log','dark_oak_log','mangrove_log','cherry_log',
];
const ALL_WOOD = [
  ...LOG_TYPES,
  'stripped_oak_log','stripped_spruce_log','stripped_birch_log','stripped_jungle_log',
  'stripped_acacia_log','stripped_dark_oak_log',
  'oak_wood','spruce_wood','birch_wood','jungle_wood','acacia_wood','dark_oak_wood',
];

function countLogs(bot) {
  return bot.inventory.items()
    .filter(i => i.name.includes('_log') || (i.name.includes('_wood') && !i.name.includes('_planks')))
    .reduce((s,i) => s+i.count, 0);
}

async function navigateToNearestTree(bot) {
  console.log('[Phase1A] Scanning for nearby trees...');
  const botY = Math.floor(bot.entity.position.y);
  for (const [r, step] of [[128,3],[256,5],[512,8]]) {
    const found = scanBlocks(bot, {
      centerPos: bot.entity.position, radiusXZ: r,
      yMin: Math.max(0, botY-30), yMax: botY+50,
      stepXZ: step, stepY: 1,
      match: b => b.name.includes('_log'), limit: 5,
    });
    if (!found.length) { console.log(`[Phase1A] No logs within ${r} blocks`); continue; }
    found.sort((a,b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
    const target = found[0];
    const dist = target.distanceTo(bot.entity.position);
    console.log(`[Phase1A] Tree at ${target} (${dist.toFixed(0)} blocks) — navigating`);
    try {
      await navigateTo(bot, target, 5, Math.min(120000, Math.max(20000, dist * 500)));
      return true;
    } catch (err) {
      console.log(`[Phase1A] Tree nav failed: ${err.message}`);
      if (target.distanceTo(bot.entity.position) < 20) return true;
    }
  }
  return false;
}

// Navigate to an open flat area for crafting.
// Used when the bot is inside a mountain / cave with no adjacent air.
async function moveToOpenGround(bot) {
  console.log('[Phase1A] Moving to open ground for crafting...');
  const botPos = bot.entity.position;

  // Scan for any surface-level (Y 60-100) air block reasonably close
  const openSpots = scanBlocks(bot, {
    centerPos: botPos, radiusXZ: 100,
    yMin: 60, yMax: 110, stepXZ: 5, stepY: 2,
    match: b => {
      if (b.name !== 'air') return false;
      // Needs solid floor below
      const below = b.position ? null : null; // blockAt uses pos separately
      return true;
    },
    limit: 10,
  });

  // Simpler: scan for an above-ground position by looking for blocks below air at the surface
  const cx = Math.floor(botPos.x);
  const cz = Math.floor(botPos.z);
  for (let r = 5; r <= 60; r += 5) {
    for (const [dx, dz] of [[r,0],[-r,0],[0,r],[0,-r],[r,r],[-r,-r],[r,-r],[-r,r]]) {
      for (let y = 110; y >= 60; y--) {
        const floorCandidate = bot.blockAt(new Vec3(cx+dx, y, cz+dz));
        const airAbove       = bot.blockAt(new Vec3(cx+dx, y+1, cz+dz));
        const airAbove2      = bot.blockAt(new Vec3(cx+dx, y+2, cz+dz));
        if (
          floorCandidate?.boundingBox === 'block' &&
          airAbove?.name === 'air' &&
          airAbove2?.name === 'air'
        ) {
          const target = new Vec3(cx+dx, y+1, cz+dz);
          try {
            await navigateTo(bot, target, 3, 30000);
            console.log(`[Phase1A] Reached open ground at ${bot.entity.position.floored()}`);
            return true;
          } catch (_) {}
          break;
        }
      }
    }
  }

  console.log('[Phase1A] Could not find open ground — will try crafting in place');
  return false;
}

async function runPhase1A(bot) {
  console.log('[Phase1A] Starting — wood collection & crafting');
  console.log(`[Phase1A] Position: ${bot.entity.position.floored()}`);

  let logs = countLogs(bot);
  console.log(`[Phase1A] Logs in inventory: ${logs}`);

  // ── Step 1: get enough wood for tools ────────────────────────────────────
  if (logs < 3) {
    const nearby = scanBlocks(bot, {
      centerPos: bot.entity.position, radiusXZ: 20,
      yMin: Math.max(0, Math.floor(bot.entity.position.y)-10),
      yMax: Math.floor(bot.entity.position.y)+20,
      stepXZ: 1, stepY: 1, match: b => b.name.includes('_log'), limit: 1,
    });
    if (!nearby.length) {
      const found = await navigateToNearestTree(bot);
      if (!found) { console.error('[Phase1A] No trees — aborting.'); bot.end(); return false; }
    }
    for (let attempt = 0; attempt < 4 && logs < 3; attempt++) {
      const r = [32,64,96,128][attempt];
      console.log(`[Phase1A] Collecting logs by hand (r=${r}, attempt ${attempt+1})`);
      await collectBlocks(bot, ALL_WOOD, 3-logs, 'fist', [], r);
      await bot.waitForTicks(20);
      logs = countLogs(bot);
      console.log(`[Phase1A] Logs: ${logs}`);
      if (logs < 3 && attempt < 3) await navigateToNearestTree(bot);
    }
    if (logs < 3) { console.error('[Phase1A] Not enough logs — aborting.'); bot.end(); return false; }
  }

  // ── Step 2: craft wooden tools ────────────────────────────────────────────
  const hasAxe  = bot.inventory.items().some(i => i.name.includes('_axe'));
  const hasPick = bot.inventory.items().some(i => i.name.includes('_pickaxe'));
  if (!hasAxe || !hasPick) {
    console.log('[Phase1A] Crafting wooden tools...');

    // BUG FIX: craftWoodenTools now returns a boolean. If it fails (e.g. bot is
    // surrounded by mountain and can't place the crafting table), we first try
    // to move to open ground and retry rather than silently continuing with no
    // tools.
    let toolsOk = await craftWoodenTools(bot);

    if (!toolsOk) {
      const stillNoAxe  = !bot.inventory.items().some(i => i.name.includes('_axe'));
      const stillNoPick = !bot.inventory.items().some(i => i.name.includes('_pickaxe'));
      if (stillNoAxe || stillNoPick) {
        console.log('[Phase1A] Tool crafting failed — moving to open ground and retrying...');
        await moveToOpenGround(bot);
        toolsOk = await craftWoodenTools(bot);
      }
    }

    if (!toolsOk) {
      const finalNoAxe  = !bot.inventory.items().some(i => i.name.includes('_axe'));
      const finalNoPick = !bot.inventory.items().some(i => i.name.includes('_pickaxe'));
      if (finalNoAxe || finalNoPick) {
        // Non-fatal: log the problem but continue. collectBlocks can use 'fist'.
        console.warn('[Phase1A] WARNING: wooden tools could not be crafted — continuing without them');
      }
    }
  } else {
    console.log('[Phase1A] Already have axe + pickaxe — skipping tool craft');
  }

  // ── Step 3: chop more logs for boat + doors ───────────────────────────────
  const hasBoat = bot.inventory.items().some(i => i.name.includes('boat'));
  const doorCnt = bot.inventory.items().filter(i => i.name.includes('door')).reduce((s,i) => s+i.count, 0);
  if (hasBoat && doorCnt >= 3) {
    console.log('[Phase1A] Already have boat + doors — skipping wood collection');
  } else {
    logs = countLogs(bot);
    const planks = bot.inventory.items().filter(i => i.name.includes('_planks')).reduce((s,i) => s+i.count, 0);
    const logNeeded = Math.max(0, Math.ceil((11 - planks) / 4));
    console.log(`[Phase1A] Planks: ${planks}, extra logs needed: ${logNeeded}`);

    if (logNeeded > 0) {
      for (let attempt = 0; attempt < 4 && countLogs(bot) < logNeeded; attempt++) {
        const r = [48,80,112,128][attempt];
        console.log(`[Phase1A] Chopping logs with axe (r=${r}, attempt ${attempt+1})`);
        await collectBlocks(bot, ALL_WOOD, logNeeded - countLogs(bot), 'axe', [], r);
        await bot.waitForTicks(20);
        logs = countLogs(bot);
        console.log(`[Phase1A] Logs: ${logs}`);
        if (logs < logNeeded && attempt < 3) await navigateToNearestTree(bot);
      }
    }

    // ── Step 4: craft boat + 3 doors ─────────────────────────────────────
    console.log('[Phase1A] Crafting boat and doors...');
    await craftBoatAndDoors(bot);
  }

  const inv = bot.inventory.items().map(i => `${i.name}×${i.count}`).join(', ');
  console.log(`[Phase1A] Inventory: ${inv}`);
  console.log('[Phase1A] Complete ✓');
  return true;
}

module.exports = { runPhase1A };