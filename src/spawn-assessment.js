// src/spawn-assessment.js — 3-tier spawn assessment
//
// Tier 1 — IDEAL:     Shipwreck + Ocean Monument  → fastest possible speedrun
// Tier 2 — SHIPWRECK: Shipwreck only              → strong speedrun start
// Tier 3 — FALLBACK:  No shipwreck                → normal run (village / underground iron)
// REJECT:             No ocean at all             → restart

const Vec3 = require('vec3');
const { scanBlocks } = require('./utils/blocks');

// ─── assessSpawn ──────────────────────────────────────────────────────────────

function assessSpawn(bot) {
  const oceanResult     = checkOcean(bot);
  const shipwreckResult = checkShipwreck(bot);
  const lavaResult      = checkMagmaRavineOrLava(bot);
  const monumentResult  = checkOceanMonument(bot, shipwreckResult.found);
  const fallbackResult  = shipwreckResult.found ? { found: false, details: 'Shipwreck present' }
                                                 : checkFallbackResources(bot);

  // Determine tier
  let tier;
  if (!oceanResult.found) {
    tier = 'reject';
  } else if (shipwreckResult.found && monumentResult.found) {
    tier = 'ideal';
  } else if (shipwreckResult.found) {
    tier = 'shipwreck';
  } else {
    tier = 'fallback';
  }

  return {
    tier,
    // Ocean
    hasOcean:             oceanResult.found,
    oceanDetails:         oceanResult.details,
    // Shipwreck
    hasShipwreck:         shipwreckResult.found,
    shipwreckDetails:     shipwreckResult.details,
    shipwreckPos:         shipwreckResult.pos,
    // Monument
    hasMonument:          monumentResult.found,
    monumentDetails:      monumentResult.details,
    monumentPos:          monumentResult.pos,
    // Lava / magma
    hasMagmaRavineOrLava: lavaResult.found,
    lavaDetails:          lavaResult.details,
    // Fallback resources
    fallbackResources:    fallbackResult,
  };
}

// ─── checkOcean ───────────────────────────────────────────────────────────────

function checkOcean(bot, radiusXZ = 120) {
  try {
    const waterBlocks = scanBlocks(bot, {
      centerPos: bot.entity.position,
      radiusXZ, yMin: 58, yMax: 65,
      stepXZ: 4, stepY: 1,
      match: b => b.name === 'water',
      limit: 60,
    });

    if (waterBlocks.length < 5)
      return { found: false, details: `Only ${waterBlocks.length} water blocks — too small for an ocean.` };

    for (const pos of waterBlocks.slice(0, 10)) {
      let neighbors = 0;
      for (let dx = -3; dx <= 3; dx++) {
        for (let dz = -3; dz <= 3; dz++) {
          const b = bot.blockAt(pos.offset(dx, 0, dz));
          if (b && b.name === 'water') neighbors++;
        }
      }
      if (neighbors >= 8)
        return { found: true, details: `Ocean confirmed near ${pos.floored()}` };
    }

    return { found: false, details: 'Found scattered water but not a large ocean.' };
  } catch (err) {
    console.error('[Ocean Error]', err);
    return { found: false, details: 'Error during ocean check.' };
  }
}

// ─── checkShipwreck ───────────────────────────────────────────────────────────

function checkShipwreck(bot, radiusXZ = 200) {
  try {
    const chestPositions = scanBlocks(bot, {
      centerPos: bot.entity.position,
      radiusXZ, yMin: 40, yMax: 65,
      stepXZ: 1, stepY: 1,
      match: b => b.name === 'chest',
      limit: 15,
    });

    console.log(`[Shipwreck] Scan found ${chestPositions.length} chest(s)`);
    chestPositions.forEach(p => console.log(`  chest at ${p}`));

    if (chestPositions.length === 0)
      return { found: false, details: 'No chests within 200 blocks (Y 40-65).', pos: null };

    const botPos = bot.entity.position;
    chestPositions.sort((a, b) => a.distanceTo(botPos) - b.distanceTo(botPos));
    const closest = chestPositions[0];

    const shipwreckBlocks = new Set([
      'chest',
      'oak_planks','spruce_planks','jungle_planks','dark_oak_planks',
      'oak_log','spruce_log','jungle_log','dark_oak_log',
      'stripped_oak_log','stripped_spruce_log',
      'oak_stairs','spruce_stairs',
      'oak_slab','spruce_slab',
    ]);

    let score = 0;
    for (let dx = -15; dx <= 15; dx += 2) {
      for (let dz = -15; dz <= 15; dz += 2) {
        for (let dy = -8; dy <= 8; dy += 2) {
          const block = bot.blockAt(closest.offset(dx, dy, dz));
          if (!block) continue;
          if (shipwreckBlocks.has(block.name)) {
            score++;
            if (block.name === 'chest') score += 3;
          }
        }
      }
    }

    console.log(`[Shipwreck] Structure score: ${score}`);

    if (score >= 8)
      return { found: true, details: `Shipwreck confirmed — ${chestPositions.length} chest(s), score ${score}.`, pos: closest };
    if (chestPositions.length >= 2)
      return { found: true, details: `Shipwreck likely — ${chestPositions.length} chests, score ${score}.`, pos: closest };

    return { found: false, details: `1 chest, low score ${score} — probably not a shipwreck.`, pos: null };
  } catch (err) {
    console.error('[Shipwreck Error]', err);
    return { found: false, details: 'Error during shipwreck check.', pos: null };
  }
}

// ─── checkOceanMonument ───────────────────────────────────────────────────────

function checkOceanMonument(bot, shipwreckFound) {
  if (!shipwreckFound) return { found: false, details: 'Skipped (no shipwreck)', pos: null };
  try {
    const monumentBlocks = new Set([
      'prismarine','prismarine_bricks','dark_prismarine','sea_lantern','wet_sponge',
    ]);
    const found = scanBlocks(bot, {
      centerPos: bot.entity.position,
      radiusXZ: 250, yMin: 30, yMax: 65,
      stepXZ: 4, stepY: 2,
      match: b => monumentBlocks.has(b.name),
      limit: 10,
    });

    if (found.length >= 3)
      return { found: true, details: `Ocean Monument detected (${found.length} prismarine blocks)`, pos: found[0] };

    return { found: false, details: 'No ocean monument nearby.', pos: null };
  } catch (err) {
    console.error('[Monument Error]', err);
    return { found: false, details: 'Error during monument check.', pos: null };
  }
}

// ─── checkMagmaRavineOrLava ───────────────────────────────────────────────────

function checkMagmaRavineOrLava(bot, radiusXZ = 120) {
  try {
    const lavaBlocks  = scanBlocks(bot, { centerPos: bot.entity.position, radiusXZ, yMin: 30, yMax: 70, stepXZ: 3, stepY: 1, match: b => b.name === 'lava',        limit: 10 });
    const magmaBlocks = scanBlocks(bot, { centerPos: bot.entity.position, radiusXZ, yMin: 30, yMax: 70, stepXZ: 3, stepY: 1, match: b => b.name === 'magma_block', limit: 10 });

    const details = [];
    if (lavaBlocks.length  > 0) details.push(`lava pool (${lavaBlocks.length} blocks)`);
    if (magmaBlocks.length > 0) details.push(`magma blocks (${magmaBlocks.length})`);

    if (details.length > 0) return { found: true,  details: details.join(' and ') };
    return { found: false, details: 'No surface lava or magma.' };
  } catch (err) {
    console.error('[Lava Error]', err);
    return { found: false, details: 'Error during lava/magma check.' };
  }
}

// ─── checkFallbackResources ───────────────────────────────────────────────────
// Only called when there's no shipwreck — looks for villages, ruined portals,
// exposed iron/coal, and ravines that could give an early iron source.

function checkFallbackResources(bot) {
  const resources = [];

  try {
    // Village indicators: hay bales, bell, iron golem, beds, villager houses
    const villageBlocks = new Set(['hay_block', 'bell', 'composter', 'barrel', 'cartography_table']);
    const villageFound = scanBlocks(bot, {
      centerPos: bot.entity.position,
      radiusXZ: 300, yMin: 60, yMax: 80,
      stepXZ: 4, stepY: 1,
      match: b => villageBlocks.has(b.name),
      limit: 5,
    });
    if (villageFound.length >= 2) {
      resources.push({ type: 'village', pos: villageFound[0], details: `Village detected (${villageFound.length} indicators)` });
    }
  } catch (e) { console.error('[Fallback] Village check error:', e.message); }

  try {
    // Ruined portal: crying obsidian or netherrack above Y55
    const portalBlocks = new Set(['crying_obsidian', 'netherrack']);
    const portalFound = scanBlocks(bot, {
      centerPos: bot.entity.position,
      radiusXZ: 200, yMin: 55, yMax: 80,
      stepXZ: 3, stepY: 1,
      match: b => portalBlocks.has(b.name),
      limit: 5,
    });
    if (portalFound.length >= 1) {
      resources.push({ type: 'ruined_portal', pos: portalFound[0], details: `Ruined portal found (${portalFound.length} blocks)` });
    }
  } catch (e) { console.error('[Fallback] Portal check error:', e.message); }

  try {
    // Exposed iron ore on the surface or in a ravine
    const ironFound = scanBlocks(bot, {
      centerPos: bot.entity.position,
      radiusXZ: 80, yMin: 20, yMax: 70,
      stepXZ: 2, stepY: 1,
      match: b => b.name === 'iron_ore' || b.name === 'deepslate_iron_ore',
      limit: 10,
    });
    if (ironFound.length >= 3) {
      resources.push({ type: 'iron_ore', pos: ironFound[0], details: `Exposed iron ore (${ironFound.length} blocks)` });
    }
  } catch (e) { console.error('[Fallback] Iron check error:', e.message); }

  try {
    // Ravine / cave opening — air at low Y
    const ravineFound = scanBlocks(bot, {
      centerPos: bot.entity.position,
      radiusXZ: 60, yMin: 30, yMax: 55,
      stepXZ: 3, stepY: 1,
      match: b => b.name === 'air',
      limit: 20,
    });
    if (ravineFound.length >= 10) {
      resources.push({ type: 'ravine', pos: ravineFound[0], details: `Cave/ravine opening nearby` });
    }
  } catch (e) { console.error('[Fallback] Ravine check error:', e.message); }

  return {
    found: resources.length > 0,
    resources,
    details: resources.length > 0
      ? resources.map(r => r.details).join(' | ')
      : 'No obvious fallback resources found — will mine normally.',
  };
}

// ─── verifySpawnAndAlert ──────────────────────────────────────────────────────
// Returns an object with { tier, shipwreckPos, fallbackResources, monumentPos }
// so main.js can route to the right phase.

function verifySpawnAndAlert(bot) {
  try {
    console.log('[Verify] Starting spawn assessment...');
    const result = assessSpawn(bot);
    console.log('[Verify] Assessment complete:', JSON.stringify(result, null, 2));

    // ── REJECT: no ocean at all ────────────────────────────────────────────
    if (result.tier === 'reject') {
      console.log('[SPAWN REJECTED] No ocean — resetting:');
      console.log(`  Ocean: ${result.oceanDetails}`);
      if (bot.ashfinder) bot.ashfinder.stop();
      bot.end();
      return null;
    }

    // ── IDEAL: shipwreck + monument ────────────────────────────────────────
    if (result.tier === 'ideal') {
      console.log('✨ [SPAWN: IDEAL] Shipwreck + Ocean Monument! ✨');
      console.log(`  Shipwreck: ${result.shipwreckDetails}`);
      console.log(`  Monument:  ${result.monumentDetails}`);
      return {
        tier: 'ideal',
        shipwreckPos: result.shipwreckPos,
        monumentPos: result.monumentPos,
        fallbackResources: null,
      };
    }

    // ── SHIPWRECK: good speedrun start ─────────────────────────────────────
    if (result.tier === 'shipwreck') {
      console.log('✓ [SPAWN: SHIPWRECK] Good speedrun start.');
      console.log(`  Shipwreck: ${result.shipwreckDetails}`);
      if (!result.hasMagmaRavineOrLava)
        console.log(`  Note: ${result.lavaDetails}`);
      return {
        tier: 'shipwreck',
        shipwreckPos: result.shipwreckPos,
        monumentPos: null,
        fallbackResources: null,
      };
    }

    // ── FALLBACK: normal run ───────────────────────────────────────────────
    console.log('⚠ [SPAWN: FALLBACK] No shipwreck — running standard route.');
    console.log(`  ${result.fallbackResources.details}`);
    return {
      tier: 'fallback',
      shipwreckPos: null,
      monumentPos: null,
      fallbackResources: result.fallbackResources,
    };

  } catch (err) {
    console.error('[FATAL] verifySpawnAndAlert threw:', err);
    bot.end();
    return null;
  }
}

module.exports = {
  assessSpawn,
  verifySpawnAndAlert,
  checkFallbackResources,
};