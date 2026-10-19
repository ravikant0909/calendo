import { spawnSync } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const persistArg = process.argv[2] || '.wrangler/test-db'
const persistPath = path.isAbsolute(persistArg) ? persistArg : path.join(repoRoot, persistArg)
const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx'

await rm(persistPath, { recursive: true, force: true })
await mkdir(path.dirname(persistPath), { recursive: true })

const result = spawnSync(
  npxCommand,
  ['wrangler', 'd1', 'execute', 'calendo', '--local', '--persist-to', persistPath, '--file=./schema.sql'],
  {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  }
)

if (result.status !== 0) {
  process.exit(result.status ?? 1)
}
