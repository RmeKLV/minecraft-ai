/**
 * moves.js — Combined movement module
 *
 * Merged from: index.js, basic.js, basic-parkour.js, break.js,
 *              climb.js, place.js, swin.js
 *
 * Excluded (dead code / not useful for survival):
 *   - break-parkour.js  → registerMoves() was commented out, never ran
 *   - crawl.js          → commented out; mineflayer crawl is broken
 *   - scaffolding.js    → all classes commented out
 *   - fly.js            → not needed for survival / speedrun
 */

"use strict";

const { Vec3 } = require("vec3");
const nbt = require("prismarine-nbt");

// ─────────────────────────────────────────────
// SECTION 1 — Core primitives  (was index.js)
// ─────────────────────────────────────────────

const cardinalDirections = [
  { x: 1, z: 0 },
  { x: -1, z: 0 },
  { x: 0, z: 1 },
  { x: 0, z: -1 },
];

class DirectionalVec3 extends Vec3 {
  constructor(x, y, z, direction, attributes = {}) {
    super(x, y, z);
    this.dir = direction;
    this.attributes = attributes;
    this.cost = 0;
  }

  forward(amount = 1, attributes = {}) {
    return new DirectionalVec3(
      this.x + this.dir.x * amount,
      this.y,
      this.z + this.dir.z * amount,
      this.dir,
      attributes
    );
  }

  right(amount = 1, attributes = {}) {
    return new DirectionalVec3(
      this.x - this.dir.z * amount,
      this.y,
      this.z + this.dir.x * amount,
      this.dir,
      attributes
    );
  }

  left(amount = 1, attributes = {}) {
    return new DirectionalVec3(
      this.x + this.dir.z * amount,
      this.y,
      this.z - this.dir.x * amount,
      this.dir,
      attributes
    );
  }

  up(amount = 1, attributes = {}) {
    return new DirectionalVec3(this.x, this.y + amount, this.z, this.dir, attributes);
  }

  down(amount = 1, attributes = {}) {
    return new DirectionalVec3(this.x, this.y - amount, this.z, this.dir, attributes);
  }

  offset(dx, dy, dz, attributes = {}) {
    return new DirectionalVec3(this.x + dx, this.y + dy, this.z + dz, this.dir, attributes);
  }

  clone() {
    return new DirectionalVec3(this.x, this.y, this.z, this.dir, this.attributes);
  }

  plus(vec) {
    return new DirectionalVec3(this.x + vec.x, this.y + vec.y, this.z + vec.z, this.dir, this.attributes);
  }

  equals(other) {
    return (
      this.x === other.x &&
      this.y === other.y &&
      this.z === other.z &&
      this.dir.x === other.dir.x &&
      this.dir.z === other.dir.z
    );
  }

  toString() {
    return `(${this.x}, ${this.y}, ${this.z}) dir: (${this.dir.x}, ${this.dir.z})`;
  }

  toStringNoDir() {
    return `${this.x}, ${this.y}, ${this.z}`;
  }

  detailsString() {
    return `(${this.x}, ${this.y}, ${this.z}) dir: (${this.dir.x}, ${this.dir.z}) cost: ${this.cost}`;
  }
}

class Vec3WithAttr extends Vec3 {
  constructor(x, y, z, attributes = {}) {
    super(x, y, z);
    this.attributes = attributes;
    this.cost = 0;
  }
}

/** @type {Array<Move>} */
const moveClasses = [];

/** @type {Map<string, {instance: Move, metadata: Object}>} */
const moveRegistry = new Map();

class Move {
  constructor(priority = 50, metadata = {}) {
    this.name = this.constructor.name;
    this.priority = priority;

    this.metadata = {
      name: this.name,
      category: metadata.category || "basic",
      tags: metadata.tags || [],
      description: metadata.description || `${this.name} movement`,
      testConfig: metadata.testConfig || {},
      ...metadata,
    };

    // Movement costs
    this.COST_NORMAL    = 1;
    this.COST_UP        = 1;
    this.COST_FALL      = 1;
    this.COST_BREAK     = this.COST_NORMAL + 0.12;
    this.COST_PLACE     = this.COST_NORMAL + 0.12;
    this.COST_SWIM      = 1;
    this.COST_SWIM_START = 1.1;
    this.COST_SWIM_EXIT  = 1.1;
    this.COST_CLIMB     = 1;
    this.COST_LADDER    = 2;
    this.COST_PARKOUR   = 3.5;
    this.COST_DIAGONAL  = Math.SQRT2;
  }

  generate(cardinalDirections, origin, neighbors, end = null) {}

  log(...args) {
    if (this.config.debugMoves) console.log(`[Move:${this.name}]`, ...args);
  }

  setValues(bot, config, manager, node = null) {
    this._blockCache = new Map();
    this.bot = bot;
    this.manager = manager;
    this.config = config;
    this.node = node;
    this.mcData = require("minecraft-data")(bot.version);
    this.virtualBlocks = new Map();
  }

  // ── Inventory helpers ──────────────────────────────────────────────────────

  hasScaffoldingBlocks() {
    return this.bot.inventory.items().some((item) => this.config.disposableBlocks.includes(item.name));
  }

  scaffoldingLeft() {
    return this.bot.inventory
      .items()
      .reduce((sum, item) => sum + (this.config.disposableBlocks.includes(item.name) ? item.count : 0), 0);
  }

  canAffordPlacement(placementCount = 1) {
    if (!this.node) return true;
    return (this.node.scaffoldingUsed || 0) + placementCount <= this.scaffoldingLeft();
  }

  // ── Block queries ──────────────────────────────────────────────────────────

  getBlock(pos) {
    const virtuals = this.node?.virtualBlocks || this.virtualBlocks;
    if (virtuals?.has(pos.toStringNoDir())) {
      const state = virtuals.get(pos.toStringNoDir());
      if (state === "air")    return this.mcData.blocksByName["air"];
      if (state === "placed") return this.mcData.blocksByName["stone"];
    }
    return this.bot.blockAt(pos);
  }

  canPlaceBlock(pos) {
    const offsets = [[0,-1,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]];
    return offsets.some(([dx, dy, dz]) => this.isSolid(pos.offset(dx, dy, dz)));
  }

  isAir(pos) {
    const block = this.getBlock(pos);
    return !!block && block.boundingBox === "empty" && !this.isWater(pos) && !this.isScaffolding(pos);
  }

  isSolid(pos) {
    const block = this.getBlock(pos);
    return !!block && block.boundingBox === "block" && this.isFullBlock(pos);
  }

  isCarpetLike(pos) {
    const block = this.getBlock(pos);
    return !!block && (block.name.includes("carpet") || block.name === "snow");
  }

  isTrapdoor(node) {
    const block = this.getBlock(node);
    return !!block && block.name.includes("trapdoor") && block.name !== "iron_trapdoor";
  }

  isTopTrapdoor(node) {
    return this.isTrapdoor(node) && this.getBlock(node)?.getProperties().half === "top";
  }

  isFree(node, pos) {
    return this.isAir(pos) || (node.attributes?.break || []).some((b) => b.equals(pos));
  }

  withOverlay(node, fn) {
    const oldVirtuals = this.virtualBlocks;
    const overlay = new Map(oldVirtuals || []);
    if (node.attributes) {
      for (const b of node.attributes.break || []) overlay.set(b.toStringNoDir(), "air");
      for (const p of node.attributes.place || []) overlay.set(p.toStringNoDir(), "placed");
    }
    this.virtualBlocks = overlay;
    const result = fn();
    this.virtualBlocks = oldVirtuals;
    return result;
  }

  isWalkable(node) {
    const block = this.getBlock(node);
    if (!block) return false;
    if (block.name.includes("lava"))  return false;
    if (block.name.includes("fence")) return false;
    if (block.name.includes("wall"))  return false;
    if (block.name.includes("glass_pane")) return false;
    return block.boundingBox !== "block" || !this.isFullBlock(node);
  }

  isStandable(node) {
    const feet  = node;
    const head  = node.up(1);
    const below = node.down(1);

    const feetOk = this.isWalkable(feet) || this.isCarpetLike(feet) || this.isTopTrapdoor(feet);
    const headOk = this.isWalkable(head) || this.isCarpetLike(head);
    const floorOk =
      this.isSolid(below)    ||
      this.isSlab(below)      ||
      this.isCarpetLike(below)||
      this.isTopTrapdoor(below);

    return feetOk && headOk && floorOk;
  }

  isBreakable(node) {
    const block = this.getBlock(node);
    if (!block) return false;
    const unbreakable = [
      "air", "bedrock", "barrier", "command_block", "chain_command_block",
      "repeating_command_block", "structure_block", "structure_void",
      "obsidian", "crying_obsidian", "end_portal_frame", "end_portal",
      "nether_portal", "chest",
    ];
    if (unbreakable.includes(block.name)) return false;
    if (block.name.includes("lava") || block.name.includes("water")) return false;
    return block.diggable !== false;
  }

  isScaffolding(node) {
    return this.getBlock(node)?.name === "scaffolding";
  }

  isFence(node) {
    const block = this.getBlock(node);
    if (!block) return false;
    return block.name.includes("fence") || block.name.includes("wall") || block.name.includes("glass_pane");
  }

  isSlab(node) {
    const block = this.getBlock(node);
    return !!block && block.name.includes("slab");
  }

  isHalfSlab(node) {
    const block = this.getBlock(node);
    if (!block || !block.name.includes("slab")) return false;
    return block.getProperties?.().type === "bottom";
  }

  getNodeDigTime(node) {
    const block = this.bot.blockAt(node);
    if (!block) return 1;
    const tool = bestHarvestTool(this.bot, block);
    const effects = this.bot.entity.effects;
    const enchants = tool?.nbt ? nbt.simplify(tool.nbt).Enchantments : [];
    return block.digTime(tool?.type ?? null, false, false, false, enchants, effects) / 1000;
  }

  isFullBlock(node) {
    const block = this.getBlock(node);
    if (!block) return false;
    if (block.name.includes("farmland")) return true;
    if (block.name.includes("door"))     return false;
    if (block.name.includes("stair"))    return true;
    if (!block.shapes || block.shapes[0]?.length === 0) return false;
    return block.shapes[0]?.[4] === 1;
  }

  // ── Liquid helpers ─────────────────────────────────────────────────────────

  isWater(node) {
    const name = this.getBlock(node)?.name;
    return name === "water" || name === "flowing_water";
  }

  isLava(node)  { return this.getBlock(node)?.name === "lava"; }
  isLeaf(node)  { return !!this.getBlock(node)?.name.includes("leaves"); }

  isClimbable(node) {
    return this.config.climbableBlocks.includes(this.getBlock(node)?.name);
  }

  isInteractable(node) {
    return this.config.interactableBlocks.includes(this.getBlock(node)?.name);
  }

  // ── Movement helpers ───────────────────────────────────────────────────────

  makeMovement(position, cost) {
    const pos = new Vec3WithAttr(position.x, position.y, position.z, position.attributes);
    pos.cost = cost;
    return pos;
  }

  forward(amount = 1, node = null, attributes) { return (node ?? this.origin).forward(amount, attributes); }
  right  (amount = 1, node = null, attributes) { return (node ?? this.origin).right  (amount, attributes); }
  left   (amount = 1, node = null, attributes) { return (node ?? this.origin).left   (amount, attributes); }
  up     (amount = 1, node = null, attributes) { return (node ?? this.origin).up     (amount, attributes); }
  down   (amount = 1, node = null, attributes) { return (node ?? this.origin).down   (amount, attributes); }
  offset (dx, dy, dz, node = null)             { return (node ?? this.origin).offset (dx, dy, dz); }

  // ── Introspection (for testing) ────────────────────────────────────────────

  getCostConstants() {
    return Object.fromEntries(Object.entries(this).filter(([k]) => k.startsWith("COST_")));
  }

  getConfigRequirements() {
    const src = this.generate.toString();
    const r = {};
    if (src.includes("breakBlocks")) r.breakBlocks = true;
    if (src.includes("placeBlocks")) r.placeBlocks = true;
    if (src.includes("parkour"))     r.parkour      = true;
    if (src.includes("swimming"))    r.swimming     = true;
    if (src.includes("fly"))         r.fly          = true;
    return r;
  }

  canRunWithConfig(config) {
    return Object.entries(this.getConfigRequirements()).every(([k, v]) => !v || config[k]);
  }
}

// ─────────────────────────────────────────────
// SECTION 2 — Basic moves  (was basic.js)
// ─────────────────────────────────────────────

class MoveForward extends Move {
  generate(cardinalDirections, origin, neighbors, end) {
    for (const dir of cardinalDirections) {
      const originVec = new DirectionalVec3(origin.x, origin.y, origin.z, dir);
      this.addNeighbors(neighbors, originVec.forward(1), originVec, end);
    }
  }

  addNeighbors(neighbors, node, originVec, end) {
    const below = node.down(1);
    const head  = node.up(1);
    const canPlace = this.config.placeBlocks && this.hasScaffoldingBlocks();
    const canBreak = this.config.breakBlocks;

    const isSolidBelow = this.isSolid(below) && !this.isClimbable(below);
    const interactable = this.isInteractable(node) && !this.isTrapdoor(node);

    // Slab / top-trapdoor fast path
    if (
      (this.isSlab(below) && this.isHalfSlab(below)) ||
      (this.isSlab(node)  && this.isHalfSlab(node))  ||
      this.isTopTrapdoor(below)
    ) {
      node.attributes = { name: this.name, break: [], place: [], crouch: false, cost: this.COST_NORMAL, interact: false };
      neighbors.push(this.makeMovement(node, this.COST_NORMAL));
      return;
    }

    // Interactable door / button fast path
    if (isSolidBelow && interactable) {
      node.attributes = { name: this.name, break: [], place: [], crouch: false, cost: this.COST_NORMAL, interact: true };
      neighbors.push(this.makeMovement(node, this.COST_NORMAL));
      return;
    }

    // Normal flat walkable
    if (isSolidBelow && this.isAir(node) && this.isAir(head) && !interactable) {
      node.attributes = { name: this.name, break: [], place: [], cost: this.COST_NORMAL, interact: false };
      neighbors.push(this.makeMovement(node, this.COST_NORMAL));
      return;
    }

    // Scaffolding placement
    const canScaffold =
      !isSolidBelow && this.isAir(node) && canPlace &&
      this.canPlaceBlock(below) && !this.manager.isAreaMarkedNode(below) &&
      this.canAffordPlacement(1);

    if (!canScaffold && !interactable) return;

    node.attributes = { name: this.name, break: [], place: [] };
    if (canScaffold) node.attributes.place.push(below.clone());
    if (!isSolidBelow && node.attributes.place.length === 0) return;
    if (this.isFence(node)) return;

    if (!this.isAir(node) && !interactable) {
      if (canBreak && this.isBreakable(node)) node.attributes.break.push(node.clone());
    }
    if (!this.isAir(head) && !this.getBlock(head).name.includes("torch") && !interactable) {
      if (!canBreak || !this.isBreakable(head)) return;
      node.attributes.break.push(head.clone());
    }

    if (!canBreak && !this.isStandable(node)) return;

    const breakCost = node.attributes.break.length > 0 ? this.COST_BREAK : 0;
    const placeCost = node.attributes.place.length > 0 ? this.COST_PLACE : 0;
    const totalCost = this.COST_NORMAL + breakCost + placeCost;
    node.attributes.cost    = totalCost;
    node.attributes.interact = interactable;
    neighbors.push(this.makeMovement(node, totalCost));
  }
}

class MoveDiagonal extends Move {
  generate(cardinalDirections, origin, neighbors) {
    const diagonals = [{ x:1,z:1 },{ x:-1,z:1 },{ x:1,z:-1 },{ x:-1,z:-1 }];
    for (const offset of diagonals) {
      const originVec = new DirectionalVec3(origin.x, origin.y, origin.z, offset);
      const node = originVec.offset(offset.x, 0, offset.z);
      this.addNeighbors(neighbors, node, originVec.offset(offset.x, 0, 0), originVec.offset(0, 0, offset.z));
    }
  }

  addNeighbors(neighbors, node, adj1, adj2) {
    if ((!this.isWalkable(adj1) && !this.isStandable(adj1)) &&
        (!this.isWalkable(adj2) && !this.isStandable(adj2))) return;

    if (this.isWalkable(node) && this.isStandable(node) && this.isWalkable(node.up(1))) {
      node.attributes["name"] = this.name;
      node.attributes["cost"] = this.COST_DIAGONAL;
      neighbors.push(this.makeMovement(node, this.COST_DIAGONAL));
    }
  }
}

class MoveForwardUp extends Move {
  generate(cardinalDirections, origin, neighbors) {
    if (this.config.fly) return;
    for (const dir of cardinalDirections) {
      const originVec = new DirectionalVec3(origin.x, origin.y, origin.z, dir);
      if (this.isWater(originVec) || this.isClimbable(originVec)) return;
      this.addNeighbors(neighbors, originVec.forward(1).up(1), originVec);
    }
  }

  addNeighbors(neighbors, node, originVec) {
    const below = node.down(1);
    const head  = node.up(1);
    const above = originVec.up(2);
    const canPlace = this.config.placeBlocks && this.hasScaffoldingBlocks();
    const canBreak = this.config.breakBlocks;

    node.attributes = { name: this.name, break: [], place: [], nJump: true };

    if (this.isStandable(node) && this.isAir(above)) {
      node.attributes.cost = this.COST_UP;
      neighbors.push(this.makeMovement(node, this.COST_UP));
      return;
    }

    if (!this.isSolid(below) && canPlace && this.canPlaceBlock(below) && this.canAffordPlacement(1))
      node.attributes.place.push(below.clone());

    if (canBreak) {
      for (const n of [node, head, above])
        if (this.isSolid(n) && this.isBreakable(n)) node.attributes.break.push(n.clone());
    }

    if (canBreak  && node.attributes.break.length === 0) return;
    if (canPlace  && node.attributes.place.length === 0) return;
    if (!canBreak && !this.isStandable(node)) return;
    if (canBreak  && node.attributes.break.length > 0) {
      if (!this.isSolid(below) && !node.attributes.place.some((p) => p.equals(below))) return;
    }
    if (!canBreak && !this.isAir(above)) return;

    const cost = this.COST_NORMAL +
      (node.attributes.break.length > 0 ? this.COST_BREAK : 0) +
      (node.attributes.place.length > 0 ? this.COST_PLACE : 0);
    node.attributes.cost = cost;
    neighbors.push(this.makeMovement(node, cost));
  }

  canPlaceBlock(pos) {
    return [[0,-1,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]]
      .some(([dx,dy,dz]) => this.isSolid(pos.offset(dx,dy,dz)));
  }
}

class MoveForwardDown extends Move {
  generate(cardinalDirections, origin, neighbors) {
    if (this.config.fly) return;
    for (const dir of cardinalDirections) {
      const originVec = new DirectionalVec3(origin.x, origin.y, origin.z, dir);
      if (this.isFence(originVec.down(1))) continue;
      this.addNeighbors(neighbors, originVec.offset(dir.x, 0, dir.z), originVec);
    }
  }

  addNeighbors(neighbors, forward, originVec) {
    if (!this.isWalkable(forward)) return;
    const maxFall = this.config.maxFallDist ?? 3;
    let fallDistance = 0;
    let below = forward.down(1);

    while (fallDistance < maxFall && this.isAir(below)) { fallDistance++; below = below.down(1); }

    if (fallDistance < 1 && !this.isHalfSlab(below)) return;
    if (!this.isSolid(below) && !this.isHalfSlab(below)) return;
    if (this.getBlock(below).name.includes("farmland")) return;
    if (!this.isWalkable(below.up(1))) return;

    const targetNode = !this.isHalfSlab(below) ? below.up(1) : below.up(0.5);
    targetNode.attributes = targetNode.attributes || {};
    targetNode.attributes.name         = this.name;
    targetNode.attributes.fallDistance = fallDistance;
    targetNode.attributes.originVec    = originVec;
    const cost = this.COST_FALL + (fallDistance > 1 ? fallDistance : 0);
    targetNode.attributes.cost = cost;
    neighbors.push(this.makeMovement(targetNode, cost));
  }
}

class MoveDiagonalUp extends Move {
  generate(cardinalDirections, origin, neighbors) {
    const diagonals = [{ x:1,z:1 },{ x:-1,z:1 },{ x:1,z:-1 },{ x:-1,z:-1 }];
    for (const offset of diagonals) {
      const originVec = new DirectionalVec3(origin.x, origin.y, origin.z, offset);
      if (this.isClimbable(originVec) || !this.isWalkable(originVec.up(1))) continue;
      this.addNeighbors(
        neighbors,
        originVec.offset(offset.x, 1, offset.z),
        originVec.offset(offset.x, 1, 0),
        originVec.offset(0, 1, offset.z)
      );
    }
  }

  addNeighbors(neighbors, node, adj1, adj2) {
    if ((!this.isWalkable(adj1) && !this.isStandable(adj1)) &&
        (!this.isWalkable(adj2) && !this.isStandable(adj2))) return;
    if (!this.isWalkable(node) || !this.isStandable(node) || !this.isAir(node.up(1))) return;

    node.attributes["name"]  = this.name;
    node.attributes["cost"]  = this.COST_DIAGONAL + this.COST_UP;
    node.attributes["nJump"] = true;
    neighbors.push(this.makeMovement(node, this.COST_DIAGONAL + this.COST_UP));
  }
}

class MoveDiagonalDown extends Move {
  generate(cardinalDirections, origin, neighbors) {
    const diagonals = [{ x:1,z:1 },{ x:-1,z:1 },{ x:1,z:-1 },{ x:-1,z:-1 }];
    for (const offset of diagonals) {
      const originVec = new DirectionalVec3(origin.x, origin.y, origin.z, offset);
      this.addNeighbors(
        neighbors,
        originVec.offset(offset.x, -1, offset.z),
        originVec.offset(offset.x, -1, 0),
        originVec.offset(0, -1, offset.z)
      );
    }
  }

  addNeighbors(neighbors, node, adj1, adj2) {
    if ((!this.isWalkable(adj1) && !this.isStandable(adj1)) &&
        (!this.isWalkable(adj2) && !this.isStandable(adj2))) return;
    if (!this.isWalkable(node) || !this.isStandable(node) || !this.isWalkable(node.up(1))) return;

    node.attributes["name"] = this.name;
    node.attributes["cost"] = this.COST_DIAGONAL + this.COST_FALL;
    neighbors.push(this.makeMovement(node, this.COST_DIAGONAL + this.COST_FALL));
  }
}

// ─────────────────────────────────────────────
// SECTION 3 — Parkour  (was basic-parkour.js)
// ─────────────────────────────────────────────

class MoveForwardParkour extends Move {
  generate(cardinalDirections, origin, neighbors) {
    if (!this.config.parkour || this.config.fly) return;
    for (const dir of cardinalDirections) {
      const originVec = new DirectionalVec3(origin.x, origin.y, origin.z, dir);
      if (this.isWater(originVec)) return;
      this.addNeighbors(neighbors, originVec);
    }
  }

  addNeighbors(neighbors, originVec) {
    if (!this.isStandable(originVec)) return;
    const start = originVec.forward(1);

    for (let distance = 1; distance <= 3; distance++) {
      const landingNode = start.forward(distance);

      if (landingNode.y !== originVec.y || landingNode.down(1).y !== originVec.y - 1) continue;

      if (!this.isStandable(landingNode)) {
        const down = landingNode.down(1);
        const canScaffold =
          this.config.placeBlocks && this.hasScaffoldingBlocks() &&
          this.isAir(down) && this.isAir(down.down(1)) &&
          this.canPlaceBlock(down) && !this.manager.isAreaMarkedNode(down) &&
          this.canAffordPlacement(1) && distance > 2;
        if (!canScaffold) continue;
      }

      const bodyClear = [], feetGap = [];
      let last = originVec;
      for (let i = 1; i <= distance; i++) {
        const forward = last.forward(1);
        if (forward.y !== originVec.y) break;
        bodyClear.push(forward.up(1));
        feetGap.push(forward.down(1));
        last = forward;
      }

      if (!feetGap.every((n) => this.isAir(n) || this.isWater(n))) continue;
      if (!bodyClear.every((n) => this.isWalkable(n))) continue;

      const parkourNode = landingNode.clone();
      parkourNode.attributes = {
        name: this.name,
        cost: this.COST_PARKOUR + distance,
        nJump: distance === 1,
        sJump: distance >= 2,
        dist: distance,
        parkour: true,
        originVec,
      };
      if (this.isAir(landingNode.down(1))) {
        parkourNode.attributes.place = [landingNode.clone().down(1)];
        // NOTE: cost doubling was a bug in original (missing assignment) — left as-is
      }
      neighbors.push(this.makeMovement(parkourNode, parkourNode.attributes.cost));
      break;
    }
  }
}

class MoveForwardParkourUp extends Move {
  generate(cardinalDirections, origin, neighbors) {
    if (!this.config.parkour || this.config.fly) return;
    for (const dir of cardinalDirections) {
      const originVec = new DirectionalVec3(origin.x, origin.y, origin.z, dir);
      if (!this.isWalkable(originVec) || this.isWater(originVec)) continue;
      this.addNeighbors(neighbors, originVec);
    }
  }

  addNeighbors(neighbors, originVec) {
    if (!this.isStandable(originVec)) return;
    const start = originVec.forward(1);

    for (let distance = 1; distance <= 2; distance++) {
      const landingNode = start.forward(distance).up(1);
      if (!this.isStandable(landingNode)) continue;

      const bodyClear = [], feetGap = [];
      let last = originVec;
      for (let i = 1; i <= distance; i++) {
        const forward = last.forward(1);
        bodyClear.push(forward.up(1));
        feetGap.push(forward.down(1));
        last = forward;
      }

      if (!feetGap.every((n) => this.isAir(n) || this.isWater(n))) continue;
      if (!bodyClear.every((n) => this.isWalkable(n))) continue;

      const parkourNode = landingNode.clone();
      parkourNode.attributes = {
        name: this.name,
        cost: this.COST_PARKOUR + distance,
        nJump: distance === 1,
        sJump: distance >= 2,
        dist: distance,
        up: true,
        parkour: true,
        originVec,
      };
      neighbors.push(this.makeMovement(parkourNode, parkourNode.attributes.cost));
      break;
    }
  }
}

class MoveForwardParkourDown extends Move {
  generate(cardinalDirections, origin, neighbors) {
    if (!this.config.parkour || this.config.fly) return;
    for (const dir of cardinalDirections) {
      const originVec = new DirectionalVec3(origin.x, origin.y, origin.z, dir);
      if (this.isWater(originVec)) continue;
      this.addNeighbors(neighbors, originVec);
    }
  }

  addNeighbors(neighbors, originVec) {
    if (!this.isStandable(originVec)) return;
    const start = originVec.forward(1);

    for (let distance = 1; distance <= 2; distance++) {
      const landingNode = start.forward(distance).down(1);
      if (!this.isStandable(landingNode)) continue;

      const bodyClear = [], feetGap = [];
      let last = originVec;
      for (let i = 1; i <= distance; i++) {
        const forward = last.forward(1);
        if (forward.y !== originVec.y) break;
        bodyClear.push(forward.up(1));
        feetGap.push(forward.down(2));
        last = forward;
      }

      if (!feetGap.every((n) => this.isWalkable(n) || this.isWater(n))) continue;
      if (!bodyClear.every((n) => this.isWalkable(n))) continue;

      const parkourNode = landingNode.clone();
      parkourNode.attributes = {
        name: this.name,
        cost: this.COST_PARKOUR + distance,
        nJump: distance <= 2,
        sJump: distance >= 3,
        dist: distance,
        down: true,
        parkour: true,
        originVec,
      };
      neighbors.push(this.makeMovement(parkourNode, parkourNode.attributes.cost));
      break;
    }
  }
}

// ─────────────────────────────────────────────
// SECTION 4 — Block breaking  (was break.js)
// ─────────────────────────────────────────────

class MoveForwardDownBreak extends Move {
  generate(cardinalDirections, origin, neighbors) {
    if (!this.config.breakBlocks) return;
    for (const dir of cardinalDirections) {
      const originVec = new DirectionalVec3(origin.x, origin.y, origin.z, dir);
      this.addNeighbors(neighbors, originVec.offset(dir.x, -1, dir.z), originVec);
    }
  }

  addNeighbors(neighbors, node, originVec) {
    if (Math.floor(node.y) !== Math.floor(originVec.y) - 1) return;
    if (this.isStandable(node) || !this.isSolid(node.down(1))) return;

    node.attributes = { name: this.name, break: [] };
    for (const n of [node, node.up(1), node.up(2)]) {
      if (!this.isAir(n)) {
        if (!this.isBreakable(n)) return;
        node.attributes.break.push(n.clone());
      }
    }
    if (node.attributes.break.length === 0) return;

    const cost = this.COST_BREAK * 2.5 * node.attributes.break.length;
    node.attributes.cost         = cost;
    node.attributes.fallDistance = 1;
    neighbors.push(this.makeMovement(node, cost));
  }
}

class MoveBreakDown extends Move {
  generate(cardinalDirections, origin, neighbors) {
    if (!this.config.breakBlocks) return;
    this.origin = new DirectionalVec3(origin.x, origin.y, origin.z, { x: 0, z: 0 });
    this.addNeighbors(neighbors, this.origin.offset(0, -1, 0));
  }

  addNeighbors(neighbors, node) {
    if (!this.isSolid(this.origin.down(1)) || !this.isWalkable(this.origin)) return;
    if (!this.isBreakable(node)) return;

    let landing = node.down(1);
    if (!this.isSolid(landing)) {
      const maxFall = (this.config.maxFallDist ?? 3) - 1;
      let fallDistance = 0;
      let below = landing;
      while (fallDistance < maxFall && this.isAir(below)) { fallDistance++; below = below.down(1); }
      if (!this.isSolid(below)) return;
      landing = below;
    }

    const moveNode = landing.up(1);
    moveNode.attributes = { name: this.name, break: [node.clone()], cost: this.COST_BREAK };
    neighbors.push(this.makeMovement(moveNode, this.COST_BREAK));
  }
}

// ─────────────────────────────────────────────
// SECTION 5 — Ladders / climbing  (was climb.js)
// ─────────────────────────────────────────────

class MoveLadderEnter extends Move {
  generate(cardinalDirections, origin, neighbors) {
    if (this.config.fly) return;
    for (const dir of cardinalDirections) {
      const originVec = new DirectionalVec3(origin.x, origin.y, origin.z, dir);
      this.addNeighbors(neighbors, originVec.offset(dir.x, 0, dir.z));
    }
  }

  addNeighbors(neighbors, node) {
    if (
      this.isSolid(node.down(1)) &&
      this.isClimbable(node) &&
      (this.isAir(node.up(1)) || this.isClimbable(node.up(1)))
    ) {
      node.attributes["name"]   = this.name;
      node.attributes["ladder"] = true;
      node.attributes["enter"]  = true;
      node.attributes["cost"]   = this.COST_LADDER ?? this.COST_NORMAL + 1;
      neighbors.push(this.makeMovement(node, node.attributes["cost"]));
    }
  }
}

class MoveLadderExit extends Move {
  generate(cardinalDirections, origin, neighbors) {
    if (this.config.fly) return;
    for (const dir of cardinalDirections) {
      const originVec = new DirectionalVec3(origin.x, origin.y, origin.z, dir);
      if (!this.isClimbable(originVec)) continue;
      const node = originVec.offset(dir.x, 1, dir.z);
      if (this.isStandable(node)) {
        node.attributes["name"] = this.name + "_up";
        node.attributes["cost"] = (this.COST_LADDER_EXIT ?? this.COST_NORMAL + 1) + 0.5;
        neighbors.push(this.makeMovement(node, node.attributes["cost"]));
        break;
      }
    }
    for (const dir of cardinalDirections) {
      const originVec = new DirectionalVec3(origin.x, origin.y, origin.z, dir);
      this.addNeighbors(neighbors, originVec.offset(dir.x, 0, dir.z));
    }
  }

  addNeighbors(neighbors, node) {
    if (
      this.isClimbable(node) && this.isStandable(node) &&
      this.isSolid(node.down(1)) && this.isAir(node.up(1))
    ) {
      node.attributes["name"]   = this.name;
      node.attributes["ladder"] = false;
      node.attributes["cost"]   = this.COST_LADDER_EXIT ?? this.COST_NORMAL;
      neighbors.push(this.makeMovement(node, node.attributes["cost"]));
    }
  }
}

class MoveLadderClimb extends Move {
  generate(cardinalDirections, origin, neighbors) {
    if (this.config.fly) return;
    const node = new DirectionalVec3(origin.x, origin.y, origin.z, { x: 0, z: 0 });
    if (!this.isClimbable(node)) return;
    const up = node.up(1);
    if (!this.isClimbable(up)) return;
    up.attributes = up.attributes || {};
    up.attributes.name   = this.name;
    up.attributes.ladder = true;
    up.attributes.cost   = this.COST_LADDER ?? this.COST_NORMAL + 1;
    neighbors.push(this.makeMovement(up, up.attributes.cost));
  }
}

class MoveLadderDescend extends Move {
  generate(cardinalDirections, origin, neighbors) {
    if (this.config.fly) return;
    const originVec = new DirectionalVec3(origin.x, origin.y, origin.z, { x: 0, z: 0 });
    const node = originVec.down(1);
    if (!this.isClimbable(node)) return;

    let climbPos  = node.clone();
    let lastValid = climbPos.clone();

    while (true) {
      if (!this.isClimbable(climbPos)) break;
      const belowPos = climbPos.down(1);
      if (!this.isAir(belowPos) && !this.isClimbable(belowPos)) break;
      lastValid = climbPos.clone();
      climbPos  = climbPos.down(1);
    }

    lastValid.attributes = lastValid.attributes || {};
    lastValid.attributes["name"]    = this.name;
    lastValid.attributes["ladder"]  = true;
    lastValid.attributes["descend"] = true;
    lastValid.attributes["cost"]    = this.COST_LADDER;
    neighbors.push(this.makeMovement(lastValid, this.COST_LADDER ?? this.COST_NORMAL + 1));
  }
}

class MoveLadderEnterDescend extends Move {
  generate(cardinalDirections, origin, neighbors) {
    if (this.config.fly) return;
    for (const dir of cardinalDirections) {
      const originVec = new DirectionalVec3(origin.x, origin.y, origin.z, dir);
      this.addNeighbors(neighbors, originVec.offset(dir.x, 0, dir.z));
    }
  }

  addNeighbors(neighbors, node) {
    if (!this.isWalkable(node) || !this.isClimbable(node.down(1))) return;
    const target = node.clone();
    target.attributes["name"]        = this.name;
    target.attributes["ladder"]      = true;
    target.attributes["descend"]     = true;
    target.attributes["enterTarget"] = node.clone();
    target.attributes["cost"]        = this.COST_LADDER ?? this.COST_NORMAL + 1;
    neighbors.push(this.makeMovement(target, target.attributes["cost"]));
  }
}

// ─────────────────────────────────────────────
// SECTION 6 — Block placement ascent  (was place.js)
// ─────────────────────────────────────────────

class MovePlaceUp extends Move {
  generate(cardinalDirections, origin, neighborArray) {
    if (!this.config.placeBlocks && !this.config.breakBlocks) return;
    const originVec = new DirectionalVec3(origin.x, origin.y, origin.z, { x: 0, z: 0 });
    this.addNeighbors(neighborArray, originVec, originVec.up(1));
  }

  addNeighbors(neighbors, originVec, node) {
    if (!this.isSolid(originVec.down(1))) return;

    const breakChain = [];
    if (!this.isAir(node) && this.config.breakBlocks) {
      if (this.isBreakable(node)) breakChain.push(node.clone());
      const above = node.up(1);
      if (this.isBreakable(node) && this.isBreakable(above)) breakChain.push(above.clone());
      if (breakChain.length === 0) return;
    }

    if (!(this.config.placeBlocks && this.hasScaffoldingBlocks() && this.canAffordPlacement(1))) return;
    if (!this.canPlaceBlock(originVec) || !this.isWalkable(originVec) || !this.isWalkable(node)) return;

    const moveNode = node.clone();
    moveNode.attributes = {
      name: this.name,
      break: breakChain.length > 0 ? breakChain : undefined,
      place: [originVec.clone()],
      cost:  (breakChain.length * this.COST_BREAK + this.COST_PLACE + this.COST_UP) * 0.8,
      ascend: true,
      originVec,
    };
    neighbors.push(this.makeMovement(moveNode, moveNode.attributes.cost));
  }

  canPlaceBlock(pos) {
    return [[0,-1,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]]
      .some(([dx,dy,dz]) => this.isSolid(pos.offset(dx,dy,dz)));
  }
}

// ─────────────────────────────────────────────
// SECTION 7 — Swimming  (was swin.js)
// ─────────────────────────────────────────────

class MoveSwimForward extends Move {
  generate(cardinalDirections, origin, neighbors) {
    if (!this.config.swimming || this.config.fly) return;
    for (const dir of cardinalDirections) {
      const originVec = new DirectionalVec3(origin.x, origin.y, origin.z, dir);
      this.addNeighbors(neighbors, originVec.offset(dir.x, 0, dir.z), originVec);
    }
  }

  addNeighbors(neighbors, node, originVec) {
    if (!this.isWater(originVec)) return;
    const below = node.down(1);
    const head  = node.up(1);
    const nodeIsSwimmable = this.isWater(node) || (this.isAir(node) && this.isWater(below));
    if (!nodeIsSwimmable || (!this.isAir(head) && !this.isWater(head))) return;

    node.attributes = { name: this.name, swim: true, cost: this.COST_SWIM ?? this.COST_NORMAL + 1.2 };
    neighbors.push(this.makeMovement(node, node.attributes.cost));
  }
}

class MoveSwimStart extends Move {
  generate(cardinalDirections, origin, neighbors) {
    if (!this.config.swimming || this.config.fly) return;
    for (const dir of cardinalDirections) {
      const originVec = new DirectionalVec3(origin.x, origin.y, origin.z, dir);
      this.addNeighbors(neighbors, originVec.offset(dir.x, 0, dir.z), originVec);
    }
  }

  addNeighbors(neighbors, node, originVec) {
    if (!this.isSolid(originVec.down(1)) || this.isWater(originVec)) return;
    const head      = node.up(1);
    const nodeBelow = node.down(1);

    // Shallow water
    if (this.isAir(node) && this.isWater(nodeBelow) && this.isAir(head)) {
      nodeBelow.attributes = { name: this.name + "_step", swim: true, cost: this.COST_SWIM_START ?? this.COST_NORMAL + 1.5, enterTarget: node };
      neighbors.push(this.makeMovement(nodeBelow, nodeBelow.attributes.cost));
      return;
    }

    // Deep water
    if (this.isWater(node) && this.isWater(nodeBelow)) {
      nodeBelow.attributes = { name: this.name + "_deep", swim: true, enterTarget: node, cost: this.COST_SWIM_START ?? this.COST_NORMAL + 1.5 };
      neighbors.push(this.makeMovement(nodeBelow, nodeBelow.attributes.cost));
      return;
    }

    // Dive from height
    const maxDive = Math.max(this.config.maxWaterDist ?? 10, 15);
    let diveDistance = 0, below = node.down(1);
    while (diveDistance < maxDive && this.isAir(below)) { diveDistance++; below = below.down(1); }
    if (diveDistance > 0 && this.isWater(below)) {
      const targetNode = below.clone();
      targetNode.attributes = { name: this.name + "_dive", swim: true, dive: true, fallDistance: diveDistance, cost: this.COST_SWIM_START + diveDistance * 0.3 };
      neighbors.push(this.makeMovement(targetNode, targetNode.attributes.cost));
    }
  }
}

class MoveSwimExit extends Move {
  generate(cardinalDirections, origin, neighbors) {
    if (!this.config.swimming || this.config.fly) return;
    const originVec = new DirectionalVec3(origin.x, origin.y, origin.z, { x: 0, z: 0 });
    if (!this.isWater(originVec)) return;
    for (const dir of cardinalDirections) {
      this.addNeighbors(neighbors, originVec.offset(dir.x,   0, dir.z), originVec, false);
      this.addNeighbors(neighbors, originVec.offset(dir.x,   1, dir.z), originVec, true);
    }
  }

  addNeighbors(neighbors, node, originVec, isClimbingOut) {
    if (!this.isAir(node) && !this.getBlock(node)?.name.includes("lily")) return;
    if (!this.isSolid(node.down(1))) return;
    if (!this.isAir(node.up(1)) && !this.isWater(node.up(1))) return;
    const belowBlock = this.getBlock(node.down(1));
    if (belowBlock.name.includes("farmland") || belowBlock.name.includes("soul_sand")) return;

    const cost = isClimbingOut
      ? (this.COST_SWIM_EXIT ?? this.COST_NORMAL + 2.5) + this.COST_UP
      : this.COST_SWIM_EXIT ?? this.COST_NORMAL + 2;

    node.attributes = { name: this.name, exitWater: true, climbOut: isClimbingOut, cost };
    neighbors.push(this.makeMovement(node, cost));
  }
}

class MoveSwimUp extends Move {
  generate(cardinalDirections, origin, neighbors) {
    if (!this.config.swimming || this.config.fly) return;
    const originVec = new DirectionalVec3(origin.x, origin.y, origin.z, { x: 0, z: 0 });
    if (!this.isWater(originVec)) return;
    this.addNeighbors(neighbors, originVec.up(1), originVec);
  }

  addNeighbors(neighbors, node, originVec) {
    const below = node.down(1);
    const validTarget = this.isWater(node) || (this.isAir(node) && this.isWater(below));
    if (!validTarget || this.isWalkable(node.up(1))) return;

    const cost = this.COST_SWIM ?? this.COST_NORMAL + 1.2;
    node.attributes = { name: this.name, swim: true, up: true, cost };
    neighbors.push(this.makeMovement(node, cost));
  }
}

class MoveSwimDown extends Move {
  generate(cardinalDirections, origin, neighbors) {
    if (!this.config.swimming || this.config.fly) return;
    const originVec = new DirectionalVec3(origin.x, origin.y, origin.z, { x: 0, z: 0 });
    if (!this.isWater(originVec)) return;
    for (let depth = 1; depth <= 3; depth++)
      this.addNeighbors(neighbors, originVec.down(depth), originVec, depth);
  }

  addNeighbors(neighbors, node, originVec, depth) {
    if (!this.isWater(node)) return;
    const below = node.down(1);
    if (!this.isWater(below) && !this.isSolid(below)) return;

    const cost = (this.COST_SWIM ?? this.COST_NORMAL + 1.2) * depth * 0.8;
    node.attributes = { name: this.name, swim: true, down: true, depth, cost };
    neighbors.push(this.makeMovement(node, cost));
  }
}

class MoveSwimDiagonal extends Move {
  generate(cardinalDirections, origin, neighbors) {
    if (!this.config.swimming || this.config.fly) return;
    for (const dir of [{ x:1,z:1 },{ x:-1,z:1 },{ x:1,z:-1 },{ x:-1,z:-1 }]) {
      const originVec = new DirectionalVec3(origin.x, origin.y, origin.z, dir);
      if (!this.isWater(originVec)) continue;
      this.addNeighbors(neighbors, originVec.offset(dir.x, 0, dir.z), originVec);
    }
  }

  addNeighbors(neighbors, node, originVec) {
    const below = node.down(1);
    const head  = node.up(1);
    const nodeIsSwimmable = this.isWater(node) || (this.isAir(node) && this.isWater(below));
    if (!nodeIsSwimmable || (!this.isAir(head) && !this.isWater(head))) return;

    node.attributes = { name: this.name, swim: true, cost: this.COST_DIAGONAL * (this.COST_SWIM ?? 1.2) };
    neighbors.push(this.makeMovement(node, node.attributes.cost));
  }
}

// ─────────────────────────────────────────────
// SECTION 8 — Registry + pathfinding engine
// ─────────────────────────────────────────────

function bestHarvestTool(bot, block) {
  const effects = bot.entity.effects;
  let fastest = Number.MAX_VALUE, bestTool = null;
  for (const tool of bot.inventory.items()) {
    const enchants = tool?.nbt ? nbt.simplify(tool.nbt).Enchantments : [];
    const digTime  = block.digTime(tool?.type ?? null, false, false, false, enchants, effects);
    if (digTime < fastest) { fastest = digTime; bestTool = tool; }
  }
  return bestTool;
}

function registerMoves(moves) {
  moveClasses.push(...moves);
  for (const move of moves) moveRegistry.set(move.name, { instance: move, metadata: move.metadata });
}

function getAllMoves()           { return [...moveClasses]; }
function getMovesByCategory(c)  { return [...moveRegistry.values()].filter((e) => e.metadata.category === c).map((e) => e.instance); }
function getMovesByTag(tag)     { return [...moveRegistry.values()].filter((e) => e.metadata.tags.includes(tag)).map((e) => e.instance); }
function getMoveMetadata(name)  { return moveRegistry.get(name)?.metadata ?? null; }
function getAllMoveNames()       { return [...moveRegistry.keys()]; }
function getCompatibleMoves(c)  { return [...moveClasses].filter((m) => m.canRunWithConfig(c)); }
function clamp(v, min, max)     { return Math.min(Math.max(v, min), max); }

function getNeighbors2(node, config, manager, bot, end) {
  const neighborMap   = new Map();
  const sortedMoves   = [...moveClasses].sort((a, b) => a.priority - b.priority);

  for (const move of sortedMoves) {
    move.setValues(bot, config, manager, node);
    move.virtualBlocks = new Map(node.virtualBlocks || []);

    const generatedNeighbors = [];
    move.generate(cardinalDirections, node.worldPos, generatedNeighbors, end);

    for (const neighbor of generatedNeighbors) {
      const hasBreaks = neighbor.attributes?.break?.length > 0;
      const hasPlaces = neighbor.attributes?.place?.length > 0;

      neighbor.virtualBlocks = new Map(node.virtualBlocks || []);
      if (hasBreaks) for (const b of neighbor.attributes.break) neighbor.virtualBlocks.set(b.toStringNoDir(), "air");
      if (hasPlaces) for (const p of neighbor.attributes.place) neighbor.virtualBlocks.set(p.toStringNoDir(), "placed");

      const key = `${neighbor.x},${neighbor.y},${neighbor.z}`;
      if (!neighborMap.has(key)) neighborMap.set(key, neighbor);
    }
  }

  return Array.from(neighborMap.values());
}

// ─────────────────────────────────────────────
// Register all active moves
// ─────────────────────────────────────────────

registerMoves([
  // Basic locomotion
  new MoveForward(10,     { category: "basic",   tags: ["ground", "horizontal", "breaking", "placing"],   description: "Forward movement with optional break/place", testConfig: { breakBlocks: true, placeBlocks: true } }),
  new MoveDiagonal(10,    { category: "basic",   tags: ["ground", "diagonal"],                            description: "Diagonal movement on flat ground" }),
  new MoveForwardUp(10,   { category: "basic",   tags: ["vertical", "up", "jumping", "breaking", "placing"], description: "Step-up jump with optional break/place", testConfig: { breakBlocks: true, placeBlocks: true } }),
  new MoveForwardDown(10, { category: "basic",   tags: ["vertical", "down", "falling"],                   description: "Fall to lower level" }),
  new MoveDiagonalUp(10,  { category: "basic",   tags: ["diagonal", "vertical", "up"],                    description: "Diagonal upward movement" }),
  new MoveDiagonalDown(10),

  // Parkour
  new MoveForwardParkour(15,     { category: "parkour", tags: ["horizontal", "jumping", "gap"],         description: "Forward parkour jump",      testConfig: { parkour: true, breakBlocks: false, placeBlocks: false } }),
  new MoveForwardParkourUp(18,   { category: "parkour", tags: ["vertical", "up", "jumping", "gap"],     description: "Parkour jump up",           testConfig: { parkour: true, breakBlocks: false, placeBlocks: false } }),
  new MoveForwardParkourDown(18, { category: "parkour", tags: ["vertical", "down", "jumping", "gap"],   description: "Parkour jump down",         testConfig: { parkour: true, breakBlocks: false, placeBlocks: false } }),

  // Breaking
  new MoveForwardDownBreak(30),
  new MoveBreakDown(30),

  // Ladders
  new MoveLadderEnter(10),
  new MoveLadderExit(10),
  new MoveLadderClimb(15),
  new MoveLadderDescend(15),
  new MoveLadderEnterDescend(10),

  // Block placement ascent
  new MovePlaceUp(20),

  // Swimming
  new MoveSwimForward(8,   { category: "water", tags: ["swimming", "horizontal"], description: "Swim forward" }),
  new MoveSwimStart(8,     { category: "water", tags: ["swimming", "entering"],   description: "Enter water from land" }),
  new MoveSwimExit(8,      { category: "water", tags: ["swimming", "exiting"],    description: "Exit water to land" }),
  new MoveSwimUp(9,        { category: "water", tags: ["swimming", "vertical"],   description: "Swim upward" }),
  new MoveSwimDown(9,      { category: "water", tags: ["swimming", "vertical"],   description: "Swim downward" }),
  new MoveSwimDiagonal(10, { category: "water", tags: ["swimming", "diagonal"],   description: "Swim diagonally" }),
]);

// ─────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────

module.exports = {
  // Pathfinding engine
  getNeighbors2,
  // Base classes
  Move,
  DirectionalVec3,
  Vec3WithAttr,
  // Registry helpers
  registerMoves,
  getAllMoves,
  getMovesByCategory,
  getMovesByTag,
  getMoveMetadata,
  getAllMoveNames,
  getCompatibleMoves,
  moveRegistry,
  moveClasses,
  // Utilities
  clamp,
};
