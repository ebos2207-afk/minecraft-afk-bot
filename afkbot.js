const bedrock = require('bedrock-protocol')
const http = require('http')

// ===== SETTINGS =====
const SERVER = process.env.MC_SERVER || 'play.frostsmp.net'
const PORT = parseInt(process.env.MC_PORT || '19132')
const EMAIL = process.env.MC_EMAIL || 'ebos2207@gmail.com'
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || 'changeme'
const WEB_PORT = process.env.PORT || 3000
const LOGIN_DIR = process.env.LOGIN_DIR || './login'
const HOME_COMMAND = process.env.HOME_COMMAND || '/home 1'
const ORDER_COMMAND = process.env.ORDER_COMMAND || '/order bone'
const MIN_BONE_PRICE = parseFloat(process.env.MIN_BONE_PRICE || '80')
const RECHECK_MIN = parseFloat(process.env.RECHECK_MIN || '5')
const DRY_RUN = (process.env.DRY_RUN || 'true') !== 'false'
const SPAWNER = process.env.SPAWNER_X
  ? { x: parseInt(process.env.SPAWNER_X), y: parseInt(process.env.SPAWNER_Y), z: parseInt(process.env.SPAWNER_Z) }
  : null
// ====================

let enabled = true
let status = 'offline'
let client = null
let reconnectTimer = null
let waitTime = 15000
let lastStop = 0
let ridCounter = -1
const logs = []

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function clean(msg) {
  return String(msg).replace(/§./g, '').replace(/\s+/g, ' ').trim()
}

function log(msg) {
  const text = clean(msg)
  if (!text) return
  const line = new Date().toLocaleTimeString() + '  ' + text
  console.log(line)
  logs.push(line)
  if (logs.length > 200) logs.shift()
}

function short(obj, n) {
  try {
    return JSON.stringify(obj, (k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, n)
  } catch (e) {
    return String(obj).slice(0, n)
  }
}

async function waitFor(fn, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return true
    await sleep(250)
  }
  return false
}

async function sleepAlive(c, ms) {
  const end = Date.now() + ms
  while (!c.__dead && Date.now() < end) await sleep(1000)
}

// ---------- helpers ----------
function sendCommand(c, cmd) {
  const uuid = '00000000-0000-0000-0000-000000000000'
  for (const version of ['52', 'latest', '1', 52]) {
    try {
      c.queue('command_request', {
        command: cmd,
        origin: { type: 'player', uuid, request_id: '' },
        internal: false,
        version
      })
      log('Sent ' + cmd)
      return true
    } catch (e) {}
  }
  log('Could not send ' + cmd)
  return false
}

function itemText(item) {
  return clean(short(item, 4000))
}

function toNum(s, suf) {
  const n = parseFloat(String(s).replace(/,/g, ''))
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[String(suf || '').toUpperCase()] || 1
  return isNaN(n) ? NaN : n * mult
}

function parseOrder(item) {
  const t = itemText(item)
  if (!/Click to Deliver/i.test(t)) return null
  if (!/Item:\D{0,6}[\d.,]+\s*[KMB]?\s*x?\s*Bone\b(?!\s*(Meal|Block))/i.test(t)) return null
  const p = t.match(/Price Each:\D{0,6}([\d.,]+)\s*([KMB])?/i)
  if (!p) return { price: NaN, done: false, owner: '?' }
  const d = t.match(/Delivered:\D{0,3}([\d.,]+)\s*([KMB])?\s*\/\s*([\d.,]+)\s*([KMB])?/i)
  const done = d ? toNum(d[1], d[2]) >= toNum(d[3], d[4]) : false
  const o = t.match(/(\S+)'s Order/i)
  return { price: toNum(p[1], p[2]), done, owner: o ? o[1] : '?' }
}

function countBones(c) {
  if (!c.__boneId) return 0
  return (c.__inv || []).reduce((n, it) => n + (it && it.network_id === c.__boneId ? it.count : 0), 0)
}

// ---------- menus & clicks ----------
function nextRid() {
  const r = ridCounter
  ridCounter -= 2
  return r
}

function slotRef(containerId, slot, stackId) {
  return { slot_type: { container_id: containerId }, slot, stack_id: stackId || 0 }
}

function stackRequest(c, actions) {
  const req = { request_id: nextRid(), actions, custom_names: [], cause: -1 }
  try {
    c.queue('item_stack_request', { requests: [req] })
    return true
  } catch (e) {
    if (!c.__stackErr) {
      c.__stackErr = true
      log('Click error: ' + String(e.message).slice(0, 140))
    }
    return false
  }
}

function clickMenuSlot(c, slot, item) {
  return stackRequest(c, [{
    type_id: 'take',
    count: Math.max(1, item.count || 1),
    source: slotRef('level_entity', slot, item.stack_id),
    destination: slotRef('cursor', 0, 0)
  }])
}

function takeToInventory(c, slot, item, invSlot) {
  return stackRequest(c, [{
    type_id: 'take',
    count: item.count,
    source: slotRef('level_entity', slot, item.stack_id),
    destination: slotRef('combined_hotbar_and_inventory', invSlot, 0)
  }])
}

function rightClickBlock(c, pos) {
  try {
    c.queue('inventory_transaction', {
      transaction: {
        legacy: { legacy_request_id: 0 },
        transaction_type: 'item_use',
        actions: [],
        transaction_data: {
          action_type: 'click_block',
          trigger_type: 'player_input',
          block_position: pos,
          face: 1,
          hotbar_slot: 0,
          held_item: { network_id: 0 },
          player_pos: c.__pos || { x: pos.x + 0.5, y: pos.y + 1, z: pos.z + 0.5 },
          click_pos: { x: 0.5, y: 1, z: 0.5 },
          block_runtime_id: 0,
          client_prediction: 'success'
        }
      }
    })
    return true
  } catch (e) {
    log('Spawner click failed: ' + String(e.message).slice(0, 140))
    return false
  }
}

async function openWindow(c, doOpen, label) {
  c.__win = null
  doOpen()
  const ok = await waitFor(() => c.__win && c.__win.items.length > 0, 12000)
  if (!ok) {
    log('Menu did not open: ' + label)
    return null
  }
  await sleep(1500)
  return c.__win
}

function closeWindow(c) {
  const w = c.__win
  if (!w) return
  try { c.queue('container_close', { window_id: w.id, window_type: w.type, server: false }) } catch (e) {}
  c.__win = null
}

// ---------- the work ----------
function pickBest(win) {
  const orders = []
  win.items.forEach((item, slot) => {
    if (!item || !item.network_id) return
    const o = parseOrder(item)
    if (o) orders.push({ slot, item, ...o })
  })
  const valid = orders.filter((o) => !isNaN(o.price) && !o.done)
  const good = valid.filter((o) => o.price >= MIN_BONE_PRICE).sort((a, b) => b.price - a.price)
  const low = [...new Set(valid.filter((o) => o.price < MIN_BONE_PRICE).map((o) => o.price))].slice(0, 8)
  const unreadable = orders.filter((o) => isNaN(o.price)).length
  log('Bone orders: ' + orders.length + ' | good (>= $' + MIN_BONE_PRICE + '): ' + good.length +
    (low.length ? ' | skipped low: $' + low.join(', $') : '') +
    (unreadable ? ' | unreadable: ' + unreadable : ''))
  return good[0] || null
}

async function harvest(c) {
  if (!SPAWNER) {
    log('Set SPAWNER_X / SPAWNER_Y / SPAWNER_Z to take bones from the spawner.')
    return 0
  }
  const menu = await openWindow(c, () => rightClickBlock(c, SPAWNER), 'spawner')
  if (!menu) return 0

  const st = menu.items.findIndex((it) => it && it.network_id && /SPAWNER STORAGE/i.test(itemText(it)))
  if (st < 0) {
    log('Spawner Storage button not found.')
    closeWindow(c)
    return 0
  }

  const storage = await openWindow(c, () => clickMenuSlot(c, st, menu.items[st]), 'storage')
  if (!storage) return 0

  const stacks = []
  storage.items.forEach((it, slot) => {
    if (it && it.network_id && it.network_id === c.__boneId && it.count > 0) stacks.push({ slot, it })
  })
  const total = stacks.reduce((n, s) => n + s.it.count, 0)
  log('Storage has ' + total + ' bones in ' + stacks.length + ' stacks.')

  if (DRY_RUN) {
    closeWindow(c)
    return 0
  }

  const free = []
  for (let i = 0; i < 36; i++) {
    const it = (c.__inv || [])[i]
    if (!it || !it.network_id) free.push(i)
  }
  const room = Math.max(0, free.length - 2)
  let moved = 0
  for (let i = 0; i < Math.min(room, stacks.length); i++) {
    if (takeToInventory(c, stacks[i].slot, stacks[i].it, free[i])) moved += stacks[i].it.count
    await sleep(300)
  }
  await sleep(2000)
  closeWindow(c)
  log('Took about ' + moved + ' bones. Inventory now has ' + countBones(c) + '.')
  return moved
}

async function deliver(c) {
  const win = await openWindow(c, () => sendCommand(c, ORDER_COMMAND), 'orders')
  if (!win) return 0
  const best = pickBest(win)
  if (!best) {
    closeWindow(c)
    return 0
  }
  if (DRY_RUN) {
    log('TEST MODE: would deliver to ' + best.owner + ' at $' + best.price + ' each.')
    closeWindow(c)
    return 0
  }
  const before = countBones(c)
  if (before === 0) {
    log('No bones in inventory to deliver.')
    closeWindow(c)
    return 0
  }
  log('Delivering to ' + best.owner + ' at $' + best.price + ' each...')
  clickMenuSlot(c, best.slot, best.item)
  await sleep(4000)

  if (c.__win && c.__win !== win) {
    log('A new menu opened after the click (send me these lines):')
    c.__win.items.forEach((it, i) => {
      if (it && it.network_id && i < 54) log('  slot ' + i + ': ' + itemText(it).slice(0, 140))
    })
  }
  const after = countBones(c)
  log('Delivered ' + (before - after) + ' bones. Left: ' + after)
  closeWindow(c)
  return before - after
}

async function cycle(c) {
  log('--- Check started ---')
  sendCommand(c, HOME_COMMAND)
  await sleepAlive(c, 6000)
  if (c.__dead) return false

  // 1. Only continue if there is a good order (never sell to cheap orders)
  const w = await openWindow(c, () => sendCommand(c, ORDER_COMMAND), 'orders')
  if (!w) return false
  const best = pickBest(w)
  closeWindow(c)
  if (!best) {
    log('No order at or above $' + MIN_BONE_PRICE + '. Bones stay in storage.')
    return false
  }

  // 2. Get bones (unless the inventory already has some)
  if (countBones(c) === 0) await harvest(c)
  else log('Inventory already has ' + countBones(c) + ' bones.')

  // 3. Deliver
  const sent = await deliver(c)
  return sent > 0
}

async function runLoop(c) {
  await sleepAlive(c, 8000)
  while (!c.__dead) {
    let again = false
    try {
      again = await cycle(c)
    } catch (e) {
      log('Cycle error: ' + e.message)
    }
    await sleepAlive(c, again ? 10000 : RECHECK_MIN * 60000)
  }
}

// ---------- connection ----------
function killClient(c) {
  c.__dead = true
  try { if (typeof c.disconnect === 'function') c.disconnect() } catch (e) {}
  try { c.close() } catch (e) {}
}

function start() {
  if (!enabled || client) return
  status = 'connecting'
  log('Connecting to ' + SERVER + ':' + PORT + (DRY_RUN ? ' (TEST MODE)' : ''))

  let c
  try {
    c = bedrock.createClient({
      host: SERVER,
      port: PORT,
      username: EMAIL,
      offline: false,
      profilesFolder: LOGIN_DIR,
      onMsaCode: (data) => {
        log('SIGN IN NEEDED: open ' + data.verification_uri + ' and enter code ' + data.user_code)
      }
    })
  } catch (e) {
    log('Start error: ' + e.message)
    status = 'offline'
    if (enabled) {
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = setTimeout(() => { reconnectTimer = null; start() }, waitTime)
    }
    return
  }
  client = c
  c.__inv = []
  c.__win = null

  let ended = false
  function onEnd() {
    if (c.__dead || ended) return
    ended = true
    c.__dead = true
    if (client === c) client = null
    status = 'offline'
    try { c.close() } catch (e) {}
    if (enabled) {
      const delay = c.__alreadyIn ? 60000 : waitTime
      log('Disconnected. Reconnecting in ' + delay / 1000 + 's...')
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = setTimeout(() => { reconnectTimer = null; start() }, delay)
      if (!c.__alreadyIn) waitTime = Math.min(waitTime * 2, 300000)
    }
  }

  c.on('start_game', (p) => {
    c.__pos = p.player_position
    c.__myId = String(p.runtime_entity_id)
    const bone = (p.itemstates || []).find((i) => i.name === 'minecraft:bone')
    if (bone) c.__boneId = bone.runtime_id
    else log('Could not find the bone item id.')
  })
  c.on('move_player', (p) => {
    if (String(p.runtime_id) === c.__myId) c.__pos = p.position
  })

  c.on('container_open', (p) => {
    c.__win = { id: p.window_id, type: p.window_type, items: [] }
  })
  c.on('container_close', (p) => {
    if (c.__win && String(p.window_id) === String(c.__win.id)) c.__win = null
  })
  c.on('inventory_content', (p) => {
    if (p.window_id === 'inventory') c.__inv = p.input || []
    else if (c.__win && String(p.window_id) === String(c.__win.id)) c.__win.items = p.input || []
  })
  c.on('inventory_slot', (p) => {
    if (p.window_id === 'inventory') c.__inv[p.slot] = p.item
    else if (c.__win && String(p.window_id) === String(c.__win.id)) c.__win.items[p.slot] = p.item
  })
  c.on('item_stack_response', (p) => {
    ;(p.responses || []).forEach((r) => {
      if (r.status && r.status !== 'ok' && (c.__respLogs = (c.__respLogs || 0) + 1) <= 4) {
        log('Server refused a click: ' + r.status)
      }
    })
  })

  c.on('spawn', () => {
    if (c.__dead) return
    status = 'online'
    waitTime = 15000
    log('Joined the server!')
    runLoop(c)
  })

  c.on('kick', (r) => {
    if (c.__dead) return
    const text = JSON.stringify(r)
    if (/already logged in/i.test(text)) {
      c.__alreadyIn = true
      log('Account already logged in somewhere else.')
    } else {
      log('Kicked: ' + text)
    }
  })
  c.on('error', (e) => { if (!c.__dead) log('Error: ' + e.message) })
  c.on('close', onEnd)
  c.on('disconnect', onEnd)
}

function stop() {
  enabled = false
  lastStop = Date.now()
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  if (client) {
    const c = client
    client = null
    killClient(c)
  }
  status = 'offline'
  log('Turned OFF')
}

function turnOn() {
  enabled = true
  waitTime = 15000
  const wait = Math.max(0, lastStop + 20000 - Date.now())
  log(wait > 0 ? 'Turned ON (starting in ' + Math.ceil(wait / 1000) + 's)' : 'Turned ON')
  status = 'connecting'
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => { reconnectTimer = null; start() }, wait)
}

// ---------- control page ----------
const PAGE = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Frost Spawner Bot</title>
<style>
body{font-family:sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:16px;text-align:center}
h2{margin:8px 0}
#dot{display:inline-block;width:14px;height:14px;border-radius:50%;background:#ef4444;margin-right:8px}
#btn{font-size:20px;padding:16px 40px;border:0;border-radius:12px;background:#22c55e;color:#fff;margin:16px 0}
#btn.off{background:#ef4444}
input{font-size:16px;padding:10px;border-radius:8px;border:0;width:70%}
#log{background:#020617;color:#86efac;font-family:monospace;font-size:12px;text-align:left;height:50vh;overflow:auto;padding:10px;border-radius:8px;white-space:pre-wrap}
</style></head><body>
<h2>Frost Spawner Bot</h2>
<div id="login"><input id="pw" type="password" placeholder="Password"><br><br><button onclick="saveKey()">Enter</button></div>
<div id="panel" style="display:none">
<div><span id="dot"></span><span id="st">...</span></div>
<button id="btn" onclick="toggle()">...</button>
<div id="log"></div>
</div>
<script>
var key = localStorage.getItem('k') || ''
if (key) { document.getElementById('login').style.display = 'none'; document.getElementById('panel').style.display = 'block' }
function saveKey(){ key = document.getElementById('pw').value; localStorage.setItem('k', key); poll() }
function toggle(){ fetch('/api/toggle?key=' + encodeURIComponent(key), {method:'POST'}).then(poll) }
function showLogin(){ document.getElementById('login').style.display='block'; document.getElementById('panel').style.display='none' }
function poll(){
  fetch('/api/state?key=' + encodeURIComponent(key)).then(function(r){
    if(r.status === 401){ showLogin(); return }
    if(r.status !== 200){ document.getElementById('st').textContent = 'SERVER WAKING UP...'; return }
    return r.json().then(function(d){
      document.getElementById('login').style.display='none'
      document.getElementById('panel').style.display='block'
      var colors = {online:'#22c55e', connecting:'#f59e0b', offline:'#ef4444'}
      document.getElementById('dot').style.background = colors[d.status]
      document.getElementById('st').textContent = d.status.toUpperCase()
      var b = document.getElementById('btn')
      b.textContent = d.enabled ? 'Turn OFF' : 'Turn ON'
      b.className = d.enabled ? 'off' : ''
      var l = document.getElementById('log')
      var atEnd = l.scrollTop + l.clientHeight >= l.scrollHeight - 20
      l.textContent = d.logs.join('\\n')
      if(atEnd) l.scrollTop = l.scrollHeight
    })
  }).catch(function(){ document.getElementById('st').textContent = 'RECONNECTING...' })
}
poll(); setInterval(poll, 2000)
</script></body></html>`

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')

    if (url.pathname.startsWith('/api/')) {
      if (url.searchParams.get('key') !== PANEL_PASSWORD) {
        res.writeHead(401)
        return res.end('Wrong password')
      }
      if (url.pathname === '/api/toggle' && req.method === 'POST') {
        if (enabled) stop()
        else turnOn()
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ enabled, status, logs }))
    }

    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(PAGE)
  })
  .listen(WEB_PORT, '0.0.0.0', () => log('Control page open on port ' + WEB_PORT))

const SELF_URL = process.env.RENDER_EXTERNAL_URL
if (SELF_URL) {
  setInterval(() => { fetch(SELF_URL).catch(() => {}) }, 10 * 60 * 1000)
}

start()
