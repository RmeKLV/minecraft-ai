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

## Roadmap

The current version targets Minecraft 1.21.1 but has proven difficult due to 
complex water physics and swimming mechanics interfering with pathfinding.

### Planned versions

**1.16.1 — Speedrun focus**
- The version used by professional Minecraft speedrunners
- Well documented speedrun route: shipwreck → iron → nether → fortress → end
- Piglin bartering for ender pearls (gold → pearls)
- Simpler ocean and cave generation
- Bastions provide reliable early gold and iron

**1.12.2 — Survival focus**
- Simplest water physics — no swimming animation fighting the pathfinder
- No phantoms, no deep dark, no complex new mechanics
- Most stable Mineflayer support for long autonomous sessions
- Focus on sustainable resource gathering and base building

Both versions will keep the same two-mode menu system and shared pathfinding core.

## Test World

The Minecraft world used for development and testing:
[Download from Google Drive](https://drive.google.com/drive/folders/16fejtlH8xgSMiPeEO0Xz6EDvUWinXAYg?usp=sharing)

To use: download the folder and place it in your Minecraft saves directory.
- Linux: `~/.minecraft/saves/`
- Windows: `%appdata%\.minecraft\saves\`

Server version: Minecraft 1.21.1 (offline mode, localhost:25565)
