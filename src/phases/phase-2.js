// src/phases/phase-2.js — Nether Phase Orchestrator
//
// Phase 2A — Portal Construction (overworld)
//   · Ensure iron pickaxe, bucket, flint & steel
//   · Locate lava pool + water source
//   · Build 4×5 obsidian portal frame using bucket method
//   · Light portal and enter
//
// Phase 2B — Nether: Fortress & Blaze Rods
//   · Navigate to nether fortress
//   · Kill blazes for blaze rods
//   · Optional: bastion loot / piglin bartering for ender pearls
//   · Return to overworld portal (Phase 3 hook)

const { runPhase2A } = require('./phase-2a');
const { runPhase2B } = require('./phase-2b');

async function runPhase2(bot) {
  console.log('[Phase2] ── Starting Phase 2 ─────────────────────────────────');

  // ── Phase 2A: Build and enter the nether portal ───────────────────────────
  console.log('[Phase2] ── 2A: Portal Construction ──────────────────────────');
  const ok2A = await runPhase2A(bot);
  if (!ok2A) {
    console.error('[Phase2] Phase 2A (portal construction) failed — aborting.');
    return false;
  }
  console.log('[Phase2] Phase 2A complete ✓');

  // ── Phase 2B: Navigate nether, kill blazes ────────────────────────────────
  console.log('[Phase2] ── 2B: Nether Navigation ────────────────────────────');
  const ok2B = await runPhase2B(bot);
  if (!ok2B) {
    console.error('[Phase2] Phase 2B (nether navigation) failed — aborting.');
    return false;
  }
  console.log('[Phase2] Phase 2B complete ✓');

  console.log('[Phase2] ── Phase 2 complete! Ready for End. ──────────────────');
  return true;
}

module.exports = { runPhase2 };