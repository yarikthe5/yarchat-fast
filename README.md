# Yarchat v5

Повноцінний месенджер оптимізований для роботи на EDGE/2G.

## Можливості
- Реєстрація/вхід з паролем
- Особисті та групові чати
- Офлайн-черга повідомлень (надсилаються автоматично)
- Адаптивне стиснення зображень залежно від якості інтернету
- Голосові повідомлення (Opus, ~3KB/сек)
- Наліпки + створення власних наборів
- Реакції на повідомлення з анімацією
- Редагування та видалення повідомлень
- Карта зустрічей + спільне малювання
- Push-сповіщення (навіть коли закрита вкладка)
- PWA — встановлюється на iPhone/Android
- Індикатор якості зв'язку

## Деплой на Render (безкоштовно)

### 1. Neon.tech (база даних, безкоштовно назавжди)
- Зайди на neon.tech → створи проект → скопіюй Connection string

### 2. Render Environment Variables
```
DATABASE_URL=postgresql://...  (з Neon.tech)
```

### 3. Build & Start
- Build command: `npm install`
- Start command: `npm start`

## Локальний запуск
```
npm install
DATABASE_URL=your_neon_url npm start
```

## Структура
```
yarchat-fast/
├── server.js          # Express + Socket.IO + Postgres
├── package.json
└── public/
    ├── index.html     # SPA
    ├── style.css      # Deep Space дизайн
    ├── app.js         # Вся клієнтська логіка
    ├── sw.js          # Service Worker (офлайн + push)
    ├── manifest.json  # PWA маніфест
    ├── icon-192.png   # Іконка
    ├── icon-512.png
    └── uploads/       # Завантажені файли
```
