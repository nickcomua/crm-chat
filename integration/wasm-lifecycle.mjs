import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { runInNewContext } from 'node:vm'

const directory = process.argv[2]
assert.ok(directory, 'expected the packaged TDLib Wasm directory')
const context = {
  module: { exports: {} },
  require: createRequire(import.meta.url),
  __dirname: directory,
  console,
  process,
  setTimeout,
  clearTimeout,
  Buffer,
  WebAssembly,
  TextDecoder,
}
runInNewContext(readFileSync(join(directory, 'td_wasm.js'), 'utf8'), context)
const module = await context.createTdwebModule({
  wasmBinary: readFileSync(join(directory, 'td_wasm.wasm')),
})
const create = module.cwrap('td_emscripten_create_client_id', 'number', [])
const send = module.cwrap('td_emscripten_send', null, ['number', 'string'])
const receive = module.cwrap('td_emscripten_receive', 'string', [])
for (let iteration = 0; iteration < 3; iteration += 1) {
  const clientId = create()
  send(clientId, JSON.stringify({ '@type': 'close' }))
  let emptyBeforeClosed = false
  let closed = false
  const deadline = Date.now() + 10_000
  while (!closed && Date.now() < deadline) {
    const raw = receive()
    if (raw === '') {
      emptyBeforeClosed = true
      await delay(1)
      continue
    }
    const response = JSON.parse(raw)
    closed =
      response['@client_id'] === clientId &&
      response.authorization_state?.['@type'] === 'authorizationStateClosed'
  }
  assert.ok(closed, 'TDLib must confirm destruction before sealing')
  assert.ok(emptyBeforeClosed, 'an empty receive is not close completion')
  for (let poll = 0; poll < 5; poll += 1) {
    assert.equal(receive(), '')
  }
}
console.log('PASS packaged Wasm close lifecycle, including idle before Closed')
