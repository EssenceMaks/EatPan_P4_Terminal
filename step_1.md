# Step 1 — P4 Terminal: Electron + P2P Chat + Auto-Update

> **Дата**: 12.03.2026  
> **Репо**: [github.com/EssenceMaks/EatPan_p2p_demo_L4](https://github.com/EssenceMaks/EatPan_p2p_demo_L4)  
> **Поточна версія**: v0.5.0

---

## Що зроблено

### 1. P2P Demo (`B_EatPan/p2p_demo/`)
- `node.js` — CLI P2P чат через libp2p (TCP + mDNS + GossipSub)
- `server.js` + `chat.html` — WebSocket-бридж для браузера
- Протестовано: 2 ПК в одній мережі знаходять один одного

### 2. Electron App (`P4_Terminal/`)
| Файл | Призначення |
|------|-------------|
| `package.json` | Electron 28, electron-builder (NSIS/DMG), electron-updater (GitHub Releases) |
| `main.cjs` | Main process: BrowserWindow, IPC, auto-updater, CustomEvent polyfill, P2P startup |
| `p2p.mjs` | libp2p backend (ESM module): TCP, mDNS, GossipSub, peer discovery |
| `preload.cjs` | Secure IPC bridge: `window.eatpan` API через contextBridge |
| `renderer/index.html` | Dark-theme chat UI: sidebar пірів, повідомлення, auto-update banner з помилками |
| `launch.cjs` | Фікс `ELECTRON_RUN_AS_NODE` env var (VS Code встановлює на рівні User) |
| `LICENSE.txt` | EULA для NSIS інсталера |
| `assets/icon.png` | Іконка додатку |

### 3. Auto-Update (повний цикл)
- `electron-updater` → GitHub Releases provider
- `latest.yml` + `.blockmap` для delta-оновлень
- **Протестовано**: v0.3.0 → v0.5.0 автоматичне оновлення через інтернет ✅

### 4. Build & Deploy
- `npm run build:win` → NSIS інсталер (~75 MB)
- GitHub Release з `gh release create`
- `artifactName` з дефісами (для сумісності URLs)

---

## Вирішені проблеми

| Проблема | Причина | Рішення |
|----------|---------|---------|
| `require('electron')` повертає шлях, не API | `ELECTRON_RUN_AS_NODE=1` встановлена VS Code | `launch.cjs` видаляє env var |
| ESM/CJS конфлікт | libp2p = ESM, Electron main = CJS | `main.cjs` (CJS) → `import('./p2p.mjs')` (dynamic) |
| `CustomEvent is not a constructor` | Node 18 (Electron 28) не має CustomEvent | Polyfill в `main.cjs` до dynamic import |
| winCodeSign symlinks | Windows без admin не може створити macOS symlinks | Dummy файли в кеші |
| Auto-update 404 | Файл з пробілами, URL з дефісами | `artifactName: "${productName}-Setup-${version}.${ext}"` |
| Auto-update checksum mismatch | Перезаливка release змінила хеші | Чистий release v0.5.0 |

---

## Peer Discovery — поточний стан

### mDNS (зараз)
- **Де працює**: тільки в **локальній мережі** (один WiFi/LAN)
- **Призначення**: discovery "своїх пристроїв" (телефон, ноутбук, ПК юзера)
- **Статус**: ✅ працює, **НЕ видаляти** — стане частиною "Local Cluster" механіки

### Relay/Bootstrap (потрібно)
- **Для чого**: підключення через інтернет
- **Потрібно**: публічний relay-сервер або DHT bootstrap ноди
- **Опції**: `@libp2p/circuit-relay-v2`, public libp2p bootstrap, fly.io free tier

---

## Архітектурні рішення

```
P4_Terminal/
├── main.cjs          ← CJS (Electron вимагає)
│   ├── CustomEvent polyfill
│   └── import('./p2p.mjs')  ← dynamic import
├── p2p.mjs           ← ESM (libp2p вимагає)
│   ├── mDNS          ← local device discovery (зберігаємо!)
│   ├── GossipSub     ← pub/sub чат
│   └── TCP + Noise   ← транспорт + шифрування
├── preload.cjs       ← IPC bridge (contextIsolation: true)
└── renderer/
    └── index.html    ← UI (чат + update banner)
```

---

## Наступні кроки

### Step 2: Internet P2P (Relay + Bootstrap)
- Додати `@libp2p/circuit-relay-v2` для NAT traversal
- Додати bootstrap ноди (публічні або fly.io)
- mDNS залишається для local discovery + relay для internet

### Step 3: Multi-device sync
- mDNS discovery між своїми пристроями в одній мережі
- Синхронізація рецептів/даних між desktop/mobile

### Step 4: Cluster mechanics (P3 upgrade)
- Docker інтеграція
- Cluster Leader функціонал
