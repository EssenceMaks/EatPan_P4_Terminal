/**
 * chat-lib.mjs — Browser libp2p exports for EatPan Web Chat
 * This file is bundled by esbuild into docs/chat-bundle.js
 */
export { createLibp2p } from 'libp2p'
export { webSockets } from '@libp2p/websockets'
export { all as wsAllFilter } from '@libp2p/websockets/filters'
export { noise } from '@chainsafe/libp2p-noise'
export { yamux } from '@chainsafe/libp2p-yamux'
export { gossipsub } from '@chainsafe/libp2p-gossipsub'
export { identify } from '@libp2p/identify'
export { ping } from '@libp2p/ping'
export { bootstrap } from '@libp2p/bootstrap'
export { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
export { multiaddr } from '@multiformats/multiaddr'
