# Step 2 — Internet P2P (Circuit Relay) + Web Chat

> **Дата**: 12-13.03.2026  
> **Версія**: v0.9.0  
> **Репо**: [github.com/EssenceMaks/EatPan_p2p_demo_L4](https://github.com/EssenceMaks/EatPan_p2p_demo_L4)

---

## Що зроблено

### 1. Relay Server (`relay.mjs`)
- Standalone Node.js скрипт — circuit-relay-v2 для NAT traversal
- TCP:9090 + WebSocket:9091
- `circuitRelayServer()` — 128 слотів, 10хв/реєстрація, 16MB/ліміт
- GossipSub — **підписаний на `eatpan-chat` топік** (ВАЖЛИВО: без підписки повідомлення не ретранслюються між пірами!)
- Запуск: `node relay.mjs` або `npm run relay`

### 2. AWS EC2 Deployment (free tier)
| Ресурс | Значення |
|--------|----------|
| Instance | `i-06d16331014323230` (t3.micro, eu-central-1) |
| AMI | Amazon Linux 2023 |
| Public IP | `63.177.83.41` |
| PeerId | `12D3KooWPjuetDeAeyArEwXZtnnyRm9E4sgbLkS4y9myzESB8pa5` |
| Security Group | `sg-0839c49792c56eea5` |
| Порти | 22 (SSH), 80, 443, 9090 (TCP relay), 9091 (WS relay) |
| Node.js | v20.20.1 (native CustomEvent) |
| Сервіс | systemd `eatpan-relay` (auto-restart) |
| SSH Key | `C:\Users\user\.ssh\eatpan-relay-fixed.pem` |

### 3. P2P Client (`p2p.mjs`) — оновлений
| Компонент | Для чого |
|-----------|----------|
| `@libp2p/tcp` | Прямі TCP з'єднання (LAN) |
| `@libp2p/websockets` | WebSocket (через relay) |
| `@libp2p/circuit-relay-v2@1.0.25` | Транспорт через relay (NAT traversal) |
| `@libp2p/bootstrap` | Підключення до відомих relay нод |
| `@libp2p/mdns` | Local network discovery (збережено!) |

**Дефолтний relay** захардкоджений в `p2p.mjs`:
```
DEFAULT_RELAY = '/ip4/63.177.83.41/tcp/9090/p2p/12D3KooWPjuetDeAeyArEwXZtnnyRm9E4sgbLkS4y9myzESB8pa5'
```

### 4. Route Detection (`getRoute()`)
Визначає як саме відбувається зв'язок з кожним піром:

| Route | Іконка | Визначення |
|-------|--------|------------|
| `direct` | 🏠 | mDNS discovery + local IP (192.168.x, 10.x, 172.x) |
| `relay` | 🌐 | Повідомлення через AWS relay GossipSub mesh |
| `relay-node` | 🔄 | Сам relay сервер (відомий PeerId) |

Алгоритм:
1. PeerId = relay → `relay-node`
2. Адреса містить `/p2p-circuit/` → `relay` (circuit transport)
3. Знайдений через mDNS + direct TCP + local IP → `direct`
4. Інакше → `relay`

### 5. Web Chat (`web-chat/`)
Браузерний клієнт для P2P чату:
- `p2p-browser.mjs` — libp2p через WebSocket (browser-compatible)
- `build.mjs` — esbuild бандлер → `p2p-bundle.js`
- `index.html` — dark theme UI, peer list, chat

### 6. Single-File Chat (`eatpan-chat.html`)
- Один HTML файл (560KB) — весь libp2p інлайнений
- Відкривається з будь-де, без сервера
- `build-single.mjs` — збирає з `web-chat/index.html` + `p2p-bundle.js`

### 7. GitHub Pages (`docs/`)
- URL: **https://essencemaks.github.io/EatPan_p2p_demo_L4/**
- Source: `/docs` branch `main`
- **⚠️ ПРОБЛЕМА**: Mixed Content — GitHub Pages = HTTPS, relay = ws:// (не wss://)
- **TODO**: потрібен домен + SSL (Let's Encrypt + nginx) для wss:// на relay

---

## Нові файли

```
P4_Terminal/
├── relay.mjs           # Relay server (circuit-relay-v2 + GossipSub)
├── aws-user-data.sh    # EC2 bootstrap script (systemd service)
├── build-single.mjs    # Збирає single-file HTML
├── eatpan-chat.html    # Портативний single-file web chat
├── docs/
│   └── index.html      # GitHub Pages (single-file)
└── web-chat/
    ├── package.json    # Deps для browser libp2p
    ├── p2p-browser.mjs # Browser P2P module
    ├── build.mjs       # esbuild конфіг
    ├── p2p-bundle.js   # Бандл (560KB)
    └── index.html      # Web chat UI
```

---

## Нові залежності

```
@libp2p/circuit-relay-v2@1.0.25   # ⚠️ ТОЧНА ВЕРСІЯ — 1.1.x ламає identify
@libp2p/websockets@8.1.1
@libp2p/bootstrap@10.1.1
@libp2p/utils@6.1.1               # ⚠️ ТОЧНА ВЕРСІЯ — потрібна peer-job-queue
```

---

## Вирішені проблеми

| Проблема | Рішення |
|----------|---------|
| `identify` capability mismatch з circuit-relay | Downgrade relay до 1.0.25 |
| `CustomEvent` crash на EC2 (Node 18) | Node.js v20.20.1 на EC2 (native CustomEvent) |
| Relay не ретранслює повідомлення | `node.services.pubsub.subscribe('eatpan-chat')` на relay |
| PeerId змінюється при рестарті relay | Оновлювати `DEFAULT_RELAY` в `p2p.mjs` після рестарту |
| `$ already declared` в single-file HTML | Перейменовано `$` → `$el`, обгорнуто в IIFE |
| GitHub Pages Mixed Content (HTTPS → ws://) | `relay.eatpan.com` + Let's Encrypt + nginx WSS proxy ✅ |
| Всі піри показують 🏠 | Нові `getRoute()` — трекає mDNS vs bootstrap discovery |

---

## AWS Relay — управління

```powershell
# SSH на relay
ssh -i C:\Users\user\.ssh\eatpan-relay-fixed.pem ec2-user@63.177.83.41

# Логи relay
sudo journalctl -u eatpan-relay --no-pager -n 20

# Перезапуск relay
sudo systemctl restart eatpan-relay

# Статус nginx (WSS proxy)
sudo systemctl status nginx

# Перевірка SSL сертифіката
sudo certbot certificates

# Оновити SSL (авто через timer, але можна вручну)
sudo certbot renew
```

### SSL/WSS Інфраструктура
| Компонент | Деталі |
|-----------|--------|
| Домен | `relay.eatpan.com` (DNS A-record на ukraine.com.ua) |
| SSL Cert | Let's Encrypt, expires 2026-06-10, auto-renewal |
| nginx | Reverse proxy wss:443 → ws:9091 |
| Config | `/etc/nginx/conf.d/relay.conf` |
| Cert path | `/etc/letsencrypt/live/relay.eatpan.com/` |

---

## Як тестувати

### Internet P2P (два ПК)
1. ПК1: запустити EatPan v0.9.0
2. ПК2: запустити EatPan v0.9.0 (через інший інтернет)
3. Обидва автоматично підключаються до AWS relay → бачать один одного 🌐

### Web Chat (браузер)
1. Відкрити `eatpan-chat.html` в браузері (file:// — працює завжди)
2. Або: **https://essencemaks.github.io/EatPan_p2p_demo_L4/** (WSS через relay.eatpan.com ✅)
3. З мобільного — теж працює!

### Локально (LAN)
- mDNS discovery працює як раніше → піри показують 🏠

---

## Виконано

### ✅ WSS для GitHub Pages
- Домен: `relay.eatpan.com` (DNS A-record)
- nginx reverse proxy: wss:443 → ws:9091
- Let's Encrypt SSL (auto-renewal)
- Web-chat: `wss://relay.eatpan.com` (multiaddr: `/dns4/relay.eatpan.com/tcp/443/wss/p2p/<PeerId>`)

### ✅ Elastic IP (Static)
- Прив'язано стабільну адресу: `63.183.129.246`
- **ВАЖЛИВО**: Онови DNS A-record для `relay.eatpan.com` на цей новий IP!
- Клієнти (`p2p.mjs`, `p2p-browser.mjs`) тепер використовують DNS замість IP.

---

## Releases
| Версія | Зміни |
|--------|-------|
| v0.6.0 | Relay code + circuit-relay |
| v0.7.0 | AWS relay, zero-config |
| v0.8.0 | GossipSub fix + web chat |
| v0.9.0 | Route detection (direct/relay/relay-node) + WSS (relay.eatpan.com) |
