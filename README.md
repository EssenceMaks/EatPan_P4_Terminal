# 🍳 EatPan P4 Terminal

> Децентралізований P2P чат + Edge Node (L4)

## Встановлення

### Windows
1. Завантажте `EatPan-Setup-X.X.X.exe` з [Releases](https://github.com/EssenceMaks/EatPan_P4_Terminal/releases)
2. Запустіть інсталятор → оберіть папку → Finish
3. Запустіть «EatPan» з меню Пуск або робочого столу

### macOS (збірка з коду)
```bash
git clone https://github.com/EssenceMaks/EatPan_P4_Terminal.git
cd EatPan_P4_Terminal
npm install
npm run build:mac
# .dmg з'явиться у dist/
```

### Linux (збірка з коду)
```bash
git clone https://github.com/EssenceMaks/EatPan_P4_Terminal.git
cd EatPan_P4_Terminal
npm install
npm run build:linux
# AppImage та .deb з'являться у dist/
```

## Web Chat (без встановлення)

Відкрийте у браузері: **https://essencemaks.github.io/EatPan_P4_Terminal/**

Веб-версія підключається через WebSocket до L3 relay і дозволяє чатитися з P2P мережею.

## Оновлення

Додаток автоматично перевіряє оновлення кожні 30 хвилин. Коли нова версія доступна — з'явиться повідомлення з пропозицією завантажити та встановити.

## Розробка

```bash
npm install
npm run dev     # Запуск з DevTools
npm run relay   # Запуск L3 relay node
```

## Архітектура

- **Level**: L4 (Edge Node)
- **Транспорт**: libp2p (TCP + WebSocket)
- **Шифрування**: Noise protocol
- **PubSub**: GossipSub (multi-topic: global, DM, group)
- **Relay**: Circuit Relay v2 → L3 cluster
- **Sync**: HTTP batch → L2 Backbone

## Технології
- Electron 28
- libp2p 1.4+
- Node.js
- electron-builder (NSIS / DMG / AppImage)
- electron-updater (auto-update via GitHub Releases)
