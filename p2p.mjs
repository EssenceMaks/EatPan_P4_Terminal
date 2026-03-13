/**
 * EatPan P2P Backend — libp2p нода для Electron
 * 
 * Експортує createP2PBackend() для використання main.cjs
 * 
 * Discovery:
 *   - mDNS — локальна мережа (свої пристрої)
 *   - Bootstrap + Relay — інтернет
 * 
 * Route detection:
 *   - 🏠 direct  — mDNS, TCP напряму (LAN)
 *   - 🌐 relay   — через VPS relay (GossipSub mesh)
 */

// Polyfill: Node 18 (Electron 28) не має CustomEvent
if (typeof globalThis.CustomEvent === 'undefined') {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, params = {}) {
      super(type, params)
      this.detail = params.detail ?? null
    }
  }
}

import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { identify } from '@libp2p/identify'
import { mdns } from '@libp2p/mdns'
import { bootstrap } from '@libp2p/bootstrap'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { randomBytes } from 'crypto'

const TOPIC = 'eatpan-chat'

// ─── Relay/Bootstrap адреси ───
const DEFAULT_RELAY = '/dns4/relay.eatpan.com/tcp/9090/p2p/12D3KooWPjuetDeAeyArEwXZtnnyRm9E4sgbLkS4y9myzESB8pa5'
const RELAY_PEER_ID = '12D3KooWPjuetDeAeyArEwXZtnnyRm9E4sgbLkS4y9myzESB8pa5'

const RELAY_ADDRS = (process.env.RELAY_ADDRS || DEFAULT_RELAY)
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

// Extract all relay PeerIds from addresses
const RELAY_PEER_IDS = new Set(
  RELAY_ADDRS.map(addr => {
    const parts = addr.split('/p2p/')
    return parts.length > 1 ? parts[parts.length - 1] : null
  }).filter(Boolean)
)

export async function createP2PBackend(callbacks = {}) {
  const nodeName = 'User-' + randomBytes(3).toString('hex')

  // ─── Track discovery source ───
  const discoveredViaMdns = new Set()
  const discoveredViaBootstrap = new Set()

  // ─── Peer discovery modules ───
  const peerDiscovery = [mdns({ interval: 2000 })]
  if (RELAY_ADDRS.length > 0) {
    peerDiscovery.push(bootstrap({ list: RELAY_ADDRS }))
  }

  // ─── Транспорти ───
  const transports = [tcp(), webSockets()]
  if (RELAY_ADDRS.length > 0) {
    transports.push(circuitRelayTransport({ discoverRelays: 1 }))
  }

  // ─── Створення libp2p ноди ───
  const node = await createLibp2p({
    addresses: {
      listen: ['/ip4/0.0.0.0/tcp/0']
    },
    transports,
    connectionEncryption: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery,
    services: {
      identify: identify(),
      pubsub: gossipsub({
        emitSelf: false,
        allowPublishToZeroTopicPeers: true,
      })
    }
  })

  node.services.pubsub.subscribe(TOPIC)

  const peerId = node.peerId.toString()
  const onlinePeers = new Map()
  onlinePeers.set(peerId, { name: nodeName, lastSeen: Date.now(), via: 'self', route: 'self' })

  // ─── Determine route for a peer ───
  function getRoute(remotePeerId) {
    // Relay itself
    if (RELAY_PEER_IDS.has(remotePeerId)) return 'relay-node'

    // Check if we have a DIRECT connection to this peer (not through relay)
    const conns = node.getConnections(remotePeerId)
    let hasDirectConn = false
    for (const conn of conns) {
      const addr = conn.remoteAddr.toString()
      if (addr.includes('/p2p-circuit/')) {
        return 'relay' // Circuit relay transport
      }
      // Direct TCP/WS connection exists
      hasDirectConn = true
    }

    // If discovered via mDNS AND has direct connection → truly local
    if (discoveredViaMdns.has(remotePeerId) && hasDirectConn) {
      return 'direct'
    }

    // If we only know this peer through GossipSub pings (no direct connection)
    // → messages are routed via the relay's GossipSub mesh
    if (!hasDirectConn) {
      return 'relay'
    }

    // Has direct connection but NOT from mDNS → could be through bootstrap/relay node
    // Check if the connection's remote address is a local network IP
    for (const conn of conns) {
      const addr = conn.remoteAddr.toString()
      const ipMatch = addr.match(/\/ip4\/([\d.]+)\//)
      if (ipMatch) {
        const ip = ipMatch[1]
        if (ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.')) {
          return 'direct'
        }
      }
    }

    return 'relay'
  }

  // ─── Track peer discovery events ───
  node.addEventListener('peer:discovery', (evt) => {
    const discoveredId = evt.detail.id.toString()
    // Check multiaddrs to determine source
    const addrs = evt.detail.multiaddrs?.map(a => a.toString()) || []
    const hasLocalAddr = addrs.some(a => {
      const m = a.match(/\/ip4\/([\d.]+)\//)
      return m && (m[1].startsWith('192.168.') || m[1].startsWith('10.') || m[1].startsWith('172.') || m[1] === '127.0.0.1')
    })

    if (hasLocalAddr && !RELAY_PEER_IDS.has(discoveredId)) {
      discoveredViaMdns.add(discoveredId)
    } else {
      discoveredViaBootstrap.add(discoveredId)
    }
  })

  console.log(`[P2P] Started: ${nodeName} (${peerId.substring(0, 12)}...)`)
  if (RELAY_ADDRS.length > 0) {
    console.log(`[P2P] Relay: ${RELAY_ADDRS.length} addr(s), PeerIDs: ${[...RELAY_PEER_IDS].map(s => s.substring(0,12)).join(', ')}`)
  } else {
    console.log(`[P2P] No relay configured — mDNS only`)
  }

  // ─── P2P Events ───
  node.addEventListener('peer:connect', (evt) => {
    const remote = evt.detail.toString()
    const route = getRoute(remote)
    console.log(`[P2P] Connected [${route}]: ${remote.substring(0, 16)}...`)
    callbacks.onConnected?.(remote)
  })

  node.addEventListener('peer:disconnect', (evt) => {
    const remote = evt.detail.toString()
    onlinePeers.delete(remote)
    discoveredViaMdns.delete(remote)
    discoveredViaBootstrap.delete(remote)
    console.log(`[P2P] Disconnected: ${remote.substring(0, 16)}...`)
    callbacks.onDisconnected?.(remote)
    callbacks.onPeersUpdate?.(Object.fromEntries(onlinePeers))
  })

  // ─── Обробка повідомлень ───
  node.services.pubsub.addEventListener('message', (evt) => {
    if (evt.detail.topic !== TOPIC) return
    try {
      const data = JSON.parse(new TextDecoder().decode(evt.detail.data))

      if (data.type === 'chat' && data.text) {
        // Add route info to chat messages
        data.route = getRoute(data.peerId)
        callbacks.onChat?.(data)
      }

      if (data.type === 'ping') {
        const route = getRoute(data.peerId)
        onlinePeers.set(data.peerId, {
          name: data.name,
          lastSeen: Date.now(),
          via: route,
          route: route
        })
        callbacks.onPeersUpdate?.(Object.fromEntries(onlinePeers))
      }
    } catch (e) { /* ignore */ }
  })

  // ─── Ping кожні 3 сек ───
  const pingInterval = setInterval(async () => {
    try {
      const encoded = new TextEncoder().encode(JSON.stringify({
        type: 'ping', name: nodeName, peerId, timestamp: Date.now()
      }))
      await node.services.pubsub.publish(TOPIC, encoded)
    } catch (e) { /* ignore */ }

    // Очистка старих пірів
    const now = Date.now()
    for (const [id, info] of onlinePeers) {
      if (id !== peerId && now - info.lastSeen > 10000) {
        onlinePeers.delete(id)
      }
    }
    callbacks.onPeersUpdate?.(Object.fromEntries(onlinePeers))
  }, 3000)

  // ─── Публічний API ───
  return {
    sendChat: async (text) => {
      const msg = {
        type: 'chat',
        from: nodeName,
        peerId,
        text,
        timestamp: Date.now()
      }
      try {
        const encoded = new TextEncoder().encode(JSON.stringify(msg))
        await node.services.pubsub.publish(TOPIC, encoded)
      } catch (e) { /* ignore */ }
      callbacks.onChat?.(msg)
    },

    getStatus: () => ({
      name: nodeName,
      peerId,
      addresses: node.getMultiaddrs().map(a => a.toString()),
      peers: Object.fromEntries(onlinePeers),
      connections: node.getConnections().length,
      relayConfigured: RELAY_ADDRS.length > 0,
      relayPeerIds: [...RELAY_PEER_IDS],
    }),

    stop: async () => {
      clearInterval(pingInterval)
      await node.stop()
      console.log('[P2P] Stopped')
    }
  }
}
