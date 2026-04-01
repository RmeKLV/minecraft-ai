// src/phases/phase-1.js — Tier-aware orchestrator
//
// tier: 'ideal'     → phase-1a (wood) → phase-1b (shipwreck) → phase-1c (monument sponge)
// tier: 'shipwreck' → phase-1a (wood) → phase-1b (shipwreck)
// tier: 'fallback'  → phase-1a (wood) → phase-1b-fallback (village / underground iron)

const { runPhase1A } = require('./phase-1a');
const { runPhase1B } = require('./phase-1b');
const { runPhase1BFallback } = require('./phase-1b-fallback');

/**
 * @param {import('mineflayer').Bot} bot
 * @param {import('vec3').Vec3 | null} shipwreckPos
 * @param {{ tier: 'ideal'|'shipwreck'|'fallback', monumentPos?: object, fallbackResources?: object }} options
 */
async function startPhase1(bot, shipwreckPos, options = {}) {
  // BUG FIX: default was 'shipwreck' — 'fallback' is the correct safe default
  // because it doesn't depend on a shipwreckPos being valid.
  const { tier = 'fallback', monumentPos = null, fallbackResources = null } = options;

  console.log(`[Phase1] ── Starting Phase 1 (tier: ${tier.toUpperCase()}) ────────────────`);

  // Step 1 — wood & wooden tools is always the same regardless of tier
  const okA = await runPhase1A(bot);
  if (!okA) {
    console.error('[Phase1] Phase 1A failed — aborting.');
    return false;
  }

  // Step 2 — depends on tier
  if (tier === 'fallback') {
    console.log('[Phase1] Using fallback route (no shipwreck)');
    const okFallback = await runPhase1BFallback(bot, fallbackResources);
    if (!okFallback) return false;
  } else {
    // 'ideal' or 'shipwreck' both go to the shipwreck for loot
    if (!shipwreckPos) {
      console.error(`[Phase1] Tier is '${tier}' but shipwreckPos is null — falling back.`);
      const okFallback = await runPhase1BFallback(bot, fallbackResources);
      if (!okFallback) return false;
    } else {
      const okB = await runPhase1B(bot, shipwreckPos);
      if (!okB) return false;

      // For ideal tier, optionally note monument — phase-1c would handle sponge farming
      if (tier === 'ideal' && monumentPos) {
        console.log(`[Phase1] Monument at ${monumentPos} — ready for phase 1C (sponge/gold)`);
        // await runPhase1C(bot, monumentPos);  ← hook for future implementation
      }
    }
  }

  console.log('[Phase1] ── Phase 1 complete! Ready for Nether. ──────────────────');
  return true;
}

module.exports = { startPhase1 };