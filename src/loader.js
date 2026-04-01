const astar = require("./pathfinder").Astar;
const { Vec3 } = require("vec3");
const {
  vectorProjection,
  shouldAutoJump,
  canWalkJump,
  smoothPath,
  placeBlock,
  autoTool,
  simulateUntil,
  isPointOnPath,
  getController,
  distanceFromLine,
  createEndFunc,
} = require("./utils.js");
const { Cell } = require("./pathfinder");
const AABB = require("./aabb.js");
const { Goal, GoalNear } = require("./goal.js");

const sleep = (ms = 2000) => {
  return new Promise((r) => {
    setTimeout(r, ms);
  });
};

const {
  default: loader,
  EPhysicsCtx,
  EntityPhysics,
  EntityState,
} = require("@nxg-org/mineflayer-physics-util");
const { AshFinderPlugin } = require("./AshFinder.js");


function inject(bot) {
  bot.ashfinder = new AshFinderPlugin(bot);
}

module.exports = inject;
