/**
 * relay.mjs — EatPan AWS DHT Phonebook + Circuit Relay
 * 
 * Two roles:
 *   1. DHT Server (Phonebook) — peers register here, discover each other
 *   2. Circuit Relay Server — NAT'd peers connect THROUGH this relay
 *      to reach each other. Relay doesn't see message contents.
 * 
 * This relay does NOT:
 *   - Subscribe to GossipSub topics
 *   - Process or forward messages
 *   - Act as a chat server
 * 
 * Messaging flow:
 *   Peer A ──circuit-relay──▶ AWS ──circuit-relay──▶ Peer B
 *   Then GossipSub works directly between A and B (through the relay circuit)
 * 
 * Ports:
 *   - TCP 9090 — Electron L4/L2/L1 clients
 *   - WS  9091 — nginx WSS (443) proxy → browsers
 */

import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { ping } from '@libp2p/ping'
import { kadDHT } from '@libp2p/kad-dht'
import { circuitRelayServer } from '@libp2p/circuit-relay-v2'
import { readFileSync, existsSync } from 'fs'

// Polyfill: Node 18 doesn't have CustomEvent
if (typeof globalThis.CustomEvent === 'undefined') {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, params = {}) {
      super(type, params)
      this.detail = params.detail ?? null
    }
  }
}

// Polyfill: Promise.withResolvers (Node < 22)
if (typeof Promise.withResolvers === 'undefined') {
  Promise.withResolvers = function () {
    let resolve, reject
    const promise = new Promise((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }
}

const TCP_PORT = process.env.RELAY_TCP_PORT || 9090
const WS_PORT  = process.env.RELAY_WS_PORT  || 9091

async function startRelay() {
  // Load persistent peer ID if available
  let peerId
  const keyPath = process.env.KEY_PATH || '/opt/eatpan/relay-key.json'
  if (existsSync(keyPath)) {
    try {
      const { createFromJSON } = await import('@libp2p/peer-id-factory')
      const keyData = JSON.parse(readFileSync(keyPath, 'utf-8'))
      peerId = await createFromJSON(keyData)
      console.log(`[Relay] Loaded peer ID: ${peerId.toString().substring(0, 24)}...`)
    } catch (e) {
      console.log(`[Relay] Could not load peer ID (${e.message}), generating new one`)
    }
  }

  const config = {
    addresses: {
      listen: [
        `/ip4/0.0.0.0/tcp/${TCP_PORT}`,
        `/ip4/0.0.0.0/tcp/${WS_PORT}/ws`,
      ]
    },
    transports: [tcp(), webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionManager: {
      minConnections: 0,
      maxConnections: 300,
    },
    services: {
      identify: identify(),
      ping: ping(),
      // DHT Server mode — global phonebook
      dht: kadDHT({
        clientMode: false,
        protocol: '/eatpan/kad/1.0.0'
      }),
      // Circuit Relay Server — helps NAT'd peers reach each other
      relay: circuitRelayServer({
        reservations: {
          maxReservations: 200,        // max peers that can reserve a slot
          reservationTtl: 300_000,     // 5 min reservation lifetime
          defaultDataLimit: 1 << 24,   // 16 MB per reservation
        }
      })
    }
  }

  if (peerId) config.peerId = peerId

  const node = await createLibp2p(config)

  const myPeerId = node.peerId.toString()

  console.log('═══════════════════════════════════════════')
  console.log('  📖 EatPan AWS — DHT + Circuit Relay')
  console.log('═══════════════════════════════════════════')
  console.log(`  Peer ID: ${myPeerId}`)
  console.log(`  TCP: ${TCP_PORT}  (Electron clients)`)
  console.log(`  WS:  ${WS_PORT}  (nginx WSS → browsers)`)
  console.log(`  Mode: DHT Phonebook + Circuit Relay`)
  console.log(`  NO GossipSub — relay doesn't process messages`)
  console.log('')
  console.log('  Multiaddrs:')
  for (const ma of node.getMultiaddrs()) {
    console.log(`    ${ma.toString()}`)
  }
  console.log('')
  console.log(`  For clients, use:`)
  console.log(`    TCP: /dns4/relay.eatpan.com/tcp/${TCP_PORT}/p2p/${myPeerId}`)
  console.log(`    WSS: /dns4/relay.eatpan.com/tcp/443/wss/p2p/${myPeerId}`)
  console.log('═══════════════════════════════════════════')

  // ─── Connection logging ───
  let connCount = 0
  let relayCircuits = 0

  node.addEventListener('peer:connect', (evt) => {
    connCount++
    const remote = evt.detail.toString()
    console.log(`[Relay] + Connected: ${remote.substring(0, 20)}... (total: ${connCount})`)
  })

  node.addEventListener('peer:disconnect', (evt) => {
    connCount = Math.max(0, connCount - 1)
    const remote = evt.detail.toString()
    console.log(`[Relay] - Disconnected: ${remote.substring(0, 20)}... (total: ${connCount})`)
  })

  // ─── Stats every 60s ───
  setInterval(() => {
    const conns = node.getConnections()
    console.log(`[Relay] Active: ${conns.length} connections`)
  }, 60_000)

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n[Relay] Shutting down...')
    await node.stop()
    process.exit(0)
  })
}

startRelay().catch((e) => {
  console.error('Relay failed to start:', e)
  process.exit(1)
})
