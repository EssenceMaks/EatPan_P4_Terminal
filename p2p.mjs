/**
 * p2p.mjs — EatPan L4 P2P Core (libp2p)
 * 
 * Pure DHT-based peer discovery. NO circuit relay transport.
 * AWS is used ONLY as a DHT Bootstrap Phonebook.
 * 
 * Discovery Fallback Chain (Interconnected):
 *   1. Try direct dial to known L2 peer ID
 *   2. If L2 unreachable → try direct dial to known L1 peer ID
 *   3. If both unreachable → query AWS DHT for L3/L2/L1 peer IDs
 *   4. Broadcast dht-key-request event (L1 gets notified about AWS query)
 *   5. Retry with newly discovered peer IDs
 * 
 * Features:
 *   - mDNS for LAN discovery
 *   - Kademlia DHT for peer/content routing
 *   - GossipSub for topic-based messaging
 *   - Route detection (direct/relay/dht-bootstrap)
 *   - Message deduplication by UUID
 *   - Multi-topic rooms (global, DM, group)
 *   - L2/L1 announce message handling
 *   - Discovery event log (forwarded to UI)
 */

// Polyfill: Node 18 (Electron 28) doesn't have CustomEvent
if (typeof globalThis.CustomEvent === 'undefined') {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, params = {}) {
      super(type, params)
      this.detail = params.detail ?? null
    }
  }
}

import './polyfill.mjs'

import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { identify } from '@libp2p/identify'
import { ping } from '@libp2p/ping'
import { bootstrap } from '@libp2p/bootstrap'
import { kadDHT } from '@libp2p/kad-dht'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { randomBytes, randomUUID } from 'crypto'
import { multiaddr } from '@multiformats/multiaddr'

const TOPIC = 'eatpan-chat'
const DHT_PROTOCOL = '/eatpan/kad/1.0.0'

// DHT Content Routing Keys for node-level discovery
const DHT_KEY_L3_SEEDER = '/eatpan/l3-seeders'
const DHT_KEY_L2_LEADER = '/eatpan/l2-leader'
const DHT_KEY_L2_HEIR   = '/eatpan/l2-heir'
const DHT_KEY_L1_ADMIN  = '/eatpan/l1-admin'

// Safe console wrappers — EPIPE-proof
function log(...args) { try { console.log(...args) } catch {} }
function warn(...args) { try { console.warn(...args) } catch {} }

// ─── Bootstrap Phonebook Address (AWS) ───
const BOOTSTRAP_NODE = '/dns4/relay.eatpan.com/tcp/9090/p2p/12D3KooWAcZCFBgGM7zTvdDtraHuDSyVFpZUSi9kvknmjDbJmBbs'
const BOOTSTRAP_ADDRS = (process.env.BOOTSTRAP_ADDRS || BOOTSTRAP_NODE)
  .split(',')
  .map(s => s.trim().replace(/["']/g, ''))
  .filter(Boolean)

const BOOTSTRAP_PEER_IDS = new Set(
  BOOTSTRAP_ADDRS.map(addr => {
    const parts = addr.split('/p2p/')
    return parts.length > 1 ? parts[parts.length - 1] : null
  }).filter(Boolean)
)

/**
 * Create the L4 P2P Backend.
 * @param {Object} callbacks — event callbacks for the Electron main process
 * @param {Object|null} backboneSync — BackboneSync instance for L2 batch sync
 * @returns {Object} P2P API
 */
export async function createP2PBackend(callbacks = {}, backboneSync = null) {
  const nodeName = 'User-' + randomBytes(3).toString('hex')

  // ─── Message dedup ───
  const sentMessageIds = new Set()

  // ═══════════════════════════════════════════════════════
  //  Known higher-level peer IDs (learned from GossipSub)
  // ═══════════════════════════════════════════════════════
  const knownL2Peers = new Map()  // peerId → { name, role, addrs[], lastSeen }
  const knownL1Peers = new Map()  // peerId → { name, addrs[], lastSeen }
  const knownL3Peers = new Map()  // peerId → { name, addrs[], lastSeen }

  // Discovery event log — forwarded to UI
  const discoveryLog = []
  const MAX_DISCOVERY_LOG = 100

  function addDiscoveryEvent(type, text) {
    const evt = { type, text, time: Date.now() }
    discoveryLog.push(evt)
    if (discoveryLog.length > MAX_DISCOVERY_LOG) discoveryLog.shift()
    callbacks.onDiscoveryEvent?.(evt)
  }

  // ─── Has connection to a peer? ───
  function isConnectedTo(targetPeerId) {
    try {
      const conns = node.getConnections(targetPeerId)
      return conns && conns.length > 0
    } catch { return false }
  }

  // ─── Peer discovery: Bootstrap ONLY (no mDNS) ───
  const peerDiscovery = []
  if (BOOTSTRAP_ADDRS.length > 0) {
    peerDiscovery.push(bootstrap({ list: BOOTSTRAP_ADDRS }))
  }

  // ─── Transports: TCP + WS + Circuit Relay ───
  const transports = [tcp(), webSockets(), circuitRelayTransport({ discoverRelays: 1 })]

  // ─── Create libp2p node ───
  const node = await createLibp2p({
    addresses: {
      listen: [
        '/ip4/0.0.0.0/tcp/0',
        '/p2p-circuit'    // listen via relay so other peers can reach us
      ]
    },
    connectionGater: {
      denyDialMultiaddr: async () => false
    },
    connectionManager: {
      minConnections: 5,   // maintain at least 5 connections
      maxConnections: 50,
      inboundUpgradeTimeout: 30000,
    },
    transports,
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery,
    services: {
      identify: identify(),
      ping: ping(),
      dht: kadDHT({
        clientMode: true,
        protocol: DHT_PROTOCOL
      }),
      pubsub: gossipsub({
        emitSelf: false,
        allowPublishToZeroTopicPeers: true,
        floodPublish: true,
        heartbeatInterval: 1000,
      })
    }
  })

  // Subscribe to global topic
  node.services.pubsub.subscribe(TOPIC)
  const subscribedTopics = new Set([TOPIC])

  const peerId = node.peerId.toString()
  const onlinePeers = new Map()
  onlinePeers.set(peerId, { name: nodeName, lastSeen: Date.now(), via: 'self', route: 'self', level: 'L4' })

  // ─── Route detection ───
  function getRoute(remotePeerId) {
    if (BOOTSTRAP_PEER_IDS.has(remotePeerId)) return 'dht-bootstrap'
    const conns = node.getConnections(remotePeerId)
    let hasDirectConn = false
    for (const conn of conns) {
      const addr = conn.remoteAddr.toString()
      if (addr.includes('/p2p-circuit/')) return 'relay'
      hasDirectConn = true
    }
    if (!hasDirectConn) return 'relay'
    for (const conn of conns) {
      const addr = conn.remoteAddr.toString()
      const ipMatch = addr.match(/\/ip4\/([\d.]+)\//)
      if (ipMatch) {
        const ip = ipMatch[1]
        if (ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.') || ip === '127.0.0.1') {
          return 'direct'
        }
      }
    }
    return 'dht'
  }

  // ─── Peer discovery — auto-dial ───
  node.addEventListener('peer:discovery', (evt) => {
    const discoveredId = evt.detail.id.toString()
    if (discoveredId === peerId) return
    log(`[P2P] 🔍 Discovered peer: ${discoveredId.substring(0, 16)}...`)
    addDiscoveryEvent('peer-found', `Discovered: ${discoveredId.substring(0, 16)}...`)
    node.dial(evt.detail.id).then(() => {
      log(`[P2P] ✅ Connected: ${discoveredId.substring(0, 16)}...`)
      addDiscoveryEvent('connected', `Connected to ${discoveredId.substring(0, 16)}...`)
    }).catch(err => {
      log(`[P2P] ⚠ Dial failed: ${discoveredId.substring(0, 16)}... — ${err.message}`)
    })
  })

  // ─── TAG PEERS on connect to prevent connection manager pruning ───
  node.addEventListener('peer:connect', (evt) => {
    const remote = evt.detail.toString()
    const route = getRoute(remote)
    log(`[P2P] + Connected [${route}]: ${remote.substring(0, 16)}...`)
    // Tag this peer as important — prevents connection manager from pruning
    node.peerStore.merge(evt.detail, {
      tags: {
        'keep-alive': { value: 100, ttl: 600000 }  // keep for 10 minutes
      }
    }).catch(() => {})
  })

  node.addEventListener('peer:disconnect', (evt) => {
    const remote = evt.detail.toString()
    if (remote !== peerId) {
      onlinePeers.delete(remote)
      log(`[P2P] - Disconnected: ${remote.substring(0, 16)}...`)
    }
  })

  log(`[P2P] Started L4 Client: ${nodeName} (${peerId.substring(0, 12)}...)`)

  // ─── Bootstrap dial ───
  if (BOOTSTRAP_ADDRS.length > 0) {
    log(`[P2P] Bootstrap DHT: ${BOOTSTRAP_ADDRS.length} addr(s)`)
    setTimeout(async () => {
      for (const addr of BOOTSTRAP_ADDRS) {
        try {
          log(`[P2P] Dialing Bootstrap: ${addr}`)
          await node.dial(multiaddr(addr), { signal: AbortSignal.timeout(10000) })
          log(`[P2P] ✅ Bootstrap connected!`)
          addDiscoveryEvent('bootstrap', `Connected to bootstrap`)
        } catch (err) {
          log(`[P2P] ⚠ Bootstrap failed: ${err.message}`)
          addDiscoveryEvent('bootstrap-fail', `Bootstrap failed: ${err.message}`)
        }
      }
    }, 1000)
  }

  // ─── Keepalive: ping all peers every 15s to keep connections alive ───
  setInterval(async () => {
    const connections = node.getConnections()
    for (const conn of connections) {
      try {
        await node.services.ping.ping(conn.remotePeer, { signal: AbortSignal.timeout(5000) })
      } catch {}
    }
  }, 15000)

  // ─── Periodic reconnect: retry bootstrap every 30s if low connections ───
  setInterval(async () => {
    if (node.getConnections().length < 2 && BOOTSTRAP_ADDRS.length > 0) {
      log('[P2P] Low connections, retrying bootstrap...')
      addDiscoveryEvent('reconnect', 'Retrying bootstrap (low connections)')
      for (const addr of BOOTSTRAP_ADDRS) {
        try {
          await node.dial(multiaddr(addr), { signal: AbortSignal.timeout(10000) })
          log(`[P2P] ✅ Reconnected via bootstrap`)
        } catch {}
      }
    }
  }, 30000)
  // ─── Message handler (multi-topic) ───
  node.services.pubsub.addEventListener('message', (evt) => {
    const topic = evt.detail.topic
    if (!subscribedTopics.has(topic)) return
    try {
      const data = JSON.parse(new TextDecoder().decode(evt.detail.data))

      if (data.type === 'chat' && data.text) {
        // DEDUP: skip own messages
        if (data.peerId === peerId) return
        if (data.id && sentMessageIds.has(data.id)) return
        data.route = getRoute(data.peerId)
        data.room_topic = topic
        if (!data.id) data.id = randomUUID()
        callbacks.onChat?.(data)
        backboneSync?.enqueueSync(data)
      }

      if (data.type === 'invite' && data.roomTopic) {
        callbacks.onInvite?.(data)
      }

      if (data.type === 'ping') {
        const route = getRoute(data.peerId)
        onlinePeers.set(data.peerId, {
          name: data.name,
          lastSeen: Date.now(),
          via: route,
          route: route,
          level: data.level || 'L4'
        })
        callbacks.onPeersUpdate?.(Object.fromEntries(onlinePeers))
      }

      // ══════════════════════════════════════════════
      //  L2/L1/L3 Announce Messages — learn peer IDs
      // ══════════════════════════════════════════════
      if (data.type === 'l2-announce') {
        knownL2Peers.set(data.peerId, {
          name: data.name,
          role: data.role || 'heir',
          addrs: data.addrs || [],
          lastSeen: Date.now(),
        })
        addDiscoveryEvent('l2-announce', `L2 ${data.role || 'node'} announced: ${data.name} (${data.peerId.substring(0, 12)}...)`)
        log(`[P2P] 📢 L2 ${data.role}: ${data.name} → ${data.peerId.substring(0, 16)}...`)
      }

      if (data.type === 'l1-announce') {
        knownL1Peers.set(data.peerId, {
          name: data.name,
          addrs: data.addrs || [],
          lastSeen: Date.now(),
        })
        addDiscoveryEvent('l1-announce', `L1 Admin announced: ${data.name} (${data.peerId.substring(0, 12)}...)`)
        log(`[P2P] 📢 L1 Admin: ${data.name} → ${data.peerId.substring(0, 16)}...`)
      }

      if (data.type === 'l2-heartbeat') {
        // L2 Leader heartbeat also reveals its peer ID
        knownL2Peers.set(data.peerId, {
          name: data.name,
          role: data.role || 'leader',
          addrs: data.addrs || [],
          lastSeen: Date.now(),
        })
      }
    } catch (e) { /* ignore malformed */ }
  })

  // ═══════════════════════════════════════════════════════
  //  INTERCONNECTED FALLBACK CHAIN DISCOVERY LOOP
  // ═══════════════════════════════════════════════════════
  let currentLevel = 'L4'
  let connectedToL2 = false
  let connectedToL1 = false
  let lastAWSQuery = 0

  const discoveryInterval = setInterval(async () => {
    try {
      // ── Step 0: Announce presence ──
      const encoded = new TextEncoder().encode(JSON.stringify({
        type: 'ping', name: nodeName, peerId, timestamp: Date.now(), level: currentLevel
      }))
      await node.services.pubsub.publish(TOPIC, encoded)

      // ══════════════════════════════════════════════
      //  Step 1: Try to connect to known L2 by peer ID
      // ══════════════════════════════════════════════
      connectedToL2 = false
      for (const [l2Id, l2Info] of knownL2Peers) {
        if (isConnectedTo(l2Id)) {
          connectedToL2 = true
          break
        }
        // Try to dial L2 by known multiaddrs
        if (l2Info.addrs && l2Info.addrs.length > 0) {
          for (const addr of l2Info.addrs) {
            try {
              await node.dial(multiaddr(addr), { signal: AbortSignal.timeout(5000) })
              connectedToL2 = true
              addDiscoveryEvent('l2-connect', `Connected to L2 ${l2Info.name} by peer ID`)
              log(`[P2P] ✅ Connected to L2 ${l2Info.name} (${l2Id.substring(0, 12)}...)`)
              break
            } catch {}
          }
          if (connectedToL2) break
        }
      }

      if (connectedToL2) {
        // Connected to L2 — skip further fallback
        callbacks.onDiscoveryStatus?.({ connectedToL2: true, connectedToL1, awsQueried: false })
      } else {
        addDiscoveryEvent('l2-miss', `No L2 reachable (known: ${knownL2Peers.size})`)

        // ══════════════════════════════════════════════
        //  Step 2: L2 unreachable → try L1 by peer ID
        // ══════════════════════════════════════════════
        connectedToL1 = false
        for (const [l1Id, l1Info] of knownL1Peers) {
          if (isConnectedTo(l1Id)) {
            connectedToL1 = true
            break
          }
          if (l1Info.addrs && l1Info.addrs.length > 0) {
            for (const addr of l1Info.addrs) {
              try {
                await node.dial(multiaddr(addr), { signal: AbortSignal.timeout(5000) })
                connectedToL1 = true
                addDiscoveryEvent('l1-connect', `Connected to L1 ${l1Info.name} by peer ID`)
                log(`[P2P] ✅ Connected to L1 ${l1Info.name} (${l1Id.substring(0, 12)}...)`)
                break
              } catch {}
            }
            if (connectedToL1) break
          }
        }

        if (!connectedToL1) {
          addDiscoveryEvent('l1-miss', `No L1 reachable (known: ${knownL1Peers.size})`)
        }

        // ══════════════════════════════════════════════
        //  Step 3: Both unreachable → query AWS DHT 
        //  for L3/L2/L1 peer IDs (max once per 30s)
        // ══════════════════════════════════════════════
        const now = Date.now()
        if (!connectedToL2 && !connectedToL1 && now - lastAWSQuery > 30000) {
          lastAWSQuery = now
          const kad = node.services.dht
          if (kad) {
            addDiscoveryEvent('aws-query', `Querying AWS DHT for L3/L2/L1 peer IDs...`)
            log(`[P2P] 🔍 Querying AWS DHT for higher-level nodes...`)

            // Broadcast dht-key-request so L1 admin gets notified
            try {
              const reqMsg = new TextEncoder().encode(JSON.stringify({
                type: 'dht-key-request',
                requesterPeerId: peerId,
                requesterName: nodeName,
                requesterLevel: currentLevel,
                requestedKeys: ['l3-seeders', 'l2-leader', 'l1-admin'],
                timestamp: now,
              }))
              await node.services.pubsub.publish(TOPIC, reqMsg)
            } catch {}

            // Step 3a: Find L3 Seeders
            try {
              const l3Key = new TextEncoder().encode(DHT_KEY_L3_SEEDER)
              for await (const provider of kad.findProviders(l3Key, { signal: AbortSignal.timeout(5000) })) {
                const l3Id = provider.id.toString()
                if (!knownL3Peers.has(l3Id) && l3Id !== peerId) {
                  knownL3Peers.set(l3Id, { name: l3Id.substring(0, 12), addrs: [], lastSeen: now })
                  addDiscoveryEvent('aws-found-l3', `AWS DHT → L3 Seeder: ${l3Id.substring(0, 16)}...`)
                  log(`[P2P] 🔍 AWS DHT → L3 Seeder: ${l3Id.substring(0, 16)}...`)
                  try { await node.dial(provider.id) } catch {}
                }
              }
            } catch {}

            // Step 3b: Find L2 Leaders
            try {
              const l2Key = new TextEncoder().encode(DHT_KEY_L2_LEADER)
              for await (const provider of kad.findProviders(l2Key, { signal: AbortSignal.timeout(5000) })) {
                const l2Id = provider.id.toString()
                if (!knownL2Peers.has(l2Id) && l2Id !== peerId) {
                  knownL2Peers.set(l2Id, { name: l2Id.substring(0, 12), role: 'leader', addrs: [], lastSeen: now })
                  addDiscoveryEvent('aws-found-l2', `AWS DHT → L2 Leader: ${l2Id.substring(0, 16)}...`)
                  log(`[P2P] 🔍 AWS DHT → L2 Leader: ${l2Id.substring(0, 16)}...`)
                  try { await node.dial(provider.id) } catch {}
                }
              }
            } catch {}

            // Step 3c: Find L1 Admin
            try {
              const l1Key = new TextEncoder().encode(DHT_KEY_L1_ADMIN)
              for await (const provider of kad.findProviders(l1Key, { signal: AbortSignal.timeout(5000) })) {
                const l1Id = provider.id.toString()
                if (!knownL1Peers.has(l1Id) && l1Id !== peerId) {
                  knownL1Peers.set(l1Id, { name: l1Id.substring(0, 12), addrs: [], lastSeen: now })
                  addDiscoveryEvent('aws-found-l1', `AWS DHT → L1 Admin: ${l1Id.substring(0, 16)}...`)
                  log(`[P2P] 🔍 AWS DHT → L1 Admin: ${l1Id.substring(0, 16)}...`)
                  try { await node.dial(provider.id) } catch {}
                }
              }
            } catch {}

            addDiscoveryEvent('aws-done', `AWS query done. Known: L2=${knownL2Peers.size} L1=${knownL1Peers.size} L3=${knownL3Peers.size}`)
          }
        }

        callbacks.onDiscoveryStatus?.({ connectedToL2, connectedToL1, awsQueried: now - lastAWSQuery < 35000 })
      }
    } catch (e) { /* ignore */ }

    // Cleanup stale peers
    const now = Date.now()
    for (const [id, info] of onlinePeers) {
      if (id !== peerId && now - info.lastSeen > 10000) {
        onlinePeers.delete(id)
      }
    }
    callbacks.onPeersUpdate?.(Object.fromEntries(onlinePeers))
  }, 5000)

  // ─── Public API ───
  return {
    /**
     * Send chat message to a topic.
     */
    sendChat: async (text, targetTopic) => {
      const topic = targetTopic || TOPIC
      const msgId = randomUUID()
      sentMessageIds.add(msgId)
      if (sentMessageIds.size > 200) {
        const first = sentMessageIds.values().next().value
        sentMessageIds.delete(first)
      }
      const msg = {
        id: msgId,
        type: 'chat',
        from: nodeName,
        peerId,
        text,
        timestamp: Date.now(),
        room_topic: topic,
        vectorClock: { [peerId]: 1 }
      }
      try {
        const encoded = new TextEncoder().encode(JSON.stringify(msg))
        await node.services.pubsub.publish(topic, encoded)
      } catch (e) { /* ignore */ }
      callbacks.onChat?.(msg)
      backboneSync?.enqueueSync(msg)
    },

    /**
     * Subscribe to a GossipSub topic (for DM or group room).
     */
    joinTopic: (topic) => {
      if (!subscribedTopics.has(topic)) {
        node.services.pubsub.subscribe(topic)
        subscribedTopics.add(topic)
        log(`[P2P] Subscribed to topic: ${topic.substring(0, 30)}...`)
      }
    },

    /**
     * Unsubscribe from a GossipSub topic.
     */
    leaveTopic: (topic) => {
      if (topic === TOPIC) return
      if (subscribedTopics.has(topic)) {
        node.services.pubsub.unsubscribe(topic)
        subscribedTopics.delete(topic)
        log(`[P2P] Unsubscribed from topic: ${topic.substring(0, 30)}...`)
      }
    },

    /**
     * Send room invite to a peer.
     */
    sendInvite: async (roomTopic, roomName, targetPeerId) => {
      const msg = {
        type: 'invite',
        from: nodeName,
        peerId,
        roomTopic,
        roomName,
        targetPeerId,
        timestamp: Date.now(),
      }
      try {
        const encoded = new TextEncoder().encode(JSON.stringify(msg))
        await node.services.pubsub.publish(TOPIC, encoded)
      } catch (e) { /* ignore */ }
    },

    /**
     * Set the current node level (called by seeder when upgrading).
     */
    setLevel: (level) => {
      currentLevel = level
      log(`[P2P] Level changed to: ${level}`)
    },

    /**
     * Get the raw libp2p node (for seeder module).
     */
    getNode: () => node,

    getStatus: () => ({
      name: nodeName,
      peerId,
      level: currentLevel,
      addresses: node.getMultiaddrs().map(a => a.toString()),
      peers: Object.fromEntries(onlinePeers),
      connections: node.getConnections().length,
      bootstrapConfigured: BOOTSTRAP_ADDRS.length > 0,
      bootstrapPeerIds: [...BOOTSTRAP_PEER_IDS],
      subscribedTopics: [...subscribedTopics],
      knownL2: [...knownL2Peers.entries()].map(([id, i]) => ({ peerId: id, ...i })),
      knownL1: [...knownL1Peers.entries()].map(([id, i]) => ({ peerId: id, ...i })),
      knownL3: [...knownL3Peers.entries()].map(([id, i]) => ({ peerId: id, ...i })),
      discoveryLog: discoveryLog.slice(-30).map(e => ({
        type: e.type,
        text: e.text,
        time: new Date(e.time).toLocaleTimeString(),
      })),
      connectedToL2,
      connectedToL1,
    }),

    stop: async () => {
      clearInterval(discoveryInterval)
      await backboneSync?.flush()
      await node.stop()
      log('[P2P] Stopped')
    }
  }
}
