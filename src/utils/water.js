// src/utils/water.js — Simplified with Baritone swimming
const Vec3 = require('vec3');

// ─── Surface for air ───────────────────────────────────────────────────────

async function surfaceForAir(bot, ms = 8000) {
  if (!bot.entity.isInWater) return;
  
  console.log('[Air] Surfacing...');
  if (bot.ashfinder && !bot.ashfinder.stopped) {
    bot.ashfinder.stop();
    await bot.waitForTicks(2);
  }
  
  bot.setControlState('sneak', false);
  bot.setControlState('forward', false);
  bot.setControlState('jump', true);
  
  const deadline = Date.now() + ms;
  // FIX: oxygenLevel is 0-300 ticks in Mineflayer (300=full), NOT 0-20 bubbles.
  // Old check < 19 meant "nearly dead" — bot was surfacing then diving immediately.
  while (Date.now() < deadline && bot.entity.isInWater && bot.oxygenLevel < 280) {
    await bot.waitForTicks(2);
  }
  
  bot.setControlState('jump', false);
  await bot.waitForTicks(15);
  console.log(`[Air] Surfaced (oxygen=${bot.oxygenLevel})`);
}

// ─── Configure bot for different environments ────────────────────────────────

function configureForLoot(bot) {
  if (!bot.ashfinder) return;
  // Swimming enabled, breaking enabled for ship hull, no placing
  bot.ashfinder.config.swimming = true;
  bot.ashfinder.config.breakBlocks = true;
  bot.ashfinder.config.placeBlocks = false;
  bot.ashfinder.config.parkour = false;
  bot.ashfinder.config.maxWaterDist = 256;
}

function configureForFlint(bot) {
  if (!bot.ashfinder) return;
  // Land config
  bot.ashfinder.config.swimming = true;
  bot.ashfinder.config.breakBlocks = true;
  bot.ashfinder.config.placeBlocks = false;
  bot.ashfinder.config.parkour = false;
}

function restoreDefaultConfig(bot) {
  if (!bot.ashfinder) return;
  bot.ashfinder.config.swimming = true;
  bot.ashfinder.config.breakBlocks = true;
  bot.ashfinder.config.placeBlocks = true;
  bot.ashfinder.config.parkour = false;
  bot.ashfinder.config.maxFallDist = 3;
}

// ─── Drowning monitor (keep this - it's good safety) ─────────────────────────

function startDrowningMonitor(bot) {
  let active = true;
  let surfacing = false;
  let paused = false;

  const iv = setInterval(async () => {
    if (!active || surfacing || paused) return;
    if (bot.entity.isInWater && bot.oxygenLevel <= 30) {
      surfacing = true;
      console.log(`[Air] EMERGENCY surface! oxygen=${bot.oxygenLevel}`);
      if (bot.ashfinder && !bot.ashfinder.stopped) bot.ashfinder.stop();
      
      bot.setControlState('sneak', false);
      bot.setControlState('forward', false);
      bot.setControlState('jump', true);
      
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline && bot.entity.isInWater && bot.oxygenLevel < 280) {
        await bot.waitForTicks(2);
      }
      
      bot.setControlState('jump', false);
      await bot.waitForTicks(20);
      console.log(`[Air] Emergency surface done (oxygen=${bot.oxygenLevel})`);
      surfacing = false;
    }
  }, 300);

  const isSurfacing = () => surfacing;
  const stop    = () => { active = false; clearInterval(iv); };
  const pause   = () => { paused = true; };
  const resume  = () => { paused = false; };

  return { stop, isSurfacing, pause, resume };
}

module.exports = {
  surfaceForAir,
  startDrowningMonitor,
  configureForLoot,
  configureForFlint,
  restoreDefaultConfig,
};