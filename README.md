# Rhythm Analyzer

Frontend-only rhythm analyzer for GitHub Pages.

## Architecture

Поток данных: метроном задаёт сетку тактов (passes) → удары (tap/mic)
записываются как мс от начала такта → анализ квантизует их на музыкальную
сетку и сравнивает проходы между собой → рендер рисует нотную дорожку.

| Модуль | Ответственность |
| --- | --- |
| `src/app.js` | Оркестрация: state, DOM, события, калибровка латентности, запись ударов |
| `src/metronome.js` | Планирование кликов и границ тактов по часам AudioContext |
| `src/audio-input.js` | Микрофон: getUserMedia, цепочка фильтров, AudioWorklet, уровень для метра |
| `src/mic-processor.js` | AudioWorklet (аудиопоток): детектор онсетов, гейтинг кликов метронома |
| `src/tap-input.js` | Тап по паду и пробел |
| `src/rhythm-core.js` | Чистый анализ: квантизация, длительности, эталонный проход, similarity |
| `src/pass-utils.js` | Чистые помощники: санитизация ударов, позиции, посеточная квантизация |
| `src/durations.js` | Классификация промежутка между ударами в длительность ноты |
| `src/meter.js` | Конфигурации размеров (4/4, 6/8, …), клики метронома, границы групп |
| `src/render-core.js` | Чистый рендер: модель таймлайна и SVG нотной дорожки (без DOM) |
| `src/debug-panel.js` | Таблица проходов и ударов для отладки |
| `src/config.js` | Все настраиваемые константы |

Ключевые договорённости:

- **Одни часы.** Все времена — в шкале `AudioContext.currentTime` (мс).
  `performance.now()` не используется, чтобы не было дрейфа между метрономом
  и вводом. Постоянный сдвиг тракта (вывод+ввод+реакция) компенсируется
  калибровкой Sync (`latencyOffsetMs` в localStorage) или `ctx.outputLatency`.
- **Одна сетка на долю.** Квантизация выбирает для каждой доли бинарную
  (k/4) или триольную (k/6) сетку целиком — смешение сеток внутри доли
  запрещено (`pass-utils.quantizeHitPositions`).
- **Гейтинг кликов.** Метроном заранее сообщает worklet'у времена слышимых
  кликов; онсеты в окне вокруг клика считаются просачиванием и не пишутся.
- **mic-processor.js не импортирует модули** (ограничение AudioWorklet),
  поэтому пара формул продублирована в `app.js` — они помечены комментариями.
- **Чистые модули** (`rhythm-core`, `pass-utils`, `durations`, `meter`,
  `render-core`) не трогают DOM и покрыты тестами `tests/rhythm-core.test.js`.

## Run locally

Do not open `index.html` through `file://`. Browsers block ES module imports from
local files, so `src/app.js` will fail with a CORS error.

Run any tiny static server from the project root instead:

```powershell
python -m http.server 5173 --bind 127.0.0.1
```

Then open:

```text
http://127.0.0.1:5173/
```

## GitHub Pages

This project is static and has no backend or build step. It works on GitHub Pages
because Pages serves files over `https://`, not `file://`.

Recommended Pages setup:

1. Push the repository to GitHub.
2. Go to `Settings -> Pages`.
3. Set source to the branch root, for example `main / root`.
4. Open the published Pages URL.

## Tests

```powershell
node tests/rhythm-core.test.js
```

If `npm test` is blocked by PowerShell execution policy, run the Node command
above directly.
