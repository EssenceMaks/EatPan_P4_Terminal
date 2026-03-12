#!/bin/bash
set -e
yum update -y
yum install -y nodejs npm git

# Create relay directory
mkdir -p /opt/eatpan-relay
cd /opt/eatpan-relay

# Create package.json
cat > package.json << 'PKGJSON'
{
  "name": "eatpan-relay",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "@chainsafe/libp2p-gossipsub": "^12.0.0",
    "@chainsafe/libp2p-noise": "^15.0.0",
    "@chainsafe/libp2p-yamux": "^6.0.0",
    "@libp2p/circuit-relay-v2": "^1.0.25",
    "@libp2p/identify": "^1.0.0",
    "@libp2p/tcp": "^9.0.0",
    "@libp2p/websockets": "^8.0.0",
    "libp2p": "^1.4.0"
  },
  "overrides": {
    "it-queue": "3.1.0",
    "mortice": "3.0.6"
  }
}
PKGJSON

npm install

# Copy relay.mjs
cat > relay.mjs << 'RELAYMJS'
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
import { identify } from '@libp2p/identify'
import { circuitRelayServer } from '@libp2p/circuit-relay-v2'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'

async function startRelay() {
  const node = await createLibp2p({
    addresses: {
      listen: [
        '/ip4/0.0.0.0/tcp/9090',
        '/ip4/0.0.0.0/tcp/9091/ws',
      ]
    },
    transports: [tcp(), webSockets()],
    connectionEncryption: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      relay: circuitRelayServer({
        reservations: {
          maxReservations: 128,
          defaultDurationLimit: 600000,
          defaultDataLimit: BigInt(1 << 24)
        }
      }),
      pubsub: gossipsub({
        emitSelf: false,
        allowPublishToZeroTopicPeers: true,
      })
    }
  })

  console.log('Relay Started! PeerId:', node.peerId.toString())
  for (const ma of node.getMultiaddrs()) {
    console.log('  ', ma.toString())
  }

  let c = 0
  node.addEventListener('peer:connect', (evt) => {
    c++; console.log(`[+${c}] ${evt.detail.toString().substring(0,20)}...`)
  })
  node.addEventListener('peer:disconnect', (evt) => {
    c = Math.max(0, c-1); console.log(`[-${c}] ${evt.detail.toString().substring(0,20)}...`)
  })
}

startRelay().catch(e => { console.error(e); process.exit(1) })
RELAYMJS

# Create systemd service
cat > /etc/systemd/system/eatpan-relay.service << 'SVC'
[Unit]
Description=EatPan P2P Relay Server
After=network.target

[Service]
Type=simple
User=ec2-user
WorkingDirectory=/opt/eatpan-relay
ExecStart=/usr/bin/node relay.mjs
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
SVC

chown -R ec2-user:ec2-user /opt/eatpan-relay
systemctl daemon-reload
systemctl enable eatpan-relay
systemctl start eatpan-relay
