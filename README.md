# Minecraft AI Bot

A Mineflayer bot that autonomously progresses through Minecraft using A* pathfinding, crafting, and loot logic.

## Current Progress

### Speedrun mode
- [x] Spawn assessment (detects ocean, shipwreck, monument)
- [x] Wood collection and wooden tool crafting
- [x] Surface travel to shipwreck
- [x] Dives to shipwreck chests with hull block-breaking
- [ ] Successfully looting chests (diving still unreliable)
- [ ] Iron tool crafting from loot
- [ ] Flint & steel, nether portal construction
- [ ] Nether navigation

### Survival mode
- [x] Spawn assessment (detects iron ore, ravines, villages nearby)
- [x] Wood collection and wooden tool crafting
- [x] Stone pickaxe crafting
- [x] Navigates to and mines iron ore veins
- [ ] Smelting iron (furnace placement unreliable)
- [ ] Iron tool crafting
- [ ] Nether portal construction
- [ ] Nether navigation

## Run

```bash
node main.js
```

Select mode 1 (Speedrun) or 2 (Survival) from the menu.

## Requirements

- Node.js 18+
- Minecraft 1.21.1 server running on `localhost:25565` in offline mode

## Stack

- [Mineflayer](https://github.com/PrismarineJS/mineflayer)
- [@miner-org/mineflayer-baritone](https://www.npmjs.com/package/@miner-org/mineflayer-baritone)

## Known Issues

- Diving into shipwreck chests is unreliable — bot sometimes gets stuck on hull geometry
- Cave water pushes bot against walls and causes stuck loops (water veins are skipped)
- Dense jungle terrain causes occasional pathfinding timeouts
- No combat logic — bot dies to mobs
- No food/hunger management
- No bed sleeping — phantoms will eventually spawn