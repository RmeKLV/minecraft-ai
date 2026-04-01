# Minecraft AI Bot

A Mineflayer bot that autonomously progresses through Minecraft using pathfinding, crafting, and loot logic.

## Modes
- **Speedrun** — detects nearby shipwreck, loots chests, crafts iron tools, builds nether portal
- **Survival** — standard mining route: wood → stone → iron → nether portal

## Run
```bash
node main.js
```

## Requirements
- Node.js 18+
- Minecraft 1.21.1 server running on localhost:25565 (offline mode)

## Stack
- [Mineflayer](https://github.com/PrismarineJS/mineflayer)
- [@miner-org/mineflayer-baritone](https://www.npmjs.com/package/@miner-org/mineflayer-baritone)
